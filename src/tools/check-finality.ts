// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";

import { promiseConcurrent } from "../utils/functions";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { getAccountIdentity } from "../utils/monitoring";
const debug = require("debug")("check:finality");

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    start: {
      type: "number",
      description: "Block number to start from",
      default: 0,
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);
  const endHash = (await api.rpc.chain.getFinalizedHead()).toString();
  console.log(endHash);
  const endNumber = (await api.rpc.chain.getHeader(endHash)).number.toNumber();

  const batchSize = 20000;
  let i = argv.start;
  debug(`Checking from ${i} to ${endNumber}...`);
  for (let i = argv.start; i < endNumber; i += batchSize) {
    await promiseConcurrent(
      10,
      async (_, index) => {
        const blockNumber = i + index;
        if (blockNumber > endNumber) {
          return;
        }
        const block = (await api.rpc.eth.getBlockByNumber(blockNumber, false)).unwrap().toJSON();
        const final = await (api.rpc as any).moon.isBlockFinalized(block.hash);
        if (!final.isTrue) {
          console.log(
            `Block #${blockNumber.toString().padEnd(10, " ")} ${new Date(
              parseInt(block.timestamp.toString()) * 1000,
            ).toISOString()} (${block.hash}): ${final.isTrue} ${await getAccountIdentity(
              api,
              block.author.toString(),
            )}`,
          );
          return;
        }
      },
      new Array(batchSize).fill(0),
    ).catch(async (err) => {
      debug(`Failed ${i} retrying`, err);
      i -= batchSize;
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
    });

    debug(`${i}...`);
  }
  console.log(`Analyzed from ${argv.start} to ${endNumber}`);
  api.disconnect();
};

main();
