import { ApiPromise } from "@polkadot/api";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { getApiFor } from "./networks.ts";
import { BaseTool, ToolContext } from "./base-tool.ts";
import { ConsoleLogger, type LogLevel } from "./logger.ts";

export interface CLIOptions extends Record<string, unknown> {
  network?: string;
  url?: string;
  "log-level"?: LogLevel;
}

export interface RunToolOptions<T extends CLIOptions> {
  toolClass: new (options: T, context: ToolContext) => BaseTool;
  yargsOptions: Record<string, yargs.Options>;
  requiresApi?: boolean;
}

/**
 * Modern CLI runner with top-level await support
 * Usage:
 * ```ts
 * await runTool({
 *   toolClass: MyTool,
 *   yargsOptions: {
 *     address: { type: "string", required: true }
 *   }
 * });
 * ```
 */
export async function runTool<T extends CLIOptions>(
  options: RunToolOptions<T>
): Promise<void> {
  // Parse CLI arguments
  const argv = await yargs(hideBin(process.argv))
    .usage("Usage: $0 [options]")
    .options({
      "log-level": {
        type: "string",
        choices: ["debug", "info", "warn", "error"],
        default: "info",
        description: "Set the logging level",
      },
      ...options.yargsOptions,
    })
    .help()
    .strict()
    .parse() as T;

  // Create logger
  const logger = new ConsoleLogger({
    level: argv["log-level"] || "info",
  });

  // Create context
  const context: ToolContext = {
    logger,
  };

  let api: ApiPromise | undefined;

  try {
    // Connect to API if required
    if (options.requiresApi !== false) {
      logger.debug("Connecting to API...");
      api = await getApiFor(argv);
      context.api = api;
      logger.debug("API connected");
    }

    // Create and run tool
    const tool = new options.toolClass(argv, context);
    await tool.run();
    
    // Exit successfully
    process.exitCode = 0;
  } catch (error) {
    logger.error("Tool execution failed:", error);
    process.exitCode = 1;
  } finally {
    // Cleanup will be handled by the tool
    // but ensure API is disconnected if tool failed to initialize
    if (api?.isConnected && !context.api) {
      await api.disconnect();
    }
  }
}

/**
 * Create a tool runner function for a specific tool
 * This allows tools to be run with a simple top-level await
 */
export function createToolRunner<T extends CLIOptions>(
  options: RunToolOptions<T>
): () => Promise<void> {
  return () => runTool(options);
}