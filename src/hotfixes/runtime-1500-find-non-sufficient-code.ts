//@ts-nocheck
// This script is expected to run against a parachain network (using launch.ts script)
import "@moonbeam-network/api-augment";

import { Keyring } from "@polkadot/api";
import fs from "fs";
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../index";

import type { FrameSystemAccountInfo } from "@polkadot/types/lookup";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "account-priv-key": { type: "string", demandOption: false, alias: "account" },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);

  const atBlockNumber = argv.at || (await api.rpc.chain.getHeader()).number.toNumber();
  const apiAt = await api.at(await api.rpc.chain.getBlockHash(atBlockNumber));

  const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
  const runtimeVersion = upgradeInfo.specVersion.toNumber();

  console.log(
    `Using data from block #${atBlockNumber} (${api.runtimeVersion.specName.toString()}-${runtimeVersion})`,
  );

  const [accountCodeKeys] = await Promise.all([apiAt.query.evm.accountCodes.keys()]);
  console.log(`Found ${accountCodeKeys.length} smart contracts`);

  const accounts: { [account: string]: FrameSystemAccountInfo } = {};
  const BATCH_SIZE = 1000;
  for (let i = 0; i < accountCodeKeys.length; i += BATCH_SIZE) {
    const chunkKeys = accountCodeKeys.slice(i, i + BATCH_SIZE);
    const multiAccount = await apiAt.query.system.account.multi(
      chunkKeys.map((k) => `0x${k.toHex().slice(-40)}`),
    );
    for (const index in chunkKeys) {
      accounts[chunkKeys[index].toHex()] = multiAccount[index];
    }
    console.log(`Retrieved ${i + chunkKeys.length} accounts...`);
  }

  const accountsToFix = [];
  for (const key of accountCodeKeys) {
    const accountId = key.toHex();
    if (
      accounts[accountId].nonce.toNumber() > 0 &&
      accounts[accountId].consumers.toNumber() == 0 &&
      accounts[accountId].providers.toNumber() == 0 &&
      accounts[accountId].sufficients.toNumber() == 0
    ) {
      accountsToFix.push(`0x${accountId.slice(-40)}`);
    }
  }

  const sortedAccountsToFix = [...new Set(accountsToFix)].sort();

  console.log(
    `Found ${sortedAccountsToFix.length} / ${
      accountCodeKeys.length
    } on ${upgradeInfo.specName.toString()}[${upgradeInfo.specVersion.toNumber()}]`,
  );

  if (argv["account-priv-key"]) {
    const keyring = new Keyring({ type: "ethereum" });
    const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
    const { nonce: rawNonce, data: balance } = (await api.query.system.account(
      account.address,
    )) as any;
    let nonce = BigInt(rawNonce.toString());

    for (let i = 0; i < sortedAccountsToFix.length; i += BATCH_SIZE) {
      const chunkAccounts = sortedAccountsToFix.slice(i, i + BATCH_SIZE);
      await api.tx.evm
        .hotfixIncAccountSufficients(chunkAccounts)
        .signAndSend(account, { nonce: nonce++ });
      await new Promise((resolve) => setTimeout(resolve, 12000));
      console.log(`Sending ${i + chunkAccounts.length} / ${sortedAccountsToFix.length}...`);
    }
  }
  fs.writeFileSync(
    `${upgradeInfo.specName.toString()}-accounts-to-fix.json`,
    JSON.stringify(sortedAccountsToFix, null, 2),
  );

  await api.disconnect();
};

main();
