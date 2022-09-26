import pMap from "p-map";
import pQueue from "p-queue";

export const promiseConcurrent = <T, R>(
  concurrency: number,
  mapper: (item: T, index?: number) => Promise<R> | R,
  list: T[]
): Promise<R[]> => pMap(list, mapper, { concurrency: concurrency });

export const numberWithCommas = (x: number | bigint | string) => {
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

// Will execute concurrent "on-fly" tasks
// This is effective for very long list where the result is not required
// as it will free the memory over time
// Stops adding new items once a task return false/null/undefined/0
// This can lead to additional items being added 
// until the finishing task is complete
export const promiseWhile = async (
  concurrency: number,
  taskGenerator: (index?: number) => () => Promise<boolean>
): Promise<void> => {
  let index = 0;
  let end = false;

  const queue = new pQueue({ concurrency });

  const addTask = () => {
    if (end) { 
      return;
    }
    const task = taskGenerator(index++);
    if (!task) {
      end = true;
      return;
    }
    queue.add(task);
  }
  queue.on("next", addTask);

  new Array(concurrency).fill(0).map(addTask);

  await queue.onIdle();
};
