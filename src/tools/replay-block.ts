import chalk from "chalk";
import { ApiPromise, WsProvider } from "@polkadot/api";
import fs from "fs/promises";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "src/utils/networks.ts";
import yargs from "yargs";
import { runTask, spawnTask } from "src/utils/runner.ts";
import { blake2AsHex } from "@polkadot/util-crypto";
import { stringToHex } from "@polkadot/util";
import { convertExponentials } from '@zombienet/utils';
import jsonBg from "json-bigint";
import { ALITH_PRIVATE_KEY } from "src/utils/constants.ts";
import { getBlockDetails, listenBlocks } from "src/utils/monitoring.ts";
import { TxWithEventAndFee } from "src/utils/types.ts";

const JSONbig = jsonBg({ useNativeBigInt: true });

export const NETWORK_WS_URLS: { [name: string]: string } = {
  rococo: "wss://rococo-rpc.polkadot.io",
  westend: "wss://westend.api.onfinality.io/public-ws",
  kusama: "wss://kusama.api.onfinality.io/public-ws",
  polkadot: "wss://polkadot.api.onfinality.io/public-ws",
};

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "Block number",
    },
    "fork-url": {
      type: "string",
      description: "HTTP(S) url",
      string: true,
    },
    "moonbeam-binary": {
      type: "string",
      alias: "m",
      description:
        "Absolute file path (e.g. /tmp/fork-chain/moonbeam) of moonbeam binary OR version number (e.g. 0.31) to download.",
      default: "../moonbeam/target/release/moonbeam",
    },
    "runtime": {
      type: "string",
      alias: "r",
      describe: "Input path for runtime blob to ",
      default: "../moonbeam/target/release/wbuild/moonbeam-runtime/moonbeam_runtime.compact.compressed.wasm"
    },
  }).argv;

