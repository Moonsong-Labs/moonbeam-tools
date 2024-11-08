// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../index.ts";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "at given block (past or future)",
      conflicts: ["in"],
    },
    in: {
      type: "number",
      description: "number of block in the future",
      conflicts: ["at"],
    },
  })
  .check((argv) => {
    return argv.at || argv.in;
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const currentBlock = await api.rpc.chain.getBlock();
  const atBlockNumber = argv.in ? currentBlock.block.header.number.toNumber() + argv.in : argv.at;

  if (atBlockNumber <= currentBlock.block.header.number.toNumber()) {
    const pastBlock = await api.rpc.chain.getBlock(
      (await api.rpc.chain.getBlockHash(atBlockNumber)).toString(),
    );
    const timestampExt = pastBlock.block.extrinsics.find(
      (e) => e.method.section == "timestamp" && e.method.method == "set",
    );

    const timestamp = api.registry.createType("Compact<u64>", timestampExt.data);

    console.log(`#${atBlockNumber}: ${new Date(timestamp.toNumber()).toUTCString()}`);
  }
  if (atBlockNumber > currentBlock.block.header.number.toNumber()) {
    const diffCount = atBlockNumber - currentBlock.block.header.number.toNumber();

    const currentTimestamp = api.registry.createType(
      "Compact<u64>",
      currentBlock.block.extrinsics.find(
        (e) => e.method.section == "timestamp" && e.method.method == "set",
      ).data,
    );

    const targetDate = new Date(currentTimestamp.toNumber() + 6000 * diffCount);
    console.log(
      `#${currentBlock.block.header.number.toNumber()}: ${new Date(
        currentTimestamp.toNumber(),
      ).toUTCString()}`,
    );

    // We get the timestamp from X blocks before to have a better approximation

    if (diffCount < currentBlock.block.header.number.toNumber()) {
      const previousBlock = await api.rpc.chain.getBlock(
        (
          await api.rpc.chain.getBlockHash(currentBlock.block.header.number.toNumber() - diffCount)
        ).toString(),
      );
      const previousTimestamp = api.registry.createType(
        "Compact<u64>",
        previousBlock.block.extrinsics.find(
          (e) => e.method.section == "timestamp" && e.method.method == "set",
        ).data,
      );

      const expectedDate = new Date(
        currentTimestamp.toNumber() + (currentTimestamp.toNumber() - previousTimestamp.toNumber()),
      );

      console.log(
        `#${atBlockNumber} (+${diffCount}): target: ${targetDate.toUTCString()}, expected: ${expectedDate.toUTCString()}`,
      );
    } else {
      console.log(`#${atBlockNumber} (+${diffCount}): target: ${targetDate.toUTCString()}`);
    }
  }
  await api.disconnect();
};

main();
