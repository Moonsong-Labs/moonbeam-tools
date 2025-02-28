import chalk from "chalk";
import fs from "fs/promises";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "src/utils/networks.ts";
import yargs from "yargs";
import { runTask, spawnTask } from "src/utils/runner.ts";
import { blake2AsHex } from "@polkadot/util-crypto";
import { ALITH_PRIVATE_KEY } from "src/utils/constants.ts";
import { getBlockDetails, } from "src/utils/monitoring.ts";
import { TxWithEventAndFee } from "src/utils/types.ts";
import { isAscii, u8aToString, } from "@polkadot/util";

import type { GenericEvent } from "@polkadot/types/generic";

import Debug from "debug";
const debug = Debug("tools:replay-block");

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
      required: true
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
  const originalApiAt = await api.at(originalBlockHash);

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
      console.log(`Disconnecting....`);
      await Promise.all(apis.map((handler) => handler.disconnect()));
      console.log(`Killing....`);
      await Promise.all(processes.map((p) => p.close()));
      console.log(`Closing....`);
      await Promise.all(logHandlers.map((handler) => handler.close()));
      console.log(`Done`);
      process.exit(0);
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
    `--lazy-loading-delay-between-requests 1`,
    `--lazy-loading-max-retries-per-request 0`,
    `--lazy-loading-runtime-override=${argv.runtime}`,
    `--block=${parentHash}`,
    `--alice`,
    `--force-authoring`,
    `--blocks-pruning=archive`,
    `--unsafe-force-node-key-generation`,
    `--sealing=manual`,
  ]

  const logs = [
    `debug`,
    `author-filtering=info`,
    // `basic-authorship=info`,
    `parachain=info,grandpa=info`,
    `netlink=info,sync=info,lib=info,multi=info`,
    `trie=info,parity-db=info,h2=info`,
    `wasm_overrides=info,wasmtime_cranelift=info,wasmtime_jit=info,code-provider=info,wasm-heap=info`,
    `evm=info`,
    `txpool=info`,
    `json=info`,
    `lazy=info`
  ]
  const logParams = logs.length > 0 ? [`--log=${logs.join(",")}`] : [];

  const alithLogs = "./alith.log"
  const alithLogHandler = await fs.open(alithLogs, "w");
  logHandlers.push(alithLogHandler);

  process.stdout.write(`\t - ${chalk.yellow(`${moonbeamBinaryPath}`)}...`);
  const alithProcess = await spawnTask(
    `${moonbeamBinaryPath} ${commonParams.join(" ")} ${lazyParams.join(" ")} ${logParams.join(" ")}`
  );
  process.stdout.write(` ✓\n`);

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
  console.log(`Creating a block to ensure migration is done`);
  await lazyApi.rpc.engine.createBlock(true, false)
  // await lazyApi.rpc.engine.createBlock(true, false);

  const formatExtrinsic = (prefix: string, tx) => {
    if (!tx) {
      return `[${prefix}] Transaction missing`;
    }
    return `[${prefix}] Transaction ${tx.extrinsic.method.section.toString()}.${tx.extrinsic.method.method.toString()} found ${!tx.dispatchError ? "✅" : "🟥"} (ref: ${tx.dispatchInfo.weight.refTime.toString().padStart(12)}, pov: ${tx.dispatchInfo.weight.proofSize.toString().padStart(9)})`;
  }

  const formatEventDiff = (original: GenericEvent, replayed: GenericEvent) => {
    const types = original.typeDef[0];
    console.log(types.namespace);
    for (let index = 0; index < types?.sub?.[0]; index++) {
      console.log(original.data[types.sub[index].name], original.data[types.sub[index].name]);
    }
  }

  const printEvent = (e: any, index: number) => {
    const types = e.typeDef;
    //console.log(`\t\t${e.meta.documentation.toString()}`);
    const lines = e.data.map((data, index) => {
      let line = ` [${types[index].lookupName || types[index].typeName || types[index].namespace || types[index].type }]`;
      let subs = types[index].sub || [];
      if (subs.length > 0) {
        for (let subIndex = 0; subIndex < subs.length; subIndex++) {
          line += `\n\t\t-${subs[subIndex].name}: ${data[subs[subIndex].name]?.toString?.()}`;
        }
      } else {
        line += ` ${data.toString()}`;
      }
      return line;
    }).join(' - ');
    console.log(`\t[${index}] ${e.section.toString()}.${e.method.toString()}\t${lines}`)
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

  const compareExtrinsics = ({ original, replayed }: { original: TxWithEventAndFee, replayed?: TxWithEventAndFee }) => {
    //  compareItem(txA, txB, "  - Error", "dispatchError");
    debug(`[${original.extrinsic.hash.toHex()}] Checking transaction ${original?.fees?.totalFees} vs ${replayed?.fees?.totalFees}`);
    let valid = true;
    const eventsA = original.events || [];
    const eventsB = replayed?.events || [];
    for (let index = 0; index < eventsA.length; index++) {
      const eventA = original ? eventsA[index] : null;
      const eventB = replayed ? eventsB[index] : null;
      debug(`[${original.extrinsic.hash.toHex()}, ${replayed.extrinsic.hash.toHex()}]`, eventA.section, eventA.method, eventB?.section, eventB?.method)
      // debug('     ', eventA?.data?.[0]?.['topics']?.toString?.(), eventB?.data?.[0]?.['topics']?.toString?.())

      if (!eventA || !eventB) {
        valid = false;
      } else if (eventA.eq(eventB)) {
        continue;
      } else if (eventA.method == eventB.method &&
        ((eventA.section == "balances" && eventA.method == "Deposit") ||
          (eventA.section == "system" && eventA.method == "ExtrinsicSuccess"))) {
        continue;
      } else if (eventA.method == eventB.method &&
        eventA.section == "evm" && eventA.method == "Log" && eventA.data[0]['topics'] == "0x793ee8b0d8020fc042a920607e3cbd37f5132c011786c8dd10a685f4414ed381") {
        // This contains timestamp: see https://moonbeam.moonscan.io/tx/0x8c686e819c7656bef9a37421d30cb101218c71fc5608bc76d51656a0992d556a#eventlog
        continue;
      } else if (eventA.method == eventB.method &&
        eventA.section == "evm" && eventA.method == "Log") {
        // This contains timestamp: see https://moonbeam.moonscan.io/tx/0x8c686e819c7656bef9a37421d30cb101218c71fc5608bc76d51656a0992d556a#eventlog
        // console.log(eventA.data[0]['topics'].toString());
      }
      valid = false;
    }

    if (eventsA.length !== replayed?.events?.length) {
      valid = false;
    }
    const ethExecution = eventsB.find((e) => e.section == "ethereum" && e.method == "Executed");
    if (!valid && ethExecution) {
      const extra = isAscii(ethExecution.data[4].toU8a())
        ? u8aToString(ethExecution.data[4].toU8a())
        : ethExecution.data[4].toString()
      if (extra.includes("Transaction too old")) {
        console.log(`[${original.extrinsic.hash.toHex()}] ${chalk.yellow("Skipping")} due to "${extra}"`);
        valid = true;
      }
    }

    if (!valid) {
      console.log(`[${original.extrinsic.hash.toHex()}] Events match: ${valid ? "✅" : `🟥 ${replayed?.events?.length ? '' : 'Missing events'}`}`);
      for (let index = 0; index < Math.max(eventsA.length, eventsB.length); index++) {
        const eventA = eventsA.length > index ? eventsA[index] : null;
        const eventB = eventsB.length > index ? eventsB[index] : null;

        // const simA = mapEventLine(eventA);
        // const simB = mapEventLine(eventB);
        // compareObjects(simA, simB);
        if (!eventA || !eventB || !eventA.eq(eventB)) {
          if (eventA) {
            printEvent(eventA, index);
          }
          if (eventB) {
            printEvent(eventB, index);
          }
        }
      }
    }
    return valid;
  }

  let foundBlock = 0;

  const submitBlock = async (exts) => {
    await lazyApi.rpc.engine.createBlock(true, false);
    const currentBlockNumber = (await lazyApi.rpc.chain.getHeader()).number.toNumber();
    const currentBlockHash = await lazyApi.rpc.chain.getBlockHash(currentBlockNumber);
    const block = await getBlockDetails(lazyApi, currentBlockHash);
    foundBlock++;
    for (const tx of block.txWithEvents) {
      // console.log(`[Lazy] Transaction ${tx.extrinsic.method.section.toString()}.${tx.extrinsic.method.method.toString()} found ${!tx.dispatchError ? "✅" : "🟥"} (ref: ${tx.dispatchInfo.weight.refTime.toString().padStart(12)}, pov: ${tx.dispatchInfo.weight.proofSize.toString().padStart(9)}) [${tx.events.length} events]`);
      if (exts[tx.extrinsic.hash.toHex()]) {
        exts[tx.extrinsic.hash.toHex()].replayed = tx;
      }
    }
    let valid = true;
    for (const hash in exts) {
      debug(formatExtrinsic("Official", exts[hash].ex));
      debug(formatExtrinsic("    Lazy", exts[hash].lazyEx));
      if (!compareExtrinsics(exts[hash])) {
        valid = false;
      }
    }
    console.log(`  - produced Block #${currentBlockNumber} [${block.txWithEvents.length} txs] ${valid ? "✅" : "🟥"}`);
    return valid;
  };
  let blockHash = "";

  while (alive) {
    const exts: { [hash: string]: { original: TxWithEventAndFee, replayed?: TxWithEventAndFee } } = {};
    try {
      const newBlockHash = await api.rpc.chain.getBlockHash(atBlock + foundBlock);
      if (blockHash.toString() == newBlockHash.toString()) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      blockHash = newBlockHash.toString()
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    const blockDetails = await getBlockDetails(api, blockHash);
    console.log(`===========Checking block ${chalk.red(atBlock + foundBlock)} [${blockHash.toString()}] [${blockDetails.txWithEvents.length} txs]==============`);
    await Promise.all(blockDetails.txWithEvents.map(async (tx, index) => {
      const { extrinsic: ex, dispatchInfo, dispatchError } = tx;
      if (!dispatchInfo.class.isNormal) {
        return
      }
      const { method, signature, isSigned, signer, nonce } = ex;
      // console.log(index, `${ex.method.section.toString()}.${ex.method.method.toString()} [${ex.hash.toHex()}]`);
      if (method.section === 'sudo' && method.method.startsWith('sudo')) {
        const apiAt = await api.at(blockHash);
        // Handle sudo extrinsics
        const nestedCall = method.args[0]; // The "call" is the first argument in sudo methods
        const { section, method: nestedMethod, args: nestedArgs } = apiAt.registry.createType('Call', nestedCall);

        debug(`  Nested Call: ${section}.${nestedMethod}`);
        const nestedDecodedArgs = nestedArgs.map((arg: any) => arg.toHuman());
        debug(`  Nested Args: ${JSON.stringify(nestedDecodedArgs, null, 2)}`);
      }
      // debug(`${ex.method.method.toString() == "setValidationData" ? "..." : ex.toHex()}`);
      // debug(`[Official] Transaction`, index, `${ex.method.section.toString()}.${ex.method.method.toString()} found ${!dispatchError ? "✅" : "🟥"} (ref: ${dispatchInfo.weight.refTime.toString().padStart(12)}, pov: ${dispatchInfo.weight.proofSize.toString().padStart(9)})`);

      await lazyApi.rpc.author.submitExtrinsic(ex.toHex()).then((hash) => {
        debug(`Submitted hash: ${hash}`);
      })
      exts[ex.hash.toHex()] = {
        original: tx,
        replayed: null
      }
    }));
    if (!await submitBlock(exts)) {
      console.log(chalk.red(`Found broken block, waiting forever !!`));
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
};



main();
