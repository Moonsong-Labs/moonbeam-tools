/*
  Settle every outstanding crowdloan reward by calling
  crowdloanRewards.completeUnclaimedRewards(target) for each account that still
  has an unclaimed balance, ahead of the crowdloanRewards pallet's removal.

  This is the companion to the lazy-migration extrinsic added in
  moonbeam-foundation/moonbeam#3756: once that extrinsic is released, run this to
  drain the remaining AccountsPayable entries before the pallet is removed.

  How it works:
  1. Enumerates the whole crowdloanRewards.accountsPayable map (paged).
  2. Keeps every entry where total_reward - claimed_reward > 0.
  3. Submits completeUnclaimedRewards(target) for each as its own extrinsic,
     which is Pays::No (free) on success. Transactions are pipelined in windows
     of concurrent submissions, re-reading the on-chain nonce per window so the
     local counter self-heals after each window settles.

  Settling removes the entry from storage, so the scan is the source of truth:
  re-running after a partial pass automatically skips everything already drained.
  The run is idempotent; no external checkpoint file is needed.

  Default is a DRY RUN (scans and reports, sends nothing — works even before the
  extrinsic is released). Pass --execute to actually settle.

  Note: completeUnclaimedRewards is Pays::No on success, but the
  transaction-payment pre-check still reserves the inclusion fee before refunding
  it, so the signing account must hold a small balance. Failed calls DO pay fees.

  Ex (dry run): bun src/lazy-migrations/007-complete-crowdloan-rewards.ts \
    --network moonbeam

  Ex (execute):  bun src/lazy-migrations/007-complete-crowdloan-rewards.ts \
    --network moonbeam --account-priv-key <key> --execute

  Ex (trial):    bun src/lazy-migrations/007-complete-crowdloan-rewards.ts \
    --network alphanet --account-priv-key <key> --execute --limit 5
*/

import "@moonbeam-network/api-augment";

import { Keyring } from "@polkadot/api";
import { isHex } from "@polkadot/util";
import { writeFileSync } from "node:fs";
import yargs from "yargs";

import { ALITH_PRIVATE_KEY } from "../utils/constants.ts";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks.ts";

import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { GenericEvent, StorageKey } from "@polkadot/types";
import type { DispatchError } from "@polkadot/types/interfaces";
import type { Codec, ISubmittableResult } from "@polkadot/types/types";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": {
      type: "string",
      demandOption: false,
      alias: "account",
      describe: "Ethereum-style (H160/ECDSA) private key of the submitting account",
    },
    alith: {
      type: "boolean",
      demandOption: false,
      conflicts: ["account-priv-key"],
      describe: "Use the well-known Alith dev account (dev/forked networks only)",
    },
    execute: {
      type: "boolean",
      default: false,
      describe: "Actually submit the settlements; without it the tool only scans (dry run)",
    },
    limit: {
      type: "number",
      demandOption: false,
      describe: "Process at most N targets (largest first) — handy for a trial run",
    },
    window: {
      type: "number",
      default: 50,
      describe: "Concurrent in-flight transactions per window",
    },
    "page-size": {
      type: "number",
      default: 1000,
      describe: "AccountsPayable keys fetched per scan page (lower it if the RPC rate-limits)",
    },
  })
  .check((argv) => {
    if (argv.execute && !(argv["account-priv-key"] || argv.alith)) {
      throw new Error("--execute requires --account-priv-key (or --alith)");
    }
    if (argv.window <= 0) {
      throw new Error("--window must be a positive integer");
    }
    if (argv["page-size"] <= 0) {
      throw new Error("--page-size must be a positive integer");
    }
    if (argv.limit !== undefined && argv.limit <= 0) {
      throw new Error("--limit must be a positive integer");
    }
    return true;
  }).argv;

// crowdloanRewards is moonbeam-specific and completeUnclaimedRewards is not yet
// in any published type augmentation, so the dynamically-typed accesses are kept
// behind these small helpers (with the unavoidable casts) rather than scattered.

