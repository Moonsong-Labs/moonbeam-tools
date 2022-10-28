// This script is expected to run against a parachain network (using launch.ts script)

import moment from "moment";
import prettyBytes from "pretty-bytes";
import { SingleBar } from "cli-progress";
import { runTask } from "../utils/runner";
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
  .map((peerId, key) => `/ip4/127.0.0.1/tcp/10001/p2p/${peerId}`);

const main = async () => {
  if (!argv["polkadot-binary"] || (await fs.access(argv["polkadot-binary"]).catch(() => false))) {
    throw new Error("Missing polkadot-binary");
  }
  process.stdout.write(`\t - Checking polkadot binary...`);
  const polkadotVersion = await runTask(`${argv["polkadot-binary"]} --version`);
  process.stdout.write(` ${chalk.green(polkadotVersion.trim())} ✓\n`);

  if (!argv["moonbeam-binary"] || (await fs.access(argv["moonbeam-binary"]).catch(() => false))) {
    throw new Error("Missing moonbeam-binary");
  }
  process.stdout.write(`\t - Checking moonbeam binary...`);
  const moonbeamVersion = await runTask(`${argv["moonbeam-binary"]} --version`);
  process.stdout.write(` ${chalk.green(moonbeamVersion.trim())} ✓\n`);

  process.stdout.write(`\t - Checking exported state...`);

  let progressBar: SingleBar;
  const file = await downloadExportedState(
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
  process.stdout.write(` ${chalk.green(file)} ✓\n`);

  process.stdout.write(`\t - Checking parachain id...`);
  const paraId = parseInt(
    await runTask(`head -100 ${file} | grep paraId  | cut -c 12- | rev | cut -c 2- | rev`)
  );
  process.stdout.write(` ${chalk.green(paraId)} ✓\n`);

  process.stdout.write(`\t - Checking customized state...`);
  const modFile = file.replace(/.json$/, ".mod.json");
  if (
    !(await fs
      .access(modFile)
      .then(() => true)
      .catch(() => false))
  ) {
    process.stdout.write(` ${chalk.yellow(`generating`)} (3min)...`);
    await neutralizeExportedState(file, modFile);
    process.stdout.write(` ✓\n`);
  }
  process.stdout.write(` ${chalk.green(modFile)} ✓\n`);

  process.stdout.write(`\t - Checking parachain wasm code...`);
  const codeFile = path.join(argv["base-path"], `${argv.network}.code`);
  if (
    !(await fs
      .access(codeFile)
      .then(() => true)
      .catch(() => false))
  ) {
    process.stdout.write(` ${chalk.yellow(`extracting`)}...`);
    const grepLine = await runTask(
      `grep '        "0x3a636f6465"' ${modFile} | cut -c 26- | rev | cut -c 3- | rev | tr -d '\n' | tee ${codeFile} | wc -c`
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
      .catch(() => false))
  ) {
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
    `rococo-${argv.network}-local-plain.json`
  );
  if (
    !(await fs
      .access(relayPlainSpecFile)
      .then(() => true)
      .catch(() => false))
  ) {
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
  const relayRawSpecFile = path.join(argv["base-path"], `rococo-${argv.network}-local-raw.json`);
  if (
    !(await fs
      .access(relayRawSpecFile)
      .then(() => true)
      .catch(() => false))
  ) {
    process.stdout.write(` ${chalk.yellow(`generating`)}...`);
    await runTask(
      `${argv["polkadot-binary"]} build-spec --chain ${relayPlainSpecFile} > ${relayRawSpecFile}`
    );
    process.stdout.write(` ✓\n`);
    process.stdout.write(`\t - ${chalk.yellow(`Saving`)} raw relaychain spec...`);
  }
  process.stdout.write(` ${chalk.green(relayRawSpecFile)} ✓\n`);
};

main();
