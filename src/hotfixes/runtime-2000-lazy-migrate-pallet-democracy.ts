/*
  This script is intended to run once for specific networks.
  Do not use it without reading the code !!

  This script will find the storage keys for the now removed items `Preimages` in pallet-democracy
  and call migrateDemocracyPreimage from pallet-migrations

Ex: ./node_modules/.bin/ts-node runtime-2000-lazy-migrate-pallet-democracy.ts \
   --url ws://127.0.0.1:34102 \
   --account-priv-key <key> \
*/
import yargs from "yargs";
import { Keyring, ApiPromise } from "@polkadot/api";
import "@moonbeam-network/api-augment";
import { xxhashAsHex } from "@polkadot/util-crypto";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": { type: "string", demandOption: false, alias: "account" },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const atBlockNumber = argv.at || (await api.rpc.chain.getHeader()).number.toNumber();
  const atBlockHash = await api.rpc.chain.getBlockHash(atBlockNumber);
  const apiAt = await api.at(atBlockHash);

  const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
  const runtimeVersion = upgradeInfo.specVersion.toNumber();

  console.log(
    `Using data from block #${atBlockNumber} (${api.runtimeVersion.specName.toString()}-${runtimeVersion})`,
  );

  // We retrieve all storage keys. Since we do not have access to the storage item
  // we just need to do it through RPC with the encodede keys
  // XX128("Democracy") || XX128("Preimages")
  const preimagePrefix = xxhashAsHex("Democracy", 128) + xxhashAsHex("Preimages", 128).slice(2);

  async function getAllKeys(api: ApiPromise, prefix: string, startKey?: string) {
    const keys = (
      await api.rpc.state.getKeysPaged(prefix, 1000, startKey || prefix, atBlockHash)
    ).map((d) => d.toHex());

    if (keys.length == 0) {
      return [];
    }
    return keys.concat(await getAllKeys(api, prefix, keys[keys.length - 1]));
  }

  // We retrieve all keys starting with this keys
  const preimageKeys = await getAllKeys(api, preimagePrefix);

  console.log("Found the following keys to migrate");
  console.log(preimageKeys);

  if (argv["account-priv-key"]) {
    const keyring = new Keyring({ type: "ethereum" });
    const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
    const { nonce: rawNonce, data: balance } = (await api.query.system.account(
      account.address,
    )) as any;
    let nonce = BigInt(rawNonce.toString());

    for (const key of preimageKeys) {
      // We slice and take only the proposal hash part.
      let proposal = "0x" + key.slice(preimagePrefix.length);
      console.log("Found proposal %s to migrate", proposal);
      // We take the storage size to bound it. This will probably be more than
      // what we need, but never less
      let storageSize = await api.rpc.state.getStorageSize(key, atBlockHash);

      // We do a batch remarking migrated proposals and migrating all
      // proposals
      await api.tx.utility
        .batch([
          api.tx.system.remark(`Democracy preimage migration: Migrating proposal: ${proposal})`),
          api.tx.migrations.migrateDemocracyPreimage(proposal, storageSize),
        ])
        .signAndSend(account, { nonce: nonce++ });
      await new Promise((resolve) => setTimeout(resolve, 12000));
    }
  }
  await api.disconnect();
};

main();
