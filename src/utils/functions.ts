import { ApiPromise } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import { SignerOptions } from "@polkadot/api/types/submittable";

import pMap from "p-map";

export const promiseConcurrent = <T, R>(
  concurrency: number,
  mapper: (item: T, index?: number) => Promise<R> | R,
  list: T[]
): Promise<R[]> => pMap(list, mapper, { concurrency: concurrency });


export const numberWithCommas = (x: number | bigint | string) => {
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export async function waitTxDone(api: ApiPromise, tx: SubmittableExtrinsic, sender: KeyringPair, options?: Partial<SignerOptions>): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const unsub = await tx.signAndSend(sender, options, ({ status, dispatchError, internalError }) => {
      if (internalError) {
        unsub();
        reject(internalError);
        return;
      }

      if (status.isInBlock || status.isFinalized) {
        if (dispatchError) {
          unsub();
          reject({
            inBlock: status.asInBlock.toString(),
            error: api.registry.findMetaError(dispatchError.asModule)
          });
          return;
        }

        unsub();
        resolve(status.asInBlock.toString());
      }
    });
  });
}
