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
import { ApiPromise, Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { blake2AsHex, xxhashAsHex } from "@polkadot/util-crypto";

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

  try {
    const atBlock =
      argv["at-block"] || (await api.rpc.chain.getBlock()).block.header.number.toNumber();
    const blockHash = await api.rpc.chain.getBlockHash(atBlock);

    const collectiveThreshold = argv["collective-threshold"] || 1;
    const proposalAmount = api.consts.democracy.minimumDeposit;

    let account: KeyringPair;
    let nonce;
    if (argv["account-priv-key"]) {
      account = keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
      const { nonce: rawNonce, data: balance } = (await api.query.system.account(
        account.address
      )) as any;
      nonce = BigInt(rawNonce.toString());
    }

    async function getAllKeys(api: ApiPromise, prefix: string, startKey?: string) {
      const keys = (
        await api.rpc.state.getKeysPaged(prefix, 1000, startKey || prefix, blockHash)
      ).map((d) => d.toHex());

      if (keys.length == 0) {
        return [];
      }
      return keys.concat(await getAllKeys(api, prefix, keys[keys.length - 1]));
    }

    const delegatorPrefix =
      xxhashAsHex("ParachainStaking", 128) +
      xxhashAsHex("DelegatorReserveToLockMigrations", 128).slice(2);
    const collatorPrefix =
      xxhashAsHex("ParachainStaking", 128) +
      xxhashAsHex("CollatorReserveToLockMigrations", 128).slice(2);

    const delegatorKeys = await getAllKeys(api, delegatorPrefix);
    const collatorKeys = await getAllKeys(api, collatorPrefix);

    console.log(
      `DelegatorReserveToLockMigrations: ${delegatorKeys.length
        .toString()
        .padStart(6, " ")} (prefix: ${delegatorPrefix})`
    );
    console.log(
      ` CollatorReserveToLockMigrations: ${collatorKeys.length
        .toString()
        .padStart(6, " ")} (prefix: ${collatorPrefix})`
    );

    const maxSubKeys = 2000; // 2000 subkeys by kill
    const batchesCount = Math.ceil(delegatorKeys.length / maxSubKeys);
    const delegatorkills = new Array(batchesCount).fill(0).map((index) => {
      return api.tx.scheduler.scheduleAfter(index + 1, null, 0, {
        Value: api.tx.utility.batch([
          api.tx.utility.dispatchAs(
            { system: { signed: account?.address } },

            api.tx.system.remarkWithEvent(
              `State cleanup: DelegatorReserveToLockMigrations storage batch ${
                index + 1
              }/${batchesCount} (keys: 2 - subkeys: ${
                delegatorKeys.length + collatorPrefix.length
              })`
            )
          ),
          api.tx.system.killPrefix(delegatorPrefix, maxSubKeys),
        ]),
      });
    });

    const toPropose = api.tx.utility.batch([
      api.tx.utility.dispatchAs(
        { system: { signed: account?.address } },
        api.tx.system.remarkWithEvent(
          `State cleanup: CollatorReserveToLockMigrations storage batch ${1}/1 (keys: 2 - subkeys: ${
            delegatorKeys.length + collatorPrefix.length
          })`
        )
      ),
      api.tx.system.killPrefix(collatorPrefix, collatorKeys.length),
      ...delegatorkills,
    ]);
    let encodedProposal = toPropose?.method.toHex() || "";
    let encodedHash = blake2AsHex(encodedProposal);
    console.log("Encoded proposal after schedule is", encodedProposal);
    console.log("Encoded proposal hash after schedule is", encodedHash);
    console.log("Encoded length", encodedProposal.length);

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
        console.log(external);

        await api.tx.councilCollective
          .propose(collectiveThreshold, external, external.length)
          .signAndSend(account, { nonce: nonce++ });
      }
    }
  } finally {
    //await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
