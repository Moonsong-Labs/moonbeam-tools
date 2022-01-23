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
    threshold: {
      type: "number",
      description: "Minimum of token to be listed",
      default: 10000,
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  // Load asycnhronously all data
  const dataPromise = Promise.all([
    api.rpc.chain.getHeader(),
    api.query.parachainStaking.round() as Promise<any>,
    api.query.parachainStaking.delegatorState.entries(),
    api.query.parachainStaking.candidateState.entries(),
    api.query.parachainStaking.totalSelected() as Promise<any>,
  ]);

  const [candidatePool] = await Promise.all([
    api.query.parachainStaking.candidatePool() as Promise<any>,
  ]);
  const candidateNames = await Promise.all(
    candidatePool.map((c: any) => getAccountIdentity(api, c.owner))
  );

  // Wait for data to be retrieved
  const [blockHeader, roundInfo, delegatorState, candidateState, totalSelected] = await dataPromise;

  const threshold = BigInt(argv.threshold) * 10n ** 18n;
  const candidates = candidatePool.reduce((p, v: any, index: number) => {
    p[v.owner.toString()] = {
      id: v.owner.toString(),
      name: candidateNames[index],
    };
    return p;
  }, {});

  const delegators = delegatorState
    .map((d) => (d[1] as any).unwrap())
    .filter((state) => state.total.toBigInt() > threshold)
    .sort((a, b) => Number(b.total - a.total));

  let delegatorsData = [];

  for (const state of delegators) {
    const data = state.delegations.map((delegation) => [
      state.id,
      delegation.owner,
      candidates[delegation.owner.toString()].name,
      delegation.amount.toBigInt() / 10n ** 18n,
      0n,
    ]);
    if (state.requests.revocationsCount > 0) {
      for (const requestData of state.requests.requests) {
        const request = requestData[1].toJSON();
        // Checking because of bug allowing pending request even if no collator
        const datum = data.find((d) => d[1] == request.collator.toString());
        datum[4] += BigInt(request.amount) / 10n ** 18n;
      }
    }
    delegatorsData = delegatorsData.concat(data);
  }

  const tableData = (
    [["Delegator", "Candidate", "Name", "Delegation", "Revokable"]] as any[]
  ).concat(delegatorsData);

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
    })
  );
  await api.disconnect();
};

main();
