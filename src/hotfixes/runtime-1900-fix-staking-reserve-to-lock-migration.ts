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

    const keyDelegator = new Uint8Array([...palletHash, ...storageHashDelegator]);
    const keyCollator = new Uint8Array([...palletHash, ...storageHashCollator]);
    console.log(
      `DelegatorReserveToLockMigrations ${u8aToHex(
        keyDelegator
      )}\nCollatorReserveToLockMigrations  ${u8aToHex(keyCollator)}`
    );

    const txKillStorage = api.tx.utility.batch(
      [keyDelegator, keyCollator].map((k) =>
        api.tx.system.killPrefix(k, 1)
      )
    );
    const toPropose = api.tx.scheduler.scheduleAfter(0, null, 0, {
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
  } finally {
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
