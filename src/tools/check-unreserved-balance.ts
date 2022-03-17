// This script is expected to run against a parachain network (using launch.ts script)
//
// Purpose is to find the accounts that have unreserved balances leftover from a staking
// bug.
import chalk from "chalk";
import yargs, { string } from "yargs";
import { table } from "table";

import { getAccountIdentities, getApiFor, NETWORK_YARGS_OPTIONS, numberWithCommas } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);

  // Load asycnhronously all data
  const dataPromise = Promise.all([
    api.rpc.chain.getHeader(blockHash),
    apiAt.query.balances.account.entries(),
    apiAt.query.proxy.proxies.entries(),
    apiAt.query.treasury.proposals.entries(),
    apiAt.query.authorMapping.mappingWithDeposit.entries(),
    apiAt.query.parachainStaking.candidateInfo.entries(),
    apiAt.query.parachainStaking.delegatorState.entries(),
  ]);
  // Wait for data to be retrieved
  const [blockHeader, accountBalances, proxies, treasuryProposals, mappingWithDeposit, candidateInfo, delegatorState] =
    await dataPromise;
  // DEFINE EXPECTED RESERVED SUM
  const expectedReservedSum = new Map<string, 'bigint'>();
  function updateReservedSum(account: string, amount: 'bigint') {
    if (expectedReservedSum[account] !== null) {
        const newV = expectedReservedSum[account] + amount;
        expectedReservedSum[account] = BigInt(newV);
    } else {
        expectedReservedSum[account] = BigInt(amount);
    };
  }
  // ACTUAL AMOUNT RESERVED FOR ALL ACCOUNTS
  const reservedAccounts = accountBalances.reduce((p, v: any) => {
    const accountData = v[1];
    const accountId = `0x${v[0].toHex().slice(-40)}`;
    p[accountId] = {
        account: accountId,
        reserved: accountData.reserved.toBigInt(),
    };
    // initial expected reserved sum to 0
    expectedReservedSum[accountId] = BigInt(0);
    return p;
    }, {});
  // TOTAL EXPECTED = STAKING (CANDIDATE || DELEGATOR) + AUTHOR MAPPING + 
  // PROXY + TREASURY
    const candidateNames = await getAccountIdentities(
        api,
        candidateInfo.map((c: any) => `0x${c[0].toHex().slice(-40)}`),
        blockHash
        );
    const delegatorNames = await getAccountIdentities(
        api,
        delegatorState.map((c: any) => `0x${c[0].toHex().slice(-40)}`),
        blockHash
        );
    const treasuryDeposits = treasuryProposals.reduce((p, v: any) => {
        const treasuryProposal = v[1].unwrap();
        const accountId = `0x${treasuryProposal.proposer.toHex().slice(-40)}`;
        const reserved = treasuryProposal.bond.toBigInt();
        updateReservedSum(accountId, reserved);
        p[accountId] = {
            accountId,
            reserved,
        };
        return p;
        }, {});
    const proxyDeposits = proxies.reduce((p, v: any) => {
        const reserved = v[1][1].toBigInt();
        const accountId = `0x${v[0].toHex().slice(-40)}`;
        updateReservedSum(accountId, reserved);
        p[accountId] = {
            accountId,
            reserved,
        };
        return p;
        }, {});
    const authorMappingDeposits = mappingWithDeposit.reduce((p, v: any) => {
        const registrationInfo = v[1].unwrap();
        const accountId = `0x${registrationInfo.account.toHex().slice(-40)}`;
        const nimbusId = `0x${v[0].toHex().slice(-64)}`;
        const reserved = registrationInfo.deposit.toBigInt();
        updateReservedSum(accountId, reserved);
        p[accountId] = {
            name: `0x${registrationInfo.account.toHex().slice(-40)}`,
            nimbusId,
            reserved,
        };
        return p;
        }, {});
    const candidates = candidateInfo.reduce((p, v: any, index: number) => {
        const candidate = v[1].unwrap();
        const id = `0x${v[0].toHex().slice(-40)}`;
        const reserved = candidate.bond.toBigInt();
        updateReservedSum(id, reserved);
        p[id] = {
            id,
            name: candidateNames[index].replace(/[\t\n]/g, "").slice(0, 42),
            staking_reserved: reserved,
            author_mapping: authorMappingDeposits[id],
        };
        return p;
        }, {});
    const delegators = delegatorState.reduce((p, v: any, index: number) => {
        const delegator = v[1].unwrap();
        const id = `0x${v[0].toHex().slice(-40)}`;
        const reserved = delegator.total.toBigInt();
        updateReservedSum(id, reserved);
        p[id] = {
            id,
            name: delegatorNames[index].replace(/[\t\n]/g, "").slice(0, 42),
            staking_reserved: reserved,
        };
        return p;
        }, {});
  console.log(reservedAccounts);

  api.disconnect();
};

main();