interface RewardInfoCodec extends Codec {
  totalReward: { toBigInt(): bigint };
  claimedReward: { toBigInt(): bigint };
}

interface OptionLike extends Codec {
  isSome: boolean;
  unwrap(): Codec;
}

function isOption(value: Codec): value is OptionLike {
  return typeof (value as Partial<OptionLike>).isSome === "boolean";
}

/** Whether the runtime exposes the storage this migration reads. */
function hasAccountsPayable(api: ApiPromise): boolean {
  return Boolean((api.query as any).crowdloanRewards?.accountsPayable);
}

/** Whether the runtime exposes the (post-release) settlement extrinsic. */
function hasCompleteExtrinsic(api: ApiPromise): boolean {
  return Boolean((api.tx as any).crowdloanRewards?.completeUnclaimedRewards);
}

/** Build `crowdloanRewards.completeUnclaimedRewards(target)`. */
function completeUnclaimedRewards(
  api: ApiPromise,
  target: string,
): SubmittableExtrinsic<"promise"> {
  return (api.tx as any).crowdloanRewards.completeUnclaimedRewards(target);
}

/** One page of `crowdloanRewards.accountsPayable` entries. */
async function accountsPayablePage(
  api: ApiPromise,
  pageSize: number,
  startKey?: string,
): Promise<[StorageKey, Codec][]> {
  return (api.query as any).crowdloanRewards.accountsPayable.entriesPaged({
    args: [],
    pageSize,
    startKey,
  });
}

/**
 * Normalise an `accountsPayable` value (which may arrive as the bare struct or
 * an `Option<struct>`) into `{ total, claimed }`, or null if unusable.
 */
function readRewardInfo(value: Codec): { total: bigint; claimed: bigint } | null {
  const info = isOption(value) ? (value.isSome ? value.unwrap() : null) : value;
  if (!info) return null;
  const reward = info as RewardInfoCodec;
  if (!reward.totalReward || !reward.claimedReward) return null;
  return { total: reward.totalReward.toBigInt(), claimed: reward.claimedReward.toBigInt() };
}

/** Amount from a `crowdloanRewards.RewardsPaid` event, or null if it isn't one. */
function rewardsPaidAmount(api: ApiPromise, event: GenericEvent): bigint | null {
  const variant = (api.events as any).crowdloanRewards?.RewardsPaid;
  if (!variant?.is(event)) return null;
  return (event.data[1] as unknown as { toBigInt(): bigint }).toBigInt();
}

/** Free balance of an account, in plancks. */
async function freeBalance(api: ApiPromise, address: string): Promise<bigint> {
  const account = (await api.query.system.account(address)) as unknown as {
    data: { free: { toBigInt(): bigint } };
  };
  return account.data.free.toBigInt();
}

interface Outstanding {
  /** 0x-prefixed H160 address of the reward target. */
  target: string;
  total: bigint;
  claimed: bigint;
  outstanding: bigint;
}

/**
 * Enumerate the whole `crowdloanRewards.accountsPayable` map (paging until
 * exhausted) and return every entry that still has an unclaimed balance.
 */
async function scanOutstanding(
  api: ApiPromise,
  opts: { pageSize?: number; onProgress?: (scanned: number, found: number) => void } = {},
): Promise<Outstanding[]> {
  const pageSize = opts.pageSize ?? 1000;
  const found: Outstanding[] = [];
  let startKey: string | undefined;
  let scanned = 0;

  for (;;) {
    const entries = await accountsPayablePage(api, pageSize, startKey);
    if (entries.length === 0) break;

    for (const [key, value] of entries) {
      scanned++;
      const reward = readRewardInfo(value);
      if (!reward) continue;
      const outstanding = reward.total - reward.claimed;
      if (outstanding > 0n) {
        found.push({
          target: key.args[0]!.toString(),
          total: reward.total,
          claimed: reward.claimed,
          outstanding,
        });
      }
    }

    opts.onProgress?.(scanned, found.length);
    if (entries.length < pageSize) break;
    startKey = entries[entries.length - 1]![0].toHex();
  }

  return found;
}

