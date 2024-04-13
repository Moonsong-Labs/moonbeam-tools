import { WsProvider, HttpProvider } from "@polkadot/api";
import chalk from "chalk";
import {
  Chain,
  PrivateKeyAccount,
  PublicClient,
  Transport,
  WalletClient,
  createPublicClient,
  createWalletClient,
  webSocket,
} from "viem";
import { ApiPromise } from "@polkadot/api";
import { typesBundlePre900 } from "moonbeam-types-bundle";
import { listenBlocks, printBlockDetails, RealtimeBlockDetails } from "./monitoring";
import { Options } from "yargs";
import { privateKeyToAccount } from "viem/accounts";
import { localhost } from "viem/chains";

export type MOONBEAM_NETWORK_NAME =
  | "stagenet"
  | "alphanet"
  | "moonsama"
  | "moonlama"
  | "moonsilver"
  | "moonriver"
  | "moonbeam";
export type POLKADOT_NETWORK_NAME = "kusama" | "polkadot";

export type NETWORK_NAME = MOONBEAM_NETWORK_NAME | POLKADOT_NETWORK_NAME;

export const NETWORK_WS_URLS: { [name in NETWORK_NAME]: string } = {
  stagenet: "wss://wss.api.moondev.network",
  alphanet: "wss://wss.api.moonbase.moonbeam.network",
  moonsama: "wss://fro-moon-moondev-1-moonsama-rpc-1.rv.moondev.network",
  moonlama: "wss://deo-moon-moondev-1-moonlama-rpc-1.rv.moondev.network",
  moonsilver: "wss://wss.moonsilver.moonbeam.network",
  moonriver: "wss://wss.api.moonriver.moonbeam.network",
  moonbeam: "wss://wss.api.moonbeam.network",
  kusama: "wss://kusama-rpc.polkadot.io",
  polkadot: "wss://rpc.polkadot.io",
};
export const NETWORK_HTTP_URLS: { [name in NETWORK_NAME]: string } = {
  stagenet: "https://rpc.api.moondev.network",
  alphanet: "https://rpc.api.moonbase.moonbeam.network",
  moonsama: "https://fro-moon-moondev-1-moonsama-rpc-1.rv.moondev.network",
  moonlama: "https://deo-moon-moondev-1-moonlama-rpc-1.rv.moondev.network",
  moonsilver: "https://rpc.moonsilver.moonbeam.network",
  moonriver: "https://rpc.api.moonriver.moonbeam.network",
  moonbeam: "https://rpc.api.moonbeam.network",
  kusama: "wss://kusama-rpc.polkadot.io",
  polkadot: "wss://rpc.polkadot.io",
};
export const NETWORK_NAMES = Object.keys(NETWORK_WS_URLS) as NETWORK_NAME[];

export const NETWORK_CHAIN_MAPPING: { [name: string]: NETWORK_NAME } = {
  "Moonbase Stage": "stagenet",
  "Moonbase Alpha": "alphanet",
  Moonsama: "moonsama",
  Moonsilver: "moonsilver",
  Moonriver: "moonriver",
  Moonbeam: "moonbeam",
  Kusama: "kusama",
  Polkadot: "polkadot",
  Moonlama: "moonlama",
};

export const NETWORK_COLORS: { [name in NETWORK_NAME]: chalk.ChalkFunction } = {
  stagenet: chalk.blueBright,
  alphanet: chalk.greenBright,
  moonsama: chalk.magentaBright,
  moonlama: chalk.magentaBright,
  moonsilver: chalk.yellowBright,
  moonriver: chalk.redBright,
  moonbeam: chalk.magentaBright,
  kusama: chalk.redBright,
  polkadot: chalk.magentaBright,
};

export type NetworkOptions = {
  url: Options & { type: "string" };
  network: Options & { type: "string" };
  finalized: Options & { type: "boolean" };
};

export type Argv = {
  url?: string;
  network?: string;
  finalized?: boolean;
};

export const NETWORK_YARGS_OPTIONS: NetworkOptions = {
  url: {
    type: "string",
    description: "Websocket url",
    conflicts: ["network"],
    string: true,
  },
  network: {
    type: "string",
    choices: NETWORK_NAMES,
    description: "Known network",
    string: true,
  },
  finalized: {
    type: "boolean",
    default: false,
    description: "listen to finalized only",
  },
};

export function isKnownNetwork(name: string): name is NETWORK_NAME {
  return NETWORK_NAMES.includes(name as NETWORK_NAME);
}

export const getWsProviderForNetwork = (name: NETWORK_NAME) => {
  return new WsProvider(NETWORK_WS_URLS[name]);
};

// Supports providing an URL or a known network
export const getWsProviderFor = (argv: Argv) => {
  if (isKnownNetwork(argv.network)) {
    return getWsProviderForNetwork(argv.network);
  }
  return new WsProvider(argv.url);
};

export const getHttpProviderForNetwork = (name: NETWORK_NAME) => {
  return new HttpProvider(NETWORK_HTTP_URLS[name]);
};

// Supports providing an URL or a known network
export const getHttpProviderFor = (argv: Argv) => {
  if (isKnownNetwork(argv.network)) {
    return getHttpProviderForNetwork(argv.network);
  }
  return new HttpProvider(argv.url);
};

export const getApiFor = async (argv: Argv) => {
  const wsProvider = getWsProviderFor(argv);
  return await ApiPromise.create({
    noInitWarn: true,
    provider: wsProvider,
    typesBundle: typesBundlePre900 as any,
  });
};

export const getViemFor = (argv: Argv): PublicClient<Transport, Chain, true> => {
  const url = isKnownNetwork(argv.network) ? NETWORK_WS_URLS[argv.network] : argv.url;
  return createPublicClient({
    transport: webSocket(url),
  });
};

/**
 *
 * @param argv Network options
 * @param key Private key
 * @returns
 */
export const getViemAccountFor = (
  argv: Argv,
  account: PrivateKeyAccount,
): WalletClient<Transport, Chain, PrivateKeyAccount, true> => {
  const url = isKnownNetwork(argv.network) ? NETWORK_WS_URLS[argv.network] : argv.url;
  return createWalletClient({
    transport: webSocket(url),
    account,
    chain: null,
  });
};

export const getMonitoredApiFor = async (argv: Argv) => {
  const wsProvider = getWsProviderFor(argv);
  const api = await ApiPromise.create({
    noInitWarn: true,
    provider: wsProvider,
    typesBundle: typesBundlePre900 as any,
  });
  const networkName = argv.url
    ? NETWORK_CHAIN_MAPPING[(await api.rpc.system.chain()).toString()]
    : argv.network;

  let previousBlockDetails: RealtimeBlockDetails = null;
  listenBlocks(api, argv.finalized, async (blockDetails) => {
    printBlockDetails(
      blockDetails,
      {
        prefix: isKnownNetwork(networkName)
          ? NETWORK_COLORS[networkName](networkName.padStart(10, " "))
          : undefined,
      },
      previousBlockDetails,
    );
    previousBlockDetails = blockDetails;
  });
  return api;
};
