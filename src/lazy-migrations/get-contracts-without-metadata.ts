import yargs from "yargs";
import * as fs from "fs";
import * as path from "path";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { blake2AsHex, xxhashAsHex } from "@polkadot/util-crypto";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
// @ts-ignore - Raw type exists at runtime
import type { Raw } from "@polkadot/types-codec";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    limit: {
      type: "number",
      default: 1000,
      describe: "The maximum number of storage entries to process per batch",
    },
    request_delay: {
      type: "number",
      default: 500,
      describe: "Delay between requests in ms",
    },
  }).argv;

async function main() {
  const api = await getApiFor(argv);

  try {
    const chain = (await api.rpc.system.chain()).toString().toLowerCase().replace(/\s/g, "-");

    const TEMPORARY_DB_FILE = path.resolve(
      process.cwd(),
      `src/lazy-migrations/contracts-without-metadata-addresses-${chain}-db.json`,
    );

    let db = {
      contract_processed: 0,
      contracts_without_metadata: {},
      fixed_contracts: {},
      cursor: "",
    };

    if (fs.existsSync(TEMPORARY_DB_FILE)) {
      db = {
        ...db,
        ...JSON.parse(fs.readFileSync(TEMPORARY_DB_FILE, { encoding: "utf-8" })),
      };
    }

    const evmAccountCodePrefix =
      xxhashAsHex("EVM", 128) + xxhashAsHex("AccountCodes", 128).slice(2);
    const evmAccountCodeMetadataPrefix =
      xxhashAsHex("EVM", 128) + xxhashAsHex("AccountCodesMetadata", 128).slice(2);

    const ITEMS_PER_PAGE = argv.limit;

    while (db.cursor !== undefined) {
      const keys = await api.rpc.state.getKeysPaged(
        evmAccountCodePrefix,
        ITEMS_PER_PAGE,
        db.cursor,
      );

      db.cursor = keys.length > 0 ? keys[keys.length - 1].toHex() : undefined;
      console.log(`Cursor: ${db.cursor}, Keys fetched: ${keys.length}`);

      if (keys.length === 0) {
        console.log("No more keys to process.");
        break;
      }

      const metadataKeys = [];
      const addresses = [];

      for (const key of keys) {
        const SKIP_BYTES = 16 + 16 + 16;
        const address =
          "0x" +
          key
            .toHex()
            .slice(2)
            .slice(SKIP_BYTES * 2);
        addresses.push(address);

        const address_blake2_hash = blake2AsHex(address, 128).slice(2);
        const contract_metadata_key =
          evmAccountCodeMetadataPrefix + address_blake2_hash + address.slice(2);
        metadataKeys.push(contract_metadata_key);
      }

      // Batch query the storage for metadata keys
      const storageValues = (await api.rpc.state.queryStorageAt(metadataKeys)) as Raw[];

      // Process the results
      storageValues.forEach((storageValue, index) => {
        if (storageValue.isEmpty) {
          const _address = addresses[index];
          db.contracts_without_metadata[_address] = true;
        }
        db.contract_processed++;
      });

      // Save progress periodically
      if (db.contract_processed % 1000 === 0) {
        fs.writeFileSync(TEMPORARY_DB_FILE, JSON.stringify(db, null, 2));
      }

      // Optional delay to prevent overloading the API
      await new Promise((resolve) => setTimeout(resolve, argv.request_delay));
    }

    // Final save
    fs.writeFileSync(TEMPORARY_DB_FILE, JSON.stringify(db, null, 2));
    console.log("Processing completed.");
  } catch (error) {
    console.error(error);
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => console.error("Error:", error));
