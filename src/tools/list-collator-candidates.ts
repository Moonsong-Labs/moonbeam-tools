// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import yargs from "yargs";
import { table } from "table";

import { getAccountIdentity, getApiFor, NETWORK_YARGS_OPTIONS } from "..";

function numberWithCommas(x) {
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  // Load asycnhronously all data
  const dataPromise = Promise.all([
    api.rpc.chain.getHeader(),
    api.query.parachainStaking.round() as Promise<any>,
    api.query.parachainStaking.delegatorState.entries(),
    api.query.parachainStaking.candidatePool() as Promise<any>,
    api.query.parachainStaking.totalSelected() as Promise<any>,
  ]);

  const [candidateState] = await Promise.all([api.query.parachainStaking.candidateState.entries()]);
  const candidateNames = await Promise.all(
    candidateState.map((c: any) => getAccountIdentity(api, c[1].unwrap().id.toString()))
  );

  // Wait for data to be retrieved
  const [blockHeader, roundInfo, delegatorState, candidatePool, totalSelected] = await dataPromise;

  const candidates = candidateState.reduce((p, v: any, index: number) => {
    const candidate = v[1].unwrap();
    p[candidate.id.toString()] = {
      id: candidate.id.toString(),
      name: candidateNames[index],
      totalDelegators: 0,
      isActive: candidate.state.toString() == "Active",
      totalDelegations: candidate.totalCounted.toBigInt(),
      totalUnused: candidate.totalBacking.toBigInt() - candidate.totalCounted.toBigInt(),
      totalRevokable: 0n,
      pendingRevoke: 0n,
    };
    return p;
  }, {});

  let delegationCount = candidatePool.length;
  const delegationSum = candidatePool.reduce(
    (p, v: any, index: number) => p + v.amount.toBigInt(),
    0n
  );

  for (const state of delegatorState) {
    const stateData = (state[1] as any).unwrap();
    delegationCount += stateData.delegations.length;
    for (const delegation of stateData.delegations) {
      candidates[delegation.owner.toString()].totalDelegators += 1;
    }
    if (stateData.requests.revocationsCount > 0) {
      for (const requestData of stateData.requests.requests) {
        const request = requestData[1].toJSON();
        // Checking because of bug allowing pending request even if no collator
        if (candidates[request.collator.toString()]) {
          candidates[request.collator.toString()].pendingRevoke += BigInt(request.amount);
          if (request.whenExecutable <= roundInfo.current.toNumber()) {
            candidates[request.collator.toString()].totalRevokable += BigInt(request.amount);
          }
        }
      }
    }
  }

  const candidateList = Object.keys(candidates)
    .sort((a, b) =>
      Number(
        (candidates[b].isActive ? candidates[b].totalDelegations : 0n) -
          (candidates[a].isActive ? candidates[a].totalDelegations : 0n)
      )
    )
    .map((a) => candidates[a]);

  const minCollator = candidateList[totalSelected.toNumber()];
  const minCollatorFifth = candidateList[Math.floor((totalSelected.toNumber() * 4) / 5)];

  const candidateOffCount = candidateList.filter((c) => !c.isActive).length;
  const nextRoundSeconds =
    12 * (roundInfo.first.toNumber() + roundInfo.length.toNumber() - blockHeader.number.toNumber());
  const tableData = (
    [["Id", "Name", "Delegators", "Delegations", "Revokable", "Pending", "Unused"]] as any[]
  ).concat(
    candidateList.map((candidate, index) => {
      return [
        candidate.isActive ? candidate.id : chalk.yellow(candidate.id.toString()),
        candidate.isActive ? candidate.name : chalk.yellow(candidate.name.toString() + ` [off]`),
        candidate.totalDelegators > 400
          ? chalk.red(candidate.totalDelegators)
          : candidate.totalDelegators > 300
          ? chalk.yellow(candidate.totalDelegators)
          : candidate.totalDelegators,
        numberWithCommas(candidate.totalDelegations / 10n ** 18n),
        candidate.totalDelegations - candidate.totalRevokable < minCollator.totalDelegations
          ? chalk.red(numberWithCommas(candidate.totalRevokable / 10n ** 18n))
          : candidate.totalDelegations - candidate.totalRevokable <
            minCollatorFifth.totalDelegations
          ? chalk.yellow(numberWithCommas(candidate.totalRevokable / 10n ** 18n))
          : numberWithCommas(candidate.totalRevokable / 10n ** 18n),
        candidate.totalDelegations - candidate.pendingRevoke < minCollator.totalDelegations
          ? chalk.red(numberWithCommas(candidate.pendingRevoke / 10n ** 18n))
          : candidate.totalDelegations - candidate.pendingRevoke < minCollatorFifth.totalDelegations
          ? chalk.yellow(numberWithCommas(candidate.pendingRevoke / 10n ** 18n))
          : numberWithCommas(candidate.pendingRevoke / 10n ** 18n),

        numberWithCommas(candidate.totalUnused / 10n ** 18n),
      ];
    }),
    [
      [
        `Next Round #${roundInfo.current.toNumber() + 1} - blocks: -${
          roundInfo.first.toNumber() + roundInfo.length.toNumber() - blockHeader.number.toNumber()
        } (-${
          nextRoundSeconds / 3600 >= 1 ? `${Math.floor(nextRoundSeconds / 3600)}h` : ""
        }${Math.floor((nextRoundSeconds % 3600) / 60)
          .toString()
          .padStart(2, "0")}m)`,
        "Total",
        candidateList.reduce((p, c) => p + c.totalDelegators, 0),
        numberWithCommas(candidateList.reduce((p, c) => p + c.totalDelegations, 0n) / 10n ** 18n),
        numberWithCommas(candidateList.reduce((p, c) => p + c.totalRevokable, 0n) / 10n ** 18n),
        numberWithCommas(candidateList.reduce((p, c) => p + c.pendingRevoke, 0n) / 10n ** 18n),
        numberWithCommas(candidateList.reduce((p, c) => p + c.totalUnused, 0n) / 10n ** 18n),
      ],
    ]
  );

  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex == 0 ||
        lineIndex == 1 ||
        lineIndex == tableData.length ||
        lineIndex == tableData.length - 1 ||
        lineIndex == tableData.length - candidateOffCount - 1 ||
        lineIndex == totalSelected.toNumber() + 1,
      columns: [
        { alignment: "left" },
        { alignment: "left" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
        { alignment: "right" },
      ],
    })
  );
  await api.disconnect();
};

main();
