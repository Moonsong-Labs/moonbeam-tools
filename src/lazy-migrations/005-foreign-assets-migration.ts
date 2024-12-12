// 005-foreign-assets-migration.ts

import yargs from "yargs";
import "@polkadot/api-augment";
import { ApiPromise, Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks.ts";
import {
  monitorSubmittedExtrinsic,
  waitForAllMonitoredExtrinsics,
} from "../utils/monitoring.ts";
import { ALITH_PRIVATE_KEY } from "../utils/constants.ts";
import { SpRuntimeDispatchError } from "@polkadot/types/lookup";

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
    "skip-start": {
      type: "boolean",
      default: false,
      describe: "Skip the start migration step",
    },
  })
  .check((argv) => {
    if (!(argv["account-priv-key"] || argv["alith"])) {
      throw new Error("Missing --account-priv-key or --alith");
    }
    return true;
  }).argv;

interface MigrationInfo {
    assetId: string;
    remainingBalances: number;
    remainingApprovals: number;
}

type MigrationStatus = {
    type: 'Idle'
} | {
    type: 'Migrating',
    info: MigrationInfo
}


async function checkMigrationFailure(api: ApiPromise, txId: string) {
  const events = await api.query.system.events();
  
  // Find ExtrinsicFailed events
  const failures = events.filter(({ event }) => {
    if (!api.events.system.ExtrinsicFailed.is(event)) {
      return false;
    }
    const dispatchError = event.data.dispatchError;
    if (!dispatchError.isModule) {
      return false;
    }
    const moduleError = api.registry.findMetaError(dispatchError.asModule);
    return moduleError.section === 'moonbeamLazyMigrations' || moduleError.section === 'moonbeamForeignAssets';
  }).map(
    ({
      event: {
        data: [error, info],
      },
    }) => {
      const dispatchError = error as SpRuntimeDispatchError;
      if (dispatchError.isModule) {
        const decoded = api.registry.findMetaError(dispatchError.asModule);
        const { docs, method, section } = decoded;

        return `${section}.${method}: ${docs.join(" ")}`;
      } else {
        // Other, CannotLookup, BadOrigin, no extra info
        return error.toString();
      }
    }
  );

  if (failures.length > 0) {
    const errorDetails = failures.join("\n");
    throw new Error(`Migration failed for ${txId}: ${errorDetails}`);
  }
}

async function main() {
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });
  const assetId = argv["asset-id"];
  const skipStart = argv["skip-start"];

  try {
    let account: KeyringPair;
    let nonce: bigint;

    // Setup account
    const privKey = argv["alith"] ? ALITH_PRIVATE_KEY : argv["account-priv-key"];
    account = keyring.addFromUri(privKey, null, "ethereum");
    const { nonce: rawNonce } = await api.query.system.account(account.address);
    nonce = BigInt(rawNonce.toString());

    const rawMigrationInfo = await api.query.moonbeamLazyMigrations.foreignAssetMigrationStatusValue();
    console.log("Migration info:", rawMigrationInfo.toString());
    
    // Step 1: Start migration (skip if flag is set)
    if (!skipStart) {
      const txStart = api.tx.moonbeamLazyMigrations.startForeignAssetsMigration(assetId);
      await txStart.signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: `start-migration-${assetId}` })
      );
      await waitForAllMonitoredExtrinsics();
      await checkMigrationFailure(api, `start-migration-${assetId}`);
      console.log("Started migration for asset", assetId);
    } else {
      console.log("Skipping start migration step");
    }

    // Step 2: Migrate balances
    const txBalances = api.tx.moonbeamLazyMigrations.migrateForeignAssetBalances(argv.limit);
    await txBalances.signAndSend(
      account,
      { nonce: nonce++ },
      monitorSubmittedExtrinsic(api, { id: `migrate-balances-${assetId}` })
    );
    console.log("Migrated balances for asset", assetId);

    // Step 3: Migrate approvals
    const txApprovals = api.tx.moonbeamLazyMigrations.migrateForeignAssetApprovals(argv.limit);
    await txApprovals.signAndSend(
      account,
      { nonce: nonce++ },
      monitorSubmittedExtrinsic(api, { id: `migrate-approvals-${assetId}` })
    );
    console.log("Migrated approvals for asset", assetId);

    // Step 4: Finish migration
    const txFinish = api.tx.moonbeamLazyMigrations.finishForeignAssetsMigration();
    await txFinish.signAndSend(
      account,
      { nonce: nonce++ },
      monitorSubmittedExtrinsic(api, { id: `finish-migration-${assetId}` })
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