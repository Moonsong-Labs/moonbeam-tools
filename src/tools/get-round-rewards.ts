import { getApiFor, NETWORK_YARGS_OPTIONS } from "src/utils/networks";
import yargs from "yargs";

export const NETWORK_WS_URLS: { [name: string]: string } = {
  rococo: "wss://rococo-rpc.polkadot.io",
  westend: "wss://westend.api.onfinality.io/public-ws",
  kusama: "wss://kusama.api.onfinality.io/public-ws",
  polkadot: "wss://polkadot.api.onfinality.io/public-ws",
};

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "Block number",
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const block = await api.rpc.chain.getBlock(blockHash);
  const apiAt = await api.at(blockHash);

  const round = await apiAt.query.parachainStaking.round();
  const roundBlockApiAt = await api.at(await api.rpc.chain.getBlockHash(round.first));

  const atStake = await roundBlockApiAt.query.parachainStaking.atStake.entries();
  const awardedPts = await roundBlockApiAt.query.parachainStaking.awardedPts.entries();
  const collatorsPoints = {};
  console.log(`Using previous round: ${round.current.toNumber() - 1}`);
  for (const [key, value] of awardedPts) {
    const [stakeRound, collator] = key.args;
    if (stakeRound.toNumber() !== round.current.toNumber() - 1) {
      continue;
    }
    collatorsPoints[collator.toHex()] = (value as any).toNumber();
  }
  let paidBlock = round.first.toNumber() + 1;
  for (const [key] of atStake) {
    const [stakeRound, collator] = key.args;
    if (stakeRound.toNumber() !== round.current.toNumber() - 1) {
      continue;
    }
    console.log(
      `Account ${collator.toHuman()} had ${collatorsPoints[collator.toHex()]} at ${paidBlock++}`,
    );
  }
  await api.disconnect();
};

main();
