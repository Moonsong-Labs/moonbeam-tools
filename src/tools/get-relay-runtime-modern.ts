#!/usr/bin/env node
// Modern version of get-relay-runtime tool using top-level await and async file operations

import { ApiPromise, WsProvider } from "@polkadot/api";
import { BaseTool, ToolContext, runTool, writeFile } from "../index.ts";

export const NETWORK_WS_URLS: Record<string, string> = {
  rococo: "wss://rococo-rpc.polkadot.io",
  westend: "wss://westend.api.onfinality.io/public-ws",
  kusama: "wss://kusama.api.onfinality.io/public-ws",
  polkadot: "wss://polkadot.api.onfinality.io/public-ws",
};

interface GetRelayRuntimeOptions {
  network: string;
  at?: number;
  output: string;
}

class GetRelayRuntimeTool extends BaseTool {
  private readonly options: GetRelayRuntimeOptions;

  constructor(options: GetRelayRuntimeOptions, context: ToolContext) {
    super(
      {
        name: "get-relay-runtime",
        description: "Download runtime WASM from a relay chain",
      },
      context
    );
    this.options = options;
  }

  async execute(): Promise<void> {
    const { network, at, output } = this.options;

    // Create API connection to relay chain
    this.context.logger.info(`Connecting to ${network} relay chain...`);
    const api = await ApiPromise.create({
      provider: new WsProvider(NETWORK_WS_URLS[network]),
    });

    // Register cleanup
    this.addCleanup(() => api.disconnect());

    // Get block hash
    const blockHash = at 
      ? await api.rpc.chain.getBlockHash(at)
      : await api.rpc.chain.getBlockHash();

    this.context.logger.info(`Fetching runtime at block ${blockHash.toString()}`);

    // Get runtime code
    const code = await api.rpc.state.getStorage(":code", blockHash) as any;
    
    if (!code || !code.unwrap) {
      throw new Error("Failed to fetch runtime code");
    }

    // Write to file asynchronously
    const wasmBytes = Buffer.from(code.unwrap().toHex().slice(2), "hex");
    await writeFile(output, wasmBytes);

    this.context.logger.info(`Runtime WASM saved to ${output} (${wasmBytes.length} bytes)`);
  }
}

// Top-level await execution
await runTool({
  toolClass: GetRelayRuntimeTool,
  yargsOptions: {
    network: {
      type: "string",
      choices: Object.keys(NETWORK_WS_URLS),
      demandOption: true,
      description: "Relay chain network",
    },
    at: {
      type: "number",
      description: "Block number to fetch runtime from",
    },
    output: {
      alias: "o",
      type: "string",
      demandOption: true,
      description: "Output file path",
    },
  },
  requiresApi: false, // We create our own API connection
});