// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";
import fs from "fs";
import path from "path";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    out: {
      type: "string",
      description: "directory to use",
    },
    interval: {
      type: "number",
      description: "time to wait between each query",
      default: 30000,
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  while (true) {
    const blockNumber = (await api.rpc.chain.getBlock()).block.header.number.toNumber();
    const blockHash = (await api.rpc.chain.getBlockHash(blockNumber)).toString();
    const extrinsics = await api.rpc.author.pendingExtrinsics();
    const txs = await Promise.all(
      extrinsics.map(async (ext) => ({
        data: ext.toJSON(),
        tx: ext.toHuman(),
      }))
    );

    const filename = path.join(argv.out || "", `extrinsics-${extrinsics.length}.json`);
    console.log(`${new Date()} Writing to ${filename}`);
    fs.writeFileSync(
      filename,
      JSON.stringify(
        {
          blockNumber,
          blockHash,
          txs: txs,
        },
        null,
        2
      )
    );
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await sleep(argv.interval || 30000);
  }
  api.disconnect();
};

main();
