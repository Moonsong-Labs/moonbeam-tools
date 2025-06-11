// This script is expected to run against a parachain network (using launch.ts script)
import chalk from "chalk";
import yargs from "yargs";

import { DelegatorRequest, getApiFor, NETWORK_YARGS_OPTIONS } from "../index";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    collator: {
      type: "string",
      description: "address of the collator",
      demandOption: true,
    },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);
  const specVersion = (await apiAt.query.system.lastRuntimeUpgrade())
    .unwrap()
    .specVersion.toNumber();

  const formattedCollator = api.registry.createType("EthereumAccountId", argv.collator).toString();

  const roundInfo = (await api.query.parachainStaking.round()) as any;
  const blockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  const roundBlockLefts = roundInfo.first.toNumber() - blockNumber;

  const requests: DelegatorRequest[] = [];
  let totalDelegations = 0;

  if (specVersion >= 1500) {
    const delegationRequests = (await apiAt.query.parachainStaking.delegationScheduledRequests(
      formattedCollator,
    )) as any;
    for (const request of delegationRequests) {
      requests.push({
        delegatorId: request.delegator.toHex(),
        collatorId: formattedCollator,
        when: request.whenExecutable.toNumber(),
        action: request.action.isRevoke ? "Revoke" : "Decrease",
        amount: request.action.isRevoke
          ? request.action.asRevoke.toBigInt()
          : request.action.asDecrease.toBigInt(),
      });
    }
    totalDelegations += delegationRequests.length;
  } else {
    const delegatorState = await apiAt.query.parachainStaking.delegatorState.entries();
    for (const state of delegatorState) {
      const stateData = state[1].unwrap();
      const delegatorId = stateData.id.toHex();

      totalDelegations += stateData.delegations.length;
      // @ts-ignore Types doesn't exist for delegatorState with requests
      const request = stateData.requests.requests.toJSON()[formattedCollator] as any;
      if (request) {
        requests.push({
          delegatorId,
          collatorId: formattedCollator,
          when: request.whenExecutable,
          action: request.action,
          amount: BigInt(request.amount),
        });
      }
    }
  }

  let totalRevoked = 0n;

  for (const req of requests.sort((a, b) => a.when - b.when)) {
    totalRevoked += req.action == "Revoke" ? BigInt(req.amount) : 0n;
    const tokens = BigInt(req.amount) / 10n ** 18n;
    const tokenString =
      tokens > 20000n
        ? chalk.red(tokens.toString().padStart(6))
        : tokens > 2000n
          ? chalk.yellow(tokens.toString().padStart(6))
          : tokens.toString().padStart(6);

    const blockLefts =
      (req.when - roundInfo.current.toNumber()) * roundInfo.length.toNumber() + roundBlockLefts;
    const timeLeft = blockLefts * 12;
    console.log(
      `#${req.when} (${Math.floor(timeLeft / 60 / 60)
        .toString()
        .padStart(5)}h): ${req.action.padStart(10)} ${tokenString} by ${req.delegatorId}`,
    );
  }
  console.log(`Pending revoke: ${totalRevoked / 10n ** 18n}`);
  console.log(`All collators delegations: ${totalDelegations}`);

  await api.disconnect();
};

main();
