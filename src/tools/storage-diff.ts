#!/usr/bin/env node

import { ApiPromise, WsProvider } from "@polkadot/api";
import { xxhashAsHex } from "@polkadot/util-crypto";

async function decodeStorageKey(api, key) {
  const keyHex = key.toString();

  // Skip the '0x' prefix
  const keyWithoutPrefix = keyHex.startsWith("0x") ? keyHex.slice(2) : keyHex;

  // Extract module and method hashes (first 32 bytes = 64 hex chars)
  const moduleHash = "0x" + keyWithoutPrefix.slice(0, 32);
  const methodHash = "0x" + keyWithoutPrefix.slice(32, 64);

  // Find matching pallet and storage item
  const metadata = await api.rpc.state.getMetadata();
  for (const pallet of metadata.asLatest.pallets) {
    const palletName = pallet.name.toString();
    const palletHash = xxhashAsHex(palletName, 128);

    if (palletHash === moduleHash) {
      if (pallet.storage.isSome) {
        for (const item of pallet.storage.unwrap().items) {
          const itemName = item.name.toString();
          const itemHash = xxhashAsHex(itemName, 128);

          if (itemHash === methodHash) {
            // Try to decode the args if possible
            let argsDisplay = keyWithoutPrefix.slice(64);
            if (argsDisplay.length > 0) {
              argsDisplay = "0x" + argsDisplay;
            }

            return {
              pallet: palletName,
              storage: itemName,
              args: argsDisplay,
            };
          }
        }
      }
    }
  }

  // If we can't decode, at least show the raw key in a more readable format
  return {
    pallet: "Unknown",
    storage: keyHex,
    args: "",
  };
}

