#!/usr/bin/env node
// Modern version of check-balance tool using top-level await and proper error handling

import { BaseTool, ToolContext, runTool, NETWORK_YARGS_OPTIONS } from "../index.ts";

interface CheckBalanceOptions {
  address: string;
  at?: number;
}

class CheckBalanceTool extends BaseTool {
  private readonly options: CheckBalanceOptions;

  constructor(options: CheckBalanceOptions, context: ToolContext) {
    super(
      {
        name: "check-balance",
        description: "Check the balance of an account at a specific block",
      },
      context
    );
    this.options = options;
  }

  async execute(): Promise<void> {
    const api = this.ensureApi();
    const { address, at } = this.options;

    // Get block number and hash
    const blockNumber = at || (await api.rpc.chain.getBlock()).block.header.number.toNumber();
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    const apiAt = await api.at(blockHash);

    // Query account
    const account = await apiAt.query.system.account(address);
    
    // Format output based on account structure
    if ("miscFrozen" in account.data) {
      this.context.logger.info(
        `#${blockNumber} - ${address}`,
        {
          free: account.data.free.toBigInt().toString(),
          reserved: account.data.reserved.toBigInt().toString(),
          miscFrozen: (account.data["miscFrozen"] as any)?.toBigInt().toString(),
          feeFrozen: (account.data["feeFrozen"] as any).toBigInt().toString(),
        }
      );
    } else {
      this.context.logger.info(
        `#${blockNumber} - ${address}`,
        {
          free: account.data.free.toBigInt().toString(),
          reserved: account.data.reserved.toBigInt().toString(),
          frozen: account.data.frozen.toBigInt().toString(),
        }
      );
    }
  }
}

// Top-level await execution
await runTool({
  toolClass: CheckBalanceTool,
  yargsOptions: {
    ...NETWORK_YARGS_OPTIONS,
    address: {
      type: "string",
      description: "The address to look at",
      demandOption: true,
    },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  },
});