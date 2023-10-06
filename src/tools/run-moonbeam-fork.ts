// This script is expected to run against a parachain network (using launch.ts script)

import moment from "moment";
import prettyBytes from "pretty-bytes";
import { SingleBar } from "cli-progress";
import { runTask, spawnTask } from "../utils/runner";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import semver from "semver";
import yargs from "yargs";
import chalk from "chalk";
import fs from "fs/promises";
import fetch from "node-fetch";
import path from "path";
import {
  downloadExportedState,
  NetworkName,
  neutralizeExportedState,
} from "../libs/helpers/state-manipulator";
import { ALITH_PRIVATE_KEY } from "../utils/constants";
import inquirer from "inquirer";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("2.0.0")
  .options({
    network: {
      type: "string",
      alias: "n",
      description: "Network to retrieve the exported state for.",
      demandOption: true,
    },
    latest: {
      type: "boolean",
      alias: "l",
      description: "Verifies if a more recent state snapshot is able to download.",
      default: false,
    },
    "reset-to-genesis": {
      type: "boolean",
      alias: "r",
      description: "Resets the network back to the initial state at genesis block.",
      default: false,
    },
    "purge-all": {
      type: "boolean",
      alias: "k",
      description: "Removes ALL files at the base-path directory, use with CAUTION.",
      default: false,
    },
    "smaller-state": {
      type: "boolean",
      description: "Downloads the smaller state version (without super heavy contracts)",
      default: true,
    },
    sealing: {
      type: "string",
      alias: "s",
      description:
        "Specify block sealing strategy for the forked chain when running a development node (i.e. only works with --dev/-d).",
      default: "manual",
    },
    regenerate: {
      type: "boolean",
      alias: "g",
      description: "Creates a new genesis file based on state manipulators.",
      default: false,
    },
    dev: {
      type: "boolean",
      description: "Runs network as a single manual-sealed development node.",
      default: false,
      alias: "d",
    },
    ephemeral: {
      type: "boolean",
      alias: "t",
      description: "Closes network immediately after it has completed setup, used for CI.",
      default: false,
    },
    "moonbeam-binary": {
      type: "string",
      alias: "m",
      description:
        "Absolute file path (e.g. /tmp/fork-chain/moonbeam) of moonbeam binary OR version number (e.g. 0.31) to download.",
      default: "latest",
    },
    "polkadot-binary": {
      type: "string",
      alias: "p",
      description:
        "Absolute file path (e.g. /tmp/fork-chain/polkadot) of polkadot binary OR version number (e.g. 0.9.28) to download.",
      default: "latest",
    },
    "base-path": {
      type: "string",
      alias: "o",
      description: "Specifies where all generated files are to be stored.",
      default: "/tmp/fork-data/",
    },
    "relay-chain": {
      type: "string",
      description: "Relay chain to use.",
      default: "rococo-local",
    },
    "authorize-upgrade": {
      type: "string",
      description: "Hash of the runtime to authorize for upgrade",
    },
    "trie-cache-size": {
      type: "string",
      description: "Size of internal state cache. ",
      default: 0,
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
  if (argv["purge-all"]) {
    const answer = await inquirer.prompt({
      name: "confirm",
      type: "confirm",
      message: `Are you sure you want to run this script with ${chalk.bgWhiteBright.blackBright(
        "purge-all"
      )} enabled? \n This will delete ${chalk.bgWhiteBright.blackBright(
        "all"
      )} files in the base-path directory: ${argv["base-path"]}.`,
    });

    if (!answer.confirm) {
      console.log("Goodbye! 👋");
      return;
    }
  }

  // Variable to allow replaying some following steps if previous steps have been modified
  let hasChanged = false;
  let polkadotVersion: string;
  let polkadotBinaryPath: string;
  if (!argv.dev) {
    const polkadotReleases = (await (
      await fetch("https://api.github.com/repos/paritytech/polkadot/releases")
    ).json()) as any;

    const latestPolkadotVersion = polkadotReleases.find((release: any) =>
      release.assets.find((asset: any) => asset.name === "polkadot")
    ).tag_name;

    // Ensure the binaries folder is there
    await fs.mkdir("./binaries", { recursive: true });

    polkadotBinaryPath = path.isAbsolute(argv["polkadot-binary"])
      ? argv["polkadot-binary"]
      : "./binaries/polkadot";

    // Download binary if:
    // 1) Absolute binary path hasn't been supplied
    // 2) Binary doesn't exist in default location
    // 3) Existing binary doesn't match requested version
    if (
      !path.isAbsolute(argv["polkadot-binary"]) &&
      ((await fs.access("./binaries/polkadot").catch(() => true)) ||
        (argv["polkadot-binary"] !== "latest" &&
          semver.compare(
            semver.valid(semver.coerce(await runTask(`${polkadotBinaryPath} --version`))) || "",
            semver.valid(semver.coerce(argv["polkadot-binary"]))
          ) !== 0) ||
        (argv["polkadot-binary"] === "latest" &&
          semver.valid(semver.coerce(await runTask(`${polkadotBinaryPath} --version`))) !==
            semver.clean(latestPolkadotVersion)))
    ) {
      try {
        const release =
          argv["polkadot-binary"] === "latest"
            ? polkadotReleases.find((release) =>
                release.assets.find((asset) => asset.name === "polkadot")
              )
            : polkadotReleases
                .filter((release) => release.tag_name.includes("v" + argv["polkadot-binary"]))
                .find((release) => release.assets.find((asset) => asset.name === "polkadot"));

        if (release == null) {
          throw new Error(`Release not found for ${argv["polkadot-binary"]}`);
        }
        process.stdout.write(
          `\t - Requested Polkadot ${argv["polkadot-binary"]} binary not found, downloading client ....`
        );
        const asset = release.assets.find((asset) => asset.name === "polkadot");
        const response = await fetch(asset.browser_download_url);
        if (!response.ok) {
          throw new Error(`unexpected response ${response.statusText}`);
        }
        await fs.writeFile(polkadotBinaryPath, response.body);
        await fs.chmod(polkadotBinaryPath, "755");
        process.stdout.write(` ${chalk.green("done")} ✓\n`);
      } catch (e) {
        console.error(e);
        throw new Error("Error downloading polkadot-binary");
      }
    }

    process.stdout.write(`\t - Checking polkadot binary...`);
    polkadotVersion = (await runTask(`${polkadotBinaryPath} --version`)).trim();
    process.stdout.write(` ${chalk.green(polkadotVersion.trim())} ✓\n`);
  }

  const moonbeamReleases = (await (
    await fetch("https://api.github.com/repos/purestake/moonbeam/releases")
  ).json()) as any;

  const latestMoonbeamVersion = semver.valid(
    semver.coerce(
      moonbeamReleases.find((release) => release.assets.find((asset) => asset.name === "moonbeam"))
        .tag_name
    )
  );

  const moonbeamBinaryPath = path.isAbsolute(argv["moonbeam-binary"])
    ? argv["moonbeam-binary"]
    : "./binaries/moonbeam";

  // Download binary if:
  // 1) Absolute binary path hasn't been supplied
  // 2) Binary doesn't exist in default location
  // 3) Existing binary doesn't match requested version
  if (
    !path.isAbsolute(argv["moonbeam-binary"]) &&
    ((await fs.access("./binaries/moonbeam").catch(() => true)) ||
      (argv["moonbeam-binary"] !== "latest" &&
        semver.compare(
          semver.valid(semver.coerce(await runTask(`${moonbeamBinaryPath} --version`))),
          semver.valid(semver.coerce(argv["moonbeam-binary"]))
        ) !== 0) ||
      (argv["moonbeam-binary"] === "latest" &&
        semver.valid(semver.coerce(await runTask(`${moonbeamBinaryPath} --version`))) !==
          semver.clean(latestMoonbeamVersion)))
  ) {
    try {
      const release =
        argv["moonbeam-binary"] === "latest"
          ? moonbeamReleases.find((release) =>
              release.assets.find((asset) => asset.name === "moonbeam")
            )
          : moonbeamReleases
              .filter((release) => release.tag_name.includes("v" + argv["moonbeam-binary"]))
              .find((release) => release.assets.find((asset) => asset.name === "moonbeam"));
      if (release == null) {
        throw new Error(`Release not found for ${argv["moonbeam-binary"]}`);
      }
      process.stdout.write(
        `\t - Requested Moonbeam ${argv["moonbeam-binary"]} binary not found, downloading client ....`
      );
      const asset = release.assets.find((asset) => asset.name === "moonbeam");
      const response = await fetch(asset.browser_download_url);
      if (!response.ok) {
        throw new Error(`unexpected response ${response.statusText}`);
      }
      await fs.writeFile(moonbeamBinaryPath, response.body);
      await fs.chmod(moonbeamBinaryPath, "755");
      process.stdout.write(` ${chalk.green("done")} ✓\n`);
    } catch (e) {
      console.error(e);
      throw new Error("Error downloading moonbeam-binary");
    }
  }

  process.stdout.write(`\t - Checking moonbeam binary...`);
  const moonbeamVersion = (await runTask(`${moonbeamBinaryPath} --version`)).trim();
  process.stdout.write(` ${chalk.green(moonbeamVersion.trim())} ✓\n`);

  if (argv["purge-all"]) {
    await fs.rm(argv["base-path"], { recursive: true, force: true });
    process.stdout.write(
      `\t - ${chalk.red(`Purged`)} all local files at:  ${argv["base-path"]} ✓\n`
    );
  }

  process.stdout.write(`\t - Checking exported state...`);
  let progressBar: SingleBar;
  const { stateFile, stateInfo } = await downloadExportedState(
    {
      network: argv.network as NetworkName,
      outPath: argv["base-path"],
      checkLatest: argv.latest,
      useCleanState: argv["smaller-state"]
    },
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
  process.stdout.write(` ${chalk.green(stateFile)} (#${chalk.yellow(stateInfo.blockNumber)}) ✓\n`);

  process.stdout.write(`\t - Checking parachain id...`);
  const paraId = parseInt(
    await runTask(`head -100 ${stateFile} | grep paraId  | cut -c 12- | rev | cut -c 2- | rev`)
  );
  process.stdout.write(` ${chalk.green(paraId)} ✓\n`);

  if (argv.regenerate) {
    await fs.rm(path.join(argv["base-path"], `${argv.network}-chain.info.json`), { force: true });
    await fs.rm(path.join(argv["base-path"], `${argv.network}-code`), { force: true });
    await fs.rm(path.join(argv["base-path"], `${argv.network}.genesis.state`), { force: true });
    await fs.rm(path.join(argv["base-path"], `${argv.network}-state.mod.json`), { force: true });

    if (!argv.dev) {
      await fs.rm(
        path.join(
          argv["base-path"],
          `${argv["relay-chain"]}-${argv.network}-${polkadotVersion.replace(
            " ",
            "-"
          )}-local-raw.json`
        ),
        { force: true }
      );
    }
  }

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
    await neutralizeExportedState(stateFile, modFile, {
      dev: argv.dev,
      authorizeUpgrade: argv["authorize-upgrade"],
    });
    process.stdout.write(` ✓\n`);
  }
  process.stdout.write(`\t - Completed at: ${chalk.green(modFile)} ✓\n`);

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
      `grep -m 1 '"0x3a636f6465"' ${stateFile} | head -1 | sed 's/[ \",]//g' | cut -d ':' -f 2 | tr -d '\n' | tee ${codeFile} | wc -c`
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
      `${moonbeamBinaryPath} export-genesis-state --chain ${modFile} | tee ${genesisStateFile}`
    );
  }
  process.stdout.write(` ${chalk.green(genesisStateFile)} ✓\n`);

  let relayRawSpecFile: string;
  if (!argv.dev) {
    const parachainCode = (await fs.readFile(codeFile)).toString();
    const genesisState = (await fs.readFile(genesisStateFile)).toString();

    const relayPlainSpecFile = path.join(
      argv["base-path"],
      `${argv["relay-chain"]}-${argv.network}-${polkadotVersion.replace(" ", "-")}-local-plain.json`
    );
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
        `${polkadotBinaryPath} build-spec --chain ${argv["relay-chain"]} --disable-default-bootnode > ${relayPlainSpecFile}`
      );
      process.stdout.write(` ✓\n`);

      process.stdout.write(`\t\t - Including parachain ${paraId} in relaychain plain specs...`);
      let relayChainSpec = JSON.parse((await fs.readFile(relayPlainSpecFile)).toString());
      relayChainSpec.bootNodes = bootNodes;
      const paras = [
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
      if ("runtime_genesis_config" in relayChainSpec.genesis.runtime) {
        relayChainSpec.genesis.runtime.runtime_genesis_config.paras = paras;
      } else {
        relayChainSpec.genesis.runtime.paras = paras;
      }
      await fs.writeFile(relayPlainSpecFile, JSON.stringify(relayChainSpec, null, 2));
      process.stdout.write(` ✓\n`);
      process.stdout.write(`\t - ${chalk.yellow(`Saving`)} plain relaychain spec...`);
    }
    process.stdout.write(` ${chalk.green(relayPlainSpecFile)} ✓\n`);

    process.stdout.write(`\t - Checking relaychain raw spec file...`);
    relayRawSpecFile = path.join(
      argv["base-path"],
      `${argv["relay-chain"]}-${argv.network}-${polkadotVersion.replace(" ", "-")}-local-raw.json`
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
        `${polkadotBinaryPath} build-spec --raw --chain ${relayPlainSpecFile} > ${relayRawSpecFile}`
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
      `${polkadotBinaryPath} --database paritydb --base-path ${aliceFolder} --log=debug,parachain=trace,netlink=info,sync=info,lib=info,multi=info,trie=info,grandpa=info,wasm_overrides=info,wasmtime_cranelift=info,parity-db=info --alice --chain ${relayRawSpecFile} --rpc-port 12001 --port 10001 --node-key ${Object.keys(NODE_KEYS)[0]
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
      `${polkadotBinaryPath} --database paritydb --base-path ${bobFolder} --bob --chain ${relayRawSpecFile} --rpc-port 12002 --port 10002  --node-key ${Object.keys(NODE_KEYS)[1]
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
  // const logs="--log=trace,netlink=trace,sync=trace,lib=trace,sub=trace,multi=trace,evm=debug,parity-db=info,trie=info,wasmtime_cranelift=info";
  const logs="";
  const alithProcess = argv.dev
    ? await spawnTask(
        `${moonbeamBinaryPath} --database paritydb --base-path ${alithFolder} --execution native ${logs} --alice --collator --db-cache 4096 --trie-cache-size ${argv["trie-cache-size"]} --chain ${modFile} --no-hardware-benchmarks --no-prometheus --no-telemetry --sealing=${argv.sealing}`
      )
    : await spawnTask(
      `${moonbeamBinaryPath} --database paritydb --base-path ${alithFolder} --execution native ${logs} --alice --collator --db-cache 4096 --trie-cache-size ${argv["trie-cache-size"]
      } --chain ${modFile} --  --chain ${relayRawSpecFile} --rpc-port 12003 --port 10003 --node-key ${Object.keys(NODE_KEYS)[2]
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
        } catch (e) { }
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
          } catch (e) { }
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
          } catch (e) { }
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
      `ℹ️  RelayChain Explorer: https://polkadot.js.org/apps/?rpc=ws://127.0.0.1:12003#/explorer\n`
    );
  }
  process.stdout.write(
    `ℹ️  ParaChain Explorer: https://polkadot.js.org/apps/?rpc=ws://127.0.0.1:9944#/explorer\n`
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
