// 005-foreign-assets-migration.ts
/**
 * Script to migrate foreign assets from the old system to the new one.
 *
 * Usage:
 *   bun src/lazy-migrations/005-foreign-assets-migration.ts \
 *     --url wss://wss.api.moondev.network \
 *     --asset-id 1234 \
 *     --alith \
 *     --limit 50
 *
 * Options:
 *   --url              Websocket url
 *   --asset-id         Asset ID to migrate
 *   --account-priv-key Private key of the account to use
 *   --limit            Maximum number of balances/approvals to migrate per batch (default: 100)
 */

import yargs from "yargs";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring";
import { ALITH_PRIVATE_KEY } from "../utils/constants";
// @ts-ignore - The type exists at runtime
import { PalletMoonbeamLazyMigrationsForeignAssetForeignAssetMigrationStatus } from "@polkadot/types/lookup";

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
    "asset-id": {
      type: "string",
      demandOption: true,
      describe: "Asset ID to migrate",
    },
    limit: {
      type: "number",
      default: 100,
      describe: "Maximum number of balances/approvals to migrate per batch",
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
  const assetId = argv["asset-id"];

  try {
    let nonce: bigint;
    let remainingBalances: number = 0;
    let remainingApprovals: number = 0;

    // Setup account
    const privKey = argv["alith"] ? ALITH_PRIVATE_KEY : argv["account-priv-key"];
    const account: KeyringPair = keyring.addFromUri(privKey, undefined, "ethereum");
    const { nonce: rawNonce } = await api.query.system.account(account.address);
    nonce = BigInt(rawNonce.toString());

    // Step 1: Start migration
    const migrationInfo: PalletMoonbeamLazyMigrationsForeignAssetForeignAssetMigrationStatus =
      await api.query.moonbeamLazyMigrations.foreignAssetMigrationStatusValue();

    if (migrationInfo.isIdle) {
      const txStart = api.tx.moonbeamLazyMigrations.startForeignAssetsMigration(assetId);
      await txStart.signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: `start-migration-${assetId}` }),
      );
      await waitForAllMonitoredExtrinsics();

      const status: PalletMoonbeamLazyMigrationsForeignAssetForeignAssetMigrationStatus =
        await api.query.moonbeamLazyMigrations.foreignAssetMigrationStatusValue();

      if (!status.isMigrating) {
        console.error("Migration did not start correctly");
        return;
      }

      remainingBalances = status.asMigrating?.remainingBalances.toNumber() || 0;
      remainingApprovals = status.asMigrating?.remainingApprovals.toNumber() || 0;
      console.log("Started migration for asset", assetId);
    } else {
      console.log("Migration already in progress for asset", assetId);
      remainingBalances = migrationInfo.asMigrating?.remainingBalances.toNumber() || 0;
      remainingApprovals = migrationInfo.asMigrating?.remainingApprovals.toNumber() || 0;
    }

    // Step 2: Migrate balances
    while (remainingBalances > 0) {
      console.log(`Migrating batch of balances (${remainingBalances} remaining)...`);
      const txBalances = api.tx.moonbeamLazyMigrations.migrateForeignAssetBalances(argv.limit);
      await txBalances.signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: `migrate-balances-${assetId}` }),
      );
      remainingBalances -= argv.limit;
    }
    console.log("Completed balances migration for asset", assetId);

    // Step 3: Migrate approvals
    while (remainingApprovals > 0) {
      console.log(`Migrating batch of approvals (${remainingApprovals} remaining)...`);
      const txApprovals = api.tx.moonbeamLazyMigrations.migrateForeignAssetApprovals(argv.limit);
      await txApprovals.signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: `migrate-approvals-${assetId}` }),
      );
      remainingApprovals -= argv.limit;
    }
    console.log("Completed approvals migration for asset", assetId);

    await waitForAllMonitoredExtrinsics();
    const status: PalletMoonbeamLazyMigrationsForeignAssetForeignAssetMigrationStatus =
      await api.query.moonbeamLazyMigrations.foreignAssetMigrationStatusValue();
    if (
      (status.asMigrating?.remainingBalances.toNumber() || 0) > 0 ||
      (status.asMigrating?.remainingApprovals.toNumber() || 0) > 0
    ) {
      // If there are still balances or approvals to migrate, we should not finish the migration
      console.log("Migration is still in progress, not finishing yet");
      return;
    }

    // Step 4: Finish migration
    const txFinish = api.tx.moonbeamLazyMigrations.finishForeignAssetsMigration();
    await txFinish.signAndSend(
      account,
      { nonce: nonce++ },
      monitorSubmittedExtrinsic(api, { id: `finish-migration-${assetId}` }),
    );
    console.log("Finished migration for asset", assetId);
  } catch (error) {
    console.error("Migration error:", error);
    throw error;
  } finally {
    await waitForAllMonitoredExtrinsics();
    await api.disconnect();
  }
}

main().catch((err) => {
  console.error("ERR!", err);
  process.exit(1);
});
