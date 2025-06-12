//   Clears the unused storage of pallet LocalAssets removed in runtime 2800
//
// Ex: bun src/lazy-migrations/002-clear-local-assets-storage.ts \
//    --url ws://localhost:9944 \
//    --max-assets 10 \
//    --limit 1000 \
//    --account-priv-key <key>
import "@moonbeam-network/api-augment";
import "@polkadot/api-augment";

import { Keyring } from "@polkadot/api";
import { KeyringPair as _KeyringPair } from "@polkadot/keyring/types";
import yargs from "yargs";

import { ALITH_PRIVATE_KEY } from "../utils/constants";
import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": {
      type: "string",
      demandOption: false,
      alias: "account",
    },
    "max-assets": {
      type: "number",
      default: 1,
      describe: "The maximum number of assets to be removed by this call",
    },
    limit: {
      type: "number",
      default: 100,
      describe: "The maximum number of storage entries to be removed by this call",
    },
    alith: {
      type: "boolean",
      demandOption: false,
      conflicts: ["account-priv-key"],
    },
  })
  .check((argv) => {
    if (!(argv["account-priv-key"] || argv["alith"])) {
      throw new Error("Missing --account-priv-key or --alith");
    }
    return true;
  }).argv;

async function main() {
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  try {
    const max_assets = argv["max-assets"];
    const entries_to_remove = argv["limit"];

    let nonce: bigint;
    const privKey = argv["alith"] ? ALITH_PRIVATE_KEY : argv["account-priv-key"];
    if (!privKey) {
      throw new Error("No private key provided");
    }
    const account = keyring.addFromUri(privKey, undefined, "ethereum");
    const { nonce: rawNonce, data: _balance } = await api.query.system.account(account.address);
    nonce = BigInt(rawNonce.toString());

    const isMigrationCompleted = (
      await api.query["moonbeamLazyMigrations"].localAssetsMigrationCompleted()
    ).toPrimitive();
    if (isMigrationCompleted) {
      throw new Error("Migration completed, all keys have been removed!");
    }

    const extrinsicCall = api.tx["moonbeamLazyMigrations"].clearLocalAssetsStorage(
      max_assets,
      entries_to_remove,
    );
    await extrinsicCall.signAndSend(
      account,
      { nonce: nonce++ },
      monitorSubmittedExtrinsic(api, { id: "migration" }),
    );
  } finally {
    await waitForAllMonitoredExtrinsics();
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
