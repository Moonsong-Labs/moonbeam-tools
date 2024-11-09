// This script is expected to run against a parachain network (using launch.ts script)
import { table } from "table";
import yargs from "yargs";

import {
  combineRequestsPerDelegators,
  getAccountIdentity,
  getApiFor,
  NETWORK_YARGS_OPTIONS,
} from "../index.ts";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    delegator: {
      type: "string",
      description: "Address of the delegator",
      required: true,
    },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const delegator = api.registry.createType("EthereumAccountId", argv.delegator).toString();

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);
  const specVersion = (await apiAt.query.system.lastRuntimeUpgrade())
    .unwrap()
    .specVersion.toNumber();

  // Load asycnhronously all data
  const dataPromise = Promise.all([
    api.query.parachainStaking.delegatorState(delegator),
    api.query.parachainStaking.delegationScheduledRequests.entries(),
    specVersion >= 1500
      ? (apiAt.query.parachainStaking.delegationScheduledRequests.entries() as any)
      : [],
  ]);

  // Wait for data to be retrieved
  const [delegatorStateData, delegationRequests] = await dataPromise;

  if (!delegatorStateData.isSome) {
    console.log("No delegations");
    await api.disconnect();
    return;
  }
  const delegatorState = delegatorStateData.unwrap();

  const candidateNames = await Promise.all(
    delegatorState.delegations.map((d) => getAccountIdentity(api, d.owner.toHex())),
  );

  const delegations = delegatorState.delegations;

  const delegatorRequests = combineRequestsPerDelegators(specVersion, delegationRequests, [
    delegatorState,
  ]);

  let total = 0n;
  let revokable = 0n;
  const data = delegations
    .map((delegation, i) => {
      const request = delegatorRequests[delegator.toLocaleLowerCase()]?.find(
        (req) => req.collatorId == delegation.owner.toHex(),
      );
      total += delegation.amount.toBigInt();
      revokable += request ? request.amount / 10n ** 18n : 0n;
      return [
        delegator,
        delegation.owner.toHex(),
        candidateNames[i],
        delegation.amount.toBigInt() / 10n ** 18n,
        request ? `${request.amount / 10n ** 18n}` : "",
      ];
    })
    .sort((a: any, b: any) => Number(b[3] - a[3]));

  const account = await apiAt.query.system.account(delegator);
  const tableData = ([["Delegator", "Candidate", "Name", "Delegation", "Revokable"]] as any[])
    .concat(data)
    .concat([
      [
        `free: ${account.data.free.toBigInt() / 10n ** 18n}`,
        data.length.toString(),
        "",
        total / 10n ** 18n,
        revokable > 0n ? revokable / 10n ** 18n : "",
      ],
    ] as any[]);

  console.log(`preparing the table: ${tableData.length} entries`);
  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex == 0 ||
        lineIndex == 1 ||
        lineIndex == tableData.length - 1 ||
        lineIndex == tableData.length,
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
