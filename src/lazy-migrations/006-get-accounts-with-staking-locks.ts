/*
  Query and export accounts that have staking locks (not yet migrated to freezes)

  This helper script queries the chain for accounts with staking locks (stkngcol, stkngdel)
  that haven't been migrated to the new freeze system yet. It exports the results to a JSON file
  that can be used as input for the migration script.

  Context: PR https://github.com/moonbeam-foundation/moonbeam/pull/3306

Ex: npx tsx src/lazy-migrations/006-get-accounts-with-staking-locks.ts --url ws://localhost:9944
*/

import yargs from "yargs";
import * as path from "path";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { NETWORK_YARGS_OPTIONS } from "../utils/networks.ts";
import * as fs from "fs";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "output-file": {
      type: "string",
      demandOption: false,
      describe: "Path to output JSON file (optional, auto-generated if not provided)",
    },
  }).argv;

interface AccountInfo {
  address: string;
  locks: {
    id: string;
    amount: string;
  }[];
}

interface OutputData {
  delegators: string[];
  candidates: string[];
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

  console.log("Connected to chain");

  const chain = (await api.rpc.system.chain()).toString().toLowerCase().replace(/\s/g, "-");
  const OUTPUT_FILE =
    argv["output-file"] ||
    path.resolve(process.cwd(), `src/lazy-migrations/accounts-with-staking-locks--${chain}.json`);
  const DETAILED_OUTPUT_FILE =
    argv["output-file"] ||
    path.resolve(
      process.cwd(),
      `src/lazy-migrations/accounts-with-staking-locks--${chain}.info.json`,
    );

  try {
    console.log("Querying delegator and collator state from parachain staking...");
    console.log("Using pagination to efficiently handle large datasets...\n");

    const delegatorAddresses: string[] = [];
    const candidateAddresses: string[] = [];
    const detailedInfo: AccountInfo[] = [];
    const PAGE_SIZE = 300; // Balance between efficiency and RPC timeout risk

    // Get all delegators from parachain staking with pagination
    console.log("Querying delegators with pagination...");
    let processed = 0;
    let lastKey: any = null;

    for (;;) {
      const locksBatch = await api.query.balances.locks.entriesPaged({
        args: [],
        pageSize: PAGE_SIZE,
        startKey: lastKey,
      });

      console.log(`  Loaded ${locksBatch.length} locks (batch ${processed / PAGE_SIZE + 1})...`);

      for (const [key, value] of locksBatch) {
        if (value.isEmpty) continue;

        // Extract account ID from storage key using args
        const accountId = key.args[0];
        const accountIdStr = accountId.toString();

        const lockData = value.toJSON() as any[];

        const stkngdelLocks = lockData.filter(
          (lock: any) => lock.id === "0x73746b6e6764656c", // stkngdel
        );

        if (stkngdelLocks.length > 0) {
          delegatorAddresses.push(accountIdStr);
          detailedInfo.push({
            address: accountIdStr,
            locks: stkngdelLocks,
          });
        }

        const stkngcolLocks = lockData.filter(
          (lock: any) => lock.id === "0x73746b6e67636f6c", // stkngcol
        );

        if (stkngcolLocks.length > 0) {
          candidateAddresses.push(accountIdStr);
          detailedInfo.push({
            address: accountIdStr,
            locks: stkngcolLocks,
          });
        }

        processed++;
        lastKey = key;
      }

      // Save progress after each batch
      const outputData: OutputData = {
        delegators: delegatorAddresses,
        candidates: candidateAddresses,
      };
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
      fs.writeFileSync(DETAILED_OUTPUT_FILE, JSON.stringify(detailedInfo, null, 2));
      console.log(
        `  Progress saved: ${delegatorAddresses.length} delegators, ${candidateAddresses.length} candidates`,
      );

      if (locksBatch.length < PAGE_SIZE) {
        console.log(`\nTotal locks processed: ${processed}`);
        break;
      }
    }

    console.log(`Delegators needing migration: ${delegatorAddresses.length}\n`);
    console.log(`Candidates needing migration: ${candidateAddresses.length}\n`);

    const totalAccounts = delegatorAddresses.length + candidateAddresses.length;
    console.log(`\n\nFound ${totalAccounts} accounts that need migration`);

    // Save the categorized lists of addresses
    const outputData: OutputData = {
      delegators: delegatorAddresses,
      candidates: candidateAddresses,
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    console.log(`\nSaved account addresses to: ${OUTPUT_FILE}`);

    // Save detailed information
    fs.writeFileSync(DETAILED_OUTPUT_FILE, JSON.stringify(detailedInfo, null, 2));
    console.log(`Saved detailed information to: ${DETAILED_OUTPUT_FILE}`);

    // Print summary
    console.log("\n" + "=".repeat(50));
    console.log("Summary:");
    console.log("=".repeat(50));
    console.log(`Total locks checked: ${processed}`);
    console.log(`Accounts needing migration: ${totalAccounts}`);
    console.log(`  - Delegators: ${delegatorAddresses.length}`);
    console.log(`  - Candidates: ${candidateAddresses.length}`);

    // Print first few examples
    if (delegatorAddresses.length > 0) {
      console.log("\nFirst 5 delegators to migrate:");
      delegatorAddresses.slice(0, 5).forEach((addr, idx) => {
        console.log(`  ${idx + 1}. ${addr}`);
      });
    }

    if (candidateAddresses.length > 0) {
      console.log("\nFirst 5 candidates to migrate:");
      candidateAddresses.slice(0, 5).forEach((addr, idx) => {
        console.log(`  ${idx + 1}. ${addr}`);
      });
    }
  } catch (error) {
    console.error("Query error:", error);
    throw error;
  } finally {
    await api.disconnect();
  }
}

main().catch((err) => {
  console.error("ERR!", err);
  process.exit(1);
});
