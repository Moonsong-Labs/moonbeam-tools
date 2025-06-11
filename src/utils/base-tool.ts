import { ApiPromise } from "@polkadot/api";
import type { Logger } from "./logger.ts";

export interface ToolOptions {
  name: string;
  description?: string;
}

export interface ToolContext {
  api?: ApiPromise;
  logger: Logger;
}

export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code: number = 1,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export abstract class BaseTool {
  protected readonly name: string;
  protected readonly description?: string;
  protected context: ToolContext;
  private cleanupTasks: Array<() => Promise<void> | void> = [];

  constructor(options: ToolOptions, context: ToolContext) {
    this.name = options.name;
    this.description = options.description;
    this.context = context;
    
    // Set up global error handlers
    this.setupErrorHandlers();
  }

  /**
   * Abstract method that must be implemented by each tool
   */
  abstract execute(): Promise<void>;

  /**
   * Main entry point for the tool with error handling
   */
  async run(): Promise<void> {
    const startTime = Date.now();
    
    try {
      this.context.logger.info(`Starting ${this.name}...`);
      await this.execute();
      this.context.logger.info(`${this.name} completed successfully in ${Date.now() - startTime}ms`);
    } catch (error) {
      this.context.logger.error(`${this.name} failed:`, error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Register a cleanup task to be run on exit
   */
  protected addCleanup(task: () => Promise<void> | void): void {
    this.cleanupTasks.push(task);
  }

  /**
   * Run all cleanup tasks
   */
  private async cleanup(): Promise<void> {
    this.context.logger.debug("Running cleanup tasks...");
    
    // Run cleanup tasks in reverse order (LIFO)
    for (const task of this.cleanupTasks.reverse()) {
      try {
        await task();
      } catch (error) {
        this.context.logger.error("Cleanup task failed:", error);
      }
    }

    // Disconnect API if connected
    if (this.context.api?.isConnected) {
      await this.context.api.disconnect();
    }
  }

  /**
   * Set up global error handlers for uncaught errors
   */
  private setupErrorHandlers(): void {
    const handleError = (error: Error | unknown, origin: string): void => {
      this.context.logger.error(`Unhandled error from ${origin}:`, error);
      // Don't use process.exit, let Node.js exit naturally
      this.cleanup().then(() => {
        process.exitCode = 1;
      });
    };

    process.on("uncaughtException", (error) => handleError(error, "uncaughtException"));
    process.on("unhandledRejection", (error) => handleError(error, "unhandledRejection"));
  }

  /**
   * Helper to ensure API is connected
   */
  protected ensureApi(): ApiPromise {
    if (!this.context.api) {
      throw new ToolError("API not initialized");
    }
    if (!this.context.api.isConnected) {
      throw new ToolError("API not connected");
    }
    return this.context.api;
  }
}