interface SettleResult {
  /** Target address. */
  target: string;
  /** Extrinsic was included with no dispatch error. */
  ok: boolean;
  /** Amount paid out, from the RewardsPaid event (0 if it failed). */
  drained: bigint;
  error?: string;
  blockHash?: string;
}

function decodeError(api: ApiPromise, err: DispatchError): string {
  if (err.isModule) {
    const meta = api.registry.findMetaError(err.asModule);
    return `${meta.section}.${meta.name}`;
  }
  return err.toString();
}

/** Sign, submit, and resolve once the extrinsic is in a block (or times out). Never rejects. */
function send(
  api: ApiPromise,
  signer: KeyringPair,
  target: string,
  nonce: number,
  timeoutMs: number,
): Promise<SettleResult> {
  return new Promise((resolve) => {
    let done = false;
    let unsub: () => void = () => {};
    const finish = (r: SettleResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        unsub();
      } catch {
        /* already unsubscribed */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ target, ok: false, drained: 0n, error: "timeout waiting for inclusion" }),
      timeoutMs,
    );

    completeUnclaimedRewards(api, target)
      .signAndSend(signer, { nonce }, (result: ISubmittableResult) => {
        if (result.isError) {
          finish({
            target,
            ok: false,
            drained: 0n,
            error: "transaction dropped, invalid, or usurped",
          });
          return;
        }
        if (result.status.isInBlock) {
          const blockHash = result.status.asInBlock.toHex();
          if (result.dispatchError) {
            finish({
              target,
              ok: false,
              drained: 0n,
              error: decodeError(api, result.dispatchError),
              blockHash,
            });
            return;
          }
          let drained = 0n;
          for (const { event } of result.events) {
            const paid = rewardsPaidAmount(api, event);
            if (paid !== null) drained += paid;
          }
          finish({ target, ok: true, drained, blockHash });
        }
      })
      .then((u) => {
        unsub = u;
      })
      .catch((e) => finish({ target, ok: false, drained: 0n, error: e?.message ?? String(e) }));
  });
}

/**
 * One `completeUnclaimedRewards` per target — `Pays::No` (free) on success.
 * Transactions are pipelined in windows of `window` concurrent submissions; the
 * on-chain next nonce is re-read per window so the local counter self-heals
 * after each window settles.
 */
async function submitIndividual(
  api: ApiPromise,
  signer: KeyringPair,
  targets: Outstanding[],
  opts: {
    window?: number;
    timeoutMs?: number;
    onProgress?: (done: number, total: number, latest: SettleResult[]) => void;
  } = {},
): Promise<SettleResult[]> {
  const window = opts.window ?? 50;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const results: SettleResult[] = [];

  for (let i = 0; i < targets.length; i += window) {
    const chunk = targets.slice(i, i + window);
    const base = (await api.rpc.system.accountNextIndex(signer.address)).toNumber();
    const batch = await Promise.all(
      chunk.map((t, j) => send(api, signer, t.target, base + j, timeoutMs)),
    );
    results.push(...batch);
    opts.onProgress?.(results.length, targets.length, batch);
  }
  return results;
}

