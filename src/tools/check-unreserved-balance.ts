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
  // Load data
  const [
    accountBalances,
    proxies,
    treasuryProposals,
    mappingWithDeposit,
    candidateInfo,
    delegatorState,
  ] = await Promise.all([
    api.query.system.account.entries(),
    api.query.proxy.proxies.entries(),
    api.query.treasury.proposals.entries(),
    api.query.authorMapping.mappingWithDeposit.entries(),
    api.query.parachainStaking.candidateInfo.entries(),
    api.query.parachainStaking.delegatorState.entries(),
  ]);
  // ACTUAL AMOUNT RESERVED FOR ALL ACCOUNTS
  const reservedAccounts: { [accountId: string]: { accountId: string; reserved: bigint } } =
    accountBalances.reduce((p, v) => {
      const accountId = `0x${v[0].toHex().slice(-40)}`;
      const reserved = v[1].data.reserved.toBigInt();
      if (!p[accountId]) {
        p[accountId] = {
          accountId,
          reserved,
        };
      }
      return p;
    }, {});
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
      const reserved = registrationInfo.deposit;
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
      const reserved = candidate.bond;
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
      const reserved = delegator.total;
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
  const imbalancesToFix = [];
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
    // const deposits = [{}]; and sum them to print if hotfix required
    const deposits = [
      authorMappingDeposits[accountId] ? authorMappingDeposits[accountId].reserved : 0n,
      candidateDeposits[accountId] ? candidateDeposits[accountId].reserved : 0n,
      delegatorDeposits[accountId] ? delegatorDeposits[accountId].reserved : 0n,
      treasuryDeposits[accountId] ? treasuryDeposits[accountId].reserved : 0n,
      proxyDeposits[accountId] ? proxyDeposits[accountId].reserved : 0n,
    ];
    // expected reserved is sum of deposits
    const expectedReserved: bigint = deposits.reduce((a, b) => a + b, 0n); // this plus is concatenating
    if (expectedReserved != reservedAccounts[accountId].reserved) {
      console.log("Printing different RESERVED and EXPECTED_RESERVED for ", accountId);
      if (reservedAccounts[accountId].reserved < expectedReserved) {
        negativeImbalanceRequiresHotfixExtrinsic = true;
        console.log(
          "BUG REQUIRES HOTFIX EXTRINSIC TO CORRECT ACCOUNT: ",
          accountId,
          "RESERVED: ",
          reservedAccounts[accountId].reserved,
          "EXPECTED RESERVED: ",
          expectedReserved
        );
        console.log("INDIVIDUAL DEPOSITS: ", deposits);
      }
      const dueToBeUnreserved = reservedAccounts[accountId].reserved - expectedReserved;
      console.log(
        "RESERVED: ",
        reservedAccounts[accountId].reserved,
        "EXPECTED RESERVED: ",
        expectedReserved,
        "POSITIVE DIFFERENCE: ",
        dueToBeUnreserved
      );
      // COLLECT INTO OUTPUT
      imbalancesToFix.push({ accountId, dueToBeUnreserved });
    }
    p[accountId] = expectedReserved;
    return p;
  }, {});
  console.log("DUE TO BE UNRESERVED: \n", imbalancesToFix);
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
