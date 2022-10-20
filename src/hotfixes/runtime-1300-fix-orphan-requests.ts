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

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const atBlockNumber = argv.at || (await api.rpc.chain.getHeader()).number.toNumber();
  const apiAt = await api.at(await api.rpc.chain.getBlockHash(atBlockNumber));

  const [delegatorState] = await Promise.all([
    await apiAt.query.parachainStaking.delegatorState.entries(),
  ]);

  const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
  const runtimeVersion = upgradeInfo.specVersion.toNumber();

  console.log(
    `Using data from block #${atBlockNumber} (${api.runtimeVersion.specName.toString()}-${runtimeVersion})`
  );

  const delegatorsToFix = [];
  let totalRequests = 0;
  for (const state of delegatorState) {
    const stateData = state[1].unwrap(); 
    // @ts-ignore ParachainStakingDelegator removed requests in runtime 1700
    const requestData = stateData.requests.requests;
    requestData.forEach((request, collator) => {
      totalRequests++;
      const delegation = stateData.delegations.find(
        ({ owner }) => owner.toString() == collator.toString()
      );
      if (
        !delegation ||
        (request.action.isRevoke && delegation.amount.toBigInt() != request.amount.toBigInt())
      ) {
        console.log(
          `${stateData.id}: ${request.whenExecutable} - ${printTokens(
            api,
            delegation.amount.toBigInt()
          )} vs requested ${printTokens(api, request.amount.toBigInt())}`
        );
        delegatorsToFix.push(stateData.id);
      }
    });
  }

  // Unify multiple occurences of the same delegator.
  const delegators = [...new Set(delegatorsToFix)].sort();
  console.log(`Found ${delegators.length} delegators (amoong ${totalRequests} requests)`);

  if (argv["send-preimage-hash"]) {
    const collectiveThreshold = argv["collective-threshold"] || 1;
    const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
    const { nonce: rawNonce, data: balance } = (await api.query.system.account(
      account.address
    )) as any;
    let nonce = BigInt(rawNonce.toString());

    const BATCH_SIZE = 500;
    for (let i = 0; i < delegators.length; i += BATCH_SIZE) {
      const delegatorChunk = delegators.slice(i, i + BATCH_SIZE);
      console.log(`Preparing hotfix for ${delegatorChunk.length} delegators`);
      const hotFixTx = api.tx.parachainStaking.hotfixRemoveDelegationRequests(delegatorChunk);

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
  }

  await api.disconnect();
};

main();
