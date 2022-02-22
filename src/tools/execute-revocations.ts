// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import yargs from "yargs";
import Web3 from "web3";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

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

  const formattedCollators = argv.collators.map((collator) =>
    api.registry.createType("EthereumAccountId", collator).toString()
  );

  let nonce = await web3.eth.getTransactionCount(revoker.address);
  let balance = await web3.eth.getBalance(revoker.address);
  console.log(`Using ${revoker.address}: nonce ${nonce}, balance ${balance}`);
  console.log(`Listing revocations for ${formattedCollators.join(", ")}`);

  const [roundInfo, delegatorState] = await Promise.all([
    (await api.query.parachainStaking.round()) as any,
    await api.query.parachainStaking.delegatorState.entries(),
  ]);

  let totalDelegations = 0;
  const requests: { id: any; request: any; collator: string }[] = [];
  for (const state of delegatorState) {
    const stateData = (state[1] as any).unwrap();
    totalDelegations += stateData.delegations.length;
    if (stateData.requests.revocationsCount > 0) {
      // console.log(stateData.toJSON());
      const requestData = stateData.requests.requests.toJSON();
      for (const collator of formattedCollators) {
        const request = requestData[collator];
        if (
          request &&
          request.whenExecutable <= roundInfo.current.toNumber() &&
          (!argv.threshold || BigInt(request.amount) / 10n ** 18n > argv.threshold) &&
          stateData.delegations.find(({owner}) => owner.toString() == collator)
        ) {
          requests.push({
            collator,
            id: stateData.id,
            request,
          });
        }
      }
    }
  }

  const revokes = await Promise.all(
    requests.map(async (req) => {
      const tokens = BigInt(req.request.amount) / 10n ** 18n;
      const tokenString =
        tokens > 20000n
          ? chalk.red(tokens.toString().padStart(6))
          : tokens > 2000n
          ? chalk.yellow(tokens.toString().padStart(6))
          : tokens.toString().padStart(6);

      console.log(`${req.collator}: ${tokenString} by ${req.id.toHex()}`);

      const tx = await web3.eth.accounts.signTransaction(
        {
          from: revoker.address,
          to: "0x0000000000000000000000000000000000000800",
          data: `0xe42366a6000000000000000000000000${req.id
            .toHex()
            .slice(2)}000000000000000000000000${req.collator.slice(2).toLowerCase()}`,
          gasPrice: web3.utils.toWei("100", "Gwei"),
          gas: 200000,
          value: 0,
          nonce: nonce++,
        },
        revoker.privateKey
      );

      return web3.eth
        .sendSignedTransaction(tx.rawTransaction)
        .catch((e) => console.log(`Error: ${e}`));
    })
  );
  console.log(`Sent ${revokes.length} revokes`);
  console.log(`${JSON.stringify(revokes, null, 2)}`);

  await api.disconnect();
};

main();
