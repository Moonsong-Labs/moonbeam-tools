import { JsonRpcResponse, JsonRpcResponseWithResult, Web3 } from "web3";

let globalId = 10000;
export async function customWeb3Request(web3: Web3, method: string, params: any[]) {
  return new Promise<JsonRpcResponseWithResult>((resolve, reject) => {
    const id = globalId++;
    (web3.currentProvider as any).send(
      {
        jsonrpc: "2.0",
        id,
        method,
        params,
      },
      (error: Error | null, result: JsonRpcResponse) => {
        // console.log(`Receiving ${id}`, error);
        if (error) {
          reject(
            `Failed to send custom request (${method} (${params.join(",")})): ${
              error.message || error.toString()
            }`,
          );
        }
        resolve(result as JsonRpcResponseWithResult);
      },
    );
  });
}
