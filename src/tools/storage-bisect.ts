import yargs from "yargs";
import { ApiPromise } from "@polkadot/api";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    start: {
      type: "number",
      description: "Block number to start",
      default: 0,
    },
    end: {
      type: "number",
      description: "Block number to end",
      default: 10000000,
    },
    key: {
      type: "string",
      description: "Storage key to look for",
      required: true,
    },
  }).argv;

async function dichotomicSearch(
  api: ApiPromise,
  startBlock: number,
  endBlock: number,
  storageKey: string,
): Promise<number | null> {
  let left = startBlock;
  let right = endBlock;

  // Get the value of the storage key at a specific block
  async function getStorageValueAtBlock(blockNumber: number): Promise<any> {
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    const storageValue = (await api.rpc.state.getStorage(storageKey, blockHash.toString())) as any;
    console.log(`[${blockNumber}: ${blockHash.toString()}] value: ${storageValue.toHex()} `);
    return storageValue.toHex();
  }

  const initialValue = await getStorageValueAtBlock(startBlock);
  console.log(`Initial value: ${initialValue}`);
  console.log(`Starting dichotomic search from block ${startBlock} to ${endBlock}`);

  // Perform binary search
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const midValue = await getStorageValueAtBlock(mid);

    if (midValue !== initialValue) {
      // If the value changed, narrow the search range to the left
      right = mid - 1;
    } else {
      // If the value is the same, narrow the search range to the right
      left = mid + 1;
    }
  }

  // Check if the change was found
  if (left <= endBlock) {
    return left;
  }

  return null; // No change found within the range
}

async function main() {
  const api = await getApiFor(argv);

  const startBlock = argv.start;
  const endBlock = Math.min(argv.end, (await api.rpc.chain.getHeader()).number.toNumber());
  const storageKey = argv.key;

  console.log("===============================================");
  console.log("Warning, this will only work if a single change of value happened during the range");
  console.log("===============================================");

  const result = await dichotomicSearch(api, startBlock, endBlock, storageKey);

  if (result !== null) {
    console.log(`Change detected at block: ${result}`);
  } else {
    console.log("No change detected in the specified range.");
  }

  await api.disconnect();
}

main().catch(console.error);
