
import yargs from "yargs";
import fs from "fs";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { getWsProviderFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { hexToNumber } from "@polkadot/util";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "at-block": { type: "number", demandOption: false },
    file: { type: "string", demandOption: true },
  }).argv;

async function main() {
  const ws = await getWsProviderFor(argv);
  await ws.isReady;

  const atBlock =
    argv["at-block"] || hexToNumber((await ws.send("chain_getBlock", [])).block.header.number);
  console.log("atBlock: ", atBlock);

  const blockHash = await ws.send("chain_getBlockHash", [atBlock]);

  const file = fs.createWriteStream(argv.file, "utf8");

  const maxKeys = 1000;
  let count = 0;
  try {
    let startKey = null;
    while (true) {
      const keys = await ws.send("state_getKeysPaged", ["", maxKeys, startKey, blockHash]);
      const values = await ws.send("state_queryStorageAt", [keys, blockHash]);

      count += keys.length;
      if (count % 100000 == 0 && keys.length > 0) {
        console.log("count: ", count, keys[keys.length - 1]);
      }

      file.write(values[0].changes.map((c) => `  "${c[0]}": "${c[1]}",\n`).join(""));
      if (keys.length != maxKeys) {
        console.log("total: ", count);
        break;
      }
      startKey = keys[keys.length - 1];
    }
  } finally {
    file.close();
    await ws.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
