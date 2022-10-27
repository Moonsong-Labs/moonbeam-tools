import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  for (const section of Object.keys(api.query)) {
    console.log(`${section}`);
    for (const method of Object.keys(api.query[section])) {
      console.log(
        `  ${`${section}.${method}`.padStart(50, " ")}: ${(api.query[section][method]).keyPrefix()}`
      );
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
