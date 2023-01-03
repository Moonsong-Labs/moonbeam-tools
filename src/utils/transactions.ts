import { ApiPromise } from "@polkadot/api";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import { GenericCall } from "@polkadot/types/generic";

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

export const sendAllStreamAndWaitLast = async (
  api: ApiPromise,
  extrinsics: SubmittableExtrinsic[],
  { threshold = 500, batch = 200, timeout = 120000 } = {
    threshold: 500,
    batch: 200,
    timeout: 120000,
  }
) => {
  let promises = [];
  let lastUpdateTime = Date.now();
  while (extrinsics.length > 0) {
    const pending = await api.rpc.author.pendingExtrinsics();
    if (pending.length < threshold) {
      const chunk = extrinsics.splice(0, Math.min(threshold - pending.length, batch));
      console.log(`Sending ${chunk.length}tx (${extrinsics.length} left)`);
      promises.push(
        Promise.all(
          chunk.map((tx) => {
            return new Promise(async (resolve, reject) => {
              let unsub;
              const timer = setTimeout(() => {
                reject(`timed out`);
                unsub();
              }, timeout);
              unsub = await tx.send((result) => {
                // reset the timer
                if (result.isError) {
                  console.log(result.toHuman());
                  clearTimeout(timer);
                  reject(result.toHuman());
                }
                if (result.isInBlock) {
                  unsub();
                  clearTimeout(timer);
                  resolve(null);
                }
              });
            }).catch((e) => {});
          })
        )
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await Promise.all(promises);
};

export const maybeProxyCall = (
  api: ApiPromise,
  call: SubmittableExtrinsic,
  proxy?: string,
  proxyType?: string
) => {
  if (proxy) {
    return api.tx.proxy.proxy(proxy, (proxyType as any) || null, call);
  }
  return call;
};

const NESTED_CALLS = [
  {
    section: "utility",
    method: "dispatchAs",
    multi: false,
    argumentPosition: 1,
  },
  { section: "sudo", method: "sudo", multi: false, argumentPosition: 0 },
  { section: "sudo", method: "sudoAs", multi: false, argumentPosition: 1 },
  { section: "batch", method: "batch", multi: true, argumentPosition: 0 },
  {
    section: "whitelist",
    method: "dispatchWhitelistedCallWithPreimage",
    multi: false,
    argumentPosition: 0,
  },
];

export interface CallInterpretation {
  text: string;
  depth: number;
  call: GenericCall;
  subCalls: CallInterpretation[];
}

export async function callInterpreter(
  api: ApiPromise,
  call: GenericCall
): Promise<CallInterpretation> {
  const nested = NESTED_CALLS.find(
    ({ section, method }) => section == call.section.toString() && method == call.method.toString()
  );
  const text = `${call.section}.${call.method}`;
  if (nested) {
    if (nested.multi) {
      const subCalls = await api.registry.createType(
        "Vec<Call>",
        call.args[nested.argumentPosition].toU8a(true)
      );
      const subCallsData = await Promise.all(
        subCalls.map((subCall) => callInterpreter(api, subCall))
      );
      return {
        text,
        call,
        depth: subCallsData.length > 0 ? Math.max(...subCallsData.map((sub) => sub.depth)) + 1 : 1,
        subCalls: subCallsData,
      };
    }
    const subCall = await api.registry.createType("Call", call.args[nested.argumentPosition]);

    return { text, call, depth: 1, subCalls: [await callInterpreter(api, subCall)] };
  }

  return { text: `${call.section}.${call.method}`, call, depth: 0, subCalls: [] };
}

export function renderCallInterpretation(
  callData: CallInterpretation,
  separator = "\n",
  depth = 0
): string {
  return [
    `${"".padStart(depth * 6, " ")}⤷ \`${callData.text}\``,
    ...callData.subCalls.map((call) => renderCallInterpretation(call, separator, depth + 1)),
  ].join("\n");
}
