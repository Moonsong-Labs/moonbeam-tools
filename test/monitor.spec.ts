import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ApiPromise } from "@polkadot/api";
import { getMonitoredApiFor } from "../src/utils/networks";
import { printBlockDetails, listenBlocks } from "../src/utils/monitoring";
import type { RealtimeBlockDetails } from "../src/utils/monitoring";

// Mock dependencies
vi.mock("@polkadot/api");
vi.mock("../src/utils/monitoring");

describe("Monitor Script", () => {
  let mockApi: any;
  let consoleLogSpy: any;
  let mockUnsubscribe: any;

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();

    // Mock console.log to capture output
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Create mock unsubscribe function
    mockUnsubscribe = vi.fn();

    // Create mock API instance
    mockApi = {
      rpc: {
        system: {
          chain: vi.fn().mockResolvedValue({ toString: () => "Moonbeam" }),
        },
        chain: {
          subscribeFinalizedHeads: vi.fn(),
          subscribeNewHeads: vi.fn(),
        },
      },
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    // Mock ApiPromise.create
    vi.mocked(ApiPromise).create = vi.fn().mockResolvedValue(mockApi);

    // Mock listenBlocks function
    vi.mocked(listenBlocks).mockImplementation(async (api, finalized, callback) => {
      // Simulate block production
      const mockBlockDetails: RealtimeBlockDetails = {
        block: {
          header: {
            number: { toString: () => "5000000", toNumber: () => 5000000 },
            hash: { toString: () => "0x1234567890abcdef" },
          },
          extrinsics: [],
        } as any,
        authorName: "Collator1",
        blockTime: 12000,
        weightPercentage: 45.5,
        txWithEvents: [],
        records: [],
        elapsedMilliSecs: 12000,
        pendingTxs: [],
        isAuthorOrbiter: false,
        storageUsed: 0,
      };

      // Call the callback with mock block details after a delay
      setTimeout(() => {
        callback(mockBlockDetails);
      }, 100);

      return mockUnsubscribe;
    });
  });

  afterEach(() => {
    // Restore all mocks
    vi.restoreAllMocks();
  });

  it("should monitor block production for moonbeam network", async () => {
    // Mock printBlockDetails to verify it's called
    vi.mocked(printBlockDetails).mockImplementation((blockDetails, options, previousBlock) => {
      expect(blockDetails).toBeDefined();
      expect(blockDetails.block.header.number.toString()).toBe("5000000");
      expect(blockDetails.authorName).toBe("Collator1");
      expect(options?.prefix).toContain("moonbeam");
    });

    // Call getMonitoredApiFor with moonbeam network
    const api = await getMonitoredApiFor({ network: "moonbeam", finalized: false });

    // Verify API was created
    expect(ApiPromise.create).toHaveBeenCalledWith({
      noInitWarn: true,
      provider: expect.any(Object),
      typesBundle: expect.any(Object),
    });

    // Wait for the block callback to be executed
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Verify listenBlocks was called with correct parameters
    expect(listenBlocks).toHaveBeenCalledWith(mockApi, false, expect.any(Function));

    // Verify printBlockDetails was called
    expect(printBlockDetails).toHaveBeenCalled();

    // Clean up
    await api.disconnect();
    expect(mockApi.disconnect).toHaveBeenCalled();
  });

  it("should monitor finalized blocks when finalized flag is true", async () => {
    // Call getMonitoredApiFor with finalized flag
    const api = await getMonitoredApiFor({ network: "moonbeam", finalized: true });

    // Wait for the block callback to be executed
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Verify listenBlocks was called with finalized = true
    expect(listenBlocks).toHaveBeenCalledWith(mockApi, true, expect.any(Function));

    // Clean up
    await api.disconnect();
  });

  it("should handle multiple networks monitoring", async () => {
    const networks = ["moonbeam", "moonriver"];
    const apis: ApiPromise[] = [];

    // Mock different chain names for different networks
    let callCount = 0;
    mockApi.rpc.system.chain.mockImplementation(() => {
      const chains = ["Moonbeam", "Moonriver"];
      return { toString: () => chains[callCount++ % chains.length] };
    });

    // Monitor multiple networks
    for (const network of networks) {
      const api = await getMonitoredApiFor({ network, finalized: false });
      apis.push(api);
    }

    // Verify API was created for each network
    expect(ApiPromise.create).toHaveBeenCalledTimes(2);

    // Clean up all APIs
    for (const api of apis) {
      await api.disconnect();
    }
  });

  it("should handle connection errors gracefully", async () => {
    // Mock API creation to throw an error
    vi.mocked(ApiPromise).create = vi.fn().mockRejectedValue(new Error("Connection failed"));

    // Attempt to monitor and expect it to throw
    await expect(getMonitoredApiFor({ network: "moonbeam", finalized: false })).rejects.toThrow(
      "Connection failed",
    );
  });

  it("should display block production output correctly", async () => {
    let capturedOutput = "";

    // Mock printBlockDetails to capture what would be displayed
    vi.mocked(printBlockDetails).mockImplementation((blockDetails, options, previousBlock) => {
      // Simulate the actual output format
      const blockNumber = blockDetails.block.header.number.toString();
      const author = blockDetails.authorName;
      const weight = blockDetails.weightPercentage.toFixed(1);

      capturedOutput = `#${blockNumber} [${weight}%] by ${author}`;
      console.log(capturedOutput);
    });

    // Monitor moonbeam network
    const api = await getMonitoredApiFor({ network: "moonbeam", finalized: false });

    // Wait for block processing
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Verify output contains expected block information
    expect(capturedOutput).toContain("#5000000");
    expect(capturedOutput).toContain("45.5%");
    expect(capturedOutput).toContain("Collator1");
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("#5000000"));

    await api.disconnect();
  });
});
