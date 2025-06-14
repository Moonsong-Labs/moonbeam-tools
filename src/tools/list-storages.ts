import yargs from "yargs";
import chalk from "chalk";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks.ts";
import { xxhashAsHex } from "@polkadot/util-crypto";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
  }).argv;

const capitalize = (s) => {
  return String(s[0]).toUpperCase() + String(s).slice(1);
};
const main = async () => {
  const api = await getApiFor(argv);

  for (const section of Object.keys(api.query)) {
    const palletName = section == "evm" ? "EVM" : capitalize(section);
    const sectionKey = xxhashAsHex(palletName, 128);
    console.log(`${chalk.yellow(palletName)}`);
    for (const method of Object.keys(api.query[section])) {
      if (api.query[section][method].keyPrefix().includes(sectionKey.slice(2))) {
        console.log(
          `  ${`${section}.${method}`.padStart(50, " ")}: ${chalk.yellow(sectionKey)}${api.query[section][method].keyPrefix().slice(34)}`,
        );
      } else {
        console.log(
          `  ${`${section}.${method}`.padStart(50, " ")}: ${api.query[section][method].keyPrefix()}`,
        );
      }
    }
  }
  await api.disconnect();
};

async function start() {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

start();
