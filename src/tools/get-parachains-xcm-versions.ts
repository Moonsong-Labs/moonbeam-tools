import "@polkadot/api-augment/kusama";

import { ApiPromise, WsProvider } from "@polkadot/api";
import {
  prodParasKusama,
  prodParasKusamaCommon,
  prodParasPolkadot,
  prodParasPolkadotCommon,
} from "@polkadot/apps-config";
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
    at: {
      type: "number",
      description: "Block number",
    },
    network: {
      type: "string",
      choices: Object.keys(NETWORK_WS_URLS),
      string: true,
      description: "",
    },
  }).argv;

export async function getXCMVersion(provider: any): Promise<[string, string]> {
  // Get XCM Version - Not great but there is no chain state approach
  let xcmpQueueVersion =
    (provider.query.xcmpQueue && ((await provider.query.xcmpQueue.palletVersion()) as any)) ||
    "N/A";
  let xcmSafeVersion =
    (provider.query.polkadotXcm && ((await provider.query.polkadotXcm.safeXcmVersion()) as any)) ||
    "N/A";
  return [xcmpQueueVersion, xcmSafeVersion];
}

function timeoutAfter(seconds) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error("request timed-out"));
    }, seconds * 1000);
  });
}

export async function getParaApi(network: "kusama" | "polkadot", id: string) {
  const prodParas =
    network == "kusama"
      ? [...prodParasKusama, ...prodParasKusamaCommon]
      : [...prodParasPolkadot, ...prodParasPolkadotCommon];
  const nodes = Object.values(
    prodParas.find((e) => e.paraId.toString() === id)?.providers || {},
  ).filter((e) => e.startsWith("wss://"));

  if (!nodes.length) {
    console.log("No nodes found for parachain", id);
    return null;
  }

  for (const node of nodes) {
    console.log(`Trying node ${node} [${nodes.length}] for ${id}`);
    try {
      const api = await Promise.race([
        timeoutAfter(10),
        ApiPromise.create({
          initWasm: false,
          noInitWarn: true,
          provider: new WsProvider(node),
        }),
      ]);
      return api;
    } catch (error) {
      console.log(error.message);
    }
  }

  return null;
}

const main = async () => {
  const api = await ApiPromise.create({
    provider: new WsProvider(NETWORK_WS_URLS[argv.network]),
  });

  const relayRuntime = api.runtimeVersion.specName.toString();
  const network = relayRuntime.startsWith("kusama")
    ? "kusama"
    : relayRuntime.startsWith("polkadot")
      ? "polkadot"
      : null;
  if (!network) {
    console.log("Unknown network", relayRuntime);
    return;
  }
  const blockHash = (
    argv.at ? await api.rpc.chain.getBlockHash(argv.at || null) : await api.rpc.chain.getBlockHash()
  ).toString();
  console.log("Network", network, blockHash);
  const apiAt = await api.at(blockHash);
  const hrmpChannels = await apiAt.query.hrmp.hrmpChannels.entries();

  const paras: { [id: string]: { connections: string[]; version: string[] } } = {};
  for (const [hrmpChannel, hrmpChannelValue] of hrmpChannels) {
    const id = hrmpChannel.args[0].sender.toString();
    if (!paras[id]) {
      const paraApi: any = await getParaApi(network, id);
      const xcmVersion = paraApi ? await getXCMVersion(paraApi) : ["", ""];
      paras[id] = { connections: [], version: xcmVersion };
      paraApi && paraApi.disconnect();
    }
    paras[id].connections.push(hrmpChannel.args[0].recipient.toString());
  }

  for (const id of Object.keys(paras)) {
    console.log(
      `Parachain ${id} ${
        paras[id].version[0] == ""
          ? "[DOWN]"
          : `[XCMQueue: ${paras[id].version[0]}, XCMSafe: ${paras[id].version[1]}]`
      } has ${paras[id].connections.length} connections`,
    );
    console.log(
      `  ${paras[id].connections
        .map((c) => `${c}[${paras[c].version[0]},${paras[c].version[1]}]`)
        .join(", ")}`,
    );
  }
  await api.disconnect();

  process.exit(1);
};

main();
