// This script is expected to run against a parachain network (using launch.ts script)
import { ParachainInherentData } from "@polkadot/types/interfaces";
import fs from "fs";
import yargs from "yargs";

import { exploreBlockRange, getApiFor, NETWORK_YARGS_OPTIONS } from "../index";

const INITIAL_ROUND_BLOCK = {
  moonbeam: 1200,
};

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    from: {
      type: "number",
      description: "from block number (included)",
    },
    to: {
      type: "number",
      description: "to block number (included)",
    },
    during: {
      type: "number",
      description: "amount of block to look at",
      default: 10000,
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);
  if (argv.during && argv.to && argv.from) {
    console.log(`--during is incompatible with --to and --from`);
    process.exit(1);
  }

  const toBlockNumber = argv.to
    ? argv.to
    : argv.during && argv.from
      ? argv.during + argv.from
      : (await api.rpc.chain.getBlock()).block.header.number.toNumber();
  const fromBlockNumber = argv.from ? argv.from : argv.during ? toBlockNumber - argv.during : 0;

  const collators = {};
  let blockCount = 0;
  let initialTimestamp = 0;
  let lastTimestamp = 0;
  const lastBlockRelayNumber = 0;
  const blocksPerRound = {};
  await exploreBlockRange(
    api,
    { from: fromBlockNumber, to: toBlockNumber, concurrency: 50 },
    async (blockDetails) => {
      if (blockDetails.block.header.number.toNumber() % 100 === 0) {
        console.log(`${blockDetails.block.header.number.toNumber()}...`);
      }
      if (!initialTimestamp || blockDetails.blockTime < initialTimestamp) {
        initialTimestamp = blockDetails.blockTime;
      }
      if (!lastTimestamp || blockDetails.blockTime > lastTimestamp) {
        lastTimestamp = blockDetails.blockTime;
      }

      const parachainData = blockDetails.block.extrinsics.find(
        (e) => e.method.section === "parachainSystem" && e.method.method === "setValidationData",
      ).args[0] as ParachainInherentData;

      const round = Math.ceil(
        (blockDetails.block.header.number.toNumber() - INITIAL_ROUND_BLOCK["moonbeam"]) / 1800,
      );
      blocksPerRound;
      if (!blocksPerRound[round]) {
        blocksPerRound[round] = {};
      }

      blocksPerRound[round][blockDetails.block.header.number.toNumber()] = {
        author: blockDetails.authorName,
        header: blockDetails.block.header,
        blockRelayNumber: parachainData.validationData.relayParentNumber.toNumber(),
      };

      if (!collators[blockDetails.authorName]) {
        collators[blockDetails.authorName] = 0;
      }
      collators[blockDetails.authorName]++;
      blockCount++;
    },
  );

  fs.writeFileSync("rewards.json", JSON.stringify(blocksPerRound, null, 2));

  for (const round of Object.keys(blocksPerRound)) {
    for (const blockNumber of Object.keys(blocksPerRound[round]).sort()) {
      const paraBlock = blocksPerRound[round][blockNumber];
      console.log(
        `${round}: #${blockNumber} (r: ${paraBlock.blockRelayNumber}) - ${paraBlock.author}`,
      );
    }
  }

  // console.log(
  //   `Total blocks: ${blockCount} (${Math.floor((lastTimestamp - initialTimestamp) / 1000)} secs)`
  // );
  // Object.keys(collators).forEach((collatorName) => {
  //   console.log(`${collatorName.padStart(44, " ")}: ${collators[collatorName]}`);
  // });
};

main();
