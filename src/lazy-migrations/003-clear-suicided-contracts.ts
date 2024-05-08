/*
  Fixes contracts that have been destructed without removing their storage

Ex: ./node_modules/.bin/ts-node src/lazy-migrations/003-clear-suicided-contracts.ts \
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
    limit: {
      type: "number",
      default: 100,
      describe: "The maximum number of storage entries to be removed by this call",
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

async function suicidedContractsRemoved(api: ApiPromise): Promise<number> {
  return (
    await api.query["moonbeamLazyMigrations"].suicidedContractsRemoved()
  ).toPrimitive() as number;
}

async function main() {
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const entries_to_remove = argv["limit"];
  const request_delay = argv["request-delay"];

  try {
    const chain = (await api.rpc.system.chain()).toString().toLowerCase().replaceAll(/\s/g, "-");
    const TEMPORADY_DB_FILE = path.resolve(
      __dirname,
      `003-clear-suicided-contracts-${chain}-db.json`
    );

    let db = {
      processed_addresses: 0,
      corrupted_addresses: {},
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

    let removedSuicidedContracts = await suicidedContractsRemoved(api);
    console.log(`Contracts already removed before this run: `, removedSuicidedContracts);

    const systemAccountPrefix = xxhashAsHex("System", 128) + xxhashAsHex("Account", 128).slice(2);
    const evmIsSuicidedPrefix = xxhashAsHex("EVM", 128) + xxhashAsHex("Suicided", 128).slice(2);
    const evmHasCodePrefix = xxhashAsHex("EVM", 128) + xxhashAsHex("AccountCodes", 128).slice(2);
    const evmHasStoragesPrefix =
      xxhashAsHex("EVM", 128) + xxhashAsHex("AccountStorages", 128).slice(2);

    const ITEMS_PER_PAGE = 1000;
    while (db.cursor != undefined) {
      const keys = await api.rpc.state.getKeysPaged(
        systemAccountPrefix,
        ITEMS_PER_PAGE,
        db.cursor,
        db.at_block
      );
      db.cursor = keys.length > 0 ? keys[keys.length - 1].toHex() : undefined;
      console.log(db.cursor, keys.length);

      let contract_suicided_keys = {};
      for (let key of keys) {
        const SKIP_BYTES =
          16 /* pallet prefix */ + 16 /* storage prefix */ + 16; /* address prefix */
        const address = key
          .toHex()
          .slice(2)
          .slice(SKIP_BYTES * 2);
        const address_blake2_hash = blake2AsHex("0x" + address, 128).slice(2);

        const contract_suicided_key = evmIsSuicidedPrefix + address_blake2_hash + address;
        contract_suicided_keys[contract_suicided_key] = address;
      }

      let keys_vec = Object.keys(contract_suicided_keys);
      const is_suicided_result = (await api.rpc.state.queryStorageAt(
        keys_vec,
        db.at_block
      )) as unknown as Raw[];

      const not_suicided_contracts = is_suicided_result.reduce((s, v, idx) => {
        if (v.isEmpty) {
          s.push(contract_suicided_keys[keys_vec[idx]]);
        }
        return s;
      }, []);

      let contract_code_keys = {};
      for (let address of not_suicided_contracts) {
        const address_blake2_hash = blake2AsHex("0x" + address, 128).slice(2);

        const contract_code_key = evmHasCodePrefix + address_blake2_hash + address;
        contract_code_keys[contract_code_key] = address;
      }

      keys_vec = Object.keys(contract_code_keys);
      const has_code_result = (await api.rpc.state.queryStorageAt(
        keys_vec,
        db.at_block
      )) as unknown as Raw[];

      const codeless_contracts = has_code_result.reduce((s, v, idx) => {
        if (v.isEmpty) {
          s.push(contract_code_keys[keys_vec[idx]]);
        }
        return s;
      }, []);

      for (let address of codeless_contracts) {
        const address_blake2_hash = blake2AsHex("0x" + address, 128).slice(2);

        const contract_storage_key = evmHasStoragesPrefix + address_blake2_hash + address;
        const has_storage =
          (await api.rpc.state.getKeysPaged(contract_storage_key, 2, undefined, db.at_block))
            .length > 0;

        // Entering this condition means:
        // - The contract address is not contained in the suicided struct
        // - The contract has no code
        // - The contract still has storage entries
        if (has_storage) {
          console.log(`Found corrupted suicided contract: `, address);
          db.corrupted_addresses[address] = true;
        }

        // await 50ms for avoiding getting banned for spamming
        await new Promise((r) => setTimeout(r, request_delay));
      }

      db.processed_addresses += keys.length;
      console.log(`Processed a total of ${db.processed_addresses} addresses...`);

      // Save results
      fs.writeFileSync(TEMPORADY_DB_FILE, JSON.stringify(db, null, 4), { encoding: "utf-8" });
    }

    while (Object.keys(db.corrupted_addresses).length) {
      const prevRemovedSuicidedContracts = removedSuicidedContracts;
      const corrupted_contracts = Object.keys(db.corrupted_addresses).slice(0, 100);
      const extrinsicCall = api.tx["moonbeamLazyMigrations"].clearSuicidedContracts(
        corrupted_contracts,
        entries_to_remove
      );
      await extrinsicCall.signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: "migration" })
      );
      await waitForAllMonitoredExtrinsics();

      // Check if the storage of corrupted contracts has been removed
      removedSuicidedContracts = await suicidedContractsRemoved(api);
      if (prevRemovedSuicidedContracts === removedSuicidedContracts) {
        corrupted_contracts.forEach((addr) => {
          db.fixed_contracts[addr] = true;
          // Remove fixed addresses from corrupted addresses map
          delete db.corrupted_addresses[addr];
        });
        // Save results
        fs.writeFileSync(TEMPORADY_DB_FILE, JSON.stringify(db, null, 4), { encoding: "utf-8" });
      }
    }
  } finally {
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
