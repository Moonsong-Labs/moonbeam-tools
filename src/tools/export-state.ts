import yargs from "yargs";
import fs from "fs";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { getWsProviderFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { hexToNumber } from "@polkadot/util";
import { processAllStorage } from "../utils/storage";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "at-block": { type: "number", demandOption: false },
    "raw-spec": { type: "string", demandOption: true },
    output: { alias: "o", type: "string", demandOption: true },
  }).argv;

async function main() {
  const ws = await getWsProviderFor(argv);
  await ws.isReady;

  const atBlock =
    argv["at-block"] || hexToNumber((await ws.send("chain_getBlock", [])).block.header.number);
  console.log("atBlock: ", atBlock);

  const blockHash = await ws.send("chain_getBlockHash", [atBlock]);

  const file = fs.createWriteStream(argv.output, "utf8");
  const rawSpec = JSON.parse(fs.readFileSync(argv["raw-spec"], "utf8"));
  rawSpec["bootNodes"] = [];
  rawSpec["telemetryEndpoints"] = [];
  rawSpec["name"] = rawSpec["name"] + " FORK";
  rawSpec["id"] = rawSpec["id"] + "_fork";
  rawSpec["chainType"] = "Local";
  rawSpec["genesis"]["raw"]["top"] = {
    // Add the storage ":fork": "0x01" for information (not useful)
    "0x3A666F726B": "0x01",
  };
  rawSpec["protocolId"] = (rawSpec["protocolId"] || "unk") + "fork";

  try {
    let t0 = performance.now();
    const rawSpecLines = JSON.stringify(rawSpec, null, 2).split(/\r?\n/);
    while (true) {
      const line = rawSpecLines.shift();
      if (line === undefined) {
        throw new Error("No spec line found");
      }
      file.write(line + "\n");
      if (/\ +"top"/.test(line)) {
        break;
      }
    }
    let total = 0;
    await processAllStorage(ws, { prefix: "0x", blockHash, splitDepth: 2 }, (batchResult) => {
      total += batchResult.length;
      file.write(batchResult.map((c) => `  "${c.key}": "${c.value}",\n`).join(""));
    });
    file.write(`  \n`);
    while (true) {
      const line = rawSpecLines.shift();
      if (line === undefined) {
        break;
      }
      file.write(line + "\n");
    }
    const t1 = performance.now();
    const duration = t1 - t0;
    const qps = total / (duration / 1000);
    console.log(`Written ${total} keys in ${duration}: ${qps.toFixed(0)} keys/sec`);
  } finally {
    file.close();
    await ws.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
