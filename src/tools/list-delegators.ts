// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";
import { table } from "table";

import {
  getAccountIdentity,
  getApiFor,
  NETWORK_YARGS_OPTIONS,
  combineRequestsPerDelegators,
} from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    threshold: {
      type: "number",
      description: "Minimum of token to be listed",
      default: 10000,
    },
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
  const specVersion = (await apiAt.query.system.lastRuntimeUpgrade())
    .unwrap()
    .specVersion.toNumber();

  // Load asycnhronously all data
  const dataPromise = Promise.all([
    api.query.parachainStaking.delegatorState.entries(),
    specVersion >= 1500
      ? (apiAt.query.parachainStaking.delegationScheduledRequests.entries() as any)
      : [],
  ]);

  const [allCandidateInfo] = await Promise.all([
    api.query.parachainStaking.candidateInfo.entries(),
  ]);
  const candidateNames = await Promise.all(
    allCandidateInfo.map((c: any) => getAccountIdentity(api, `0x${c[0].toHex().slice(-40)}`)),
  );

  // Wait for data to be retrieved
  const [delegatorState, delegationRequests] = await dataPromise;

  const threshold = BigInt(argv.threshold) * 10n ** 18n;
  const candidates = allCandidateInfo.reduce((p, candidate, index: number) => {
    const candidateId = `0x${candidate[0].toHex().slice(-40)}`;
    p[candidateId] = {
      id: candidateId,
      name: candidateNames[index],
    };
    return p;
  }, {});

  const delegatorRequests = combineRequestsPerDelegators(
    specVersion,
    delegationRequests,
    delegatorState,
  );

  const delegators = delegatorState
    .map((d) => (d[1] as any).unwrap())
    .filter((state) => state.total.toBigInt() > threshold)
    .sort((a, b) => Number(b.total - a.total));

  let delegatorsData = [];

  for (const state of delegators) {
    const delegatorId = state.id.toHex();
    const data = state.delegations.map((delegation) => [
      delegatorId,
      delegation.owner.toHex(),
      candidates[delegation.owner.toHex()].name,
      delegation.amount.toBigInt() / 10n ** 18n,
      0n,
    ]);
    for (const request of delegatorRequests[delegatorId] || []) {
      // Checking because of bug allowing pending request even if no collator
      const datum = data.find((d) => d[1] == request.collatorId);
      datum[4] += request.amount / 10n ** 18n;
    }
    delegatorsData = delegatorsData.concat(data);
  }

  const tableData = (
    [["Delegator", "Candidate", "Name", "Delegation", "Revokable"]] as any[]
  ).concat(delegatorsData);

  console.log(`preparing the table: ${tableData.length} entries`);
  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex == 0 || lineIndex == 1 || lineIndex == tableData.length,
      columns: [
        { alignment: "left" },
        { alignment: "left" },
        { alignment: "left" },
        { alignment: "right" },
        { alignment: "right" },
      ],
    }),
  );
  await api.disconnect();
};

main();
