/*
  Migrate parachain staking locks to freezes for delegators and collators

  This migration script facilitates the transition from the deprecated Currency trait
  with lock-based fund restrictions to the modern Fungible trait with freeze-based mechanisms.

  Context: PR https://github.com/moonbeam-foundation/moonbeam/pull/3306

  The script will:
  1. Query for accounts that still have staking locks (not yet migrated to freezes)
  2. Batch migrate up to 100 accounts per transaction using migrate_locks_to_freezes_batch
  3. Verify the migration by checking Balances.Freezes for the migrated accounts
  4. Track progress and handle failures gracefully

  Ex: npx tsx src/lazy-migrations/006-migrate-locks-to-freezes.ts \
    --url ws://localhost:9944 \
    --account-priv-key <key> \
    --limit 100

  To retry verification of failed accounts:
  Ex: npx tsx src/lazy-migrations/006-migrate-locks-to-freezes.ts \
    --url ws://localhost:9944 \
    --retry-failed
*/

import yargs from "yargs";
import * as path from "path";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { NETWORK_YARGS_OPTIONS } from "../utils/networks.ts";
import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring.ts";
import { ALITH_PRIVATE_KEY } from "../utils/constants.ts";
import * as fs from "fs";

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
    limit: {
      type: "number",
      default: 100,
      describe: "The maximum number of accounts to migrate per batch (max 100)",
    },
    alith: {
      type: "boolean",
      demandOption: false,
      conflicts: ["account-priv-key"],
    },
    "input-file": {
      type: "string",
      demandOption: false,
      describe:
        "Path to JSON file containing array of account addresses to migrate. If not provided, will query from chain state.",
    },
    "retry-failed": {
      type: "boolean",
      demandOption: false,
      default: false,
      describe:
        "Re-verify accounts in failed_accounts to check if they were actually migrated successfully",
    },
  })
  .check((argv) => {
    if (!argv["retry-failed"] && !(argv["account-priv-key"] || argv["alith"])) {
      throw new Error("Missing --account-priv-key or --alith");
    }
    if (argv["limit"] > 100) {
      throw new Error("Limit cannot exceed 100 accounts per batch");
    }
    if (argv["input-file"] && !fs.existsSync(path.resolve(process.cwd(), argv["input-file"]))) {
      throw new Error(`Input file ${argv["input-file"]} not found`);
    }
    return true;
  }).argv;

interface AccountEntry {
  address: string;
  isCandidate: boolean;
}

interface MigrationDB {
  pending_accounts: AccountEntry[];
  migrated_accounts: string[];
  failed_accounts: Record<string, string>;
}

/**
 * Verify that an account has been migrated by checking freezes
 */
async function verifyMigration(api: any, accountId: string): Promise<boolean> {
  const freezes = await api.query.balances.freezes(accountId);
  const freezeData = freezes.toJSON() as any[];

  // Check if account has staking freezes
  // Freeze ID format: { parachainStaking: "StakingDelegator" } or { parachainStaking: "StakingCollator" }
  const hasStakingFreeze = freezeData.some(
    (freeze: any) =>
      freeze.id?.parachainStaking === "StakingCollator" ||
      freeze.id?.parachainStaking === "StakingDelegator",
  );

  return hasStakingFreeze;
}

