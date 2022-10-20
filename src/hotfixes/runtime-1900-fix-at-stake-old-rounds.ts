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
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { Keyring } from "@polkadot/api";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";
import { BN } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";

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
    "send-preimage-hash": { type: "boolean", demandOption: false, alias: "h" },
    "send-proposal-as": {
      choices: ["democracy", "council-external"],
      demandOption: false,
      alias: "s",
    },
    "collective-threshold": { type: "number", demandOption: false, alias: "c" },
    "at-block": { type: "number", demandOption: false },
  }).argv;

async function main() {
  const api = await getApiFor(argv);
  const blockHash = await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);

  const keyring = new Keyring({ type: "ethereum" });
  const atBlock = argv["at-block"]
    ? new BN(argv["at-block"])
    : (await api.rpc.chain.getBlock()).block.header.number.toBn();
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
    const round = await apiAt.query.parachainStaking.round();
    const maxUnpaidRound = round.current.sub(apiAt.consts.parachainStaking.rewardPaymentDelay);

    const checkedRounds = {};
    const keysToRemove = [];
    for await (const key of await apiAt.query.parachainStaking.atStake.keys()) {
      const [round, candidate] = key.args;
      const checkKey = round.toString();

      // skip if unpaid round
      if (round >= maxUnpaidRound) {
        continue;
      }

      // skip if round was checked already and flagged as "cannot remove"
      if (checkedRounds[checkKey] === false) {
        continue;
      }

      // check if round can be removed (Points & DelayedPayout entries do not exist)
      if (!(checkKey in checkedRounds)) {
        if (!(await apiAt.query.parachainStaking.points.size(round)).isZero()) {
          console.warn(
            `Storage "Points" is not empty for round ${round.toString()}, entries will not be cleaned`
          );
          checkedRounds[checkKey] = false;
          continue;
        }

        if (!(await apiAt.query.parachainStaking.delayedPayouts.size(round)).isZero()) {
          console.warn(
            `Storage "DelayedPayouts" is not empty for round ${round.toString()}, entries will not be cleaned`
          );
          checkedRounds[checkKey] = false;
          continue;
        }

        checkedRounds[checkKey] = true;
      }

      keysToRemove.push({
        round,
        candidate,
        key: key.toHex(),
      });
    }

    const chunkSize = 100;
    console.log(`hotfixing ${keysToRemove.length} accounts in chunks of ${chunkSize}`);

    for (
      let i = 0, nextScheduleAt = atBlock.addn(1);
      i < keysToRemove.length;
      i += chunkSize, nextScheduleAt = nextScheduleAt.addn(1)
    ) {
      const chunk = keysToRemove.slice(i, i + chunkSize).map((k) => k.key);
      const txKillStorage = await api.tx.system.killStorage(chunk).signAsync(account);

      // prepare the proposals
      console.log(
        `propose batch ${(i % (chunkSize - 1)) + 1} for #${nextScheduleAt.toString()}: ${chunk.join(
          ", "
        )}`
      );
      const toPropose = api.tx.scheduler.schedule(nextScheduleAt, null, 0, { Value: txKillStorage });
      let encodedProposal = toPropose?.method.toHex() || "";
      let encodedHash = blake2AsHex(encodedProposal);
      console.log("Encoded proposal after schedule is", encodedProposal);
      console.log("Encoded proposal hash after schedule is", encodedHash);
      console.log("Encoded length", encodedProposal.length);

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
