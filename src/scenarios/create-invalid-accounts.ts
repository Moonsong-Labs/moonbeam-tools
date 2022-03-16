/*
  This script is intended to run once as hotfix for specific networks.
  Do not use it without reading the code !!

  This script will create inconsistent accounts having a zero value for `sufficients`,
  `consumers` and `providers`, but a non-zero value for `nonce`.

Ex: ./node_modules/.bin/ts-node-transpile-only src/scenarios/create-invalid-accounts.ts \
   --network alphanet \
   --count <N>
*/


import yargs from "yargs";

import { ALITH_PRIVATE_KEY, getApiFor, NETWORK_YARGS_OPTIONS, waitTxDone } from "..";
import { ApiPromise, Keyring } from "@polkadot/api";
import { blake2AsHex, randomAsHex } from "@polkadot/util-crypto";
import { KeyringPair } from "@polkadot/keyring/types";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import { Codec } from "@polkadot/types-codec/types";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    "count": {
      type: "number",
      default: 10,
      description: "number of invalid accounts to create",
    },
    ...NETWORK_YARGS_OPTIONS,
  }).argv;

async function main() {
  const api = await getApiFor(argv);
  try {
    return await createInvalidAccounts(api, argv.count);
  } finally {
    await api.disconnect();
  }
}

async function createInvalidAccounts(api: ApiPromise, count: number): Promise<string[]> {
  const keyPrefixAccount = api.query.system.account.keyPrefix();
  const keyPrefixEvm = api.query.evm.accountCodes.keyPrefix();

  // This refers to the following structure
  // {
  //   nonce: 1
  //   consumers: 0
  //   providers: 0
  //   sufficients: 0
  //   data: {
  //     free: 0
  //     reserved: 0
  //     miscFrozen: 0
  //     feeFrozen: 0
  //   }
  // }
  const SCALE_account_nonce_1 = "0x0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

  const keyring = new Keyring({ type: "ethereum" });
  const alith = keyring.addFromUri(ALITH_PRIVATE_KEY);

  // get random unique account ids
  const accounts = [];
  while (accounts.length < count) {
    accounts.push(randomAsHex(20));
  }

  const txs = accounts.map((addr) => {
    const keyAccount = keyOf(keyPrefixAccount, addr);
    const keyEvm = keyOf(keyPrefixEvm, addr);
    return api.tx.system.setStorage([
      [
        keyEvm,
        "0x00",
      ],
      [
        keyAccount,
        SCALE_account_nonce_1,
      ],
    ]);
  });

  const txSudo = api.tx.sudo.sudo(api.tx.utility.batch(txs));
  const inBlock = await waitTxDone(api, txSudo, alith, { nonce: -1 });

  console.error(`inBlock: ${inBlock}`);

  return accounts;
}

function keyOf(prefix: string, addr: string): string {
  return `${prefix}${blake2AsHex(addr, 128).slice(2)}${addr.slice(2)}`;
}

main()
  .then((d) => console.log(d.join("\n")))
  .catch((err) => console.error("ERR!", err));