async function main() {
  // Create provider with extended timeout for large state queries
  // WsProvider(endpoint, autoConnectMs, headers, timeout, cacheCapacity, cacheTtl)
  const wsProvider = new WsProvider(
    argv.url || process.env.MOONBEAM_TOOLS_WS_URL,
    undefined, // autoConnectMs - use default auto-reconnect
    undefined, // headers
    300000, // timeout - 5 minute timeout for large queries
  );
  const api = await ApiPromise.create({
    noInitWarn: true,
    provider: wsProvider,
  });
  const keyring = new Keyring({ type: "ethereum" });

  const chain = (await api.rpc.system.chain()).toString().toLowerCase().replace(/\s/g, "-");
  const PROGRESS_FILE = path.resolve(
    process.cwd(),
    `src/lazy-migrations/locks-to-freezes-migration-progress--${chain}.json`,
  );

  // Initialize or load progress DB
  let db: MigrationDB = {
    pending_accounts: [],
    migrated_accounts: [],
    failed_accounts: {},
  };

  try {
    // Load existing progress first
    if (fs.existsSync(PROGRESS_FILE)) {
      db = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
      console.log(
        `Loaded existing progress: ${db.migrated_accounts.length} migrated, ${db.pending_accounts.length} pending, ${Object.keys(db.failed_accounts).length} failed`,
      );
    }

    // Handle --retry-failed mode
    if (argv["retry-failed"]) {
      if (!fs.existsSync(PROGRESS_FILE)) {
        console.log("No progress file found. Nothing to retry.");
        return;
      }

      const failedAccounts = Object.keys(db.failed_accounts);
      if (failedAccounts.length === 0) {
        console.log("No failed accounts to retry.");
        return;
      }

      console.log(`\nRetrying verification for ${failedAccounts.length} failed accounts...\n`);

      let reverified = 0;
      let stillFailed = 0;

      for (const accountId of failedAccounts) {
        try {
          const migrated = await verifyMigration(api, accountId);
          if (migrated) {
            // Migration was successful, move from failed to migrated
            db.migrated_accounts.push(accountId);
            delete db.failed_accounts[accountId];
            reverified++;
            console.log(
              `✅ ${accountId} - Successfully migrated (was incorrectly marked as failed)`,
            );
          } else {
            stillFailed++;
            console.log(`❌ ${accountId} - Still no staking freeze found`);
          }
        } catch (error) {
          stillFailed++;
          console.error(`❌ ${accountId} - Verification error: ${error.message}`);
        }
      }

      // Save updated progress
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(db, null, 2));

      console.log("\n" + "=".repeat(50));
      console.log("Retry Summary:");
      console.log("=".repeat(50));
      console.log(`✅ Re-verified as migrated: ${reverified} accounts`);
      console.log(`❌ Still failed: ${stillFailed} accounts`);
      console.log(`\nUpdated progress saved to: ${PROGRESS_FILE}`);

      return;
    }

    // Load accounts to migrate (normal migration mode)
    let accountsToMigrate: AccountEntry[] = [];

    // Load from provided file
    const inputFile = path.resolve(process.cwd(), argv["input-file"]);
    if (!fs.existsSync(inputFile)) {
      throw new Error(`Input file ${inputFile} not found`);
    }
    const fileData = JSON.parse(fs.readFileSync(inputFile, "utf8"));

    // Handle different input formats
    if (Array.isArray(fileData)) {
      // Old format: simple array of addresses (assume all are delegators for backwards compatibility)
      accountsToMigrate = fileData.map((addr) => ({ address: addr, isCandidate: false }));
    } else if (fileData.delegators && fileData.candidates) {
      // New format: object with separate delegator and candidate lists
      const delegators = fileData.delegators.map((addr: string) => ({
        address: addr,
        isCandidate: false,
      }));
      const candidates = fileData.candidates.map((addr: string) => ({
        address: addr,
        isCandidate: true,
      }));
      accountsToMigrate = [...delegators, ...candidates];
    } else {
      throw new Error(`Invalid input file format. Expected array or {delegators, candidates}`);
    }

    console.log(`Loaded ${accountsToMigrate.length} accounts from ${inputFile}`);

    // If progress file is empty but we have accounts to migrate, initialize from input
    if (db.pending_accounts.length === 0 && accountsToMigrate.length > 0) {
      db.pending_accounts = accountsToMigrate;
      console.log(`Initialized ${db.pending_accounts.length} accounts from input`);
    }

    const limit = Math.min(argv["limit"], 100); // Enforce max of 100
    let nonce: bigint;

    // Setup account
    const privKey = argv["alith"] ? ALITH_PRIVATE_KEY : argv["account-priv-key"];
    if (!privKey) {
      throw new Error("No private key provided");
    }
    const account: KeyringPair = keyring.addFromUri(privKey, undefined, "ethereum");
    const { nonce: rawNonce } = await api.query.system.account(account.address);
    nonce = BigInt(rawNonce.toString());

    console.log(`\nStarting migration process...`);
    console.log(`Total pending: ${db.pending_accounts.length}`);
    console.log(`Batch size: ${limit}\n`);

    // Process accounts in batches
    while (db.pending_accounts.length > 0) {
      const batch = db.pending_accounts.slice(0, limit);
      console.log(`Processing batch of ${batch.length} accounts...`);

      try {
        // Convert batch to [address, isCandidate] tuples for the extrinsic
        const batchTuples = batch.map((entry) => [entry.address, entry.isCandidate]);

        // Submit migration transaction
        const tx = api.tx.parachainStaking.migrateLocksToFreezesBatch(batchTuples);
        await tx.signAndSend(
          account,
          { nonce: nonce++ },
          monitorSubmittedExtrinsic(api, { id: `migrate-locks-to-freezes-batch-${batch.length}` }),
        );
        console.log(`Submitted transaction for batch of ${batch.length} accounts`);
      } catch (error) {
        console.error(`Failed to submit batch transaction:`, error);
        // Mark all accounts in this batch as failed
        batch.forEach((entry) => {
          db.failed_accounts[entry.address] =
            error.message || "Batch transaction submission failed";
          db.pending_accounts = db.pending_accounts.filter((e) => e.address !== entry.address);
        });
        // Save progress and continue
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(db, null, 2));
        continue;
      }

      // Wait for transaction to complete
      console.log("Waiting for transaction to complete...");
      await waitForAllMonitoredExtrinsics();
      console.log("Transaction completed. Starting verification...");

      // Verify migration for each account in the batch
      for (const entry of batch) {
        try {
          const migrated = await verifyMigration(api, entry.address);
          if (migrated) {
            db.migrated_accounts.push(entry.address);
            db.pending_accounts = db.pending_accounts.filter((e) => e.address !== entry.address);
            console.log(`✅ Verified migration for ${entry.address}`);
          } else {
            console.log(`❌ Migration verification failed for ${entry.address}`);
            db.failed_accounts[entry.address] =
              "Migration verification failed - no staking freeze found";
            db.pending_accounts = db.pending_accounts.filter((e) => e.address !== entry.address);
          }
        } catch (error) {
          console.error(`Error verifying ${entry.address}:`, error);
          db.failed_accounts[entry.address] = error.message || "Verification error";
          db.pending_accounts = db.pending_accounts.filter((e) => e.address !== entry.address);
        }
      }

      // Save progress after each batch
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(db, null, 2));
      console.log(`Progress saved. Remaining: ${db.pending_accounts.length}\n`);
    }

    // Print final summary
    console.log("\n" + "=".repeat(50));
    console.log("Migration Summary:");
    console.log("=".repeat(50));
    console.log(`✅ Successfully migrated: ${db.migrated_accounts.length} accounts`);
    console.log(`❌ Failed: ${Object.keys(db.failed_accounts).length} accounts`);
    console.log(`⏳ Remaining: ${db.pending_accounts.length} accounts`);

    if (Object.keys(db.failed_accounts).length > 0) {
      console.log("\nFailed accounts:");
      Object.entries(db.failed_accounts).forEach(([account, reason]) => {
        console.log(`  ${account}: ${reason}`);
      });
    }
  } catch (error) {
    console.error("Migration error:", error);
    throw error;
  } finally {
    // Save final state
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(db, null, 2));
    await waitForAllMonitoredExtrinsics();
    await api.disconnect();
  }
}

main().catch((err) => {
  console.error("ERR!", err);
  process.exit(1);
});
