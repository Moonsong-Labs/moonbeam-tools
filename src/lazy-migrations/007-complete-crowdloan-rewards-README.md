# Complete Crowdloan Rewards - Migration Script

This migration permissionlessly settles **every outstanding crowdloan reward** by
calling `crowdloanRewards.completeUnclaimedRewards(target)` for each account that
still has an unclaimed balance, ahead of the `crowdloanRewards` pallet's removal.

## Context

This is the companion to the lazy-migration extrinsic added in
[moonbeam-foundation/moonbeam#3756](https://github.com/moonbeam-foundation/moonbeam/pull/3756).
Once that extrinsic is released, run this script to drain the remaining
`crowdloanRewards.accountsPayable` entries before the pallet is fully removed.

### Migration Mechanism

`completeUnclaimedRewards(target)` pays out the unclaimed remainder for a single
account and is `Pays::No` (free) on success. The script enumerates the whole
`accountsPayable` map and submits one such extrinsic per outstanding account.

Settling **removes** the entry from storage, so the scan is the source of truth:
re-running after a partial pass automatically skips everything already drained.
The run is idempotent — no external checkpoint file is needed.

## Script

**File**: `007-complete-crowdloan-rewards.ts`

1. Enumerates the entire `crowdloanRewards.accountsPayable` map (paged).
2. Keeps every entry where `total_reward - claimed_reward > 0`.
3. Submits `completeUnclaimedRewards(target)` for each as its own extrinsic.
   Transactions are pipelined in windows of concurrent submissions; the on-chain
   next nonce is re-read per window so the local counter self-heals after each
   window settles.

### Usage

Dry run (default — scans and reports, sends nothing; works even before the
extrinsic is released):

```bash
bun src/lazy-migrations/007-complete-crowdloan-rewards.ts --network moonbeam
```

Execute (free settlements, one extrinsic per target):

```bash
bun src/lazy-migrations/007-complete-crowdloan-rewards.ts \
  --network moonbeam \
  --account-priv-key <private-key> \
  --execute
```

Trial against a few accounts first (on Moonbase Alpha):

```bash
bun src/lazy-migrations/007-complete-crowdloan-rewards.ts \
  --network alphanet \
  --account-priv-key <private-key> \
  --execute --limit 5
```

### Options

- `--network`: Known network (`moonbeam`, `moonriver`, `alphanet` for Moonbase Alpha, ...)
- `--url`: WebSocket URL of the chain (alternative to `--network`)
- `--account-priv-key`: Ethereum-style (H160/ECDSA) private key of the submitting
  account (required with `--execute` unless using `--alith`)
- `--alith`: Use Alith's private key (dev/forked networks only)
- `--execute`: Actually submit the settlements; without it the tool only scans (dry run)
- `--limit`: Process at most N targets (largest first) — handy for a trial run
- `--window`: Concurrent in-flight transactions per window (default: 50)
- `--page-size`: `accountsPayable` keys fetched per scan page (default: 1000);
  lower it if a forked/proxied RPC rate-limits the scan

### Output

Live per-transaction progress, a final summary (settled / failed counts, total
drained, any failures with decoded errors), and a
`report-<chain>-<timestamp>.json` artifact with the full per-result detail.

### Requirements & safety notes

- For `--execute`: an Ethereum-style account with a small balance.
  `completeUnclaimedRewards` is `Pays::No` on success, but the
  transaction-payment pre-check still reserves the inclusion fee before
  refunding it, so the signer must be fundable. **Failed** calls pay fees.
- Default is a **dry run**; you must pass `--execute` to send anything.
- Start with `--limit` and/or `--network alphanet` to rehearse.
- The script never logs or persists the private key.
