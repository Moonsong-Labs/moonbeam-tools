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

  for (const section of Object.keys(api.tx)) {
    console.log(`${section}`);
    for (const method of Object.keys(api.tx[section])) {
      console.log(
        `  ${`${section}.${method}`.padStart(50, " ")}: ${api.tx[section][method].callIndex
          .toString()
          .padStart(6, " ")}`
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
