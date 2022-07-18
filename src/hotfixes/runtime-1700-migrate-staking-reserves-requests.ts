/*
  This script is intended to run once as hotfix for specific networks.
  Do not use it without reading the code !!

  This script will find orphan requests (already executed but not removed
    from the delegator state)

Ex: ./node_modules/.bin/ts-node-transpile-only src/hotfixes/runtime-1300-fix-orphan-requests.ts \
   --network alphanet \
   --send-preimage-hash \
   --send-proposal-as council-external \
   --collective-threshold 3 \
   --account-priv-key <key> \
*/

import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";
import { Keyring } from "@polkadot/api";
import { blake2AsHex } from "@polkadot/util-crypto";
import { printTokens } from "../utils/monitoring";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": { type: "string", demandOption: false, alias: "account" },
    "send-preimage-hash": { type: "boolean", demandOption: false, alias: "h" },
    "send-proposal-as": {
      choices: ["democracy", "council-external", "sudo"],
      demandOption: false,
      alias: "s",
    },
    "collators": { type: "boolean", demandOption: false, },
    "delegators": { type: "boolean", demandOption: false, },
    at: {
      type: "number",
      description: "Block number to look into",
    },
    "collective-threshold": { type: "number", demandOption: false, alias: "c" },
  })
  .check(function (argv) {
    if (argv["send-preimage-hash"] && !argv["account-priv-key"]) {
      console.log(`Missing --account-priv-key`);
      return false;
    }
    return true;
  }).argv;

const findUnmigratedCollators = async (apiAt: any) => {
  const [collatorState] = await Promise.all([
    await apiAt.query.parachainStaking.candidateInfo.entries(),
  ]);

  console.log(`examining ${collatorState.length}`);

  const collatorsToFix = [];
  let totalRequests = 0;
  for (const state of collatorState) {
    const storageKey = ""+state[0];
    const id = storageKey.substring(storageKey.length - 40, storageKey.length);

    let hasMigrated = 
      await apiAt.query.parachainStaking.collatorReserveToLockMigrations(id);

    console.log(`${id}: ${hasMigrated.eq(true) ? '✅' : '✗'}`);

    if (hasMigrated.eq(false)) {
      collatorsToFix.push(id);
    }
  }

  // Unify multiple occurences of the same collator.
  const collators = [...new Set(collatorsToFix)].sort();
  console.log(`Found ${collators.length} collators`);

  return collators;
}

const findUnmigratedDelegators = async (apiAt: any) => {
  const [delegatorState] = await Promise.all([
    await apiAt.query.parachainStaking.delegatorState.entries(),
  ]);

  console.log(`examining ${delegatorState.length}`);

  const delegatorsToFix = [];
  let totalRequests = 0;
  for (const state of delegatorState) {
    const stateData = state[1].unwrap();

    let hasMigrated = 
      await apiAt.query.parachainStaking.delegatorReserveToLockMigrations(stateData.id);

    console.log(`${stateData.id}: ${hasMigrated.eq(true) ? '✅' : '✗'}`);

    if (hasMigrated.eq(false)) {
      delegatorsToFix.push(stateData.id);
    }
  }

  // Unify multiple occurences of the same delegator.
  const delegators = [...new Set(delegatorsToFix)].sort();
  console.log(`Found ${delegators.length} delegators`);

  return delegators;
}

const main = async () => {
  const doDelegators = argv["delegators"] ? true : false;
  const doCollators = argv["collators"] ? true : false;

  if (! doDelegators && ! doCollators) {
    console.log("Error: must use one or both of --delegators and --collators");
    return 1;
  }

  // Instantiate Api
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const atBlockNumber = argv.at || (await api.rpc.chain.getHeader()).number.toNumber();
  const apiAt = await api.at(await api.rpc.chain.getBlockHash(atBlockNumber));

  const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
  const runtimeVersion = upgradeInfo.specVersion.toNumber();

  let collators = [];
  if (doCollators) {
    collators = await findUnmigratedCollators(apiAt);
  }
  let delegators = [];
  if (doDelegators) {
    delegators = await findUnmigratedDelegators(apiAt);
  }

  console.log(
    `Using data from block #${atBlockNumber} (${api.runtimeVersion.specName.toString()}-${runtimeVersion})`
  );

  if (argv["send-preimage-hash"]) {
    const collectiveThreshold = argv["collective-threshold"] || 1;
    const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
    const { nonce: rawNonce, data: balance } = (await api.query.system.account(
      account.address
    )) as any;
    let nonce = BigInt(rawNonce.toString());

    const BATCH_SIZE = 99;

    const submitTx = async (hotFixTx) => {
      let encodedProposal = hotFixTx?.method.toHex() || "";
      let encodedHash = blake2AsHex(encodedProposal);
      console.log("Encoded proposal hash for complete is %s", encodedHash);
      console.log("Encoded length %d", encodedProposal.length);

      console.log("Sending pre-image");
      await api.tx.democracy.notePreimage(encodedProposal).signAndSend(account, { nonce: nonce++ });

      if (argv["send-proposal-as"] == "democracy") {
        console.log("Sending proposal");
        await api.tx.democracy
          .propose(encodedHash, await api.consts.democracy.minimumDeposit)
          .signAndSend(account, { nonce: nonce++ });
      } else if (argv["send-proposal-as"] == "council-external") {
        console.log("Sending external motion");
        let external = api.tx.democracy.externalProposeMajority(encodedHash);
        await api.tx.councilCollective
          .propose(collectiveThreshold, external, external.length)
          .signAndSend(account, { nonce: nonce++ });
      }
    }

    // send collator hotfix extrinsics
    if (doCollators) {
      for (let i = 0; i < collators.length; i += BATCH_SIZE) {
        const collatorChunk = collators.slice(i, i + BATCH_SIZE);
        console.log(`Preparing hotfix for ${collatorChunk.length} collators`);
        const hotFixTx = api.tx.parachainStaking.hotfixMigrateCollatorsFromReserveToLocks(collatorChunk);
        await submitTx(hotFixTx);
      }
    }

    // send delegator hotfix extrinsics
    if (doDelegators) {
      for (let i = 0; i < delegators.length; i += BATCH_SIZE) {
        const delegatorChunk = delegators.slice(i, i + BATCH_SIZE);
        console.log(`Preparing hotfix for ${delegatorChunk.length} delegators`);
        const hotFixTx = api.tx.parachainStaking.hotfixMigrateDelegatorsFromReserveToLocks(delegatorChunk);
        await submitTx(hotFixTx);
      }
    }
  }

  await api.disconnect();
};

main();
