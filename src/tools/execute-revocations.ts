// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import yargs from "yargs";
import Web3 from "web3";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";
import { promiseConcurrent } from "../utils/functions";
import "@moonbeam-network/api-augment";
import { ParachainStakingDelegationRequest } from "@polkadot/types/lookup";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    collators: {
      type: "array",
      string: true,
      description: "addresses of the collator",
      demandOption: true,
    },
    "eth-url": {
      type: "string",
      description: "RPC url for Eth API",
      demandOption: true,
    },
    "private-key": {
      type: "string",
      description: "Private key to transfer from",
      conflicts: ["to"],
    },
    threshold: {
      type: "number",
      description: "Minimum number of token for revocations to execute (0 for no threshold)",
      default: 0,
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const web3 = new Web3(argv["eth-url"]);
  const revoker = web3.eth.accounts.privateKeyToAccount(argv["private-key"]);

  const gasPrice = ((await api.query.baseFee.baseFeePerGas()).toBigInt() + 49n).toString();

  const formattedCollators = argv.collators.map(
    (collator) => api.registry.createType("EthereumAccountId", collator).toHex() as string
  );

  const chainId = (await api.query.ethereumChainId.chainId()).toNumber();
  let nonce = await web3.eth.getTransactionCount(revoker.address);
  let balance = await web3.eth.getBalance(revoker.address);
  console.log(`Using ${revoker.address}: nonce ${nonce}, balance ${balance}`);
  console.log(`Listing revocations for ${formattedCollators.join(", ")}`);

  const [roundInfo, delegatorState] = await Promise.all([
    (await api.query.parachainStaking.round()) as any,
    await api.query.parachainStaking.delegatorState.entries(),
  ]);

  const requests: {
    requester: string;
    request: ParachainStakingDelegationRequest;
    collator: string;
  }[] = [];
  const leaves: { requester: string; amount: bigint; count: number }[] = [];
  for (const state of delegatorState) {
    const stateData = state[1].unwrap();

    const delegationAmounts = stateData.delegations.reduce((p, delegation) => {
      p = delegation.amount.toBigInt();
      return p;
    }, 0n);
    const hasDelegationsToCollators = stateData.delegations.find((delegation) =>
      formattedCollators.includes(delegation.owner.toHex())
    );
    if (!hasDelegationsToCollators) {
      continue;
    }

    const isLeaving =
      stateData.status.isLeaving &&
      stateData.status.asLeaving.toNumber() <= roundInfo.current.toNumber();

    if (isLeaving) {
      leaves.push({
        requester: stateData.id.toHex(),
        amount: delegationAmounts,
        count: stateData.delegations.length,
      });
    } else if (stateData.requests.revocationsCount.toNumber() > 0) {
      // console.log(stateData.toJSON());
      const requestData = stateData.requests.requests;
      for (const collator of formattedCollators) {
        const request = Array.from(requestData.values()).find(
          (r) => r.collator.toHex() == collator
        );
        if (
          request &&
          request.whenExecutable <= roundInfo.current.toNumber() &&
          (!argv.threshold || request.amount.toBigInt() / 10n ** 18n > argv.threshold) &&
          stateData.delegations.find(({ owner }) => owner.toHex() == collator)
        ) {
          requests.push({
            collator,
            requester: stateData.id.toHex(),
            request,
          });
        }
      }
    }
  }

  const txs = await Promise.all([
    ...requests.map(async (req) => {
      const tokens = req.request.amount.toBigInt() / 10n ** 18n;
      const tokenString =
        tokens > 20000n
          ? chalk.red(tokens.toString().padStart(6))
          : tokens > 2000n
          ? chalk.yellow(tokens.toString().padStart(6))
          : tokens.toString().padStart(6);

      console.log(`${req.collator}: ${tokenString} by ${req.requester}`);

      const txData = {
        from: revoker.address,
        to: "0x0000000000000000000000000000000000000800",
        data: `0xe42366a6${req.requester.slice(2).toLowerCase().padStart(64, "0")}${req.collator
          .slice(2)
          .toLowerCase()
          .padStart(64, "0")}`,
        gasPrice,
        gas: 300000,
        value: 0,
        nonce: nonce++,
      };
      console.log(`Less: ${JSON.stringify(txData)}`);
      return web3.eth.accounts.signTransaction(txData, revoker.privateKey);
    }),
    ...leaves.map(async ({ requester, amount, count }) => {
      const tokens = amount / 10n ** 18n;
      const tokenString =
        tokens > 20000n
          ? chalk.red(tokens.toString().padStart(6))
          : tokens > 2000n
          ? chalk.yellow(tokens.toString().padStart(6))
          : tokens.toString().padStart(6);

      console.log(`Leave: ${tokenString} by ${requester}`);

      const txData = {
        from: revoker.address,
        to: "0x0000000000000000000000000000000000000800",
        data: `0xa84a7468${requester.slice(2).toLowerCase().padStart(64, "0")}${count
          .toString(16)
          .padStart(64, "0")}`,
        gasPrice,
        gas: 300000,
        value: 0,
        nonce: nonce++,
        chainId,
      };
      console.log(`Leave: ${JSON.stringify(txData)}`);
      return web3.eth.accounts.signTransaction(txData, revoker.privateKey);
    }),
  ]);

  const revokes = await promiseConcurrent(
    10,
    (tx) =>
      web3.eth.sendSignedTransaction(tx.rawTransaction).catch((e) => console.log(`Error: ${e}`)),
    txs
  );

  console.log(`Sent ${revokes.length} revokes`);
  console.log(`${JSON.stringify(revokes, null, 2)}`);

  await api.disconnect();
};

main();
