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
    api.query.parachainStaking.selectedCandidates() as Promise<any>,
    api.query.parachainStaking.totalSelected() as Promise<any>,
  ]);

  const [candidateState] = await Promise.all([api.query.parachainStaking.candidateState.entries()]);
  const candidateNames = await Promise.all(
    candidateState.map((c: any) => getAccountIdentity(api, c[1].unwrap().id.toString()))
  );

  // Wait for data to be retrieved
  const [blockHeader, roundInfo, delegatorState, candidatePool, selectedCandidates, totalSelected] =
    await dataPromise;

  const candidates = candidateState.reduce((p, v: any, index: number) => {
    const candidate = v[1].unwrap();
    p[candidate.id.toString()] = {
      id: candidate.id.toString(),
      name: candidateNames[index].replace(
        /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g,
        ""
      ),
      totalDelegators: 0,
      isActive: candidate.state.toString() == "Active",
      isSelected: selectedCandidates.find((c) => c.toString() == candidate.id.toString()),
      totalDelegations: candidate.totalCounted.toBigInt(),
      totalUnused: candidate.totalBacking.toBigInt() - candidate.totalCounted.toBigInt(),
      totalRevokable: new Array(8).fill(0n),
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
          const day = Math.ceil(
            (Math.max(request.whenExecutable, roundInfo.current.toNumber()) -
              roundInfo.current.toNumber()) /
              4
          );
          candidates[request.collator.toString()].totalRevokable[day] += BigInt(request.amount);
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

  const printColoredNumber = (value: bigint, total: bigint) => {
    const valueWithCommas = numberWithCommas(value / 10n ** 18n);
    return value > total / 10n
      ? chalk.red(valueWithCommas)
      : value > total / 20n
      ? chalk.yellow(valueWithCommas)
      : valueWithCommas;
  };

  const sumRevokable = new Array(8)
    .fill(0)
    .map((_, day) => candidateList.reduce((p, c) => p + c.totalRevokable[day], 0n));
  const tableData = (
    [
      [
        "Id",
        "Name",
        "Delegators",
        "Delegations",
        "Revokable",
        ...new Array(7).fill(0).map((_, i) => `${i + 1} day`),
        "Pending",
        "Unused",
      ],
    ] as any[]
  ).concat(
    candidateList.map((candidate, index) => {
      return [
        !candidate.isActive
          ? chalk.yellow(candidate.id.toString())
          : candidate.isSelected
          ? candidate.id
          : chalk.red(candidate.id.toString()),
        !candidate.isActive
          ? chalk.yellow(candidate.name.toString() + ` [off]`)
          : candidate.isSelected
          ? candidate.name
          : chalk.red(candidate.name.toString()),
        candidate.totalDelegators > 400
          ? chalk.red(candidate.totalDelegators)
          : candidate.totalDelegators > 300
          ? chalk.yellow(candidate.totalDelegators)
          : candidate.totalDelegators,
        numberWithCommas(candidate.totalDelegations / 10n ** 18n),
        ...candidate.totalRevokable.map((r, i) => printColoredNumber(r, sumRevokable[i])),
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
        ...new Array(8)
          .fill(0)
          .map((_, day) =>
            numberWithCommas(
              candidateList.reduce((p, c) => p + c.totalRevokable[day], 0n) / 10n ** 18n
            )
          ),
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
        { alignment: "right" },
        { alignment: "right" },
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
