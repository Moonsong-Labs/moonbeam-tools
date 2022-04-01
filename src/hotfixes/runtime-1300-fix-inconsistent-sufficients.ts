/*
  This script is intended to run once as hotfix for specific networks.
  Do not use it without reading the code !!

  This script will find inconsistent accounts having a zero value for `sufficients`
  but a non-zero value for `nonce`. Then it will increment the `sufficients` value,
  so as to be consistent with our logic. An input file with a list of addresses can be 
  optionally provided.

Ex: ./node_modules/.bin/ts-node-transpile-only src/hotfixes/runtime-1300-fix-inconsistent-sufficients.ts \
      --network alphanet \
      --size <PAGE_SIZE> \
      [--input <INPUT_FILE>]

   ./node_modules/.bin/ts-node-transpile-only src/hotfixes/runtime-1300-fix-inconsistent-sufficients.ts \
      --network alphanet \
      --check
*/


import yargs from "yargs";
import chunk from "lodash.chunk";
import { readFile } from "fs/promises";
import '@moonbeam-network/api-augment';

import { getApiFor, NETWORK_YARGS_OPTIONS, waitTxDone } from "..";
import { ApiPromise, Keyring } from "@polkadot/api";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    "size": {
      type: "number",
      default: 1000,
      description: "batch size",
    },
    "check": {
      type: "boolean",
      description: "checks for any invalid accounts",
      conflicts: ["input"],
    },
    "input": {
      type: "string",
      description: "use an input file with newline separated addresses"
    },
    "account-priv-key": {
      type: "string",
      demandOption: false,
      alias: "account",
    },
    ...NETWORK_YARGS_OPTIONS,
  }).check(function (argv) {
    if (!argv["account-priv-key"]) {
      console.error(`Missing --account-priv-key`);
      return false;
    }
    return true;
  }).argv;

async function main() {
  const api = await getApiFor(argv);
  const inBlocks = [];
  try {
    if (argv.check) {
      for await (const invalidAccount of getInvalidAccounts(api)) {
        console.log(invalidAccount)
      }
      process.exit(0);
    }

    const invalidAccounts = argv.input
      ? await loadFile(argv.input)
      : await consumeGenerator(getInvalidAccounts(api));

    const keyring = new Keyring({ type: "ethereum" });
    const signer = keyring.addFromUri(argv["account-priv-key"], null, "ethereum");

    const sender = { account: signer, options: { nonce: -1 }};
    const txs = chunk(invalidAccounts, argv.size).map((b) => api.tx.evm.hotfixIncAccountSufficients(b));
    await waitTxDone(api, api.tx.utility.batch(txs), sender);

    for await (const batch of chunk(invalidAccounts, argv.size)) {
      console.log(`hotfixing ${batch.length} accounts`);
      const tx = api.tx.evm.hotfixIncAccountSufficients(batch);
      const inBlock = await waitTxDone(api, tx, sender);
      inBlocks.push(inBlock);
    }

    return inBlocks;
  } finally {
    await api.disconnect();
  }
}

async function* getInvalidAccounts(api: ApiPromise): AsyncGenerator<string> {
  const keyPrefix = api.query.evm.accountCodes.keyPrefix();

  let startKey = keyPrefix;
  const invalidAccounts = [];

  while (true) {
    const storageKeys = await api.rpc.state.getKeysPaged(keyPrefix, 200, startKey);
    if (storageKeys.isEmpty) {
      break;
    }

    const addresses = storageKeys.map((k) => getValue(k.toString()));
    const accounts = await api.query.system.account.multi(addresses);
    for await (const [index, account] of accounts.entries()) {
      const address = addresses[index];
      const totalRef = account.consumers.toBigInt() + account.providers.toBigInt() + account.sufficients.toBigInt();
      if (totalRef === BigInt(0) && account.nonce.toBigInt() > 0) {
        yield address;
      }
    }

    startKey = storageKeys[storageKeys.length - 1].toString();
  }

  return invalidAccounts;
}

// https://docs.substrate.io/v3/advanced/storage/
function getValue(key: string): string {
  const valueStartIndex = 2 + 32 + 32 + 32; // "0x" + TwoX128(pallet) + TwoX128(storage) + blake2_128(item)
  return `0x${key.slice(valueStartIndex)}`;
}

async function consumeGenerator(generator: AsyncGenerator<string>): Promise<string[]> {
  const d = [];
  for await (const elem of generator) {
    d.push(elem);
  }
  return d;
}

async function loadFile(path: string): Promise<string[]> {
  const data = await readFile(argv.input);
  return data.toString("utf8").trim().split("\n");
}

main()
  .then(console.log)
  .catch((err) => console.error("ERR!", err));
