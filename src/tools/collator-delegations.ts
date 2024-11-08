// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import { table } from "table";
import yargs from "yargs";

import { combineRequestsPerDelegators, getApiFor, NETWORK_YARGS_OPTIONS } from "../index.ts";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    collator: {
      type: "string",
      description: "address of the collator",
      demandOption: true,
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

  const formattedCollator = api.registry.createType("EthereumAccountId", argv.collator).toString();

  // Load asycnhronously all data
  // TODO: This could be highly optimized by avoid delegationScheduledRequests.entries()
  const [delegatorState, candidateInfo, delegationRequests] = await Promise.all([
    apiAt.query.parachainStaking.delegatorState.entries(),
    apiAt.query.parachainStaking.candidateInfo(formattedCollator),
    specVersion >= 1500
      ? (apiAt.query.parachainStaking.delegationScheduledRequests.entries() as any)
      : [],
  ]);

  if (candidateInfo.isNone) {
    console.log(`Candidate not found: ${formattedCollator}`);
    await api.disconnect();
    return;
  }

  const delegations = [
    {
      owner: `${formattedCollator}*`,
      amount: candidateInfo.unwrap().bond,
      revoking: 0n,
    },
  ];

  const delegatorRequests = combineRequestsPerDelegators(
    specVersion,
    delegationRequests,
    delegatorState,
  );

  for (const state of delegatorState) {
    const stateData = (state[1] as any).unwrap();
    const delegation = stateData.delegations.find((d) => d.owner.toString() == formattedCollator);
    if (!delegation) {
      continue;
    }
    const delegationData = {
      owner: stateData.id.toString(),
      amount: delegation.amount,
      revoking: 0n,
    };

    if (delegatorRequests[formattedCollator]) {
      delegationData.revoking += delegatorRequests[formattedCollator].reduce(
        (p, v) => (p += v.amount),
        0n,
      );
    }
    delegations.push(delegationData);
  }
  const totalDelegations = delegations.reduce(
    (p, delegation) => p + delegation.amount.toBigInt(),
    0n,
  );
  const totalRevoking = delegations.reduce((p, delegation) => p + delegation.revoking, 0n);

  const tableData = ([["Id", "Amount", "Revoking"]] as any[]).concat(
    delegations
      .sort((a, b) => Number(a.amount.toBigInt() - b.amount.toBigInt()))
      .map((delegation) => {
        return [
          delegation.owner.toString(),
          delegation.amount.toBigInt() > totalDelegations / 10n
            ? chalk.red(BigInt(delegation.amount.toBigInt()) / 10n ** 18n)
            : delegation.amount.toBigInt() > totalDelegations / 20n
              ? chalk.yellow(delegation.amount.toBigInt() / 10n ** 18n)
              : BigInt(delegation.amount.toBigInt()) / 10n ** 18n,
          delegation.revoking > totalRevoking / 10n
            ? chalk.red(delegation.revoking / 10n ** 18n)
            : delegation.revoking > totalRevoking / 20n
              ? chalk.yellow(delegation.revoking / 10n ** 18n)
              : delegation.revoking / 10n ** 18n,
        ];
      }),
    [["Total", totalDelegations / 10n ** 18n, totalRevoking / 10n ** 18n]],
  );

  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex == 0 ||
        lineIndex == 1 ||
        lineIndex == tableData.length ||
        lineIndex == tableData.length - 1,
      columns: [{ alignment: "left" }, { alignment: "right" }, { alignment: "right" }],
    }),
  );

  await api.disconnect();
};

main();