const main = async () => {


  const logHandlers = [];
  const exitPromises = [];
  const processes = [];
  const apis = [];

  const api = await getApiFor(argv);
  apis.push(api);

  const atBlock = argv.at ? argv.at : (await api.rpc.chain.getHeader()).number.toNumber();
  const originalBlockHash = await api.rpc.chain.getBlockHash(atBlock);
  const originalBlock = await api.rpc.chain.getBlock(originalBlockHash);
  const apiAt = await api.at(originalBlockHash);

  const parentHash = originalBlock.block.header.parentHash.toHex();
  const moonbeamBinaryPath = argv["moonbeam-binary"]; // to improve

  process.stdout.write(`\t - Checking moonbeam binary...`);
  const moonbeamVersion = (await runTask(`${moonbeamBinaryPath} --version`)).trim();
  process.stdout.write(` ${chalk.green(moonbeamVersion.trim())} ✓\n`);

  process.stdout.write(`\t - Checking moonbeam runtime...`);
  const runtimeBlob = await fs.readFile(argv.runtime);
  const runtimeHash = blake2AsHex(runtimeBlob);
  process.stdout.write(` ${chalk.green(runtimeHash)} ✓\n`);

  process.stdout.write("Done ✅\n");

  const onProcessExit = async () => {
    try {
      alive = false;
      await Promise.race(exitPromises);
      console.log(`Closing....`);
      await Promise.all(logHandlers.map((handler) => handler.close()));
      console.log(`Killing....`);
      await Promise.all(processes.map((handler) => handler.close()));
      await Promise.all(apis.map((handler) => handler.disconnect()));
      await lazyApi.disconnect();
      await api.disconnect();
    } catch (err) {
      // console.log(err.message);
    }
  };

  process.once("SIGINT", onProcessExit);

  const commonParams = ["--database paritydb",
    "--rpc-cors all",
    "--unsafe-rpc-external",
    "--rpc-methods=Unsafe",
    "--no-private-ipv4",
    "--no-mdns",
    "--no-prometheus",
    "--no-grandpa",
    "--reserved-only",
    "--detailed-log-output",
    "--enable-log-reloading"
  ];

  const lazyParams = [
    `--lazy-loading-remote-rpc=${argv['fork-url']}`,
    `--lazy-loading-delay-between-requests 5`,
    `--lazy-loading-runtime-override=${argv.runtime}`,
    `--block=${parentHash}`,
    `--alice`,
    `--force-authoring`,
    `--blocks-pruning=archive`,
    `--unsafe-force-node-key-generation`,
    `--sealing=manual`,
  ]

  const alithLogs = "./alith.log"
  const alithLogHandler = await fs.open(alithLogs, "w");
  logHandlers.push(alithLogHandler);
  const alithProcess = await spawnTask(
    `${moonbeamBinaryPath} ${commonParams.join(" ")} ${lazyParams.join(" ")}`,
  );
  processes.push(alithProcess);

  exitPromises.push(new Promise<void>((resolve) => {
    alithProcess.stderr.pipe(alithProcess.stdout.pipe(alithLogHandler.createWriteStream()));
    alithProcess.on("exit", () => {
      console.log(`${chalk.red(`parachain alith`)} is closed.`);
      resolve();
    });
    process.on("exit", () => {
      try {
        alithProcess.kill();
      } catch (e) { }
    });
  }));
  process.stdout.write(`\t - ${chalk.yellow(`Waiting`)}...(~20s)`);
  while (
    (await runTask(`egrep -o '(Accepting|Running JSON-RPC)' ${alithLogs} || echo "no"`)).trim()
      .length < 4
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  let alive = true;

  process.stdout.write(` ✓\n`);
  process.stdout.write(
    `ℹ️  ParaChain Explorer: https://polkadot.js.org/apps/?rpc=ws://127.0.0.1:9944#/explorer\n`,
  );
  process.stdout.write(`      Sudo: ${chalk.green("Alith")} ${ALITH_PRIVATE_KEY}\n`);
  process.stdout.write(`Council/TC: ${chalk.green("Alith")} ${ALITH_PRIVATE_KEY}\n`);

  const lazyApi = await getApiFor({ url: "ws://localhost:9944" });
  apis.push(lazyApi);

  const specVersion = await lazyApi.runtimeVersion.specVersion.toNumber();
  console.log(`Lazy loaded chain spec version: ${specVersion}`);
  await lazyApi.rpc.engine.createBlock(true, false)
  await lazyApi.rpc.engine.createBlock(true, false);

  const printExt = (prefix: string, tx) => {
    if (!tx) {
      console.log(`[${prefix}] Transaction missing`);
    }
    else {
      console.log(`[${prefix}] Transaction ${tx.extrinsic.method.section.toString()}.${tx.extrinsic.method.method.toString()} found ${!tx.dispatchError ? "✅" : "🟥"} (ref: ${tx.dispatchInfo.weight.refTime.toString().padStart(12)}, pov: ${tx.dispatchInfo.weight.proofSize.toString().padStart(9)})`);
    }
  }


  const printEvent = (e: any) => {
    const types = e.typeDef;
    //console.log(`\t\t${e.meta.documentation.toString()}`);
    const lines = e.data.map((data, index) => {
      return `${typeof types[index].type == "object" ? "" : types[index].type}: ${data.toString()}`;
    }).join(' - ');
    console.log(`\t${e.section.toString()}.${e.method.toString()}\t${lines}`)
  }

  const mapEventLine = (e: any) => {
    if (!e) {
      return {}
    }
    const types = e.typeDef;
    const data = {};
    for (let index = 0; index < e.data.length; index++) {
      if (types[index].type == "object") {
        data[types[index].lookupName] = mapEventLine(e.data[index])
      } else {
        data[types[index].type] = e.data[index].toString()
      }
    }
    return data;
  }

  const compare = (txA: TxWithEventAndFee, txB: TxWithEventAndFee) => {
    //  compareItem(txA, txB, "  - Error", "dispatchError");
    let valid = true;
    for (let index = 0; index < txA.events.length; index++) {
      const eventA = txA.events[index];
      const eventB = txB.events[index];
      if (!eventA || !eventB || !eventA.eq(eventB)) {
        if (eventA.method == eventB.method &&
          ((eventA.section.toString() == "balances" && eventA.method.toString() == "Deposit") ||
            (eventA.section.toString() == "system" && eventA.method.toString() == "ExtrinsicSuccess"))) {
          continue;
        }
        valid = false;
      }
    }

    if (txA.events.length !== txB.events.length) {
      valid = false;
    }
    console.log(`[${txA.extrinsic.hash.toHex()}] Events match: ${valid ? "✅" : "🟥"}`);
    if (!valid) {
      console.log(`[${txA.extrinsic.hash.toHex()}] Events do not match`);
      for (let index = 0; index < Math.max(txA.events.length, txB.events.length); index++) {
        const eventA = txA.events.length > index ? txA.events[index] : null;
        const eventB = txB.events.length > index ? txB.events[index] : null;

        const simA = mapEventLine(eventA);
        const simB = mapEventLine(eventB);
        // compareObjects(simA, simB);
        if (!eventA || !eventB || !eventA.eq(eventB)) {
          console.log(`     ${index}`);
          if (eventA) {
            printEvent(eventA);
          }
          if (eventB) {
            printEvent(eventB);
          }
        }
      }
    }
  }

  let foundBlock = 0;

  const submitBlock = async (exts) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await lazyApi.rpc.engine.createBlock(true, false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const currentBlockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
    const currentBlockHash = await api.rpc.chain.getBlockHash(atBlock);
    console.log(`Block #${currentBlockNumber} [${currentBlockHash.toString()}]`);
    const block = await getBlockDetails(lazyApi, currentBlockHash);
    console.log(`Block #${currentBlockNumber} [${block.txWithEvents.length} txs]`);
    for (const tx of block.txWithEvents) {
      console.log(`[Lazy] Transaction ${tx.extrinsic.method.section.toString()}.${tx.extrinsic.method.method.toString()} found ${!tx.dispatchError ? "✅" : "🟥"} (ref: ${tx.dispatchInfo.weight.refTime.toString().padStart(12)}, pov: ${tx.dispatchInfo.weight.proofSize.toString().padStart(9)})`);
      if (exts[tx.extrinsic.hash.toHex()]) {
        foundBlock++;
        exts[tx.extrinsic.hash.toHex()].lazyEx = tx;
      }
    }
    if (foundBlock > 0) {
      for (const hash in exts) {
        //printExt("Official", exts[hash].ex);
        //printExt("    Lazy", exts[hash].lazyEx);
        compare(exts[Object.keys(exts)[0]].ex, exts[Object.keys(exts)[0]].lazyEx);
      }
    }
  };
  let blockHash = "";

  while (alive) {
    const exts = {};
    try {
      const newBlockHash = await api.rpc.chain.getBlockHash(atBlock + foundBlock);
      if (blockHash.toString() == newBlockHash.toString()) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    blockHash = originalBlockHash.toString()
    console.log(`===========================Checking block ${atBlock + foundBlock} [${blockHash.toString()}]`);
    const blockDetails = await getBlockDetails(api, blockHash);
    await Promise.all(blockDetails.txWithEvents.map(async (tx, index) => {
      const { extrinsic: ex, dispatchInfo, dispatchError } = tx;
      if (!dispatchInfo.class.isNormal) {
        return
      }
      const { method, signature, isSigned, signer, nonce } = ex;
      // console.log(index, `${ex.method.section.toString()}.${ex.method.method.toString()} [${ex.hash.toHex()}]`);
      if (method.section === 'sudo' && method.method.startsWith('sudo')) {
        // Handle sudo extrinsics
        const nestedCall = method.args[0]; // The "call" is the first argument in sudo methods
        const { section, method: nestedMethod, args: nestedArgs } = apiAt.registry.createType('Call', nestedCall);

        console.log(`  Nested Call: ${section}.${nestedMethod}`);
        const nestedDecodedArgs = nestedArgs.map((arg: any) => arg.toHuman());
        console.log(`  Nested Args: ${JSON.stringify(nestedDecodedArgs, null, 2)}`);
      }
      // console.log(`${ex.method.method.toString() == "setValidationData" ? "..." : ex.toHex()}`);
      console.log(`[Official] Transaction`, index, `${ex.method.section.toString()}.${ex.method.method.toString()} found ${!dispatchError ? "✅" : "🟥"} (ref: ${dispatchInfo.weight.refTime.toString().padStart(12)}, pov: ${dispatchInfo.weight.proofSize.toString().padStart(9)})`);

      await lazyApi.rpc.author.submitExtrinsic(ex.toHex()).then((hash) => {
        console.log(`Submitted hash: ${hash}`);
      })
      exts[ex.hash.toHex()] = {
        ex: tx
      }
    }));
    console.log("Ready for block !!!");
    await submitBlock(exts);
  }


  console.log(`Waiting....`);
  onProcessExit();

};



main();
