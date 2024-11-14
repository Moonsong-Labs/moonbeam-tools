#!/usr/bin/env node
import yargs from "yargs";

import { getMonitoredApiFor, NETWORK_NAMES } from "../index.ts";

// This script is expected to run against a moonbeam blockchain
const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    url: {
      type: "string",
      description: "Websocket url",
      conflicts: ["networks"],
      string: true,
    },
    networks: {
      type: "array",
      choices: NETWORK_NAMES,
      description: "Known networks",
      string: true,
    },
    finalized: {
      type: "boolean",
      default: false,
      description: "listen to finalized only",
    },
  })
  .check(function (argv) {
    if (!argv.url && !argv.networks) {
      throw new Error("Error: must provide --url or --networks");
    }
    return true;
  }).argv;

const main = async () => {
  if (argv.networks) {
    argv.networks.map((network) => getMonitoredApiFor({ network, finalized: argv.finalized }));
  } else {
    getMonitoredApiFor(argv);
  }
};

main();
