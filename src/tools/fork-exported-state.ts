// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";

import {
  downloadExportedState,
  NetworkName,
  neutralizeExportedState,
} from "../libs/helpers/state-manipulator/index.ts";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    network: {
      type: "string",
      description: "Network to retrieve the exported state for",
      demandOption: true,
    },
    "state-folder": {
      type: "string",
      description: "Folder where to store the state",
      demandOption: true,
    },
  }).argv;

const main = async () => {
  // await fs.mkdir(argv["state-folder"], { recursive: true });
  const file = await downloadExportedState({
    network: argv.network as NetworkName,
    outPath: argv["state-folder"],
  });
  await neutralizeExportedState(file.stateFile, file.stateFile.replace(/.json$/, ".mod.json"));
};

main();
