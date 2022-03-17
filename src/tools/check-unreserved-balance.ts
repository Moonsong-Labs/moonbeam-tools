// This script is expected to run against a parachain network (using launch.ts script)
//
// Purpose is to find the accounts that have unreserved balances leftover from a staking
// bug.
import chalk from "chalk";
import yargs from "yargs";
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
    apiAt.query.proxy.proxies.entries(),
    apiAt.query.authorMapping.mappingWithDeposit.entries(),
    apiAt.query.parachainStaking.candidateInfo.entries(),
    apiAt.query.parachainStaking.delegatorState.entries(),
  ]);
  // Wait for data to be retrieved
  const [blockHeader, proxies, mappingWithDeposit, candidateInfo, delegatorState] =
    await dataPromise;
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
    const proxyDeposits = proxies.reduce((p, v: any) => {
        const depositAmount = v[1][1];
        const accountId = `0x${v[0].toHex().slice(-40)}`;
        p[accountId] = {
            accountId,
            reserved: depositAmount.toBigInt(),
        };
        return p;
        }, {});
    const authorMappingDeposits = mappingWithDeposit.reduce((p, v: any) => {
        const registrationInfo = v[1].unwrap();
        const accountId = `0x${registrationInfo.account.toHex().slice(-40)}`;
        const nimbusId = `0x${v[0].toHex().slice(-64)}`;
        p[accountId] = {
            name: `0x${registrationInfo.account.toHex().slice(-40)}`,
            nimbusId,
            reserved: registrationInfo.deposit.toBigInt(),
        };
        return p;
        }, {});
    const candidates = candidateInfo.reduce((p, v: any, index: number) => {
        const candidate = v[1].unwrap();
        const id = `0x${v[0].toHex().slice(-40)}`;
        p[id] = {
            id,
            name: candidateNames[index].replace(/[\t\n]/g, "").slice(0, 42),
            staking_reserved: candidate.bond.toBigInt(),
            author_mapping: authorMappingDeposits[id],
        };
        return p;
        }, {});
    const delegators = delegatorState.reduce((p, v: any, index: number) => {
        const delegator = v[1].unwrap();
        const id = `0x${v[0].toHex().slice(-40)}`;
        p[id] = {
            id,
            name: delegatorNames[index].replace(/[\t\n]/g, "").slice(0, 42),
            staking_reserved: delegator.total.toBigInt(),
        };
        return p;
        }, {});
  // TODO: treasury
  // TODO: map for all accounts total reserved
  // then make a map of expected reserve which sums all below
  console.log("AUTHOR MAPPING:", authorMappingDeposits);
  console.log("------------------------------------------------------------");
  console.log("CANDIDATES:", candidates);
  console.log("------------------------------------------------------------");
  console.log("PROXIES:", proxyDeposits);
  console.log("------------------------------------------------------------");
  console.log("DELEGATORS:", delegators);
  console.log("------------------------------------------------------------");

  api.disconnect();
};

main();