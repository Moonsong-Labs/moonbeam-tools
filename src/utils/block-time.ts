import { ApiPromise } from "@polkadot/api";
import { SignedBlock } from "@polkadot/types/interfaces";
import moment, { Moment } from "moment";

async function getFutureBlockDate(
  api: ApiPromise,
  blockNumber: number,
  currentBlock: SignedBlock
) {
  const diffCount = blockNumber - currentBlock.block.header.number.toNumber();
  if (diffCount <= 0) {
    console.error("Block must be in the future");
    return;
  }

  const currentTimestamp = api.registry.createType(
    "Compact<u64>",
    currentBlock.block.extrinsics.find(
      (e) => e.method.section == "timestamp" && e.method.method == "set"
    ).data
  );

  // Too far in the future to compure accurately,
  // will use ratio of past/expected to guess it
  // TODO: will need to change once we go with 6s block time
  if (diffCount > currentBlock.block.header.number.toNumber()) {
    const firstBlock = await api.rpc.chain.getBlock(
      (await api.rpc.chain.getBlockHash(1)).toString()
    );

    const firstTimestamp = api.registry.createType(
      "Compact<u64>",
      firstBlock.block.extrinsics.find(
        (e) => e.method.section == "timestamp" && e.method.method == "set"
      ).data
    );

    const expected =
      currentBlock.block.header.number.toNumber() * 12 * 1000 * 1000;
    const past = currentTimestamp.toNumber() - firstTimestamp.toNumber();
    const expectedDate = new Date(
      currentTimestamp.toNumber() +
        (diffCount * 12 * 1000 * 1000 * past) / expected
    );
    return moment.utc(expectedDate);
  }

  const previousBlock = await api.rpc.chain.getBlock(
    (
      await api.rpc.chain.getBlockHash(
        currentBlock.block.header.number.toNumber() - diffCount
      )
    ).toString()
  );

  const previousTimestamp = api.registry.createType(
    "Compact<u64>",
    previousBlock.block.extrinsics.find(
      (e) => e.method.section == "timestamp" && e.method.method == "set"
    ).data
  );

  const expectedDate = new Date(
    currentTimestamp.toNumber() +
      (currentTimestamp.toNumber() - previousTimestamp.toNumber())
  );

  return moment.utc(expectedDate);
}

async function getPastBlockDate(
  api: ApiPromise,
  blockNumber: number,
  currentBlock: SignedBlock
) {
  const diffCount = blockNumber - currentBlock.block.header.number.toNumber();
  if (diffCount > 0) {
    console.error("Block must be in the past");
    return;
  }

  const pastBlock = await api.rpc.chain.getBlock(
    (await api.rpc.chain.getBlockHash(blockNumber)).toString()
  );
  const timestampExt = pastBlock.block.extrinsics.find(
    (e) => e.method.section == "timestamp" && e.method.method == "set"
  );

  const timestamp = api.registry.createType("Compact<u64>", timestampExt.data);
  return moment.utc(timestamp.toNumber());
}

export async function getBlockDate(api: ApiPromise, blockNumber: number) {
  const currentBlock = await api.rpc.chain.getBlock();
  const currentBlockNumber = currentBlock.block.header.number.toNumber();
  if (currentBlockNumber >= blockNumber) {
    return {
      blockCount: blockNumber - currentBlockNumber,
      date: await getPastBlockDate(api, blockNumber, currentBlock),
    };
  }
  return {
    blockCount: blockNumber - currentBlockNumber,
    date: await getFutureBlockDate(api, blockNumber, currentBlock),
  };
}

export async function computeBlockForMoment(
  api: ApiPromise,
  targetDate: Moment
) {
  const currentBlock = await api.rpc.chain.getBlock();
  const currentBlockNumber = currentBlock.block.header.number.toNumber();

  let evalDate = moment.utc();
  let targetBlock = currentBlockNumber;

  do {
    targetBlock += Math.floor(targetDate.diff(evalDate) / 1000 / 12);
    evalDate = await getFutureBlockDate(api, targetBlock, currentBlock);

    await new Promise((resolve) => setTimeout(resolve, 1));
  } while (Math.abs(evalDate.diff(targetDate)) > 1000 * 60 * 10);
  return {
    block: targetBlock,
    date: evalDate,
    blockCount: targetBlock - currentBlockNumber,
  };
}
