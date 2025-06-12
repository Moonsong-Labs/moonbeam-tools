import { ApiPromise, Keyring } from "@polkadot/api";
import { SubmittableExtrinsic } from "@polkadot/api/types";
import { KeyringPair } from "@polkadot/keyring/types";
import { Callback, ISubmittableResult } from "@polkadot/types/types";
import Debug from "debug";
import { Options } from "yargs";

import type { MoonbeamRuntimeProxyType } from "@polkadot/types/lookup";
const _debug = Debug("proxy-chain");

// Library providing easy support for multiple proxy signing for CLI
// Proxied accounts can be combined by using comma separator and colon for types.
// --proxied-account "<proxied-address>[:<proxy-type>][,<proxied-address>[:<proxy-type>]]....""
//
// Ex:
//
// --proxied-account '0x111...:Any,0x222...:Staking,0x333...'
// will proxy the call from 0x111... and call proxy on 0x222... which
// will call proxy on 0x333... which will proxy the real account :)
// Something like:
// tx.proxy.proxy("0x111...", "Any",
//   tx.proxy.proxy("0x222...", null,
//     tx.proxy.proxy("0x333...", "Staking", call)))

//
// There is no limit to the amount of proxies, but in order to allow
// execution, sub-proxies must of type non-transfer or any

interface ProxyAccount {
  address: string;
  type?: MoonbeamRuntimeProxyType["type"];
}

export type ProxyType = MoonbeamRuntimeProxyType["type"][];
export type ProxyChainOptions = {
  "proxied-account": Options & { type: "string" };
};
export type ProxyChainArgv = {
  "proxied-account"?: string;
};

export const PROXY_CHAIN_YARGS_OPTIONS: ProxyChainOptions = {
  "proxied-account": {
    type: "string",
    description:
      "Accounts being proxied, in order, comma separated(Ex: '0x111...:Any,0x444:Staking')",
    string: true,
  },
};

// Keeps track of nonce and will apply proxy automatically
export class ProxyChain {
  proxies: ProxyAccount[];
  ready: Promise<any>;

  constructor(proxies: ProxyAccount[] = []) {
    this.proxies = proxies;
  }

  applyChain(api: ApiPromise, call: SubmittableExtrinsic<"promise", ISubmittableResult>) {
    return this.proxies
      .slice()
      .reverse()
      .reduce((call, proxy, index) => {
        debug(
          `chain [${index}]: ${proxy.address}${proxy.type ? `:${proxy.type}` : ""} - ${
            call.method.section
          }.${call.method.method}`,
        );
        return api.tx.proxy.proxy(proxy.address, (proxy.type as any) || null, call);
      }, call);
  }

  private static parseArgv(argv: ProxyChainArgv): ProxyAccount[] {
    return (argv["proxied-account"] ? argv["proxied-account"].split(",") : []).map((data) => {
      const typeSplit = data.split(":");
      return {
        address: typeSplit[0],
        type: typeSplit.length > 1 ? (typeSplit[1] as MoonbeamRuntimeProxyType["type"]) : null,
      };
    });
  }

  static from(argv: ProxyChainArgv) {
    return new ProxyChain(this.parseArgv(argv));
  }
}

export type ProxyChainSignerOptions = ProxyChainOptions & {
  "private-key": Options & { type: "string" };
};
export type ProxyChainSignerArgv = ProxyChainArgv & {
  "private-key": string;
};

export const PROXY_CHAIN_SIGNER_YARGS_OPTIONS: ProxyChainSignerOptions = {
  ...PROXY_CHAIN_YARGS_OPTIONS,
  "private-key": {
    type: "string",
    description: "Private key to transfer from",
  },
};

export class ProxyChainSigner {
  api: ApiPromise;
  signer: KeyringPair;
  nonce: number;
  chain: ProxyChain;
  realAccount: string; // The final account being proxied
  ready: Promise<any>;

  constructor(api: ApiPromise, signer: KeyringPair, chain: ProxyChain) {
    this.api = api;
    this.signer = signer;
    this.chain = chain;
    this.realAccount =
      this.chain.proxies.length > 0
        ? this.chain.proxies[this.chain.proxies.length - 1].address
        : signer.address;

    this.ready = api.query.system
      .account(signer.address)
      .then(({ nonce }) => (this.nonce = nonce.toNumber()));
  }

  static async from(api: ApiPromise, keyring: Keyring, argv: ProxyChainSignerArgv) {
    return new ProxyChainSigner(
      api,
      await keyring.addFromUri(argv["private-key"]),
      ProxyChain.from(argv),
    );
  }

  async signAndSendWithNonce(
    call: SubmittableExtrinsic<"promise", ISubmittableResult>,
    nonce: number,
    tip: bigint = 0n,
    optionalStatusCb?: Callback<ISubmittableResult>,
  ) {
    if (nonce >= this.nonce) {
      this.nonce = nonce + 1;
    }
    return this.chain
      .applyChain(this.api, call)
      .signAndSend(this.signer, { nonce, tip }, optionalStatusCb)
      .catch((e) => {
        console.log(`Error: ${e}`);
      });
  }

  async signAndSend(
    call: SubmittableExtrinsic<"promise", ISubmittableResult>,
    tip: bigint = 0n,
    optionalStatusCb?: Callback<ISubmittableResult>,
  ) {
    return this.signAndSendWithNonce(call, this.nonce++, tip, optionalStatusCb);
  }
}
