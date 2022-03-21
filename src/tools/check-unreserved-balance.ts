// This script is expected to run against a parachain network (using launch.ts script)
//
// Purpose is to find the accounts that have unreserved balances leftover from a staking
// bug.
import yargs from "yargs";
import "@moonbeam-network/api-augment";

import { getAccountIdentities, getApiFor, NETWORK_YARGS_OPTIONS, numberWithCommas } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": { type: "string", demandOption: false, alias: "account" },
    "send-preimage-hash": { type: "boolean", demandOption: false, alias: "h" },
    "send-proposal-as": {
      choices: ["democracy", "council-external", "sudo"],
      demandOption: false,
      alias: "s",
    },
    "collective-threshold": { type: "number", demandOption: false, alias: "c" },
  })
  .check(function (argv) {
    if (argv["send-preimage-hash"] && !argv["account-priv-key"]) {
      console.log(`Missing --account-priv-key`);
      return false;
    }
    return true;
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const blockHash = await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);

  // Load asycnhronously all data
  const [proxies, treasuryProposals, mappingWithDeposit, candidateInfo, delegatorState] =
    await Promise.all([
      apiAt.query.proxy.proxies.entries(),
      apiAt.query.treasury.proposals.entries(),
      apiAt.query.authorMapping.mappingWithDeposit.entries(),
      apiAt.query.parachainStaking.candidateInfo.entries(),
      apiAt.query.parachainStaking.delegatorState.entries(),
    ]);

  let limit = 1000;
  let last_key = "";
  const reservedAccounts: { [accountId: string]: { accountId: string; reserved: bigint } } = {};

  while (true) {
    let query = await api.query.system.account.entriesPaged({
      args: [],
      pageSize: limit,
      startKey: last_key,
    });

    if (query.length == 0) {
      break;
    }

    for (const user of query) {
      let accountId = `0x${user[0].toHex().slice(-40)}`;
      let reserved = user[1].data.reserved.toBigInt();
      last_key = user[0].toString();
      reservedAccounts[accountId] = {
        accountId,
        reserved,
      };
    }
    console.log(`...${Object.keys(reservedAccounts).length}`);
  }
  // EXPECTED RESERVED = STAKING (CANDIDATE || DELEGATOR) + AUTHOR MAPPING +
  // PROXY + TREASURY
  const treasuryDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    treasuryProposals.reduce((p, v) => {
      const treasuryProposal = v[1].unwrap();
      const accountId = `0x${treasuryProposal.proposer.toHex().slice(-40)}`;
      const reserved = treasuryProposal.bond.toBigInt();
      if (!p[accountId]) {
        p[accountId] = {
          accountId,
          reserved: 0n,
        };
      }
      p[accountId].reserved += reserved;
      return p;
    }, {});
  const proxyDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    proxies.reduce((p, v) => {
      const reserved = v[1][1].toBigInt();
      const accountId = `0x${v[0].toHex().slice(-40)}`;
      if (!p[accountId]) {
        p[accountId] = {
          accountId,
          reserved: 0n,
        };
      }
      p[accountId].reserved += reserved;
      return p;
    }, {});
  const authorMappingDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    mappingWithDeposit.reduce((p, v) => {
      const registrationInfo = v[1].unwrap();
      const accountId = `0x${registrationInfo.account.toHex().slice(-40)}`;
      const reserved = registrationInfo.deposit.toBigInt();
      if (!p[accountId]) {
        p[accountId] = {
          accountId,
          reserved: 0n,
        };
      }
      p[accountId].reserved += reserved;
      return p;
    }, {});
  const candidateDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    candidateInfo.reduce((p, v) => {
      const candidate = v[1].unwrap();
      const id = `0x${v[0].toHex().slice(-40)}`;
      const reserved = candidate.bond.toBigInt();
      if (!p[id]) {
        p[id] = {
          id,
          reserved: 0n,
        };
      }
      p[id].reserved += reserved;
      return p;
    }, {});
  const delegatorDeposits: { [accountId: string]: { accountId: string; reserved: bigint } } =
    delegatorState.reduce((p, v) => {
      const delegator = v[1].unwrap();
      const id = `0x${v[0].toHex().slice(-40)}`;
      const reserved = delegator.total.toBigInt();
      if (!p[id]) {
        p[id] = {
          id,
          reserved: 0n,
        };
      }
      p[id].reserved += reserved;
      return p;
    }, {});
  var negativeImbalanceRequiresHotfixExtrinsic = false;
  const balancesToForceUnReserve = [];
  const balancesToForceReserve = [];
  const allDeposits: { [accountId: string]: bigint } = [
    ...Object.keys(authorMappingDeposits),
    ...Object.keys(candidateDeposits),
    ...Object.keys(delegatorDeposits),
    ...Object.keys(treasuryDeposits),
    ...Object.keys(proxyDeposits),
    ...Object.keys(reservedAccounts),
  ].reduce((p, accountId) => {
    if (p[accountId]) {
      return p;
    }
    const deposits = [
      authorMappingDeposits[accountId]?.reserved || 0n,
      candidateDeposits[accountId]?.reserved || 0n,
      delegatorDeposits[accountId]?.reserved || 0n,
      treasuryDeposits[accountId]?.reserved || 0n,
      proxyDeposits[accountId]?.reserved || 0n,
    ];
    const expectedReserved: bigint = deposits.reduce((a, b) => a + b, 0n);

    if (expectedReserved != reservedAccounts[accountId].reserved) {
      console.log("Printing different RESERVED and EXPECTED_RESERVED for ", accountId);
      if (reservedAccounts[accountId].reserved < expectedReserved) {
        negativeImbalanceRequiresHotfixExtrinsic = true;
        const dueToBeReserved = expectedReserved - reservedAccounts[accountId].reserved;
        console.log(
          "BUG REQUIRES HOTFIX EXTRINSIC TO CORRECT ACCOUNT: ",
          accountId,
          "RESERVED: ",
          reservedAccounts[accountId].reserved,
          "EXPECTED RESERVED: ",
          expectedReserved,
          "NEGATIVE DIFFERENCE: ",
          dueToBeReserved
        );
        console.log("INDIVIDUAL DEPOSITS: ", deposits);
        balancesToForceReserve.push({ accountId, dueToBeReserved });
      } else {
        const dueToBeUnreserved = reservedAccounts[accountId].reserved - expectedReserved;
        console.log(
          "RESERVED: ",
          reservedAccounts[accountId].reserved,
          "EXPECTED RESERVED: ",
          expectedReserved,
          "POSITIVE DIFFERENCE: ",
          dueToBeUnreserved
        );
        balancesToForceUnReserve.push({ accountId, dueToBeUnreserved });
      }
    }
    p[accountId] = expectedReserved;
    return p;
  }, {});
  console.log("DUE TO BE UNRESERVED: \n", balancesToForceUnReserve);
  console.log("DUE TO BE RESERVED: \n", balancesToForceReserve);
  if (negativeImbalanceRequiresHotfixExtrinsic) {
    console.log("FIX REQUIRES HOTFIX EXTRINSIC TO FIX NEGATIVE RESERVE IMBALANCE(S)");
    // look for console output prefixed by
    // `BUG REQUIRES HOTFIX EXTRINSIC TO CORRECT ACCOUNT: `
  }
  // TODO: propose and send as democracy proposal
  // use code below
  //   const delegatorChunk = delegators.slice(i, i + BATCH_SIZE);
  //       console.log(`Preparing hotfix for ${delegatorChunk.length} delegators`);
  //       const hotFixTx = api.tx.parachainStaking.hotfixRemoveDelegationRequests(delegatorChunk);

  //       let encodedProposal = hotFixTx?.method.toHex() || "";
  //       let encodedHash = blake2AsHex(encodedProposal);
  //       console.log("Encoded proposal hash for complete is %s", encodedHash);
  //       console.log("Encoded length %d", encodedProposal.length);

  //       console.log("Sending pre-image");
  //       await api.tx.democracy.notePreimage(encodedProposal).signAndSend(account, { nonce: nonce++ });

  //       if (argv["send-proposal-as"] == "democracy") {
  //         console.log("Sending proposal");
  //         await api.tx.democracy
  //           .propose(encodedHash, await api.consts.democracy.minimumDeposit)
  //           .signAndSend(account, { nonce: nonce++ });
  //       } else if (argv["send-proposal-as"] == "council-external") {
  //         console.log("Sending external motion");
  //         let external = api.tx.democracy.externalProposeMajority(encodedHash);
  //         await api.tx.councilCollective
  //           .propose(collectiveThreshold, external, external.length)
  //           .signAndSend(account, { nonce: nonce++ });
  //       }
  api.disconnect();
};

main();
