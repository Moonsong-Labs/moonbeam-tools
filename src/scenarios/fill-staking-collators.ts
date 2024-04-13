// This script is expected to run against a parachain network (using launch.ts script)

import { Keyring } from "@polkadot/api";

import yargs from "yargs";
import { getMonitoredApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import { sendAllStreamAndWaitLast } from "../utils/transactions";
import { ALITH_PRIVATE_KEY, BALTATHAR_PRIVATE_KEY } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    collators: {
      type: "number",
      default: 2000,
      description: "Total collators",
    },
    "transfer-initial-funds": {
      type: "boolean",
      default: false,
      description: "Should funds be transferered from Alice to those accounts",
    },
    "setup-staking": {
      type: "boolean",
      default: false,
      description: "Will configure staking to support the given amount of collators",
    },
    "setup-eligibility": {
      type: "boolean",
      default: false,
      description: "Will configure author filter to allow all node to create blocks",
    },
  }).argv;

const main = async () => {
  const api = await getMonitoredApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });
  const alith = await keyring.addFromUri(ALITH_PRIVATE_KEY);
  const baltathar = await keyring.addFromUri(BALTATHAR_PRIVATE_KEY);

  const minCandidateStk = ((await api.consts.parachainStaking.minCollatorStk) as any).toBigInt();

  // Create a bunch of delegator using deterministic private key

  console.log(`Creating ${argv.collators - 2} collators...`);
  const collators = await Promise.all([
    alith,
    baltathar,
    ...new Array(argv.collators - 2).fill(0).map((_, i) => {
      return keyring.addFromUri(`0x${(i + 10000000).toString().padStart(64, "0")}`);
    }),
  ]);

  let aliceNonce = (await api.rpc.system.accountNextIndex(alith.address)).toNumber();

  if (argv["setup-staking"]) {
    console.log(`     Setting staking total selected to ${argv.collators}`);

    await api.tx.sudo
      .sudo(await api.tx.parachainStaking.setTotalSelected(argv.collators))
      .signAndSend(alith, { nonce: aliceNonce++ });

    console.log(`     Setting staking block per round to 100`);
    await api.tx.sudo
      .sudo(await api.tx.parachainStaking.setBlocksPerRound(100))
      .signAndSend(alith, { nonce: aliceNonce++ });
  }
  if (argv["setup-eligibility"]) {
    console.log(`     Setting author eligibility to 100%`);
    await api.tx.sudo.sudo(api.tx.authorFilter.setEligible(100)).signAndSend(alith, {
      nonce: aliceNonce++,
    });
  }

  if (argv["transfer-initial-funds"]) {
    console.log(
      `Transferring ${minCandidateStk / 10n ** 18n + 1n} tokens to ${
        argv.collators - 2
      } to collators...`,
    );
    const transferTxs = await Promise.all(
      collators.map((collator) =>
        api.tx.balances
          .transfer(collator.address, minCandidateStk + 1n * 10n ** 18n)
          .signAsync(alith, { nonce: aliceNonce++ }),
      ),
    );

    // Send the transfer transactions and wait for the last one to finish
    await sendAllStreamAndWaitLast(api, transferTxs);
  }

  const transactions: SubmittableExtrinsic[] = [];
  await Promise.all(
    collators.map(async (_, collatorIndex) => {
      console.log(`Registering collator ${collatorIndex}`);

      const collator = (
        (await api.query.parachainStaking.candidateState(collators[collatorIndex].address)) as any
      ).unwrapOr(null);

      if (collatorIndex < 2) {
        // Makes sure we add extra for Alith/Baltathar to keep them in top of list
        const nonce = (
          await api.rpc.system.accountNextIndex(collators[collatorIndex].address)
        ).toNumber();
        transactions.push(
          await api.tx.parachainStaking
            .candidateBondMore(minCandidateStk)
            .signAsync(collators[collatorIndex], { nonce }),
        );
      }

      if (!collator) {
        const nonce = (
          await api.rpc.system.accountNextIndex(collators[collatorIndex].address)
        ).toNumber();
        // Register candidate and assign Alith session key;
        transactions.push(
          await api.tx.parachainStaking
            .joinCandidates(minCandidateStk, argv.collators)
            .signAsync(collators[collatorIndex], { nonce }),
        );
      }
    }),
  );
  if (transactions.length !== 0) {
    await sendAllStreamAndWaitLast(api, transactions, { threshold: 5000, batch: 200 }).catch(
      (e) => {
        console.log(`Failing to send delegation`);
        console.log(e.msg || e.message || e.error);
        console.log(e.toString());
        console.log(JSON.stringify(e));
      },
    );
  }

  console.log(`Finished\nShutting down...`);
  // For some reason we need to wait to avoid error message
  await new Promise((resolve) => {
    setTimeout(resolve, 5000);
  });
  await api.disconnect();
};

main();
