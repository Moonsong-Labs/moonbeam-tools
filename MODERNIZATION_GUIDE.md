# Moonbeam Tools - Modernization Guide

This guide helps developers modernize existing tools to use the new patterns and utilities.

## Key Changes

### 1. Top-Level Await
Instead of wrapping everything in a `main()` function, use top-level await:

**Before:**
```typescript
const main = async () => {
  // tool logic
};
main();
```

**After:**
```typescript
#!/usr/bin/env node
await runTool({
  toolClass: MyTool,
  yargsOptions: { /* ... */ }
});
```

### 2. BaseTool Class
Convert tools to extend the BaseTool class for consistent error handling and cleanup:

**Before:**
```typescript
const main = async () => {
  const api = await getApiFor(argv);
  try {
    // tool logic
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  await api.disconnect();
};
```

**After:**
```typescript
class MyTool extends BaseTool {
  async execute(): Promise<void> {
    const api = this.ensureApi();
    // tool logic - cleanup is automatic
  }
}
```

### 3. Structured Logging
Replace console.log with the logger:

**Before:**
```typescript
console.log(`Processing block ${blockNumber}`);
console.error("Error:", error);
```

**After:**
```typescript
this.context.logger.info("Processing block", { blockNumber });
this.context.logger.error("Processing failed", error);
```

### 4. Async File Operations
Replace synchronous file operations:

**Before:**
```typescript
import fs from "fs";
const data = fs.readFileSync("file.json", "utf8");
fs.writeFileSync("output.json", JSON.stringify(result));
```

**After:**
```typescript
import { readJSON, writeJSON } from "../index.ts";
const data = await readJSON("file.json");
await writeJSON("output.json", result);
```

### 5. Error Handling
Use ToolError and avoid process.exit:

**Before:**
```typescript
if (!address) {
  console.error("Address is required");
  process.exit(1);
}
```

**After:**
```typescript
if (!address) {
  throw new ToolError("Address is required");
}
```

## Complete Example

Here's a complete example of modernizing a simple tool:

### Original Tool
```typescript
import yargs from "yargs";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../index.ts";

const argv = yargs(process.argv.slice(2))
  .options({
    ...NETWORK_YARGS_OPTIONS,
    address: { type: "string", required: true }
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);
  
  try {
    const balance = await api.query.system.account(argv.address);
    console.log(`Balance: ${balance.data.free.toString()}`);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
  
  await api.disconnect();
};

main();
```

### Modernized Tool
```typescript
#!/usr/bin/env node
import { BaseTool, ToolContext, runTool, NETWORK_YARGS_OPTIONS } from "../index.ts";

interface CheckBalanceOptions {
  address: string;
}

class CheckBalanceTool extends BaseTool {
  private readonly options: CheckBalanceOptions;

  constructor(options: CheckBalanceOptions, context: ToolContext) {
    super({
      name: "check-balance",
      description: "Check account balance"
    }, context);
    this.options = options;
  }

  async execute(): Promise<void> {
    const api = this.ensureApi();
    const balance = await api.query.system.account(this.options.address);
    
    this.context.logger.info("Account balance", {
      address: this.options.address,
      free: balance.data.free.toString(),
      reserved: balance.data.reserved.toString()
    });
  }
}

// Top-level await
await runTool({
  toolClass: CheckBalanceTool,
  yargsOptions: {
    ...NETWORK_YARGS_OPTIONS,
    address: {
      type: "string",
      demandOption: true,
      description: "Account address"
    }
  }
});
```

## Benefits

1. **Automatic cleanup** - API disconnection and cleanup tasks run automatically
2. **Consistent error handling** - Errors are logged and handled uniformly
3. **Better debugging** - Structured logging with debug support
4. **Type safety** - Better TypeScript integration
5. **Testability** - Tools can be easily unit tested
6. **No process.exit** - Allows proper cleanup and testing

## Migration Checklist

- [ ] Convert to use `runTool()` with top-level await
- [ ] Create a class extending `BaseTool`
- [ ] Move main logic to `execute()` method
- [ ] Replace `console.log` with logger
- [ ] Replace synchronous file operations with async versions
- [ ] Remove all `process.exit()` calls
- [ ] Add proper TypeScript types for options
- [ ] Test the modernized tool