// This script is expected to run against a parachain network (using launch.ts script)

import moment from "moment";
import prettyBytes from "pretty-bytes";
import { SingleBar } from "cli-progress";
import { runTask, spawnTask } from "../utils/runner";
import yargs from "yargs";
import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import {
  downloadExportedState,
  NetworkName,
  neutralizeExportedState,
} from "../libs/helpers/state-manipulator";
import {  ALITH_PRIVATE_KEY } from "../utils/constants";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    network: {
      type: "string",
      alias: "n",
      description: "Network to retrieve the exported state for",
      demandOption: true,
    },
    latest: {
      type: "boolean",
      description: "Will verify if a latest snapshot is available and download it",
      default: false,
    },
    purge: {
      type: "boolean",
      description: "Will delete previous execution database",
      default: false,
    },
    "purge-specs": {
      type: "boolean",
      description: "Will delete previous generated specs",
      default: false,
    },
    "moonbeam-binary": {
      type: "string",
      alias: "m",
      description: "Binary file path or of the moonbeam node",
      demandOption: true,
    },
    "polkadot-binary": {
      type: "string",
      alias: "p",
      description: "Binary file path of the polkadot node",
      demandOption: true,
    },
    "base-path": {
      type: "string",
      description: "Where to store the data",
      demandOption: true,
    },
  }).argv;

// const NODE_KEYS = {
//   "1111111111111111111111111111111111111111111111111111111111111111":
//     "12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz",
//   "2222222222222222222222222222222222222222222222222222222222222222":
//     "12D3KooWLdJAwPtyQ5RFnr9wGXsQzpf3P2SeqFbYkqbfVehLu4Ns",
//   "3333333333333333333333333333333333333333333333333333333333333333":
//     "12D3KooWBRFW3HkJCLKSWb4yG6iWRBpgNjbM4FFvNsL5T5JKTqrd",
// };
// const bootNodes = Object.values(NODE_KEYS)
//   .slice(0, 3)
//   .map((peerId, index) => `/ip4/127.0.0.1/tcp/1000${index + 1}/p2p/${peerId}`);

