// Schedules / executes / cancels leaving parachain staking, for every role:
//   - staker (delegator): revokes every delegation
//   - collator (candidate): leaves the set of candidates
//   - orbiter (moonbeamOrbiters): leaves every collator pool and unregisters
//
// The roles are auto-detected from the on-chain state of the target account.
// Leaving staking is a two-phase process: you first `schedule` the exit, then
// `execute` it once the exit delay (several rounds) has elapsed. `cancel`
// reverts a previously scheduled exit.
//
// Orbiter leaving is immediate (no round delay): it is performed on both
// `schedule` and `execute` based on the current state (idempotent), and cannot
// be reverted by `cancel`.
//
// Supports acting through a proxy: pass `--proxy <staker/collator address>` and
// sign with the proxy account's key. Without `--proxy`, the signing account is
// the staker/collator itself.
//
// Ex (schedule leaving for an account controlled by a proxy):
//   bun src/tools/leave-staking.ts \
//     --network moonbeam \
//     --account-priv-key <proxy-key> \
//     --proxy <staker-collator-address> \
//     --action schedule
//
// Ex (execute once the delay has passed, signing directly):
//   bun src/tools/leave-staking.ts \
//     --network moonbeam \
//     --account-priv-key <staker-collator-key> \
//     --action execute
import "@moonbeam-network/api-augment";
import "@polkadot/api-augment";

import { Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import yargs from "yargs";

import { ALITH_PRIVATE_KEY } from "../utils/constants";
import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { maybeProxyCall } from "../utils/transactions";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": {
      type: "string",
      demandOption: false,
      alias: "account",
      describe: "Private key of the signing account (the proxy when --proxy is set)",
    },
    alith: {
      type: "boolean",
      demandOption: false,
      conflicts: ["account-priv-key"],
      describe: "Sign with the well-known Alith development key",
    },
    proxy: {
      type: "string",
      demandOption: false,
      describe: "Address of the staker/collator being proxied",
    },
    "proxy-type": {
      type: "string",
      demandOption: false,
      describe: "Type of proxy (e.g. Any, Staking, Governance)",
    },
    action: {
      choices: ["schedule", "execute", "cancel"] as const,
      demandOption: false,
      default: "schedule" as const,
      describe: "Phase of the leave process to perform",
    },
    "dry-run": {
      type: "boolean",
      demandOption: false,
      default: false,
      describe: "Only print the calls that would be sent, without submitting them",
    },
  })
  .check((argv) => {
    if (!argv["account-priv-key"] && !argv["alith"]) {
      throw new Error("Missing --account-priv-key (or --alith)");
    }
    return true;
  }).argv;

