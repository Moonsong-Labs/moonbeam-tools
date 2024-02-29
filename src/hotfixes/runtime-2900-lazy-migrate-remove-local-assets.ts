/*
  This script is intended to run once for specific networks.
  Do not use it without reading the code !!

  This script will continuosly call and wait for completion of clearLocalAssetsStorage
  extrinsic from pallet moonbeam-lazy-migrations until the migration is completed.

Ex: ./node_modules/.bin/ts-node runtime-2900-lazy-migrate-remove-local-assets.ts \
   --url ws://127.0.0.1:34102 \
   --account-priv-key <key> \
*/
import yargs from "yargs";
import { Keyring } from "@polkadot/api";
import "@moonbeam-network/api-augment";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";
import * as readline from "readline-sync";
import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": { type: "string", demandOption: true, alias: "account" },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const atBlockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  const atBlockHash = await api.rpc.chain.getBlockHash(atBlockNumber);
  const apiAt = await api.at(atBlockHash);

  const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
  const runtimeVersion = upgradeInfo.specVersion.toNumber();

  console.log(
    `Current block number #${atBlockNumber} with runtime version ${api.runtimeVersion.specName.toString()}-${runtimeVersion}`
  );

  const LAZY_MIGRATION_TARGET_RUNTIME_VERSION = 2900;
  if (runtimeVersion != LAZY_MIGRATION_TARGET_RUNTIME_VERSION) {
    console.log(
      `This lazy migration is intended to be ran only for runtime version ${LAZY_MIGRATION_TARGET_RUNTIME_VERSION}`
    );

    const answer = readline.question("Do you want to continue? (y/n)");
    if (answer !== "y") {
      process.exit(0);
    }
    console.log("Continuing...");
  }

  const keyring = new Keyring({ type: "ethereum" });
  const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
  const { nonce: rawNonce } = (await api.query.system.account(account.address)) as any;
  let nonce = BigInt(rawNonce.toString());

  const MAX_CLEAR_LOCAL_ASSETS_STORAGE_LIMIT = 2000;
  /// We want to use half of the limit in order to avoid our transactions staying in the mempool forever.
  const CLEAR_LOCAL_ASSETS_STORAGE_LIMIT = MAX_CLEAR_LOCAL_ASSETS_STORAGE_LIMIT / 2;

  let migrationCompleted = (
    await api.query.moonbeamLazyMigrations.localAssetsMigrationCompleted()
  ).toHuman();
  if (migrationCompleted === true) {
    console.log("Local assets storage already cleared. Exiting...");
    return;
  } else {
    console.log("Clearing local assets storage...");
    while (migrationCompleted === false) {
      const tx = api.tx.moonbeamLazyMigrations.clearLocalAssetsStorage(
        CLEAR_LOCAL_ASSETS_STORAGE_LIMIT
      );
      await tx.signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: "clear_local_assets" })
      );
      await waitForAllMonitoredExtrinsics();
      migrationCompleted = (
        await api.query.moonbeamLazyMigrations.localAssetsMigrationCompleted()
      ).toHuman();
    }
    console.log("Done!");
  }

  await api.disconnect();
};

main();