function fmt(raw: bigint, decimals: number, token: string): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${v / base}${frac ? `.${frac}` : ""} ${token}`;
}

function loadSigner(): KeyringPair {
  const pk = (argv.alith ? ALITH_PRIVATE_KEY : argv["account-priv-key"])?.trim();
  if (!pk) {
    throw new Error("No private key provided (use --account-priv-key or --alith).");
  }
  if (!isHex(pk) || pk.length !== 66) {
    throw new Error("Private key must be a 0x-prefixed 32-byte hex string.");
  }
  return new Keyring({ type: "ethereum" }).addFromUri(pk, undefined, "ethereum");
}

const main = async () => {
  const api = await getApiFor(argv);

  try {
    const chain = await api.rpc.system.chain();
    const specVersion = api.runtimeVersion.specVersion.toString();
    const decimals = api.registry.chainDecimals[0] ?? 18;
    const token = api.registry.chainTokens[0] ?? "UNIT";
    console.log(`Connected: ${chain.toString()} (spec ${specVersion}, ${token}/${decimals}dp)\n`);

    if (!hasAccountsPayable(api)) {
      throw new Error("This runtime has no crowdloanRewards.accountsPayable storage.");
    }
    const canExecute = hasCompleteExtrinsic(api);
    if (!canExecute) {
      console.log(
        "Note: crowdloanRewards.completeUnclaimedRewards is not present on this runtime yet — " +
          "scan/dry-run still works, but --execute will refuse until it is released.\n",
      );
    }

    console.log("Scanning crowdloanRewards.accountsPayable for outstanding rewards ...");
    let targets = await scanOutstanding(api, {
      pageSize: argv["page-size"],
      onProgress: (scanned, found) =>
        process.stdout.write(`\r  scanned ${scanned} entries, ${found} outstanding`),
    });
    process.stdout.write("\n");

    targets.sort((a, b) => (b.outstanding > a.outstanding ? 1 : -1));
    const totalOutstanding = targets.reduce((s, t) => s + t.outstanding, 0n);
    console.log(
      `\nFound ${targets.length} account(s) with outstanding rewards, ` +
        `totalling ${fmt(totalOutstanding, decimals, token)}.`,
    );
    if (targets.length > 0) {
      console.log("Largest:");
      for (const t of targets.slice(0, 5)) {
        console.log(`  ${t.target}  ${fmt(t.outstanding, decimals, token)}`);
      }
      if (targets.length > 5) console.log(`  ... and ${targets.length - 5} more`);
    }

    if (argv.limit !== undefined && argv.limit < targets.length) {
      targets = targets.slice(0, argv.limit);
      console.log(`\n--limit ${argv.limit}: processing only the ${targets.length} largest.`);
    }

    if (targets.length === 0) {
      console.log("\nNothing to settle. Done.");
      return;
    }

    if (!argv.execute) {
      console.log("\nDRY RUN — no transactions sent.");
      console.log("Re-run with --execute (and --account-priv-key) to settle.");
      return;
    }

    if (!canExecute) {
      throw new Error(
        "Cannot --execute: crowdloanRewards.completeUnclaimedRewards is not on this runtime yet.",
      );
    }

    const signer = loadSigner();
    const balance = await freeBalance(api, signer.address);
    console.log(`\nSigner: ${signer.address}  (free balance ${fmt(balance, decimals, token)})`);
    console.log(`EXECUTING against ${chain.toString()}: settling ${targets.length} account(s).\n`);

    const results = await submitIndividual(api, signer, targets, {
      window: argv.window,
      onProgress: (done, total, latest) => {
        for (const r of latest) {
          const tag = r.ok ? "ok " : "ERR";
          const extra = r.error ? ` — ${r.error}` : ` — ${fmt(r.drained, decimals, token)}`;
          console.log(`  [${done}/${total}] ${tag} ${r.target}${extra}`);
        }
      },
    });

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const drained = results.reduce((s, r) => s + r.drained, 0n);

    console.log(`\n===== Summary (${chain.toString()}) =====`);
    console.log(`  settled:       ${ok.length} / ${targets.length}`);
    console.log(`  failed:        ${failed.length}`);
    console.log(`  total drained: ${fmt(drained, decimals, token)}`);
    if (failed.length) {
      console.log("  failures:");
      for (const r of failed) console.log(`    ${r.target} — ${r.error}`);
    }

    const networkTag = chain.toString().toLowerCase().replace(/\s+/g, "-");
    const reportPath = `report-${networkTag}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          network: chain.toString(),
          when: new Date().toISOString(),
          targets: targets.length,
          results,
        },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ),
    );
    console.log(`\nReport written to ${reportPath}`);

    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await api.disconnect();
  }
};

main().catch((err) => {
  console.error(`\nError: ${err?.message ?? err}`);
  process.exit(1);
});
