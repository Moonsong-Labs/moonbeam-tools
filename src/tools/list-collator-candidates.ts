// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import yargs from "yargs";
import { table, getBorderCharacters } from "table";

import { getAccountIdentity, getApiFor, getAuthorIdentity, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const [roundInfo, blockHeader, delegatorState, candidatePool, totalSelected] = await Promise.all([
    api.query.parachainStaking.round() as Promise<any>,
    api.rpc.chain.getHeader(),
    api.query.parachainStaking.delegatorState.entries(),
    api.query.parachainStaking.candidatePool() as Promise<any>,
    api.query.parachainStaking.totalSelected() as Promise<any>,
  ]);

  const candidateNames = await Promise.all(
    candidatePool.map((c: any) => getAccountIdentity(api, c.owner))
  );

  const candidates = candidatePool.reduce((p, v: any, index: number) => {
    p[v.owner.toString()] = {
      id: v.owner.toString(),
      name: candidateNames[index],
      totalDelegations: v.amount.toBigInt(),
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
    if (stateData.requests.revocationsCount > 0) {
      for (const requestData of stateData.requests.requests) {
        const request = requestData[1].toJSON();
        candidates[request.collator.toString()].pendingRevoke += BigInt(request.amount);
        if (request.whenExecutable <= roundInfo.current.toNumber()) {
          candidates[request.collator.toString()].totalRevokable += BigInt(request.amount);
        }
      }
    }
  }

  const candidateList = Object.keys(candidates)
    .sort((a, b) => Number(candidates[b].totalDelegations - candidates[a].totalDelegations))
    .map((a) => candidates[a]);

  const minCollator = candidateList[totalSelected.toNumber()];
  const minCollatorFifth = candidateList[Math.floor((totalSelected.toNumber() * 4) / 5)];

  const tableData = ([["Id", "Name", "Delegations", "Revokable", "Pending"]] as any[]).concat(
    candidateList.map((candidate, index) => {
      return [
        candidate.id,
        candidate.name,
        candidate.totalDelegations / 10n ** 18n,
        candidate.totalDelegations - candidate.totalRevokable < minCollator.totalDelegations
          ? chalk.red(candidate.totalRevokable / 10n ** 18n)
          : candidate.totalDelegations - candidate.totalRevokable <
            minCollatorFifth.totalDelegations
          ? chalk.yellow(candidate.totalRevokable / 10n ** 18n)
          : candidate.totalRevokable / 10n ** 18n,
        candidate.totalDelegations - candidate.pendingRevoke < minCollator.totalDelegations
          ? chalk.red(candidate.pendingRevoke / 10n ** 18n)
          : candidate.totalDelegations - candidate.pendingRevoke < minCollatorFifth.totalDelegations
          ? chalk.yellow(candidate.pendingRevoke / 10n ** 18n)
          : candidate.pendingRevoke / 10n ** 18n,
      ];
    })
  );

  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex == 0 ||
        lineIndex == 1 ||
        lineIndex == tableData.length ||
        lineIndex == totalSelected.toNumber() + 1,
    })
  );

  console.log(
    `\nTotal delegations: ${(delegationSum / 10n ** 18n).toString()} (count: ${delegationCount})`
  );

  await api.disconnect();
};

main();
