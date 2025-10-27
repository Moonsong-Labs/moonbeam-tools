# Migrate Locks to Freezes - Migration Script

This migration facilitates the transition from the deprecated `Currency` trait with lock-based fund restrictions to the modern `Fungible` trait with freeze-based mechanisms for parachain staking.

## Context

Related to [PR #3306](https://github.com/moonbeam-foundation/moonbeam/pull/3306), this migration converts staking locks (`stkngcol`, `stkngdel`) to staking freezes (`StakingCollator`, `StakingDelegator`).

### What Changed

- **Before**: Accounts had staking locks visible in `Balances.Locks` with identifiers `stkngcol` (collators) and `stkngdel` (delegators)
- **After**: Accounts have staking freezes visible in `Balances.Freezes` with reasons `StakingCollator` and `StakingDelegator`

### Migration Mechanism

The migration is lazy - accounts automatically migrate during their next staking interaction. However, this script allows proactive batch migration of accounts before they interact with the staking pallet.

## Scripts

### 1. Query Accounts (Helper Script)

**File**: `006-get-accounts-with-staking-locks.ts`

Queries the chain for accounts that still have staking locks and haven't been migrated to freezes yet.

#### Usage

```bash
npx tsx src/lazy-migrations/get-accounts-with-staking-locks.ts --url wss://wss.api.moonbeam.network
```

#### Options

- `--url`: WebSocket URL of the chain
- `--output-file`: (Optional) Custom path for output JSON file

#### Output

Creates two files:
1. `accounts-with-staking-locks--{chain}.json` - Simple array of account addresses
2. `accounts-with-staking-locks--{chain}.info.json` - Detailed information with locks and freezes

### 2. Migration Script

**File**: `006-migrate-locks-to-freezes.ts`

Performs the actual migration by calling `parachainStaking.migrateLocksToFreezesBatch` with batches of up to 100 accounts.

#### Usage

```bash
# Using pre-generated account list
bun src/lazy-migrations/006-migrate-locks-to-freezes.ts \
  --url wss://wss.api.moonbeam.network \
  --account-priv-key <private-key> \
  --input-file src/lazy-migrations/accounts-with-staking-locks--moonbeam.json \
  --limit 50
```

#### Options

- `--url`: WebSocket URL of the chain
- `--account-priv-key`: Private key of the account to sign transactions (required unless using `--alith`)
- `--alith`: Use Alith's private key (dev/testing only)
- `--limit`: Maximum number of accounts per batch (default: 100, max: 100)
- `--input-file`: (Optional) Path to JSON file with account addresses. If not provided, will query chain state

#### Progress Tracking

The script creates a progress file: `locks-to-freezes-migration-progress--{chain}.json`

This file tracks:
- `pending_accounts`: Accounts still to be migrated
- `migrated_accounts`: Successfully migrated accounts
- `failed_accounts`: Failed migrations with error messages

You can safely interrupt and restart the script - it will resume from where it left off.

#### Verification

After each batch transaction, the script verifies migration by:
1. Checking `Balances.Freezes` for the account
2. Confirming presence of `StakingCollator` or `StakingDelegator` freeze reason