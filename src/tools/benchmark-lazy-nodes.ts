import yargs from "yargs";
import chalk from "chalk";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { mapExtrinsics } from "src/utils/types";
import { getBlockDetails } from "src/utils/monitoring";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "Block number to look into",
    },
    tx: {
      type: "string",
      description: "transaction to replay",
      demandOption: true,
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();

  const block = await getBlockDetails(api, blockHash);

  const tx = block.txWithEvents.find((tx) => {
    return tx.extrinsic.hash.toHex().toLocaleLowerCase() == argv.tx.toLocaleLowerCase();
  });

  if (!tx) {
    console.error(`Transaction ${argv.tx} not found`);
    process.exit(1);
  }
  console.log(
    `Transaction ${argv.tx} found ${!tx.dispatchError ? "✅" : "🟥"} (ref: ${tx.dispatchInfo.weight.refTime.toString().padStart(12)}, pov: ${tx.dispatchInfo.weight.proofSize.toString().padStart(9)})`,
  );

  const extrinsicData = tx.extrinsic.toHex();

  const servers = [
    {
      name: "original",
      color: "gray",
      url: "ws://127.0.0.1:9947",
    },
    {
      name: "pov refund",
      color: "yellow",
      url: "ws://127.0.0.1:9948",
    },
    {
      name: "pov refund + fix",
      color: "green",
      url: "ws://127.0.0.1:9949",
    },
  ];

  await Promise.all(
    servers.map(async (server) => {
      const api = await getApiFor({ url: server.url });
      const serverName = chalk[server.color](server.name.padStart(20));
      let valid = 0;

      const unsubscribe = await api.rpc.chain.subscribeNewHeads(async (header) => {
        // console.log(`[${serverName}] Chain is at block: #${header.number}`);
        const block = await getBlockDetails(api, header.hash.toHex());

        for (const tx of block.txWithEvents) {
          if (tx.extrinsic.hash.toHex().toLocaleLowerCase() == argv.tx.toLocaleLowerCase()) {
            console.log(
              `[${serverName}] Transaction ${argv.tx} found in block ${header.number} ${!tx.dispatchError ? "✅" : "🟥"} (ref: ${tx.dispatchInfo.weight.refTime.toString().padStart(12)}, pov: ${tx.dispatchInfo.weight.proofSize.toString().padStart(9)})`,
            );
            unsubscribe();
            valid = 1;
            break;
          }
        }
      });

      const extrinsic = api.tx(extrinsicData);

      try {
        const hash = await api.rpc.author.submitExtrinsic(extrinsic);
        console.log(`[${serverName}] Submitted hash: ${hash}`);
      } catch (error) {
        console.error(`[${serverName}] Failed to submit:`, error);
      }

      while (valid == 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      await api.disconnect();
    }),
  );

  await api.disconnect();
};

async function start() {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

start();
