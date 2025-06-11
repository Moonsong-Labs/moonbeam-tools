import chalk from "chalk";
import debug from "debug";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  level?: LogLevel;
  prefix?: string;
  useColors?: boolean;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(prefix: string): Logger;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class ConsoleLogger implements Logger {
  private readonly level: number;
  private readonly prefix: string;
  private readonly useColors: boolean;
  private readonly debugLogger: debug.Debugger;

  constructor(options: LoggerOptions = {}) {
    this.level = LOG_LEVELS[options.level || "info"];
    this.prefix = options.prefix || "";
    this.useColors = options.useColors ?? true;
    this.debugLogger = debug(`moonbeam-tools${this.prefix ? `:${this.prefix}` : ""}`);
  }

  private format(level: LogLevel, args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const prefix = this.prefix ? `[${this.prefix}]` : "";
    const levelStr = `[${level.toUpperCase()}]`;
    
    const message = args
      .map((arg) => {
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");

    return `${timestamp} ${prefix} ${levelStr} ${message}`;
  }

  private log(level: LogLevel, ...args: unknown[]): void {
    if (LOG_LEVELS[level] < this.level) {
      return;
    }

    const formatted = this.format(level, args);

    if (level === "debug") {
      // Use debug library for debug messages
      this.debugLogger(...args);
      return;
    }

    if (!this.useColors) {
      console.log(formatted);
      return;
    }

    switch (level) {
      case "info":
        console.log(chalk.blue(formatted));
        break;
      case "warn":
        console.warn(chalk.yellow(formatted));
        break;
      case "error":
        console.error(chalk.red(formatted));
        break;
    }
  }

  debug(...args: unknown[]): void {
    this.log("debug", ...args);
  }

  info(...args: unknown[]): void {
    this.log("info", ...args);
  }

  warn(...args: unknown[]): void {
    this.log("warn", ...args);
  }

  error(...args: unknown[]): void {
    this.log("error", ...args);
  }

  child(prefix: string): Logger {
    return new ConsoleLogger({
      level: Object.keys(LOG_LEVELS)[this.level] as LogLevel,
      prefix: this.prefix ? `${this.prefix}:${prefix}` : prefix,
      useColors: this.useColors,
    });
  }
}

// Default logger instance
export const logger = new ConsoleLogger({
  level: process.env.LOG_LEVEL as LogLevel || "info",
});

// Export convenience functions
export const { debug, info, warn, error } = logger;