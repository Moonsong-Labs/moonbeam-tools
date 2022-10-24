/*
  This script is intended to run once as hotfix for specific networks.
  Do not use it without reading the code !!

  This script will find the storage keys for the now removed items `DelegatorReserveToLockMigrations`
  and `CollatorReserveToLockMigrations` and remove them in incremental blocks in 100kB batches.

Ex: ./node_modules/.bin/ts-node-transpile-only runtime-1900-fix-staking-reserve-to-lock-migration \
   --network alphanet \
   --send-preimage-hash \
   --send-proposal-as council-external \
   --collective-threshold 3 \
   --account-priv-key <key> \
*/
import yargs from "yargs";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { Keyring } from "@polkadot/api";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { BN, u8aToHex } from "@polkadot/util";
import { blake2AsHex, xxhashAsU8a } from "@polkadot/util-crypto";
import { promiseConcurrent } from "../utils/functions";
import { AnyTuple } from "@polkadot/types-codec/types";
import { StorageKey } from "@polkadot/types";

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
    sudo: {
      type: "boolean",
      demandOption: false,
      conflicts: ["send-preimage-hash", "send-proposal-as", "collective-threshold"],
    },
    "send-preimage-hash": { type: "boolean", demandOption: false, alias: "h" },
    "send-proposal-as": {
      choices: ["democracy", "council-external"],
      demandOption: false,
      alias: "s",
    },
    "collective-threshold": { type: "number", demandOption: false, alias: "c" },
    "at-block": { type: "number", demandOption: false },
  })
  .check((argv) => {
    if (
      (argv.sudo || argv["send-preimage-hash"] || argv["send-proposal-as"]) &&
      !argv["account-priv-key"]
    ) {
      throw new Error("Missing --account-priv-key");
    }
    return true;
  }).argv;

async function main() {
  const api = await getApiFor(argv);

  const keyring = new Keyring({ type: "ethereum" });
  const atBlock = argv["at-block"]
    ? new BN(argv["at-block"])
    : (await api.rpc.chain.getBlock()).block.header.number.toBn();
  const blockHash = await api.rpc.chain.getBlockHash(atBlock);
  const apiAt = await api.at(blockHash);

  const collectiveThreshold = argv["collective-threshold"] || 1;
  const proposalAmount = api.consts.democracy.minimumDeposit;

  let account;
  let nonce;
  if (argv["account-priv-key"]) {
    account = keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
    const { nonce: rawNonce, data: balance } = (await api.query.system.account(
      account.address
    )) as any;
    nonce = BigInt(rawNonce.toString());
  }

  try {
    const palletEncoder = new TextEncoder().encode("ParachainStaking");
    const palletHash = xxhashAsU8a(palletEncoder, 128);
    const delegatorReserveToLockMigrations = new TextEncoder().encode(
      "DelegatorReserveToLockMigrations"
    );
    const collatorReserveToLockMigrations = new TextEncoder().encode(
      "CollatorReserveToLockMigrations"
    );
    const storageHashDelegator = xxhashAsU8a(delegatorReserveToLockMigrations, 128);
    const storageHashCollator = xxhashAsU8a(collatorReserveToLockMigrations, 128);

    const keyDelegator = u8aToHex(new Uint8Array([...palletHash, ...storageHashDelegator]));
    const keyCollator = u8aToHex(new Uint8Array([...palletHash, ...storageHashCollator]));
    console.log(
      `DelegatorReserveToLockMigrations ${keyDelegator}\nCollatorReserveToLockMigrations  ${keyCollator}`
    );

    const keysToRemove: { key: StorageKey<AnyTuple>; storageSize: number }[] = [];
    for (const keyPrefix of [
      u8aToHex(new Uint8Array([...palletHash, ...storageHashDelegator])),
      u8aToHex(new Uint8Array([...palletHash, ...storageHashCollator])),
    ]) {
      const keys = await promiseConcurrent(
        10,
        async (key: any) => {
          return {
            key: key,
            storageSize:
              (await api.rpc.state.getStorageSize(key, blockHash)).toNumber() + key.toU8a().length,
          };
        },
        await api.rpc.state.getKeys(keyPrefix, blockHash)
      );

      keysToRemove.push(...keys);
    }

    const maxStorageSize = 100_000; // 100 kB
    const maxKeys = 100000;
    const batches: { storageSize: number; keys: StorageKey<AnyTuple>[] }[] = keysToRemove.reduce(
      (acc, item) => {
        // skip if item doesn't exist
        if (item.storageSize === 0) {
          return acc;
        }

        if (
          acc.length == 0 ||
          acc[acc.length - 1].storageSize + item.storageSize > maxStorageSize ||
          acc[acc.length - 1].keys.length == maxKeys
        ) {
          if (acc.length !== 0) {
            console.log(`batch[${acc.length}] ${acc[acc.length - 1].storageSize / 1024}kB`);
          }
          acc.push({ keys: [], storageSize: 0 });
        }

        acc[acc.length - 1].storageSize += item.storageSize;
        acc[acc.length - 1].keys.push(item.key);
        return acc;
      },
      [] as { storageSize: number; keys: StorageKey<AnyTuple>[] }[]
    );

    // console.log(batches);
    for (const [i, batch] of batches.entries()) {
      const txKillStorage =
        batch.keys.length > 1
          ? api.tx.utility.batchAll(
              batch.keys.map((k) =>
                api.tx.system.killPrefix(api.query.parachainStaking.atStake.keyPrefix(k), 1)
              )
            )
          : api.tx.system.killPrefix(
              api.query.parachainStaking.atStake.keyPrefix(batch.keys[0]),
              1
            );
      // prepare the proposals
      console.log(
        `propose batch ${i} for block +${i + 1}: [Keys: ${
          batch.keys.length
        } - Storage: ${Math.floor(batch.storageSize / 1024)}kb]`
      );
      const toPropose = api.tx.scheduler.scheduleAfter(i + 1, null, 0, {
        Value: txKillStorage,
      });
      let encodedProposal = toPropose?.method.toHex() || "";
      let encodedHash = blake2AsHex(encodedProposal);
      // console.log("Encoded proposal after schedule is", encodedProposal);
      // console.log("Encoded proposal hash after schedule is", encodedHash);
      // console.log("Encoded length", encodedProposal.length);

      if (argv["sudo"]) {
        await api.tx.sudo.sudo(toPropose).signAndSend(account, { nonce: nonce++ });
      } else {
        if (argv["send-preimage-hash"]) {
          await api.tx.democracy
            .notePreimage(encodedProposal)
            .signAndSend(account, { nonce: nonce++ });
        }

        if (argv["send-proposal-as"] == "democracy") {
          await api.tx.democracy
            .propose(encodedHash, proposalAmount)
            .signAndSend(account, { nonce: nonce++ });
        } else if (argv["send-proposal-as"] == "council-external") {
          let external = api.tx.democracy.externalProposeMajority(encodedHash);

          await api.tx.councilCollective
            .propose(collectiveThreshold, external, external.length)
            .signAndSend(account, { nonce: nonce++ });
        }
      }
    }
  } finally {
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
