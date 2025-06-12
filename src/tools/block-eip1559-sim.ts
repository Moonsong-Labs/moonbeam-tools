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
    target: {
      type: "array",
      description: "target block fullness, eg --target 10 20 30",
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

  const toBlockNumber = argv.from + argv.size;
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

  type FeeData = {
    t: number; // target block fullness
    f: number; // baseFee
  };
  type BlockData = {
    h: number; // block number (height)
    d: Array<FeeData>; // fees data
  };

  if (argv.target.length == 0) {
    console.log("Error: target block fullness is required");
    return;
  }

  let blocks: BlockData[] = [];
  for (let i = fromBlockNumber; i <= toBlockNumber; i++) {
    blocks.push({ h: i, d: [] });
  }

  const minBaseFee = 1;
  const maxBaseFee = 10e75;

  let currentFees: FeeData[] = argv.target.map((t: number) => ({ t: t, f: minBaseFee }));
  await promiseConcurrent(
    20,
    async (block: BlockData, i: number) => {
      const blockDetails = await api.rpc.chain
        .getBlockHash(block.h)
        .then((blockHash) => getBlockDetails(api, blockHash));

      currentFees = currentFees.map((feeData: FeeData) => {
        const eip1559 = 1 + ((blockDetails.weightPercentage - feeData.t) / feeData.t) * (1 / 8);
        const newFee = Math.min(Math.max(feeData.f * eip1559, minBaseFee), maxBaseFee);
        return { t: feeData.t, f: newFee };
      });
      blocks[i].d = currentFees;
    },
    blocks,
  );

  // write to file
  const fs = require("fs");
  const path = require("path");
  const fileName = `block-eip1559-sim-${fromBlockNumber}-${toBlockNumber}.json`;
  const filePath = path.join(__dirname, "..", "..", "notebooks", "data", fileName);
  fs.writeFileSync(filePath, JSON.stringify(blocks, null, 2));

  console.log(`output written to ${filePath}`);
  console.log(`plot_data("${fileName}")`);
  await api.disconnect();
};

main();