const main = async () => {
  // Variable to allow replaying some following steps if previous steps have been modified
  let hasChanged = false;

  if (!argv["moonbeam-binary"] || (await fs.access(argv["moonbeam-binary"]).catch(() => false))) {
    throw new Error("Missing moonbeam-binary");
  }
  process.stdout.write(`\t - Checking moonbeam binary...`);
  const moonbeamVersion = (await runTask(`${argv["moonbeam-binary"]} --version`)).trim();
  process.stdout.write(` ${chalk.green(moonbeamVersion.trim())} ✓\n`);

  process.stdout.write(`\t - Checking exported state...`);

  let progressBar: SingleBar;
  const { file: stateFile, blockNumber } = await downloadExportedState(
    argv.network as NetworkName,
    argv["base-path"],
    argv.latest,
    (length) => {
      process.stdout.write(`${chalk.yellow(`Downloading`)}\n`);
      progressBar = new SingleBar({
        etaAsynchronousUpdate: true,
        fps: 5,
        etaBuffer: 100,
        format:
          "CLI Progress |" +
          chalk.yellow("{bar}") +
          "| {percentage}% | {eta_formatted} || {value}/{total}",
        formatTime: (value) => moment.duration(value * 1000).humanize(),
        formatValue: (value) => (value <= 100 ? value : prettyBytes(parseInt(value))),
      });
      hasChanged = true;
      progressBar.start(length, 0);
    },
    (bytes) => {
      progressBar.update(bytes);
    },
    () => {
      progressBar.stop();
      process.stdout.write(`\t - ${chalk.yellow(`Saving`)} ${argv.network} exported state...`);
    }
  );
  process.stdout.write(` ${chalk.green(stateFile)} (#${chalk.yellow(blockNumber)}) ✓\n`);

  process.stdout.write(`\t - Checking parachain id...`);
  const paraId = parseInt(
    await runTask(`head -100 ${stateFile} | grep paraId  | cut -c 12- | rev | cut -c 2- | rev`)
  );
  process.stdout.write(` ${chalk.green(paraId)} ✓\n`);

  process.stdout.write(`\t - Checking customized state...`);
  const modFile = stateFile.replace(/.json$/, ".mod.json");
  if (
    !(await fs
      .access(modFile)
      .then(() => true)
      .catch(() => false)) ||
    hasChanged
  ) {
    hasChanged = true;
    process.stdout.write(` ${chalk.yellow(`generating`)} (3min)...`);
    await neutralizeExportedState(stateFile, modFile, true);
    process.stdout.write(` ✓\n`);
  }
  process.stdout.write(` ${chalk.green(modFile)} ✓\n`);

  process.stdout.write(`\t - Checking parachain wasm code...`);
  const codeFile = path.join(argv["base-path"], `${argv.network}.code`);
  if (
    !(await fs
      .access(codeFile)
      .then(() => true)
      .catch(() => false)) ||
    hasChanged
  ) {
    hasChanged = true;
    process.stdout.write(` ${chalk.yellow(`extracting`)}...`);
    const grepLine = await runTask(
      `grep '        "0x3a636f6465"' ${stateFile} | cut -c 26- | rev | cut -c 3- | rev | tr -d '\n' | tee ${codeFile} | wc -c`
    );
    process.stdout.write(` ${prettyBytes(parseInt(grepLine) / 2)} ✓\n`);
    process.stdout.write(`\t - ${chalk.yellow(`Saving`)} wasm code...`);
  }
  process.stdout.write(` ${chalk.green(codeFile)} ✓\n`);

  process.stdout.write(`\t - Checking parachain genesis...`);
  const genesisStateFile = path.join(argv["base-path"], `${argv.network}.genesis.state`);
  if (
    !(await fs
      .access(genesisStateFile)
      .then(() => true)
      .catch(() => false)) ||
    hasChanged
  ) {
    hasChanged = true;
    process.stdout.write(` ${chalk.yellow(`exporting`)}...`);
    await runTask(
      `${argv["moonbeam-binary"]} export-genesis-state --chain ${modFile} | tee ${genesisStateFile}`
    );
  }
  process.stdout.write(` ${chalk.green(genesisStateFile)} ✓\n`);

  const baseDataFolder = path.join(argv["base-path"], `${argv.network}`);
  if (argv.purge) {
    process.stdout.write(`\t - ${chalk.red(`purging`)} node db... ${baseDataFolder}\n`);
    await fs.rm(baseDataFolder, { recursive: true, force: true });
  }

  process.stdout.write(`\t - ${chalk.yellow(`Starting`)} parachain nodes...\n`);
  process.stdout.write(`\t\t - ${chalk.green(`Starting`)} Alith node... \n`);
  const alithFolder = path.join(baseDataFolder, `para-alith`);
  const alithLogs = path.join(alithFolder, `alith.log`);
  process.stdout.write(`\t\t - ${chalk.yellow(`Logs`)}: ${alithLogs}`);
  await fs.mkdir(alithFolder, { recursive: true });
  const alithLogHandler = await fs.open(alithLogs, "w");
  const alithProcess = await spawnTask(
    `${
      argv["moonbeam-binary"]
    } --base-path ${alithFolder} --execution native --log=info,netlink=info,sync=info,lib=info,multi=info --alice --collator --db-cache 5000 --trie-cache-size 0 --chain ${
      modFile
    } --rpc-port 19101 --ws-port 19102 --no-hardware-benchmarks --no-prometheus --no-telemetry`
  );
  process.stdout.write(` ✓\n`);

  const exitPromises = [
    new Promise<void>((resolve) => {
      alithProcess.stderr.pipe(alithProcess.stdout.pipe(alithLogHandler.createWriteStream()));
      alithProcess.on("exit", () => {
        console.log(`Unexpected closure ${chalk.red(`parachain alith`)}`);
        resolve();
      });
      process.on("exit", () => {
        try {
          alithProcess.kill();
        } catch (e) {}
      });
    }),
  ];

  process.stdout.write(`\t - ${chalk.yellow(`Waiting`)}...(5-10min)`);
  while (
    (await runTask(`egrep -o '(Accepting|Running JSON-RPC)' ${alithLogs} || echo "no"`)).trim()
      .length < 4
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write(` ✓\n`);

  process.stdout.write(`\tℹ️  Polkadot.js Explorer: https://polkadot.js.org/apps/?rpc=ws://127.0.0.1:19102#/explorer\n`);
  process.stdout.write(`      Sudo: ${chalk.green("Alith")} ${ALITH_PRIVATE_KEY}\n`);
  process.stdout.write(`Council/TC: ${chalk.green("Alith")} ${ALITH_PRIVATE_KEY}\n`);

  await Promise.race(exitPromises);

  await Promise.all([alithLogHandler.close()]);
  await Promise.all([alithProcess.kill()]);
  console.log(`Done`);
};

main();
