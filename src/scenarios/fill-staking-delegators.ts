// This script is expected to run against a parachain network (using launch.ts script)

import { Keyring } from "@polkadot/api";

import yargs from "yargs";
import { getMonitoredApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import { sendAllStreamAndWaitLast } from "../utils/transactions";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    delegations: {
      type: "number",
      default: 1000,
      description: "Delegations per collator",
    },
    from: {
      type: "string",
      description: "Private key to transfer from",
    },
    // Todo: use MinCandidateStk from constants instead
    amount: {
      type: "number",
      description: "Number of Token to delegate (default to minDelegatorStk)",
    },
    "transfer-initial-funds": {
      type: "boolean",
      default: false,
      description: "Should funds be transferered from Alice to those accounts",
    },
  }).argv;

const main = async () => {
  const api = await getMonitoredApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const minDelegatorStk = argv.amount
    ? BigInt(argv.amount) * 10n ** 18n
    : ((await api.consts.parachainStaking.minDelegatorStk) as any).toBigInt();

  // Create a bunch of delegator using deterministic private key

  const collators: {
    owner: any;
    amount: any;
  }[] = (await api.query.parachainStaking.candidatePool()) as any;

  console.log(`Found ${collators.length} collators...`);

  // Create a bunch of delegator using deterministic private key
  console.log(`Creating ${argv.delegations * collators.length} delegators...`);
  const delegators = await Promise.all(
    new Array(argv.delegations * collators.length).fill(0).map((_, i) => {
      return keyring.addFromUri(`0x${(i + 20000000).toString().padStart(64, "0")}`);
    })
  );

  if (argv["transfer-initial-funds"]) {
    if (!argv["from"]) {
      console.log(`Missing --from`);
      return;
    }
    const fromAccount = await keyring.addFromUri(argv.from);

    const amountToTransfer = minDelegatorStk + 1n * 10n ** 18n; // extra for fees
    const amountToTip = 1n * 10n ** 15n;
    const amountRequired = (amountToTransfer + amountToTip) * BigInt(delegators.length);
    const amountAvailable = (
      await api.query.system.account(fromAccount.address)
    ).data.free.toBigInt();

    if (amountRequired > amountAvailable) {
      console.log(
        `Amount required ${amountRequired} > amount available ${amountAvailable} (from ${fromAccount.address})`
      );
      return;
    }

    // Create transaction for 100 tokens tranfer to each delegator, from Alith
    console.log(
      `Transferring ${(amountToTransfer + amountToTip) / 10n ** 18n} tokens to ${
        delegators.length
      } to delegators... (Total: ${amountRequired / (10n * 18n)} Tokens)`
    );

    const batchSize = 20000;
    for (let i = 0; i < delegators.length; i += batchSize) {
      const chunk = delegators.slice(i, i + batchSize);
      console.log(
        `Preparing to transfer to delegator ${i}...${Math.min(
          i + batchSize - 1,
          delegators.length - 1
        )}`
      );
      let fromNonce = (await api.rpc.system.accountNextIndex(fromAccount.address)).toNumber();
      const transferTxs = (
        await Promise.all(
          chunk.map(async (delegator, index) => {
            if (
              (await api.query.system.account(delegator.address as string)).data.free.toBigInt() >
              0n
            ) {
              return null;
            }
            return api.tx.balances
              .transfer(delegator.address, amountToTransfer)
              .signAsync(fromAccount, { nonce: fromNonce++, tip: amountToTip });
          })
        )
      ).filter((t) => !!t);
      console.log(
        `Transferring to delegator ${i}...${Math.min(i + batchSize - 1, delegators.length - 1)}`
      );
      if (transferTxs.length > 0) {
        // Send the transfer transactions and wait for the last one to finish
        await sendAllStreamAndWaitLast(api, transferTxs, { threshold: 5000, batch: 200 }).catch(
          (e) => {
            console.log(`Failing to send transfer`);
            console.log(e.msg || e.message || e.error);
            console.log(e.toString());
            console.log(JSON.stringify(e));
          }
        );
      }
    }
  }

  const transactions: SubmittableExtrinsic[] = [];
  await Promise.all(
    collators.map(async (_, collatorIndex) => {
      console.log(`Registering delegators for collator ${collatorIndex}`);

      const collator = (
        (await api.query.parachainStaking.candidateState(collators[collatorIndex].owner)) as any
      ).unwrap();

      const delegatorChunk = delegators.slice(
        collatorIndex * argv.delegations,
        (collatorIndex + 1) * argv.delegations
      );

      const existingDelegators = collator.delegators.reduce((p, v) => {
        p[v] = true;
        return p;
      }, {});

      // for each delegator (sequentially)
      console.log(`Delegating to collator ${collatorIndex}...`);
      let delegationCount = collator.delegators.length + 1;
      for (const delegator of delegatorChunk) {
        if (existingDelegators[delegator.address]) {
          continue;
        }
        // Retrieve the nonce
        const nonce = (await api.rpc.system.accountNextIndex(delegator.address)).toNumber();

        // Creates and Adds the nomination transaction (5 token)
        transactions.push(
          await api.tx.parachainStaking
            .delegate(collators[collatorIndex].owner, minDelegatorStk, delegationCount++, 1)
            .signAsync(delegator, { nonce })
        );
      }
    })
  );
  if (transactions.length !== 0) {
    await sendAllStreamAndWaitLast(api, transactions, { threshold: 2000, batch: 200, timeout: 300000 }).catch(
      (e) => {
        console.log(`Failing to send delegation`);
        console.log(e.msg || e.message || e.error);
        console.log(e.toString());
        console.log(JSON.stringify(e));
      }
    );
  }
  console.log(`Finished\nShutting down...`);
  // For some reason we need to wait to avoid error message
  await new Promise(resolve => {
    setTimeout(resolve, 5000);
  });

  await api.disconnect();
};

main();
