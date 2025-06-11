import { ApiPromise, WsProvider } from "@polkadot/api";
import fs from "fs";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "src/utils/networks";
import yargs from "yargs";

export const NETWORK_WS_URLS: { [name: string]: string } = {
  rococo: "wss://rococo-rpc.polkadot.io",
  westend: "wss://westend.api.onfinality.io/public-ws",
  kusama: "wss://kusama.api.onfinality.io/public-ws",
  polkadot: "wss://polkadot.api.onfinality.io/public-ws",
};

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    at: {
      type: "number",
      description: "Block number",
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const block = await api.rpc.chain.getBlock(blockHash);
  const apiAt = await api.at(blockHash);

  block.block.extrinsics.forEach((ex, index) => {
    const { method, signature, isSigned, signer, nonce } = ex;
    console.log(
      index,
      `${ex.method.section.toString()}.${ex.method.method.toString()} [${ex.hash.toHex()}]`,
    );
    // if (method.args.length > 0) {
    //   console.log(`  Args: ${method.args.map((arg) => arg.toHex()).join(', ')}`);
    // }

    if (method.section === "sudo" && method.method.startsWith("sudo")) {
      // Handle sudo extrinsics
      const nestedCall = method.args[0]; // The "call" is the first argument in sudo methods
      const {
        section,
        method: nestedMethod,
        args: nestedArgs,
      } = apiAt.registry.createType("Call", nestedCall);

      console.log(`  Nested Call: ${section}.${nestedMethod}`);
      const nestedDecodedArgs = nestedArgs.map((arg: any) => arg.toHuman());
      console.log(`  Nested Args: ${JSON.stringify(nestedDecodedArgs, null, 2)}`);
    }
    console.log(`${ex.method.method.toString() == "setValidationData" ? "..." : ex.toHex()}`);
  });

  await api.disconnect();
};

main();
