import { ApiPromise, WsProvider } from "@polkadot/api";
import fs from "fs";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "src/utils/networks.ts";
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
    }
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const blockHash = argv.at
    ? await api.rpc.chain.getBlockHash(argv.at)
    : await api.rpc.chain.getBlockHash();
  const block = await api.rpc.chain.getBlock(blockHash);

  block.block.extrinsics.forEach((ex, index) => {
    console.log(index, `${ex.method.section.toString()}.${ex.method.method.toString()} [${ex.hash.toHex()}]\n${ex.method.method.toString() == "setValidationData" ? "..." : ex.toHex()}`);
  });

  await api.disconnect();
};

main();
