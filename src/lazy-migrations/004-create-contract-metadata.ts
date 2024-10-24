/*
    Create metadata for old contracts that don't have it

Ex: ./node_modules/.bin/ts-node src/lazy-migrations/004-create-contract-metadata.ts \
   --url ws://localhost:9944 \
   --limit 1000 \
   --at <block_hash> \
   --account-priv-key <key> \
*/
import yargs from "yargs";
import fs from "fs";
import path from "path";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { ApiPromise, Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { blake2AsHex, xxhashAsHex } from "@polkadot/util-crypto";
import { Raw } from "@polkadot/types-codec";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring";
import { ALITH_PRIVATE_KEY } from "../utils/constants";

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
    "request-delay": {
      type: "number",
      default: 100,
      describe: "The delay between each account verification to avoid getting banned for spamming",
    },
    at: {
      type: "string",
      describe: "The block hash at which the state should be queried",
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

  const entries_to_remove = argv["limit"];
  const request_delay = argv["request-delay"];

  try {
    const chain = (await api.rpc.system.chain()).toString().toLowerCase().replaceAll(/\s/g, "-");
    const TEMPORADY_DB_FILE = path.resolve(
      __dirname,
      `004-create-contract-metadata-${chain}-db.json`,
    );

    let db = {
      contract_processed: 0,
      contracts_without_metadata: {},
      fixed_contracts: {},
      at_block: argv["at"],
      cursor: "",
    };
    if (fs.existsSync(TEMPORADY_DB_FILE)) {
      db = { ...db, ...JSON.parse(fs.readFileSync(TEMPORADY_DB_FILE, { encoding: "utf-8" })) };
    }
    db.at_block ||= (await api.query.system.parentHash()).toHex();

    let account: KeyringPair;
    let nonce;
    const privKey = argv["alith"] ? ALITH_PRIVATE_KEY : argv["account-priv-key"];
    if (privKey) {
      account = keyring.addFromUri(privKey, null, "ethereum");
      const { nonce: rawNonce } = await api.query.system.account(account.address);
      nonce = BigInt(rawNonce.toString());
    }

    const evmAccountCodePrefix = xxhashAsHex("EVM", 128) + xxhashAsHex("AccountCodes", 128).slice(2);
    const evmAccountCodeMetadataPrefix =
      xxhashAsHex("EVM", 128) + xxhashAsHex("AccountCodesMetadata", 128).slice(2);

    const ITEMS_PER_PAGE = 1000;
    while (db.cursor != undefined) {
      const keys = await api.rpc.state.getKeysPaged(
        evmAccountCodePrefix,
        ITEMS_PER_PAGE,
        db.cursor,
        db.at_block,
      );
      db.cursor = keys.length > 0 ? keys[keys.length - 1].toHex() : undefined;
      console.log(db.cursor, keys.length);

      let contract_metadata_keys = {};
      for (let key of keys) {
        const SKIP_BYTES =
          16 /* pallet prefix */ + 16 /* storage prefix */ + 16; /* address prefix */
        const address = key
          .toHex()
          .slice(2)
          .slice(SKIP_BYTES * 2);

        const address_blake2_hash = blake2AsHex("0x" + address, 128).slice(2);

        const contract_metadata_key =
          evmAccountCodeMetadataPrefix + address_blake2_hash + address;
        contract_metadata_keys[contract_metadata_key] = address;
      }

      let keys_vec = Object.keys(contract_metadata_keys);
      const has_metadata_result = (await api.rpc.state.queryStorageAt(
        keys_vec,
        db.at_block,
      )) as unknown as Raw[];

      has_metadata_result.forEach((v, idx) => {
        if (v.isEmpty) {
          db.contracts_without_metadata[contract_metadata_keys[keys_vec[idx]]] = true;
        }
      });

      db.contract_processed += keys.length;
      console.log(`Processed a total of ${db.contract_processed} addresses...`);

      // Save results
      fs.writeFileSync(TEMPORADY_DB_FILE, JSON.stringify(db, null, 4), { encoding: "utf-8" });
    }

    // Contract Metadata Tx
    let batchInner = [];
    let metaTx;
    // For each contract without metadata, create the metadata
    for (let contract of Object.keys(db.contracts_without_metadata)) {
      metaTx = await api.tx["moonbeamLazyMigrations"].createContractMetadata(contract);
      batchInner.push(metaTx);
    }
    let batchTx = await api.tx.utility.forceBatch(batchInner);

    console.log(`Call add contract metadata`);
    console.log(batchTx.method.toHex());

    await waitForAllMonitoredExtrinsics();

    // Check if metadata has been created
    for (let contract of Object.keys(db.contracts_without_metadata)) {
      const has_metadata = await api.query.evm.accountCodesMetadata(contract);
      if (!has_metadata.isEmpty) {
        db.fixed_contracts[contract] = true;
        // Remove fixed addresses from corrupted addresses map
        delete db.contracts_without_metadata[contract];
      }
    }

    // Save results
    fs.writeFileSync(TEMPORADY_DB_FILE, JSON.stringify(db, null, 4), { encoding: "utf-8" });
  } finally {
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
