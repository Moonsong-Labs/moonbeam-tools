/*
  Create contract metadata for a given contract address

Ex: ./node_modules/.bin/ts-node src/lazy-migrations/004-create-contract-metadata.ts \
   --url ws://localhost:9944 \
   --account-priv-key <key> \
   --limit 1000
*/
import yargs from "yargs";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import {
  monitorSubmittedExtrinsic,
  waitForAllMonitoredExtrinsics,
} from "../utils/monitoring";
import { ALITH_PRIVATE_KEY } from "../utils/constants";
import fs from "fs";
import path from "path";

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
      describe:
        "The maximum number of storage entries to be removed by this call",
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

interface MigrationDB {
  pending_contracts: string[];
  migrated_contracts: string[];
  failed_contracts: Record<string, string>;
}

async function main() {
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const chain = (await api.rpc.system.chain())
    .toString()
    .toLowerCase()
    .replace(/\s/g, "-");
  const INPUT_FILE = path.resolve(
    __dirname,
    `contracts-without-metadata-addresses-${chain}-db.json`,
  );
  const PROGRESS_FILE = path.resolve(
    __dirname,
    `contract-without-metadata-migration-progress--${chain}.json`,
  );

  // Initialize or load progress DB
  let db: MigrationDB = {
    pending_contracts: [],
    migrated_contracts: [],
    failed_contracts: {},
  };

  try {
    // Load addresses to migrate
    if (!fs.existsSync(INPUT_FILE)) {
      throw new Error(`Input file ${INPUT_FILE} not found`);
    }
    const addresses = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));

    // Load existing progress
    if (fs.existsSync(PROGRESS_FILE)) {
      db = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    } else {
      db.pending_contracts = addresses;
    }

    const limit = argv["limit"];
    let account: KeyringPair;
    let nonce;

    // Setup account
    const privKey = argv["alith"]
      ? ALITH_PRIVATE_KEY
      : argv["account-priv-key"];
    if (privKey) {
      account = keyring.addFromUri(privKey, null, "ethereum");
      const { nonce: rawNonce } = await api.query.system.account(
        account.address,
      );
      nonce = BigInt(rawNonce.toString());
    }

    // Get contracts to process in this run
    const contractsToProcess = db.pending_contracts.slice(0, limit);
    console.log(
      `Submitting transactions for ${contractsToProcess.length} contracts...`,
    );

    // Submit all transactions first
    for (const contract of contractsToProcess) {
      // Check if already have metadata
      const has_metadata = await api.query.evm.accountCodesMetadata(contract);
      if (!has_metadata.isEmpty) {
        db.migrated_contracts.push(contract);
        db.pending_contracts = db.pending_contracts.filter(
          (addr) => addr !== contract,
        );
        continue;
      }

      try {
        const tx =
          api.tx["moonbeamLazyMigrations"].createContractMetadata(contract);
        await tx.signAndSend(
          account,
          { nonce: nonce++ },
          monitorSubmittedExtrinsic(api, { id: `migration-${contract}` }),
        );
        console.log(`Submitted transaction for ${contract}`);
      } catch (error) {
        console.error(`Failed to submit transaction for ${contract}:`, error);
        db.failed_contracts[contract] =
          error.message || "Transaction submission failed";
        db.pending_contracts = db.pending_contracts.filter(
          (addr) => addr !== contract,
        );
      }
    }

    // Wait for all transactions to complete
    console.log("\nWaiting for all transactions to complete...");
    await waitForAllMonitoredExtrinsics();
    console.log("All transactions completed. Starting verification...");

    // Verify metadata creation for all contracts
    for (const contract of contractsToProcess) {
      // Skip contracts that failed during submission
      if (db.failed_contracts[contract]) {
        continue;
      }

      const has_metadata = await api.query.evm.accountCodesMetadata(contract);
      if (!has_metadata.isEmpty) {
        db.migrated_contracts.push(contract);
        db.pending_contracts = db.pending_contracts.filter(
          (addr) => addr !== contract,
        );
        console.log(`✅ Verified metadata for ${contract}`);
      } else {
        console.log(`❌ Metadata verification failed for ${contract}`);
        db.failed_contracts[contract] = "Metadata verification failed";
        db.pending_contracts = db.pending_contracts.filter(
          (addr) => addr !== contract,
        );
      }
    }

    // Save final progress
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(db, null, 2));

    // Print summary
    console.log("\nMigration Summary:");
    console.log(
      `✅ Successfully processed: ${db.migrated_contracts.length} contracts`,
    );
    console.log(
      `❌ Failed: ${Object.keys(db.failed_contracts).length} contracts`,
    );
    console.log(`⏳ Remaining: ${db.pending_contracts.length} contracts`);
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
