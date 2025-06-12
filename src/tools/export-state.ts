import "@moonbeam-network/api-augment";
import "@polkadot/api-augment";

import { hexToNumber } from "@polkadot/util";
import fs from "fs";
import moment from "moment";
import path from "path";
import yargs from "yargs";

import { getApiFor, getWsProviderFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { processAllStorage } from "../utils/storage";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "at-block": { type: "number", demandOption: false },
    concurrency: { type: "number", demandOption: false, default: 10 },
    delay: { type: "number", demandOption: false, default: 0 },
    "raw-spec": { type: "string", demandOption: true },
    "path-prefix": { type: "string", demandOption: true },
  }).argv;

async function main() {
  const ws = await getWsProviderFor(argv);
  await ws.isReady;

  const now = moment().format("YYYY-MM-DD");

  const atBlock =
    argv["at-block"] || hexToNumber((await ws.send("chain_getBlock", [])).block.header.number);

  const concurrency = argv.concurrency || 10;
  const delay = argv.delay;
  console.log(
    `${now}: Exporting at block ${atBlock} using ${ws.endpoint} and ${concurrency} threads (+${delay}ms delay)`,
  );

  const chainName = await ws.send("system_chain", []);
  const blockHash = await ws.send("chain_getBlockHash", [atBlock]);
  const runtimeVersion = await ws.send("state_getRuntimeVersion", [blockHash]);
  const chainId = await ws.send("net_version", [blockHash]);

  const filename = `${argv["path-prefix"]}-${now}.json`;
  const metaFilename = `${argv["path-prefix"]}-${now}.info.json`;

  const file = fs.createWriteStream(filename, "utf8");
  const rawSpec = JSON.parse(fs.readFileSync(argv["raw-spec"], "utf8"));
  rawSpec["bootNodes"] = [];
  rawSpec["telemetryEndpoints"] = [];
  rawSpec["name"] = rawSpec["name"] + " FORK";
  rawSpec["id"] = rawSpec["id"] + "_fork";
  rawSpec["chainType"] = "Local";
  rawSpec["genesis"]["raw"]["top"] = {
    // Add the storage ":fork": "0x01" for information (not directly useful)
    "0x3A666F726B": "0x01",
  };
  rawSpec["protocolId"] = (rawSpec["protocolId"] || "unk") + "fork";

  try {
    const t0 = performance.now();
    const rawSpecLines = JSON.stringify(rawSpec, null, 2).split(/\r?\n/);
    while (rawSpecLines.length > 0) {
      const line = rawSpecLines.shift();
      if (line === undefined) {
        throw new Error("No spec line found");
      }
      file.write(line + "\n");
      if (/\s+"top"/.test(line)) {
        break;
      }
    }

    const storageNames: { [prefix: string]: string } = {};
    const storageCount: { [prefix: string]: bigint } = {};
    const storageKeySize: { [prefix: string]: number } = {};
    const storageSize: { [prefix: string]: bigint } = {};

    const api = await getApiFor(argv);
    for (const section of Object.keys(api.query)) {
      for (const method of Object.keys(api.query[section])) {
        const prefix = api.query[section][method].keyPrefix();
        storageNames[prefix] = `${section}.${method}`;
        storageCount[prefix] = 0n;
        storageSize[prefix] = 0n;
      }
    }
    api.disconnect();

    const storagePrefixes = Object.keys(storageNames);
    let total = 0;
    await processAllStorage(
      ws,
      { prefix: "0x", blockHash, splitDepth: 2, concurrency, delayMS: delay },
      (batchResult) => {
        total += batchResult.length;
        file.write(batchResult.map((c) => `  "${c.key}": "${c.value}",\n`).join(""));
        for (const line of batchResult) {
          for (const storagePrefix of storagePrefixes) {
            if (line.key.startsWith(storagePrefix)) {
              storageCount[storagePrefix] += 1n;
              storageKeySize[storagePrefix] = line.key.length / 2 - 1;
              storageSize[storagePrefix] +=
                BigInt(line.key.length / 2) + BigInt(line.value.length / 2) - 2n;
            }
          }
        }
      },
    );
    file.write(`  \n`);
    while (rawSpecLines.length > 0) {
      const line = rawSpecLines.shift();
      if (line === undefined) {
        break;
      }
      file.write(line + "\n");
    }
    const t1 = performance.now();
    const duration = t1 - t0;
    const qps = total / (duration / 1000);

    fs.writeFileSync(
      metaFilename,
      JSON.stringify(
        {
          file: path.basename(filename),
          name: chainName,
          chainId: chainId,
          blockHash: blockHash,
          blockNumber: atBlock,
          runtime: runtimeVersion,
          storages: Object.keys(storageNames).map((prefix) => {
            return {
              name: storageNames[prefix],
              prefix: prefix,
              count: storageCount[prefix].toString(),
              size: storageSize[prefix]?.toString(),
              keySize: storageKeySize[prefix],
            };
          }),
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      `Written ${total} keys in ${moment
        .duration(duration / 1000, "seconds")
        .humanize()}: ${qps.toFixed(0)} keys/sec`,
    );
  } catch (e) {
    console.log("ERROR:");
    console.log(e);
    console.trace(e);
  } finally {
    file.close();
    await ws.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
