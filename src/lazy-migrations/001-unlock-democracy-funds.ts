//   This script is intended to run once for specific networks.
//   Do not use it without reading the code !!
//
//   This script will continuously call and wait for completion of unlockDemocracyFunds
//   extrinsic from pallet moonbeam-lazy-migrations until the migration is completed.
//
// Ex: bun src/lazy-migrations/001-unlock-democracy-funds.ts \
//    --url ws://127.0.0.1:34102 \
//    --account-priv-key <key>
import "@moonbeam-network/api-augment";

import { Keyring } from "@polkadot/api";
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../index.ts";
import { monitorSubmittedExtrinsic, waitForAllMonitoredExtrinsics } from "../utils/monitoring.ts";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": { type: "string", demandOption: true, alias: "account" },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const atBlockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  const atBlockHash = await api.rpc.chain.getBlockHash(atBlockNumber);
  const apiAt = await api.at(atBlockHash);

  const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
  const runtimeVersion = upgradeInfo.specVersion.toNumber();

  console.log(
    `Current block number #${atBlockNumber} with runtime version ${api.runtimeVersion.specName.toString()}-${runtimeVersion}`,
  );

  const keyring = new Keyring({ type: "ethereum" });
  const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
  const { nonce: rawNonce } = (await api.query.system.account(account.address)) as any;
  let nonce = BigInt(rawNonce.toString());

  const MAX_UNLOCK_DEMOCRACY_FUNDS_LIMIT = 50;

  let migrationCompleted = (
    await api.query.moonbeamLazyMigrations.democracyLocksMigrationCompleted()
  ).toHuman();
  if (migrationCompleted === true) {
    console.log("Democracy locks migration already completed. Exiting...");
  } else {
    console.log("Unlocking democracy funds...");
    while (migrationCompleted === false) {
      const tx = api.tx.moonbeamLazyMigrations.unlockDemocracyFunds(
        MAX_UNLOCK_DEMOCRACY_FUNDS_LIMIT,
      );
      await tx.signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: "unlock_democracy_funds" }),
      );
      await waitForAllMonitoredExtrinsics();
      migrationCompleted = (
        await api.query.moonbeamLazyMigrations.democracyLocksMigrationCompleted()
      ).toHuman();
    }
    console.log("Done!");
  }

  await api.disconnect();
};

main();
