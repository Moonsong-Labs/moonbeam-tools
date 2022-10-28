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
    "moonbeam-binary": {
      type: "string",
      alias: "m",
      description: "Binary of the moonbeam node",
      demandOption: true,
    },
    "polkadot-binary": {
      type: "string",
      alias: "p",
      description: "Binary of the polkadot node",
      demandOption: true,
    },
    "base-path": {
      type: "string",
      description: "Where to store the data",
      demandOption: true,
    },
  }).argv;

const NODE_KEYS = {
  "1111111111111111111111111111111111111111111111111111111111111111":
    "12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz",
  "2222222222222222222222222222222222222222222222222222222222222222":
    "12D3KooWLdJAwPtyQ5RFnr9wGXsQzpf3P2SeqFbYkqbfVehLu4Ns",
  "3333333333333333333333333333333333333333333333333333333333333333":
    "12D3KooWBRFW3HkJCLKSWb4yG6iWRBpgNjbM4FFvNsL5T5JKTqrd",
};
const bootNodes = Object.values(NODE_KEYS)
  .slice(0, 3)
  .map((peerId, index) => `/ip4/127.0.0.1/tcp/1000${index + 1}/p2p/${peerId}`);

const main = async () => {
  // Variable to allow replaying some following steps if previous steps have been modified
  let hasChanged = false;

  if (!argv["polkadot-binary"] || (await fs.access(argv["polkadot-binary"]).catch(() => false))) {
    throw new Error("Missing polkadot-binary");
  }
  process.stdout.write(`\t - Checking polkadot binary...`);
  const polkadotVersion = (await runTask(`${argv["polkadot-binary"]} --version`)).trim();
  process.stdout.write(` ${chalk.green(polkadotVersion.trim())} ✓\n`);

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
    await neutralizeExportedState(stateFile, modFile);
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

  const parachainCode = (await fs.readFile(codeFile)).toString();
  const genesisState = (await fs.readFile(genesisStateFile)).toString();

  process.stdout.write(`\t - Checking relaychain plain spec file...`);
  const relayPlainSpecFile = path.join(
    argv["base-path"],
    `rococo-${argv.network}-${polkadotVersion.replace(" ", "-")}-local-plain.json`
  );
  if (
    !(await fs
      .access(relayPlainSpecFile)
      .then(() => true)
      .catch(() => false)) ||
    hasChanged
  ) {
    hasChanged = true;
    process.stdout.write(` ${chalk.yellow(`generating`)}...`);
    await runTask(
      `${argv["polkadot-binary"]} build-spec --chain rococo-local --disable-default-bootnode > ${relayPlainSpecFile}`
    );
    process.stdout.write(` ✓\n`);

    process.stdout.write(`\t   - Including parachain ${paraId} in relaychain plain specs...`);
    let relayChainSpec = JSON.parse((await fs.readFile(relayPlainSpecFile)).toString());
    relayChainSpec.bootNodes = bootNodes;
    relayChainSpec.genesis.runtime.runtime_genesis_config.paras = [
      [
        [
          paraId,
          {
            genesis_head: genesisState,
            validation_code: parachainCode,
            parachain: true,
          },
        ],
      ],
    ];
    await fs.writeFile(relayPlainSpecFile, JSON.stringify(relayChainSpec, null, 2));
    process.stdout.write(` ✓\n`);
    process.stdout.write(`\t - ${chalk.yellow(`Saving`)} plain relaychain spec...`);
  }
  process.stdout.write(` ${chalk.green(relayPlainSpecFile)} ✓\n`);

  process.stdout.write(`\t - Checking relaychain raw spec file...`);
  const relayRawSpecFile = path.join(
    argv["base-path"],
    `rococo-${argv.network}-${polkadotVersion.replace(" ", "-")}-local-raw.json`
  );
  if (
    !(await fs
      .access(relayRawSpecFile)
      .then(() => true)
      .catch(() => false)) ||
    hasChanged
  ) {
    hasChanged = true;
    process.stdout.write(` ${chalk.yellow(`generating`)}...`);
    await runTask(
      `${argv["polkadot-binary"]} build-spec --raw --chain ${relayPlainSpecFile} > ${relayRawSpecFile}`
    );
    process.stdout.write(` ✓\n`);
    process.stdout.write(`\t - ${chalk.yellow(`Saving`)} raw relaychain spec...`);
  }
  process.stdout.write(` ${chalk.green(relayRawSpecFile)} ✓\n`);

  process.stdout.write(`\t - ${chalk.yellow(`Starting`)} relay nodes...\n`);

  const baseDataFolder = path.join(argv["base-path"], `${argv.network}`);
  if (argv.purge) {
    await fs.rm(baseDataFolder, { recursive: true });
  }

  process.stdout.write(`\t\t - ${chalk.green(`Starting`)} Alice node...\n`);
  const aliceFolder = path.join(baseDataFolder, `relay-alice`);
  const aliceLogs = path.join(aliceFolder, `alice.log`);
  process.stdout.write(`\t\t - ${chalk.yellow(`Logs`)}: ${aliceLogs}`);
  await fs.mkdir(aliceFolder, { recursive: true });
  const aliceLogHandler = await fs.open(aliceLogs, "w");
  const aliceProcess = await spawnTask(
    `${
      argv["polkadot-binary"]
    } --base-path ${aliceFolder} --alice --chain ${relayRawSpecFile} --rpc-port 11001 --ws-port 12001 --port 10001 --node-key ${
      Object.keys(NODE_KEYS)[0]
    } --validator`
  );
  process.stdout.write(` ✓\n`);
  process.stdout.write(`\t\t - ${chalk.green(`Starting`)} Bob node...\n`);
  const bobFolder = path.join(baseDataFolder, `relay-bob`);
  const bobLogs = path.join(bobFolder, `bob.log`);
  process.stdout.write(`\t\t - ${chalk.yellow(`Logs`)}: ${bobLogs}`);
  await fs.mkdir(bobFolder, { recursive: true });
  const bobLogHandler = await fs.open(bobLogs, "w");
  const bobProcess = await spawnTask(
    `${
      argv["polkadot-binary"]
    } --base-path ${bobFolder} --bob --chain ${relayRawSpecFile} --rpc-port 11002 --ws-port 12002 --port 10002  --node-key ${
      Object.keys(NODE_KEYS)[1]
    } --validator`
  );
  process.stdout.write(` ✓\n`);

  process.stdout.write(`\t - ${chalk.yellow(`Starting`)} parachain nodes...\n`);
  process.stdout.write(`\t\t - ${chalk.green(`Starting`)} Alith node...\n`);
  const alithFolder = path.join(baseDataFolder, `para-alith`);
  const alithLogs = path.join(alithFolder, `alith.log`);
  process.stdout.write(`\t\t - ${chalk.yellow(`Logs`)}: ${alithLogs}`);
  await fs.mkdir(alithFolder, { recursive: true });
  const alithLogHandler = await fs.open(alithLogs, "w");
  const alithProcess = await spawnTask(
    `${
      argv["moonbeam-binary"]
    } --base-path ${alithFolder} --alice --collator  --chain ${modFile} --  --chain ${relayRawSpecFile} --rpc-port 11003 --ws-port 12003 --port 10003 --node-key ${
      Object.keys(NODE_KEYS)[2]
    }`
  );
  process.stdout.write(` ✓\n`);

  process.stdout.write(`https://polkadot.js.org/apps/?rpc=ws://127.0.0.1:9944#/explorer\n`)

  await Promise.race([
    new Promise<void>((resolve) => {
      // aliceProcess.stderr.on("data", (d) => console.log(d.toString()));
      aliceProcess.stderr.pipe(aliceProcess.stdout.pipe(aliceLogHandler.createWriteStream()));
      aliceProcess.on("exit", () => {
        console.log(`Unexpected closure ${chalk.red(`relay alice`)}`);
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      // bobProcess.stderr.on("data", (d) => console.log(d.toString()));
      bobProcess.stderr.pipe(bobProcess.stdout.pipe(bobLogHandler.createWriteStream()));
      bobProcess.on("exit", () => {
        console.log(`Unexpected closure ${chalk.red(`relay bob`)}`);
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      alithProcess.stderr.pipe(alithProcess.stdout.pipe(alithLogHandler.createWriteStream()));
      alithProcess.on("exit", () => {
        console.log(`Unexpected closure ${chalk.red(`parachain alith`)}`);
        resolve();
      });
    }),
  ]);

  await Promise.all([aliceLogHandler.close(), bobLogHandler.close(), alithLogHandler.close()]);
  await Promise.all([aliceProcess.kill(), bobProcess.kill(), alithProcess.kill()]);
  console.log(`Done`);
};

main();