async function main() {
  const api = await getApiFor(argv);

  try {
    const keyring = new Keyring({ type: "ethereum" });
    const privKey = argv["alith"] ? ALITH_PRIVATE_KEY : argv["account-priv-key"];
    const account: KeyringPair = keyring.addFromUri(privKey, null, "ethereum");
    const { nonce: rawNonce } = (await api.query.system.account(account.address)) as any;
    let nonce = BigInt(rawNonce.toString());

    // The target is the account whose staking state we act on. With a proxy,
    // that is the proxied account; otherwise it is the signer itself.
    const target = api.registry
      .createType("EthereumAccountId", argv.proxy || account.address)
      .toString();

    const action = argv.action as "schedule" | "execute" | "cancel";
    const tryProxy = (call: SubmittableExtrinsic) =>
      maybeProxyCall(api, call, argv.proxy, argv["proxy-type"]);

    console.log(`Signer:  ${account.address}`);
    console.log(`Target:  ${target}${argv.proxy ? " (via proxy)" : ""}`);
    console.log(`Action:  ${action}`);

    const round = await api.query.parachainStaking.round();
    const currentRound = round.current.toNumber();
    console.log(`Round:   #${currentRound}`);

    // --- Detect the target's staking roles ---------------------------------
    const hasOrbiters = !!api.query.moonbeamOrbiters;
    const [delegatorStateOpt, candidateInfoOpt, registeredOrbiterOpt] = await Promise.all([
      api.query.parachainStaking.delegatorState(target),
      api.query.parachainStaking.candidateInfo(target),
      hasOrbiters
        ? api.query.moonbeamOrbiters.registeredOrbiter(target)
        : Promise.resolve(undefined),
    ]);

    const isDelegator = delegatorStateOpt.isSome;
    const isCandidate = candidateInfoOpt.isSome;
    const isOrbiter = !!registeredOrbiterOpt && registeredOrbiterOpt.isSome;

    if (!isDelegator && !isCandidate && !isOrbiter) {
      console.log(
        `Target ${target} is neither a delegator, a candidate nor an orbiter. Nothing to do.`,
      );
      await api.disconnect();
      return;
    }

    const calls: { label: string; call: SubmittableExtrinsic }[] = [];

    // --- Staker (delegator) ------------------------------------------------
    if (isDelegator) {
      const delegatorState = delegatorStateOpt.unwrap();
      const collators = delegatorState.delegations.map((d) => d.owner.toString());
      const revokeDelay = api.consts.parachainStaking.revokeDelegationDelay.toNumber();
      console.log(
        `\nDelegator with ${collators.length} delegation(s) [revoke delay: ${revokeDelay} rounds]`,
      );

      // Scheduled requests for this delegator, keyed by collator. The storage
      // layout differs across runtimes: older ones use a single map
      // (collator -> Vec<{delegator, whenExecutable, action}>), current ones a
      // double map ((collator, delegator) -> Vec<{whenExecutable, action}>).
      const scheduledReq = api.query.parachainStaking.delegationScheduledRequests as any;
      const isDoubleMap = scheduledReq.creator.meta.type.asMap.hashers.length === 2;
      const requestByCollator = new Map<string, { whenExecutable: number; action: string }>();
      const perCollator = isDoubleMap
        ? await Promise.all(collators.map((collator) => scheduledReq(collator, target)))
        : await scheduledReq.multi(collators);
      collators.forEach((collator, i) => {
        // Double map: value is already scoped to (collator, target), take the
        // first request. Single map: filter the collator's requests by target.
        const request = isDoubleMap
          ? perCollator[i][0]
          : perCollator[i].find((r: any) => r.delegator.toString() === target);
        if (request) {
          requestByCollator.set(collator, {
            whenExecutable: request.whenExecutable.toNumber(),
            action: request.action.isRevoke ? "Revoke" : "Decrease",
          });
        }
      });

      for (const collator of collators) {
        const request = requestByCollator.get(collator);
        if (action === "schedule") {
          if (request) {
            console.log(
              `  - ${collator}: already has a scheduled ${request.action} (executable at round #${request.whenExecutable}), skipping`,
            );
            continue;
          }
          calls.push({
            label: `scheduleRevokeDelegation(${collator})`,
            call: tryProxy(api.tx.parachainStaking.scheduleRevokeDelegation(collator)),
          });
        } else if (action === "execute") {
          if (!request) {
            console.log(`  - ${collator}: no scheduled request, skipping`);
            continue;
          }
          if (request.whenExecutable > currentRound) {
            console.log(
              `  - ${collator}: not executable yet (round #${request.whenExecutable} > #${currentRound}), skipping`,
            );
            continue;
          }
          calls.push({
            label: `executeDelegationRequest(${target}, ${collator})`,
            call: tryProxy(api.tx.parachainStaking.executeDelegationRequest(target, collator)),
          });
        } else if (action === "cancel") {
          if (!request) {
            console.log(`  - ${collator}: no scheduled request to cancel, skipping`);
            continue;
          }
          calls.push({
            label: `cancelDelegationRequest(${collator})`,
            call: tryProxy(api.tx.parachainStaking.cancelDelegationRequest(collator)),
          });
        }
      }
    }

    // --- Collator (candidate) ----------------------------------------------
    if (isCandidate) {
      const candidateInfo = candidateInfoOpt.unwrap();
      const status = candidateInfo.status;
      const leaveDelay = api.consts.parachainStaking.leaveCandidatesDelay.toNumber();
      console.log(`\nCandidate [status: ${status.type}, leave delay: ${leaveDelay} rounds]`);

      const isLeaving = status.isLeaving;
      const leavingRound = isLeaving ? status.asLeaving.toNumber() : 0;

      if (action === "schedule") {
        if (isLeaving) {
          console.log(
            `  - already scheduled to leave (executable at round #${leavingRound}), skipping`,
          );
        } else {
          const candidateCount = (await api.query.parachainStaking.candidatePool()).length;
          calls.push({
            label: `scheduleLeaveCandidates(${candidateCount})`,
            call: tryProxy(api.tx.parachainStaking.scheduleLeaveCandidates(candidateCount)),
          });
        }
      } else if (action === "execute") {
        if (!isLeaving) {
          console.log(`  - not scheduled to leave, skipping`);
        } else if (leavingRound > currentRound) {
          console.log(
            `  - not executable yet (round #${leavingRound} > #${currentRound}), skipping`,
          );
        } else {
          const delegationCount = candidateInfo.delegationCount.toNumber();
          calls.push({
            label: `executeLeaveCandidates(${target}, ${delegationCount})`,
            call: tryProxy(api.tx.parachainStaking.executeLeaveCandidates(target, delegationCount)),
          });
        }
      } else if (action === "cancel") {
        if (!isLeaving) {
          console.log(`  - not scheduled to leave, nothing to cancel`);
        } else {
          const candidateCount = (await api.query.parachainStaking.candidatePool()).length;
          calls.push({
            label: `cancelLeaveCandidates(${candidateCount})`,
            call: tryProxy(api.tx.parachainStaking.cancelLeaveCandidates(candidateCount)),
          });
        }
      }
    }

    // --- Orbiter (moonbeamOrbiters) ----------------------------------------
    // Leaving is immediate: leave every collator pool the orbiter belongs to,
    // then unregister from the program (recovering the deposit). Ordering is
    // guaranteed by the incrementing nonce, so pools are left before the
    // unregister call is processed.
    if (isOrbiter) {
      if (action === "cancel") {
        console.log(`\nOrbiter: leaving is immediate and cannot be cancelled, skipping`);
      } else {
        const pools = await api.query.moonbeamOrbiters.collatorsPool.entries();
        const memberOf = pools
          .filter(
            ([, info]) =>
              info.isSome && info.unwrap().orbiters.some((o) => o.toString() === target),
          )
          .map(([key]) => key.args[0].toString());
        const poolCount = (await api.query.moonbeamOrbiters.counterForCollatorsPool()).toNumber();
        console.log(
          `\nOrbiter registered in ${memberOf.length} collator pool(s) [immediate, no delay]`,
        );

        for (const collator of memberOf) {
          calls.push({
            label: `orbiterLeaveCollatorPool(${collator})`,
            call: tryProxy(api.tx.moonbeamOrbiters.orbiterLeaveCollatorPool(collator)),
          });
        }
        calls.push({
          label: `orbiterUnregister(${poolCount})`,
          call: tryProxy(api.tx.moonbeamOrbiters.orbiterUnregister(poolCount)),
        });
      }
    }

    if (calls.length === 0) {
      console.log(`\nNo extrinsics to send for action "${action}".`);
      await api.disconnect();
      return;
    }

    console.log(`\n${argv["dry-run"] ? "Would send" : "Sending"} ${calls.length} extrinsic(s):`);
    for (const { label } of calls) {
      console.log(`  - ${label}`);
    }

    if (argv["dry-run"]) {
      await api.disconnect();
      return;
    }

    for (const { label, call } of calls) {
      await call.signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: label, verbose: true }),
      );
    }

    await waitForAllMonitoredExtrinsics();
  } finally {
    await api.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
