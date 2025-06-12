import { ApiPromise } from "@polkadot/api";
import yargs from "yargs";

import { exploreBlockRange, getApiFor, NETWORK_YARGS_OPTIONS } from "../index";

const XEN_ADDRESS = "0xb564A5767A00Ee9075cAC561c427643286F8F4E1".toLowerCase();

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    date: {
      type: "string",
      description: "Date/Month/Year to query (Ex: `2024`, `2024-05`, `2024-05-01`)",
      demandOption: true,
    },
  }).argv;

const reportLine = function (
  date: string,
  uniqueFroms: number,
  uniqueTos: number,
  total: number,
  xenCount: number,
  blocks: number,
) {
  return `[${date}] Blocks: ${blocks.toString().padStart(7)}, from: ${uniqueFroms.toString().padStart(7)}, to: ${uniqueTos.toString().padStart(7)}, txs: ${total.toString().padStart(7)}, xens: ${xenCount.toString().padStart(6)}`;
};

async function binaryHighSearch(max: number, compare_fn: (v: number) => Promise<number>) {
  let m = 0;
  let n = max;
  while (m <= n) {
    const k = (n + m) >> 1;
    const cmp = await compare_fn(k);
    if (cmp >= 0) {
      m = k + 1;
    } else if (cmp < 0) {
      n = k - 1;
    }
  }
  return -~m;
}

async function binaryLowSearch(max: number, compare_fn: (v: number) => Promise<number>) {
  let m = 0;
  let n = max;
  while (m <= n) {
    const k = (n + m) >> 1;
    const cmp = await compare_fn(k);
    if (cmp > 0) {
      m = k + 1;
    } else if (cmp <= 0) {
      n = k - 1;
    }
  }
  return -~m;
}

const compareDate = (api: ApiPromise, targetDate: string) => async (n) => {
  const { block } = await api.rpc.chain.getBlock(await api.rpc.chain.getBlockHash(n));
  const timestamp = api.registry.createType(
    "Compact<u64>",
    block.extrinsics.find((e) => e.method.section === "timestamp" && e.method.method === "set")
      .data,
  );
  const date = new Date(timestamp.toNumber()).toISOString().slice(0, targetDate.length);
  return date === targetDate ? 0 : date > targetDate ? -1 : 1;
};

const main = async () => {
  const api = await getApiFor(argv);
  if (argv.during && argv.to && argv.from) {
    console.log(`--during is incompatible with --to and --from`);
    process.exit(1);
  }

  const currentBlockNumber = (await api.rpc.chain.getBlock()).block.header.number.toNumber();
  const beforeBlock = await binaryLowSearch(currentBlockNumber, compareDate(api, argv.date));
  const afterBlock = await binaryHighSearch(currentBlockNumber, compareDate(api, argv.date));

  const counts: {
    froms: { [accountId: string]: number };
    tos: { [accountId: string]: number };
    uniqueFroms: number;
    uniqueTos: number;
    total: number;
    xenCount: number;
  } = {
    froms: {},
    tos: {},
    uniqueFroms: 0,
    uniqueTos: 0,
    total: 0,
    xenCount: 0,
  };
  let blockCount = 0;

  const timer = setInterval(() => {
    console.error(
      reportLine(
        argv.date,
        counts.uniqueFroms,
        counts.uniqueTos,
        counts.total,
        counts.xenCount,
        blockCount,
      ),
    );
  }, 10000);

  let date;

  await exploreBlockRange(
    api,
    { from: beforeBlock, to: afterBlock, concurrency: 50 },
    async (blockDetails) => {
      blockCount++;

      const timestamp = api.registry.createType(
        "Compact<u64>",
        blockDetails.block.extrinsics.find(
          (e) => e.method.section === "timestamp" && e.method.method === "set",
        ).data,
      );
      date = new Date(timestamp.toNumber());

      const _month = date.getMonth();

      const evmEvents = blockDetails.txWithEvents
        .map((e) => e.events.filter((e) => e.section === "ethereum" && e.method === "Executed"))
        .flat();

      for (const evmEvent of evmEvents) {
        const from = evmEvent.data[0].toHex();
        const to = evmEvent.data[1].toHex();

        if (to === XEN_ADDRESS) {
          counts.xenCount++;
        }

        counts.total++;
        if (!counts.froms[from]) {
          counts.froms[from] = 1;
          counts.uniqueFroms++;
        } else {
          counts.froms[from]++;
        }
        if (!counts.tos[to]) {
          counts.tos[to] = 1;
          counts.uniqueTos++;
        } else {
          counts.tos[to]++;
        }
      }
    },
  );

  clearInterval(timer);

  console.log(
    reportLine(
      argv.date,
      counts.uniqueFroms,
      counts.uniqueTos,
      counts.total,
      counts.xenCount,
      blockCount,
    ),
  );
  await api.disconnect();
};

main();
