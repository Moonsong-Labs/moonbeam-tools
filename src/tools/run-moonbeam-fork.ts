// This script is expected to run against a parachain network (using launch.ts script)

import moment from "moment";
import prettyBytes from "pretty-bytes";
import { SingleBar } from "cli-progress";
import { runTask, spawnTask } from "../utils/runner";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "fs";
import { pipeline } from "stream";
import { promisify } from "util";
import yargs from "yargs";
import chalk from "chalk";
import fs from "fs/promises";
import http from "http";
import fetch from "node-fetch";
import path from "path";
import {
  downloadExportedState,
  NetworkName,
  neutralizeExportedState,
} from "../libs/helpers/state-manipulator";
import { ALITH_PRIVATE_KEY } from "../utils/constants";
import ts from "typescript";

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
    "reset-to-genesis": {
      type: "boolean",
      description:
        "Will delete the execution database, setting this will restore network back to genesis state",
      default: false,
    },
    "purge-all": {
      type: "boolean",
      description: "Will delete ALL files at base path, use with caution",
      default: false,
    },
    dev: {
      type: "boolean",
      description: "Will run the network as a single manual-sealed dev node",
      default: false,
    },
    ephemeral: {
      type: "boolean",
      description: "Will close the network immediately after it has completed setup, used for CI.",
      default: false,
    },
    "moonbeam-binary": {
      type: "string",
      alias: "m",
      description: "Binary file path or of the moonbeam node",
      default: "./binaries/moonbeam",
    },
    "polkadot-binary": {
      type: "string",
      alias: "p",
      description: "Binary file path of the polkadot node",
      default: "./binaries/polkadot",
    },
    "polkadot-version": {
      type: "string",
      alias: "pver",
      description: "Client version number for Polkadot binary",
      default: "latest",
    },
    "moonbeam-version": {
      type: "string",
      alias: "mver",
      description: "Client version number for Moonbeam binary",
      default: "latest",
    },
    "base-path": {
      type: "string",
      alias: "bp",
      description: "Where to store the data",
      default: "/tmp/fork-data/",
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
  let polkadotVersion: string;

  if (!argv.dev) {
    const polkadotReleases = await (
      await fetch("https://api.github.com/repos/paritytech/polkadot/releases")
    ).json();

    const latestPolkadotVersion = polkadotReleases.find((release) =>
      release.assets.find((asset) => asset.name === "polkadot")
    ).tag_name;

    // Download new binary if non found, or if existing version doesnt match specified, or if not latest
    if (
      (await fs.access(argv["polkadot-binary"]).catch(() => true)) ||
      ((await runTask(`${argv["polkadot-binary"]} --version`))
        .trim()
        .split(" ")[1]
        .split("-")[0] !== argv["polkadot-version"] &&
        argv["polkadot-version"] !== "latest") ||
      ("v" +
        (await runTask(`${argv["polkadot-binary"]} --version`))
          .trim()
          .split(" ")[1]
          .split("-")[0] !==
        latestPolkadotVersion &&
        argv["polkadot-version"] === "latest")
    ) {
      try {
        const release =
          argv["polkadot-version"] === "latest"
            ? polkadotReleases.find((release) =>
                release.assets.find((asset) => asset.name === "polkadot")
              )
            : polkadotReleases
                .filter((release) => release.tag_name.includes("v" + argv["polkadot-version"]))
                .find((release) => release.assets.find((asset) => asset.name === "polkadot"));

        if (release == null) {
          throw new Error(`Release not found for ${argv["polkadot-version"]}`);
        }
        process.stdout.write(
          `\t - Requested Polkadot ${argv["polkadot-version"]} binary not found, downloading client ....`
        );
        const asset = release.assets.find((asset) => asset.name === "polkadot");
        const response = await fetch(asset.browser_download_url);
        if (!response.ok) {
          throw new Error(`unexpected response ${response.statusText}`);
        }
        await fs.writeFile(argv["polkadot-binary"], response.body);
        await fs.chmod(argv["polkadot-binary"], "755");
        process.stdout.write(` ${chalk.green("done")} ✓\n`);
      } catch (e) {
        console.error(e);
        throw new Error("Error downloading polkadot-binary");
      }
    }

    process.stdout.write(`\t - Checking polkadot binary...`);
    polkadotVersion = (await runTask(`${argv["polkadot-binary"]} --version`)).trim();
    process.stdout.write(` ${chalk.green(polkadotVersion.trim())} ✓\n`);
  }

  const moonbeamReleases = await (
    await fetch("https://api.github.com/repos/purestake/moonbeam/releases")
  ).json();

  const latestMoonbeamVersion = moonbeamReleases.find((release) =>
    release.assets.find((asset) => asset.name === "moonbeam")
  ).tag_name;

  // Download new binary if: none found, or if existing version doesnt match requested, or newer latest available
  if (
    (await fs.access(argv["moonbeam-binary"]).catch(() => true)) ||
    ((await runTask(`${argv["moonbeam-binary"]} --version`)).trim().split(" ")[1].split("-")[0] !==
      argv["moonbeam-version"] &&
      argv["moonbeam-version"] !== "latest") ||
    ("v" +
      (await runTask(`${argv["moonbeam-binary"]} --version`)).trim().split(" ")[1].split("-")[0] !==
      latestMoonbeamVersion &&
      argv["moonbeam-version"] === "latest")
  ) {
    try {
      const release =
        argv["moonbeam-version"] === "latest"
          ? moonbeamReleases.find((release) =>
              release.assets.find((asset) => asset.name === "moonbeam")
            )
          : moonbeamReleases
              .filter((release) => release.tag_name.includes("v" + argv["moonbeam-version"]))
              .find((release) => release.assets.find((asset) => asset.name === "moonbeam"));

      if (release == null) {
        throw new Error(`Release not found for ${argv["moonbeam-version"]}`);
      }
      process.stdout.write(
        `\t - Requested Moonbeam ${argv["moonbeam-version"]} binary not found, downloading client ....`
      );
      const asset = release.assets.find((asset) => asset.name === "moonbeam");
      const response = await fetch(asset.browser_download_url);
      if (!response.ok) {
        throw new Error(`unexpected response ${response.statusText}`);
      }
      await fs.writeFile(argv["moonbeam-binary"], response.body);
      await fs.chmod(argv["moonbeam-binary"], "755");
      process.stdout.write(` ${chalk.green("done")} ✓\n`);
    } catch (e) {
      console.error(e);
      throw new Error("Error downloading moonbeam-binary");
    }
  }

  process.stdout.write(`\t - Checking moonbeam binary...`);
  const moonbeamVersion = (await runTask(`${argv["moonbeam-binary"]} --version`)).trim();
  process.stdout.write(` ${chalk.green(moonbeamVersion.trim())} ✓\n`);

  if (argv["purge-all"]) {
    await fs.rm(argv["base-path"], { recursive: true, force: true });
    process.stdout.write(
      `\t - ${chalk.red(`Purged`)} all local files at:  ${argv["base-path"]} ✓\n`
    );
  }

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
    await neutralizeExportedState(stateFile, modFile, argv.dev);
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

  let relayRawSpecFile: string;
  if (!argv.dev) {
    const parachainCode = (await fs.readFile(codeFile)).toString();
    const genesisState = (await fs.readFile(genesisStateFile)).toString();

    const relayPlainSpecFile = path.join(
      argv["base-path"],
      `rococo-${argv.network}-${polkadotVersion.replace(" ", "-")}-local-plain.json`
    );
    // if (argv["purge-specs"]) {
    //   process.stdout.write(`\t - ${chalk.red(`purging`)} relay spec... ${relayPlainSpecFile}\n`);
    //   await fs.rm(relayPlainSpecFile, { recursive: true });
    // }
    process.stdout.write(`\t - Checking relaychain plain spec file...`);
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

      process.stdout.write(`\t\t - Including parachain ${paraId} in relaychain plain specs...`);
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
    relayRawSpecFile = path.join(
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
  }

  const baseDataFolder = path.join(argv["base-path"], `${argv.network}`);
  if (argv["reset-to-genesis"]) {
    process.stdout.write(`\t - ${chalk.red(`Purging`)} node db... ${baseDataFolder}\n`);
    await fs.rm(baseDataFolder, { recursive: true, force: true });
  }

  let aliceProcess: ChildProcessWithoutNullStreams;
  let aliceLogHandler: fs.FileHandle;
  let bobProcess: ChildProcessWithoutNullStreams;
  let bobLogHandler: fs.FileHandle;

  if (!argv.dev) {
    process.stdout.write(`\t - ${chalk.yellow(`Starting`)} relay nodes...\n`);
    process.stdout.write(`\t\t - ${chalk.green(`Starting`)} Alice node...\n`);
    const aliceFolder = path.join(baseDataFolder, `relay-alice`);
    const aliceLogs = path.join(aliceFolder, `alice.log`);
    process.stdout.write(`\t\t - ${chalk.yellow(`Logs`)}: ${aliceLogs}`);
    await fs.mkdir(aliceFolder, { recursive: true });
    aliceLogHandler = await fs.open(aliceLogs, "w");
    aliceProcess = await spawnTask(
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
    bobLogHandler = await fs.open(bobLogs, "w");
    bobProcess = await spawnTask(
      `${
        argv["polkadot-binary"]
      } --base-path ${bobFolder} --bob --chain ${relayRawSpecFile} --rpc-port 11002 --ws-port 12002 --port 10002  --node-key ${
        Object.keys(NODE_KEYS)[1]
      } --validator`
    );
    process.stdout.write(` ✓\n`);
  }

  process.stdout.write(`\t - ${chalk.yellow(`Starting`)} parachain nodes...\n`);
  process.stdout.write(`\t\t - ${chalk.green(`Starting`)} Alith node... \n`);
  const alithFolder = path.join(baseDataFolder, `para-alith`);
  const alithLogs = path.join(alithFolder, `alith.log`);
  process.stdout.write(`\t\t - ${chalk.yellow(`Logs`)}: ${alithLogs}`);
  await fs.mkdir(alithFolder, { recursive: true });
  const alithLogHandler = await fs.open(alithLogs, "w");
  const alithProcess = argv.dev
    ? await spawnTask(
        `${argv["moonbeam-binary"]} --base-path ${alithFolder} --execution native --log=info,netlink=info,sync=info,lib=info,multi=info --alice --collator --db-cache 5000 --trie-cache-size 0 --chain ${modFile} --no-hardware-benchmarks --no-prometheus --no-telemetry --sealing=manual`
      )
    : await spawnTask(
        `${
          argv["moonbeam-binary"]
        } --base-path ${alithFolder} --execution native --log=debug,netlink=info,sync=info,lib=info,multi=info --alice --collator --db-cache 5000 --trie-cache-size 0 --chain ${modFile} --  --chain ${relayRawSpecFile} --rpc-port 11003 --ws-port 12003 --port 10003 --node-key ${
          Object.keys(NODE_KEYS)[2]
        }`
      );
  process.stdout.write(` ✓\n`);

  const exitPromises = [
    new Promise<void>((resolve) => {
      alithProcess.stderr.pipe(alithProcess.stdout.pipe(alithLogHandler.createWriteStream()));
      alithProcess.on("exit", () => {
        console.log(`${chalk.red(`parachain alith`)} is closed.`);
        resolve();
      });
      process.on("exit", () => {
        try {
          alithProcess.kill();
        } catch (e) {}
      });
    }),
  ];

  if (!argv.dev) {
    exitPromises.push(
      new Promise<void>((resolve) => {
        // aliceProcess.stderr.on("data", (d) => console.log(d.toString()));
        aliceProcess.stderr.pipe(aliceProcess.stdout.pipe(aliceLogHandler.createWriteStream()));
        aliceProcess.on("exit", () => {
          console.log(`${chalk.red(`relay alice`)} is closed.`);
          resolve();
        });
        process.on("exit", () => {
          try {
            aliceProcess.kill();
          } catch (e) {}
        });
      }),
      new Promise<void>((resolve) => {
        // bobProcess.stderr.on("data", (d) => console.log(d.toString()));
        bobProcess.stderr.pipe(bobProcess.stdout.pipe(bobLogHandler.createWriteStream()));
        bobProcess.on("exit", () => {
          console.log(`${chalk.red(`relay bob`)} is closed.`);
          resolve();
        });
        process.on("exit", () => {
          try {
            bobProcess.kill();
          } catch (e) {}
        });
      })
    );
  }

  process.stdout.write(`\t - ${chalk.yellow(`Waiting`)}...(5-10min)`);
  while (
    (await runTask(`egrep -o '(Accepting|Running JSON-RPC)' ${alithLogs} || echo "no"`)).trim()
      .length < 4
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write(` ✓\n`);

  if (!argv.dev) {
    process.stdout.write(
      `\tℹ️  RelayChain Explorer: https://polkadot.js.org/apps/?rpc=ws://127.0.0.1:12003#/explorer\n`
    );
  }
  process.stdout.write(
    `\tℹ️  ParaChain Explorer: https://polkadot.js.org/apps/?rpc=ws://127.0.0.1:9944#/explorer\n`
  );
  process.stdout.write(`      Sudo: ${chalk.green("Alith")} ${ALITH_PRIVATE_KEY}\n`);
  process.stdout.write(`Council/TC: ${chalk.green("Alith")} ${ALITH_PRIVATE_KEY}\n`);

  if (!argv.ephemeral) {
    await Promise.race(exitPromises);
  }

  await Promise.all([
    !argv.dev && aliceLogHandler.close(),
    !argv.dev && bobLogHandler.close(),
    alithLogHandler.close(),
  ]);
  await Promise.all([
    !argv.dev && aliceProcess.kill(),
    !argv.dev && bobProcess.kill(),
    alithProcess.kill(),
  ]);
  console.log(`Done`);
};

main();
