//@ts-nocheck
// This script is intended to run once as hotfix for specific networks.
// Do not use it without reading the code !!
//
// This script will find the storage keys for the now removed items `DelegatorReserveToLockMigrations`
// and `CollatorReserveToLockMigrations` and remove them in incremental blocks in 100kB batches.
//
// Ex: bun runtime-1900-fix-staking-reserve-to-lock-migration \
//    --network alphanet \
//    --send-preimage-hash \
//    --send-proposal-as council-external \
//    --collective-threshold 3 \
//    --account-priv-key <key>
import "@moonbeam-network/api-augment";
import "@polkadot/api-augment";

import { ApiPromise, Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { blake2AsHex, xxhashAsHex } from "@polkadot/util-crypto";
import yargs from "yargs";

import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";

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
    "fast-track": { type: "boolean", demandOption: false },
    vote: { type: "boolean", demandOption: false },
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

  async function getAllKeys(api: ApiPromise, prefix: string, blockHash: any, startKey?: string) {
    const keys = (
      await api.rpc.state.getKeysPaged(prefix, 1000, startKey || prefix, blockHash)
    ).map((d) => d.toHex());

    if (keys.length === 0) {
      return [];
    }
    return keys.concat(await getAllKeys(api, prefix, blockHash, keys[keys.length - 1]));
  }

  try {
    const atBlock =
      argv["at-block"] || (await api.rpc.chain.getBlock()).block.header.number.toNumber();
    const blockHash = await api.rpc.chain.getBlockHash(atBlock);

    const collectiveThreshold =
      argv["collective-threshold"] ||
      Math.ceil(((await api.query.councilCollective.members()).length * 3) / 5);
    const proposalAmount = api.consts.democracy.minimumDeposit;

    let account: KeyringPair;
    let nonce;
    if (argv["account-priv-key"]) {
      account = keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
      const { nonce: rawNonce, data: _balance } = (await api.query.system.account(
        account.address,
      )) as any;
      nonce = BigInt(rawNonce.toString());
    }

    const delegatorPrefix =
      xxhashAsHex("ParachainStaking", 128) +
      xxhashAsHex("DelegatorReserveToLockMigrations", 128).slice(2);
    const collatorPrefix =
      xxhashAsHex("ParachainStaking", 128) +
      xxhashAsHex("CollatorReserveToLockMigrations", 128).slice(2);

    const delegatorKeys = await getAllKeys(api, delegatorPrefix, blockHash);
    const collatorKeys = await getAllKeys(api, collatorPrefix, blockHash);

    console.log(
      `DelegatorReserveToLockMigrations: ${delegatorKeys.length
        .toString()
        .padStart(6, " ")} (prefix: ${delegatorPrefix})`,
    );
    console.log(
      ` CollatorReserveToLockMigrations: ${collatorKeys.length
        .toString()
        .padStart(6, " ")} (prefix: ${collatorPrefix})`,
    );

    const proposal = api.tx.utility.batch([
      api.tx.system.remark(
        `State cleanup: CollatorReserveToLockMigrations storage (keys: 1 - subkeys: ${collatorKeys.length})`,
      ),
      api.tx.system.killPrefix(collatorPrefix, collatorKeys.length),
      api.tx.system.remark(
        `State cleanup: DelegatorReserveToLockMigrations storage (keys: 1 - subkeys: ${delegatorKeys.length})`,
      ),
      api.tx.system.killPrefix(delegatorPrefix, delegatorKeys.length),
    ]);

    const encodedProposal = proposal.method.toHex();
    const encodedHash = blake2AsHex(encodedProposal);
    console.log("Encoded proposal after schedule is", encodedProposal);
    console.log("Encoded proposal hash after schedule is", encodedHash);
    console.log("Encoded length", encodedProposal.length);

    if (argv["sudo"]) {
      await api.tx.sudo
        .sudo(proposal)
        .signAndSend(account, { nonce: nonce++ }, monitorSubmittedExtrinsic(api, { id: "sudo" }));
    } else {
      const refCount = (await api.query.democracy.referendumCount()).toNumber();
      if (argv["send-preimage-hash"]) {
        await api.tx.democracy
          .notePreimage(encodedProposal)
          .signAndSend(
            account,
            { nonce: nonce++ },
            monitorSubmittedExtrinsic(api, { id: "preimage" }),
          );
      }

      if (argv["send-proposal-as"] === "democracy") {
        await api.tx.democracy
          .propose(encodedHash, proposalAmount)
          .signAndSend(
            account,
            { nonce: nonce++ },
            monitorSubmittedExtrinsic(api, { id: "proposal" }),
          );
      } else if (argv["send-proposal-as"] === "council-external") {
        const external = api.tx.democracy.externalProposeMajority(encodedHash);

        await api.tx.councilCollective
          .propose(collectiveThreshold, external, external.length)
          .signAndSend(
            account,
            { nonce: nonce++ },
            monitorSubmittedExtrinsic(api, { id: "proposal" }),
          );

        if (argv["fast-track"]) {
          const fastTrack = api.tx.democracy.fastTrack(encodedHash, 1, 0);

          await api.tx.techCommitteeCollective
            .propose(collectiveThreshold, fastTrack, fastTrack.length)
            .signAndSend(
              account,
              { nonce: nonce++ },
              monitorSubmittedExtrinsic(api, { id: "fast-track" }),
            );
        }
      }

      if (argv["vote"]) {
        await api.tx.democracy
          .vote(refCount, {
            Standard: {
              balance: 1n * 10n ** BigInt(api.registry.chainDecimals[0]),
              vote: { aye: true, conviction: 1 },
            },
          })
          .signAndSend(account, { nonce: nonce++ }, monitorSubmittedExtrinsic(api, { id: "vote" }));
      }
    }
  } finally {
    await waitForAllMonitoredExtrinsics();
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
