/*
  This script is intended to run once as hotfix for specific networks.
  Do not use it without reading the code !!

  This script will find the entries in `AtStake` for rounds before `RewardsPaymentDelay` that
  have already been paid. If no storage entry exists for these rounds in `Points` and `DelayedPayouts`
  then all the (round, candidate) keys for the given round will be cleared in batches of 100 per block.

Ex: ./node_modules/.bin/ts-node-transpile-only src/hotfixes/runtime-1900-fix-at-stake-old-rounds \
   --network alphanet \
   --send-preimage-hash \
   --send-proposal-as council-external \
   --collective-threshold 3 \
   --account-priv-key <key> \
*/
import yargs from "yargs";
import chalk from "chalk";
import Debug from "debug";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { Keyring } from "@polkadot/api";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { BN } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import { promiseConcurrent } from "../utils/functions";
const debug = Debug("hotfix:1900-at-stake");

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
    const currentRound = await apiAt.query.parachainStaking.round();
    console.log(`[#${atBlock}] Starting: ${currentRound}`);
    const maxUnpaidRound = currentRound.current.sub(
      apiAt.consts.parachainStaking.rewardPaymentDelay
    );

    const checkedRounds = {};
    const keysToRemove: {
      round: number;
      storageSize: number;
      candidate: string;
      key: string;
    }[] = [];

    const limit = 1000;
    let lastKey = "";
    let queryCount = 0;

    while (true) {
      let query = await apiAt.query.parachainStaking.atStake.keysPaged({
        args: [],
        pageSize: limit,
        startKey: lastKey,
      });

      if (query.length == 0) {
        break;
      }
      lastKey = query[query.length - 1].toString();
      queryCount += query.length;

      const newKeysToRemove = await promiseConcurrent(
        10,
        async (key) => {
          const [round, candidate] = key.args;
          const checkKey = round.toString();

          // skip if unpaid round
          if (round.gte(maxUnpaidRound)) {
            debug(
              `Skipping round ${round} (current: ${currentRound.current.toNumber()}): ${candidate.toString()}`
            );
            return;
          }

          // skip if round was checked already and flagged as "cannot remove"
          if (checkedRounds[checkKey] === false) {
            return;
          }

          // check if round can be removed (Points & DelayedPayout entries do not exist)
          if (!(checkKey in checkedRounds)) {
            if (!(await apiAt.query.parachainStaking.points.size(round)).isZero()) {
              console.warn(
                `Storage "Points" is not empty for round ${round.toString()}, entries will not be cleaned`
              );
              checkedRounds[checkKey] = false;
              return;
            }

            if (!(await apiAt.query.parachainStaking.delayedPayouts.size(round)).isZero()) {
              console.warn(
                `Storage "DelayedPayouts" is not empty for round ${round.toString()}, entries will not be cleaned`
              );
              checkedRounds[checkKey] = false;
              return;
            }

            checkedRounds[checkKey] = true;
          }
          // Cannot use atStake(...) directly because of different types in 1900
          const storageSize = await api.rpc.state.getStorageSize(key, blockHash);
          debug(
            `Round ${round.toString().padStart(5, " ")} [${storageSize
              .toString()
              .padStart(5, " ")} Bytes]: ${candidate.toString()}`
          );

          return {
            round: round.toNumber(),
            storageSize: storageSize.toNumber() + key.toU8a().length,
            candidate: candidate.toString(),
            key: key.toHex(),
          };
        },
        query
      );
      keysToRemove.push(...newKeysToRemove.filter((data) => !!data));
      if (queryCount % limit == 0) {
        console.log(`Queried ${queryCount}...`);
      }
    }

    const roundsToRemove: { [round: number]: { candidates: number; storageSize: number } } =
      keysToRemove.reduce((p, v) => {
        if (!(v.round in p)) {
          p[v.round] = {
            candidates: 0,
            storageSize: 0,
          };
        }
        p[v.round].candidates++;
        p[v.round].storageSize += v.storageSize;
        return p;
      }, {});
    const maxStorageSize = 500_000; // 500kb
    const maxCall = 500; // 500 calls per batch
    console.log(
      `hotfixing ${keysToRemove.length} accounts through ${
        Object.keys(roundsToRemove).length
      } (max [storage: ${maxStorageSize}, calls: ${maxCall}] per batch)`
    );

    // We make batches of maxium ${maxAccountPerBatch} by adding 1 by 1
    const batches = Object.keys(roundsToRemove).reduce((p, roundNumber: any) => {
      const round = roundsToRemove[roundNumber];
      if (
        p.length == 0 ||
        p[p.length - 1].storageSize + round.storageSize > maxStorageSize ||
        p[p.length - 1].rounds.length == maxCall
      ) {
        p.push({ totalCandidates: 0, storageSize: 0, extrinsicSize: 0, rounds: [] });
      }
      p[p.length - 1].totalCandidates += round.candidates;
      p[p.length - 1].storageSize += round.storageSize;
      p[p.length - 1].extrinsicSize += api.tx.system
        .killPrefix(api.query.parachainStaking.atStake.keyPrefix(roundNumber), 1000)
        .toU8a().length;
      p[p.length - 1].rounds.push({ round: roundNumber, candidates: round.candidates });
      return p;
    }, [] as { totalCandidates: number; extrinsicSize: number; storageSize: number; rounds: { round: number; candidates: number }[] }[]);

    const batchCount = batches.length;
    for (const [i, batch] of batches.entries()) {
      // console.log(`using key: ${api.query.parachainStaking.atStake.keyPrefix(batch.rounds[0])}`);

      const txKillStorage =
        batch.rounds.length > 1
          ? api.tx.utility.batchAll([
              api.tx.system.remarkWithEvent(
                `State cleanup: at-stake-old-round storage batch ${i + 1}/${batchCount} (keys: ${
                  batch.rounds.length
                } - storage: ~${Math.floor(batch.storageSize / 1024)}kB)`
              ),
              ...batch.rounds.map(({ round, candidates }) =>
                api.tx.system.killPrefix(
                  api.query.parachainStaking.atStake.keyPrefix(round),
                  candidates + 1
                )
              ),
            ])
          : api.tx.system.killPrefix(
              api.query.parachainStaking.atStake.keyPrefix(batch.rounds[0].round),
              batch.rounds[0].candidates + 1
            );
      // prepare the proposals
      console.log(
        `propose batch ${i} for block +${i + 1}: [Rounds: ${batch.rounds.length} - Candidates: ${
          batch.totalCandidates
        } - Extrinsic: ${chalk.red(
          `${Math.floor(batch.extrinsicSize / 1024)}kB`
        )} - Storage: ${chalk.red(`${Math.floor(batch.storageSize / 1024)}kB`)}]`
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
