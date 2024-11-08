//@ts-nocheck
//
//   This script is intended to run once as hotfix for specific networks.
//   Do not use it without reading the code !!
//
//   This script will find the entries in `AtStake` for rounds before `RewardsPaymentDelay` that
//   have already been paid. If no storage entry exists for these rounds in `Points` and `DelayedPayouts`
//   then all the (round, candidate) keys for the given round will be cleared in batches of 100 per block.
//
// Ex: bun src/hotfixes/runtime-1900-fix-at-stake-old-rounds \
//    --network alphanet \
//    --send-preimage-hash \
//    --send-proposal-as council-external \
//    --collective-threshold 3 \
//    --account-priv-key <key>
import "@moonbeam-network/api-augment";
import "@polkadot/api-augment";

import { Keyring } from "@polkadot/api";
import { SubmittableExtrinsic } from "@polkadot/api/types";
import { ISubmittableResult } from "@polkadot/types/types";
import { BN } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import chalk from "chalk";
import Debug from "debug";
import yargs from "yargs";

import { promiseConcurrent } from "../utils/functions.ts";
import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring.ts";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks.ts";

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
    proxy: {
      type: "string",
      demandOption: false,
      describe: "Account being proxied",
      conflicts: ["sudo"],
    },
    "proxy-type": {
      type: "string",
      demandOption: false,
      describe: "Type of proxy",
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
  const atBlock = argv["at-block"]
    ? new BN(argv["at-block"])
    : (await api.rpc.chain.getBlock()).block.header.number.toBn();
  const blockHash = await api.rpc.chain.getBlockHash(atBlock);
  const apiAt = await api.at(blockHash);

  const collectiveThreshold =
    argv["collective-threshold"] ||
    Math.ceil(((await api.query.councilCollective.members()).length * 3) / 5);
  const proposalAmount = api.consts.democracy.minimumDeposit;

  let account;
  let nonce;
  if (argv["account-priv-key"]) {
    account = keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
    console.log(`[#${atBlock}]    Using account: ${account.address}`);
    if (argv["proxy"]) {
      console.log(
        `[#${atBlock}] Proxying account: ${argv["proxy"]} ${
          argv["proxy-type"] ? `(${argv["proxy"]})` : ""
        }`,
      );
    }

    const { nonce: rawNonce, data: balance } = await api.query.system.account(
      account.address as string,
    );
    nonce = BigInt(rawNonce.toString());
  }

  try {
    const currentRound = await apiAt.query.parachainStaking.round();
    console.log(`[#${atBlock}]         Starting: ${currentRound}`);
    const maxUnpaidRound = currentRound.current.sub(
      apiAt.consts.parachainStaking.rewardPaymentDelay,
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
              `Skipping round ${round} (current: ${currentRound.current.toNumber()}): ${candidate.toString()}`,
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
                `Storage "Points" is not empty for round ${round.toString()}, entries will not be cleaned`,
              );
              checkedRounds[checkKey] = false;
              return;
            }

            if (!(await apiAt.query.parachainStaking.delayedPayouts.size(round)).isZero()) {
              console.warn(
                `Storage "DelayedPayouts" is not empty for round ${round.toString()}, entries will not be cleaned`,
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
              .padStart(5, " ")} Bytes]: ${candidate.toString()}`,
          );

          return {
            round: round.toNumber(),
            storageSize: storageSize.toNumber() + key.toU8a().length,
            candidate: candidate.toString(),
            key: key.toHex(),
          };
        },
        query,
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
    console.log(
      `Found ${keysToRemove.length} keys through ${Object.keys(roundsToRemove).length} rounds ${
        keysToRemove.length > 0
          ? `(oldest: ${Math.min(...(Object.keys(roundsToRemove) as any))}, most recent: ${Math.max(
              ...(Object.keys(roundsToRemove) as any),
            )})`
          : ``
      }`,
    );

    if (keysToRemove.length == 0) {
      return;
    }

    // Preparing the batches

    const maxStorageSize = 500_000; // 500kb
    const maxExtrinsicSize = 500_000; // 500kb
    const maxCall = 500; // 500 calls per batch

    console.log(
      `Applying batch limits: [storage: ${Math.floor(
        maxStorageSize / 1000,
      )}kB, extrinsic: ${Math.floor(maxExtrinsicSize / 1000)}kB, calls: ${maxCall}]`,
    );

    // We make batches of maxium ${maxAccountPerBatch} by adding 1 by 1
    const batches = Object.keys(roundsToRemove).reduce(
      (p, roundNumber: any) => {
        const round = roundsToRemove[roundNumber];
        const extrinsicSize = api.tx.system
          .killPrefix(api.query.parachainStaking.atStake.keyPrefix(roundNumber), 1000)
          .toU8a().length;
        if (
          p.length == 0 ||
          p[p.length - 1].storageSize + round.storageSize > maxStorageSize ||
          p[p.length - 1].extrinsicSize + extrinsicSize > maxExtrinsicSize ||
          p[p.length - 1].rounds.length == maxCall
        ) {
          p.push({ totalCandidates: 0, storageSize: 0, extrinsicSize: 0, rounds: [] });
        }
        p[p.length - 1].totalCandidates += round.candidates;
        p[p.length - 1].storageSize += round.storageSize;
        p[p.length - 1].extrinsicSize += extrinsicSize;
        p[p.length - 1].rounds.push({ round: roundNumber, candidates: round.candidates });
        return p;
      },
      [] as {
        totalCandidates: number;
        extrinsicSize: number;
        storageSize: number;
        rounds: { round: number; candidates: number }[];
      }[],
    );

    const batchCount = batches.length;

    const allProposals = batches.map((batch, i) => {
      // console.log(`using key: ${api.query.parachainStaking.atStake.keyPrefix(batch.rounds[0])}`);

      console.log(
        `propose batch ${i} for block +${i + 1}: [Rounds: ${batch.rounds.length} - Candidates: ${
          batch.totalCandidates
        } - Extrinsic: ${chalk.red(
          `${Math.floor(batch.extrinsicSize / 1000)}kB`,
        )} - Storage: ${chalk.red(`${Math.floor(batch.storageSize / 1000)}kB`)}]`,
      );
      // prepare the proposals
      return api.tx.scheduler.scheduleAfter(i + 1, null, 0, {
        Value:
          batch.rounds.length > 1
            ? api.tx.utility.batchAll([
                api.tx.system.remark(
                  `State cleanup: at-stake-old-round storage batch ${i + 1}/${batchCount} (keys: ${
                    batch.rounds.length
                  } - storage: ~${Math.floor(batch.storageSize / 1000)}kB)`,
                ),
                ...batch.rounds.map(({ round, candidates }) =>
                  api.tx.system.killPrefix(
                    api.query.parachainStaking.atStake.keyPrefix(round),
                    candidates + 1,
                  ),
                ),
              ])
            : api.tx.system.killPrefix(
                api.query.parachainStaking.atStake.keyPrefix(batch.rounds[0].round),
                batch.rounds[0].candidates + 1,
              ),
      });
    });

    const finalProposal = api.tx.utility.batchAll(allProposals);

    let encodedProposal = finalProposal.method.toHex();
    let encodedHash = blake2AsHex(encodedProposal);

    console.log(
      `propose all-in batch Extrinsic: ${chalk.red(
        `${Math.floor(finalProposal.toU8a().length / 1000)}kB`,
      )} - hash: ${encodedHash}`,
    );
    if (finalProposal.toU8a().length > maxExtrinsicSize) {
      throw new Error(
        `Final proposal is too big: ${finalProposal.toU8a().length} (limit: ${maxExtrinsicSize})`,
      );
    }

    const proxyTx = (call: SubmittableExtrinsic<"promise", ISubmittableResult>) => {
      if (argv["proxy"]) {
        return api.tx.proxy.proxy(argv["proxy"], (argv["proxy-type"] as any) || null, call);
      }
      return call;
    };

    if (argv["sudo"]) {
      await proxyTx(api.tx.sudo.sudo(finalProposal)).signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: "sudo" }),
      );
    } else {
      let refCount = (await api.query.democracy.referendumCount()).toNumber();
      if (argv["send-preimage-hash"]) {
        await proxyTx(api.tx.democracy.notePreimage(encodedProposal)).signAndSend(
          account,
          { nonce: nonce++ },
          monitorSubmittedExtrinsic(api, { id: "preimage" }),
        );
      }

      if (argv["send-proposal-as"] == "democracy") {
        await proxyTx(api.tx.democracy.propose(encodedHash, proposalAmount)).signAndSend(
          account,
          { nonce: nonce++ },
          monitorSubmittedExtrinsic(api, { id: "proposal" }),
        );
      } else if (argv["send-proposal-as"] == "council-external") {
        let external = api.tx.democracy.externalProposeMajority(encodedHash);

        await proxyTx(
          api.tx.councilCollective.propose(collectiveThreshold, external, external.length),
        ).signAndSend(
          account,
          { nonce: nonce++ },
          monitorSubmittedExtrinsic(api, { id: "proposal" }),
        );

        if (argv["fast-track"]) {
          let fastTrack = api.tx.democracy.fastTrack(encodedHash, 1, 0);

          await proxyTx(
            api.tx.techCommitteeCollective.propose(
              collectiveThreshold,
              fastTrack,
              fastTrack.length,
            ),
          ).signAndSend(
            account,
            { nonce: nonce++ },
            monitorSubmittedExtrinsic(api, { id: "fast-track" }),
          );
        }
      }

      if (argv["vote"]) {
        await proxyTx(
          api.tx.democracy.vote(refCount, {
            Standard: {
              balance: 1n * 10n ** BigInt(api.registry.chainDecimals[0]),
              vote: { aye: true, conviction: 1 },
            },
          }),
        ).signAndSend(account, { nonce: nonce++ }, monitorSubmittedExtrinsic(api, { id: "vote" }));
      }
    }
  } finally {
    await waitForAllMonitoredExtrinsics();
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
