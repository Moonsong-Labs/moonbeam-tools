import { ApiPromise } from "@polkadot/api";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import { KeyringPair } from "@polkadot/keyring/types";
import { SignerOptions } from "@polkadot/api/types/submittable";
import ISubmittableResult from '@polkadot/types/types';
import chunk from "lodash.chunk";

export const sendAllAndWaitLast = async (extrinsics: SubmittableExtrinsic[]) => {
  return new Promise(async (resolve, reject) => {
    console.log(`Preparing to send ${extrinsics.length} extrinsics`);
    for (let i = 0; i < extrinsics.length; i++) {
      if (i == extrinsics.length - 1) {
        const unsub = await extrinsics[i].send((result) => {
          if (result.isError) {
            reject(result.toHuman());
          }
          if (result.isInBlock) {
            console.log(`Last extrinsic submitted`);
            unsub();
            resolve(null);
          }
        });
      } else {
        await extrinsics[i].send();
      }
      if (i % 100 == 0) {
        console.log(`Sending extrinsic: ${i}...`);
      }
    }
    console.log(`Waiting for last extrinsic...`);
  });
};

type Sender = { account: KeyringPair, options?: Partial<SignerOptions> };
type SendAndWaitParams = {
  sender?: Sender,
  batch?: number,
  maxPending?: number,
  timeoutMs?: number,
};

export async function sendBatchedAndWait(
  api: ApiPromise,
  extrinsics: SubmittableExtrinsic[],
  {
    sender = null,
    batch = 200,
    maxPending = 500,
    timeoutMs = 120000,
  }: SendAndWaitParams = {
      sender: null,
      batch: 200,
      maxPending: 500,
      timeoutMs: 120000,
    },
) {
  for await (const chunkedExtrinsics of chunk(extrinsics, batch)) {
    await waitPendingExtrinsics(api, maxPending);
    console.log(`Sending ${chunkedExtrinsics.length} tx (of ${extrinsics.length} total)`);

    for await (const extrinsic of chunkedExtrinsics) {
      const result = await waitTxDone(api, extrinsic, sender, timeoutMs);
      console.log(result);
    }
  }
}

export async function waitTxDone(api: ApiPromise, tx: SubmittableExtrinsic, sender?: Sender, timeoutMs: number = 120000): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let unsub = () => { };

    const timer = setTimeout(() => {
      reject('timed out');
      unsub();
    }, timeoutMs);

    const resolveUnsub = (value: any) => {
      clearTimeout(timer);
      unsub();
      resolve(value);
    };
    const rejectUnsub = (value: any) => {
      clearTimeout(timer);
      unsub();
      reject(value);
    };

    const cb = ({ status, dispatchError, internalError }: ISubmittableResult.ISubmittableResult) => {
      if (internalError) {
        return rejectUnsub(internalError);
      }

      if (status.isInBlock || status.isFinalized) {
        if (dispatchError) {
          return rejectUnsub({
            inBlock: status.asInBlock.toString(),
            error: api.registry.findMetaError(dispatchError.asModule)
          });
        }

        resolveUnsub(status.asInBlock.toString());
      }
    };

    if (sender) {
      unsub = await tx.signAndSend(sender.account, sender.options, cb);
    } else {
      unsub = await tx.send(cb);
    }
  });
}


async function waitPendingExtrinsics(api: ApiPromise, maxPending: number, checkIntervalMs: number = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    function checkCondition() {
      api.rpc.author.pendingExtrinsics()
        .then((pending) => {
          if (pending.length > maxPending) {
            setTimeout(() => checkCondition, checkIntervalMs);
          } else {
            resolve();
          }
        })
        .catch(reject);
    }

    checkCondition();
  });
}