async function compareBlocks(endpoint, block1, block2) {
  const wsProvider = new WsProvider(endpoint);
  const api = await ApiPromise.create({ provider: wsProvider });

  try {
    // Get block hashes
    const hash1 = block1.startsWith("0x") ? block1 : await api.rpc.chain.getBlockHash(block1);
    const hash2 = block2.startsWith("0x") ? block2 : await api.rpc.chain.getBlockHash(block2);

    console.log(`Comparing blocks:\n  Block 1: ${hash1}\n  Block 2: ${hash2}\n`);

    // Get all storage keys at each block
    console.log("Fetching storage keys...");
    const keys1 = await api.rpc.state.getKeys("0x", hash1);
    const keys2 = await api.rpc.state.getKeys("0x", hash2);

    const keySet1 = new Set(keys1.map((k) => k.toHex()));
    const keySet2 = new Set(keys2.map((k) => k.toHex()));

    // Find new and removed keys
    const newKeys = [...keySet2].filter((k) => !keySet1.has(k));
    const removedKeys = [...keySet1].filter((k) => !keySet2.has(k));
    const commonKeys = [...keySet1].filter((k) => keySet2.has(k));

    // Get storage values for common keys to detect changes
    console.log("Comparing storage values...");
    const changedKeys = [];
    let processed = 0;

    for (const key of commonKeys) {
      const value1: any = await api.rpc.state.getStorage(key, hash1);
      const value2: any = await api.rpc.state.getStorage(key, hash2);

      if (value1?.toHex() !== value2?.toHex()) {
        const decoded = await decodeStorageKey(api, key);
        changedKeys.push({
          key,
          decoded,
          oldValue: value1?.toHex() || "0x",
          newValue: value2?.toHex() || "0x",
        });
      }

      processed++;
      if (processed % 100 === 0) {
        process.stdout.write(`\rProcessed ${processed}/${commonKeys.length} keys...`);
      }
    }
    console.log("\n");

    // Decode new and removed keys
    const decodedNewKeys = [];
    for (const key of newKeys) {
      const decoded = await decodeStorageKey(api, key);
      const value: any = await api.rpc.state.getStorage(key, hash2);
      decodedNewKeys.push({
        key,
        decoded,
        value: value?.toHex() || "0x",
      });
    }

    const decodedRemovedKeys = [];
    for (const key of removedKeys) {
      const decoded = await decodeStorageKey(api, key);
      const value: any = await api.rpc.state.getStorage(key, hash1);
      decodedRemovedKeys.push({
        key,
        decoded,
        value: value?.toHex() || "0x",
      });
    }

    // Output results
    console.log(`=== Storage Diff Summary ===`);
    console.log(`New keys: ${newKeys.length}`);
    console.log(`Removed keys: ${removedKeys.length}`);
    console.log(`Changed values: ${changedKeys.length}`);
    console.log(`Unchanged keys: ${commonKeys.length - changedKeys.length}`);
    console.log(`Total keys in block 1: ${keys1.length}`);
    console.log(`Total keys in block 2: ${keys2.length}`);

    // Group by pallet for better organization
    const groupByPallet = (items): Record<string, any[]> => {
      const grouped = {};
      for (const item of items) {
        const pallet = item.decoded.pallet;
        if (!grouped[pallet]) grouped[pallet] = [];
        grouped[pallet].push(item);
      }
      return grouped;
    };

    if (newKeys.length > 0) {
      console.log(`\n=== New Keys ===`);
      const grouped = groupByPallet(decodedNewKeys);
      for (const [pallet, items] of Object.entries(grouped)) {
        console.log(`\n${pallet}:`);
        for (const item of items) {
          const valuePreview =
            item.value.length > 66 ? item.value.slice(0, 66) + "..." : item.value;
          console.log(`  + ${item.decoded.storage}: ${valuePreview}`);
        }
      }
    }

    if (removedKeys.length > 0) {
      console.log(`\n=== Removed Keys ===`);
      const grouped = groupByPallet(decodedRemovedKeys);
      for (const [pallet, items] of Object.entries(grouped)) {
        console.log(`\n${pallet}:`);
        for (const item of items) {
          console.log(`  - ${item.decoded.storage}`);
        }
      }
    }

    if (changedKeys.length > 0) {
      console.log(`\n=== Changed Values ===`);
      const grouped = groupByPallet(changedKeys);
      for (const [pallet, items] of Object.entries(grouped)) {
        console.log(`\n${pallet}:`);
        for (const item of items) {
          console.log(`  ~ ${item.decoded.storage}:`);
          const oldPreview =
            item.oldValue.length > 66 ? item.oldValue.slice(0, 66) + "..." : item.oldValue;
          const newPreview =
            item.newValue.length > 66 ? item.newValue.slice(0, 66) + "..." : item.newValue;
          console.log(`    Old: ${oldPreview}`);
          console.log(`    New: ${newPreview}`);
        }
      }
    }

    // Optional: Save full diff to file
    if (process.argv.includes("--save")) {
      const fs = require("fs");
      const diff = {
        metadata: {
          block1: hash1.toString(),
          block2: hash2.toString(),
          timestamp: new Date().toISOString(),
          endpoint,
        },
        summary: {
          newKeys: newKeys.length,
          removedKeys: removedKeys.length,
          changedKeys: changedKeys.length,
          unchangedKeys: commonKeys.length - changedKeys.length,
        },
        newKeys: decodedNewKeys.map((item) => ({
          key: item.key,
          pallet: item.decoded.pallet,
          storage: item.decoded.storage,
          value: item.value,
        })),
        removedKeys: decodedRemovedKeys.map((item) => ({
          key: item.key,
          pallet: item.decoded.pallet,
          storage: item.decoded.storage,
          value: item.value,
        })),
        changedKeys: changedKeys.map((item) => ({
          key: item.key,
          pallet: item.decoded.pallet,
          storage: item.decoded.storage,
          oldValue: item.oldValue,
          newValue: item.newValue,
        })),
      };

      const filename = `storage-diff-${block1}-${block2}.json`;
      fs.writeFileSync(filename, JSON.stringify(diff, null, 2));
      console.log(`\nFull diff saved to ${filename}`);
    }
  } catch (error) {
    console.error("Error:", error.message);
    console.error(error.stack);
  } finally {
    await api.disconnect();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  save: false,
  filter: null,
  format: "console",
};

// Parse options
let positionalArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--save") {
    options.save = true;
  } else if (args[i] === "--filter" && i + 1 < args.length) {
    options.filter = args[++i];
  } else if (args[i] === "--json") {
    options.format = "json";
  } else if (!args[i].startsWith("--")) {
    positionalArgs.push(args[i]);
  }
}

if (positionalArgs.length < 3) {
  console.log("Substrate Storage Diff Tool");
  console.log("===========================\n");
  console.log("Usage: node storage-diff.js <ws_endpoint> <block1> <block2> [options]");
  console.log("\nArguments:");
  console.log("  ws_endpoint  WebSocket endpoint (e.g., ws://localhost:9944)");
  console.log("  block1       First block (number or hash)");
  console.log("  block2       Second block (number or hash)");
  console.log("\nOptions:");
  console.log("  --save       Save full diff to JSON file");
  console.log("  --filter     Filter by pallet name (e.g., --filter System)");
  console.log("  --json       Output in JSON format instead of console");
  console.log("\nExamples:");
  console.log("  node storage-diff.js ws://localhost:9944 100 200");
  console.log("  node storage-diff.js ws://localhost:9944 0x123... 0x456... --save");
  console.log("  node storage-diff.js ws://localhost:9944 100 200 --filter Balances");
  console.log("  node storage-diff.js ws://localhost:9944 100 200 --json > diff.json");
  process.exit(1);
}

compareBlocks(positionalArgs[0], positionalArgs[1], positionalArgs[2]).catch(console.error);
