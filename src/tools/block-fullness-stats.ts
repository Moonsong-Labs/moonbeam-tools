// This script is expected to run against a parachain network (using launch.ts script)
import { ApiPromise, WsProvider } from "@polkadot/api";
import yargs from "yargs";
import { promiseConcurrent, getBlockDetails, BlockDetails } from "..";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { max } from "moment";
const percentile = require("percentile");

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    // url: {
    //   type: "string",
    //   description: "Websocket url",
    //   string: true,
    //   demandOption: true,
    // },
    from: {
      type: "number",
      description: "from block number (included)",
      demandOption: true,
    },
    size: {
      type: "number",
      description: "number of blocks to process",
      demandOption: true,
    },
  }).argv;

const printDOTs = (value: bigint, decimals = 4) => {
  const power = 10n ** (10n - BigInt(decimals));
  const decimal_power = 10 ** decimals;
  if (decimals > 0) {
    return (Number(value / power) / decimal_power).toFixed(decimals).padStart(5 + decimals, " ");
  }
  return (value / power).toString().padStart(5, " ");
};

/*

what do we want

block fullness avg 
block fullness max
block fullness min
block fullness percentile 90, 50
block fullness distribution
distribution of tx per block

*/

const main = async () => {
  const api = await getApiFor(argv);
  // const api = await ApiPromise.create({
  //   provider: new WsProvider(argv.url),
  // });

  const toBlockNumber = argv.from + argv.size - 1;
  const fromBlockNumber = argv.from;

  console.log(`========= Checking block ${fromBlockNumber}...${toBlockNumber}`);

  // collect block fullness data
  let bfData = {
    max: 0,
    maxBlock: 0,
    min: 100,
    minBlock: 0,
    sum: 0,
    values: [],
  };

  let txData = {
    max: 0,
    maxBlock: 0,
    min: 100,
    minBlock: 0,
    sum: 0,
    txPerBlock: [],
  };

  type BlockData = {
    number: number;
    fill: number;
  };

  let blocks: BlockData[] = [];
  for (let i = fromBlockNumber; i <= toBlockNumber; i++) {
    blocks.push({ number: i, fill: 0 });
  }

  await promiseConcurrent(
    20,
    async (block: BlockData, i: number) => {
      const blockHash = await api.rpc.chain.getBlockHash(block.number);
      const records = await api.query.system.events.at(blockHash);

      const blockDetails = await api.rpc.chain
        .getBlockHash(block.number)
        .then((blockHash) => getBlockDetails(api, blockHash));

      blocks[i].fill = blockDetails.weightPercentage;

      if (blockDetails.weightPercentage > bfData.max) {
        bfData.max = blockDetails.weightPercentage;
        bfData.maxBlock = block.number;
      }
      if (blockDetails.weightPercentage < bfData.min) {
        bfData.min = blockDetails.weightPercentage;
        bfData.minBlock = block.number;
      }
      bfData.sum += blockDetails.weightPercentage;
      bfData.values.push(blockDetails.weightPercentage);

      if (blockDetails.txWithEvents.length > txData.max) {
        txData.max = blockDetails.txWithEvents.length;
        txData.maxBlock = block.number;
      }
      if (blockDetails.txWithEvents.length < txData.min) {
        txData.min = blockDetails.txWithEvents.length;
        txData.minBlock = block.number;
      }
      txData.sum += blockDetails.txWithEvents.length;
      txData.txPerBlock.push(blockDetails.txWithEvents.length);
    },
    blocks,
  );

  await api.disconnect();

  console.log(`Total blocks: ${toBlockNumber - fromBlockNumber}`);
  console.log(
    `Block Fullness Max ${bfData.maxBlock}: ${bfData.max} (whole block: ${(bfData.max + 25).toFixed(2)})`,
  );
  console.log(
    `Block Fullness Min ${bfData.minBlock}: ${bfData.min} (whole block: ${(bfData.min + 25).toFixed(2)})`,
  );
  console.log(`Block Fullness Avg: ${(bfData.sum / blocks.length).toFixed(2)}`);

  const percentiles = [90, 80, 70, 60, 50, 45, 40, 37.5, 35, 30, 20, 10];

  for (let i of percentiles) {
    const full75 = percentile(i, bfData.values);
    const full = full75 + 25;
    console.log(`Block Fullness ${i}perc: ${full75.toFixed(2)} (whole block: ${full.toFixed(2)})`);
  }

  // simulate EIP1559
  console.log(`------- Simulated EIP1559 -------`);
  let sim = percentiles.reduce((p, i) => ({ ...p, [i]: 1 }), {});
  let targetFullness = percentiles.map((i) => ({
    p: i,
    target: percentile(i, bfData.values),
  }));

  blocks.forEach((block) => {
    targetFullness.forEach(({ p, target }) => {
      const eip1559 = 1 + ((block.fill - target) / target) * (1 / 8);
      sim[p] = sim[p] * eip1559;
      // sim[p] = Math.max(sim[p], eip1559);
    });
  });

  Object.entries(sim)
    .reverse()
    .forEach(([p, price]) => {
      console.log(`Simulated ${p}perc, ${percentile(p, bfData.values).toFixed(2)}%: ${price}`);
    });

  console.log(`=========== Tx stats ===========`);
  console.log(`Total tx: ${txData.sum}`);
  console.log(`Max TXs in a block: ${txData.max} in block ${txData.maxBlock}`);
  console.log(`Min TXs in a block: ${txData.min} in block ${txData.minBlock}`);
  console.log(`Avg TXs in a block: ${(txData.sum / blocks.length).toFixed(2)}`);
  console.log(`----- Tx per block distribution -----`);
  for (let i of percentiles) {
    console.log(`Tx per block ${i}%: ${percentile(i, txData.txPerBlock)}`);
  }
};

main();
