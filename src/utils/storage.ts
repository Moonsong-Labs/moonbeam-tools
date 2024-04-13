import type { ProviderInterface } from "@polkadot/rpc-provider/types";
import { promiseConcurrent } from "./functions";

const debug = require("debug")("utils:storage-query");

// Timer must be wrapped to be passed
const startReport = (total: () => number) => {
  let t0 = performance.now();
  let timer: NodeJS.Timeout = undefined;

  const report = () => {
    const t1 = performance.now();
    const duration = t1 - t0;
    const qps = total() / (duration / 1000);
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    debug(`Queried ${total()} keys @ ${qps.toFixed(0)} keys/sec, ${used.toFixed(0)} MB heap used`);

    timer = setTimeout(report, 5000);
  };
  timer = setTimeout(report, 5000);

  const stopReport = () => {
    clearTimeout(timer);
  };

  return stopReport;
};

export function splitPrefix(prefix: string, splitDepth) {
  return new Array(256 ** splitDepth)
    .fill(0)
    .map((_, i) => `${prefix}${i.toString(16).padStart(splitDepth * 2, "0")}`);
}

// Only works with keys longer than keyPrefix
// Is effective only on well spread keys
export async function concurrentGetKeys(
  provider: ProviderInterface,
  keyPrefix: string,
  blockHash: string,
) {
  const maxKeys = 1000;
  let total = 0;

  let prefixes = splitPrefix(keyPrefix, 1);
  const stopReport = startReport(() => total);

  try {
    const allKeys = await promiseConcurrent(
      10,
      async (prefix) => {
        let keys = [];
        let startKey = null;
        while (true) {
          const result = await provider.send("state_getKeysPaged", [
            prefix,
            maxKeys,
            startKey,
            blockHash,
          ]);
          total += result.length;
          keys.push(...result);
          if (result.length != maxKeys) {
            break;
          }
          startKey = result[result.length - 1];
        }
        global.gc();
        return keys;
      },
      prefixes,
    );
    return allKeys.flat().sort();
  } finally {
    stopReport();
  }
}

export async function queryUnorderedRawStorage(
  provider: ProviderInterface,
  keys: string[],
  blockHash: string,
): Promise<
  {
    key: `0x${string}`;
    value: string;
  }[]
> {
  const result = await provider.send("state_queryStorageAt", [keys, blockHash]);

  return result[0].changes.map((pair) => ({
    value: pair[1],
    key: pair[0],
  }));
}

export async function processAllStorage(
  provider: ProviderInterface,
  options: {
    prefix: string;
    blockHash: string;
    splitDepth?: number;
    concurrency?: number;
    delayMS?: number;
  },
  processor: (batchResult: { key: `0x${string}`; value: string }[]) => void,
) {
  const { prefix, blockHash, splitDepth, concurrency, delayMS } = options;

  const maxKeys = 1000;
  let total = 0;
  let prefixes = splitPrefix(prefix, splitDepth || 1);
  const stopReport = startReport(() => total);

  try {
    await promiseConcurrent(
      concurrency || 10,
      async (prefix) => {
        let startKey = null;
        while (true) {
          const keys = await provider.send("state_getKeysPaged", [
            prefix,
            maxKeys,
            startKey,
            blockHash,
          ]);
          if (keys.length == 0) {
            break;
          }
          const response = await provider.send("state_queryStorageAt", [keys, blockHash]);

          if (!response[0]) {
            throw new Error(`No response: ${JSON.stringify(response)}`);
          }

          processor(response[0].changes.map((pair) => ({ key: pair[0], value: pair[1] })));
          total += keys.length;

          if (keys.length != maxKeys) {
            break;
          }
          startKey = keys[keys.length - 1];

          if (delayMS) {
            await new Promise((resolve) => setTimeout(resolve, delayMS));
          }
        }
      },
      prefixes,
    );
  } finally {
    stopReport();
  }
}
