/*
This script is a sample. Do not use it without reading the code !!

Goal: 
 - This script set proxies by changing directly the storage values.
   It is useful when setting proxies without deposits in test environments.

 - It demonstrate how to use createType with runtime specific modules (L92)

Ex: ./node_modules/.bin/ts-node-transpile-only src/tools/list-methods.ts \
   --network alphanet \
   --send-preimage-hash \
   --send-proposal-as council-external \
   --collective-threshold 3 \
   --account-priv-key <key> \
*/

import { Keyring } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";

const PROPOSAL_AMOUNT = 10_000_000_000_000_000_000n;

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
    "collective-threshold": { type: "number", demandOption: false, alias: "c" },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  const storage = {};
  const accounts = [
    "0xec5849f7b9f7b5188e53e6546d07062b7d2b46a0",
    "0xe15a2e4f35215a553151df283a39c7d17db8aaec",
    "0xee050f48ff5ff71604d5ca32020a6ba1c070f1b2",
    "0x3ad24a37d4b6ebd24e70a2c87241a63d92a6b288",
    "0x835d6f7b649e109470f966a936308f78fdebec2d",
    "0x02f50d4c3861c279aa0467caf49f8077b3c0ca60",
    "0xce216241675657f40203679aa8f6472d8c140ab0",
    "0xf1e35633ebbb793f1d22e6cc6b279afe8c33b381",
    "0x906ea348769389c32f2732b79615d12b2514274e",
    "0x91ad9c2608d04722400a22215d2d951dedb11cb4",
    "0x6e87680133c34c96c86ffd101844b14fd63f0fe1",
    "0xe5a56b7ff1aa39376588968e057f73ba9dc43ac1",
    "0xb843fa0c53382a24386c4bfd6e26156b6c1aa502",
    "0x98091cad1243f4a6d2454a7f0ca3258fb053c152",
    "0xb29f4d175953faf999869036bb170e4a99dba62c",
    "0x0344cb6a7acb0f074237943e2ffb0bfce6e6c1fc",
    "0xfb43cc3136a81d6df94b92637b007f0235b92563",
    "0x418671c5e8e14095720bae1f063df18c6414239b",
    "0xaab463ba7bf4eca75d5f84aabfb077dc9b9fbf0c",
    "0xbfa14eb753e03ec28f1fca98e60227f1e3631451",
    "0xef24bcef8052cf5f2758ea23ed02d48c0f788bd5",
    "0xd985dd9453bb9bae5f2bcb79f90b3ed724033ca0",
    "0x47b69aef78183b282c6dfad76eecfcd0676a85f3",
    "0xb00af4494099bf419c79768cc3d2e1f45a106b54",
    "0x7882fc72720e2bd786dc1e2dda3b37f76ef7ac1a",
    "0x2afbdaeed55af511d2f4f54048db5347993c41d1",
    "0xb49e71e2516084f4697e21b7f2ebeddbfc900887",
    "0x286c93de3767bdc37694ff5326a2ec074a271841",
    "0x4599d3fb61afbe53ec0c74e9d3e662df14c011bc",
    "0x18cb64d0d2b5cecb7d0f08e4bec9c955f3a221ed",
    "0xeee7f269e04163dea8f9c8c075429e0b9928a6f8",
    "0x471ac074b60dab1ce62eec90b766a7e3da5719bf",
    "0x85b46641d2f1c1c207d50c1d0e04f8e57c8cf2f8",
    "0x7f8d1c2b3d770693a4c0ebc02731dc3107bca672",
    "0x670762abc78c65aee1274bc2ed179da7b8bd3b81",
    "0x7f1ba0b92943a38a55ea344676f5685afbfe5ad5",
    "0xac6d13f8b148acfc5fca4d4d6b4eaa5a78c6079c",
    "0x365cb79b68552a44ecce2cfc698de5edfaf452c0",
    "0x93041c0aa0b6e96c4e5f98831c58673f2e318274",
    "0x0a2f88f2c8ec33ab7d5118a09b09eef844e3be72",
  ];

  const proxies = ["0x456087a9a2062b249063b128c57ae039fc0a00d9"];

  const runtimePrefix =
    api.runtimeVersion.specName.toString().charAt(0).toUpperCase() +
    api.runtimeVersion.specName.toString().slice(1);

  const proxyType = api.registry.createType(`${runtimePrefix}RuntimeProxyType`, "Any");
  const proxyDelay = api.registry.createType(`u32`, 60);
  const proxyDeposit = api.registry.createType(`u128`, 0);

  for (const account of accounts) {
    const exist = await api.query.proxy.proxies(account);
    if (!exist.isEmpty && !exist[1].isEmpty) {
      console.log(`Found proxies for ${account} already`);
      console.log(exist[1].toJSON());
      return;
    }
    storage[api.query.proxy.proxies.key(account)] = `0x${(proxies.length * 4)
      .toString(16)
      .padStart(2, "0")}${proxies
      .map(
        (proxy) =>
          `${proxy.slice(2)}${u8aToHex(proxyType.toU8a()).slice(2)}${u8aToHex(
            proxyDelay.toU8a()
          ).slice(2)}`
      )
      .join("")}${u8aToHex(proxyDeposit.toU8a()).slice(2)}`;
  }
  console.log("Found %d proxies", Object.keys(storage).length);

  if (argv["send-preimage-hash"]) {
    const collectiveThreshold = argv["collective-threshold"] || 1;
    const account = await keyring.addFromUri(argv["account-priv-key"], null, "ethereum");
    const { nonce: rawNonce, data: balance } = (await api.query.system.account(
      account.address
    )) as any;
    let nonce = BigInt(rawNonce.toString());

    const setStorageTx = api.tx.system.setStorage(
      Object.keys(storage).map((key) => [key, storage[key]] as [string, string])
    );

    let encodedProposal = setStorageTx?.method.toHex() || "";
    let encodedHash = blake2AsHex(encodedProposal);
    console.log("Encoded proposal hash for complete is %s", encodedHash);
    console.log("Encoded length %d", encodedProposal.length);

    console.log("Sending pre-image");
    await api.tx.democracy.notePreimage(encodedProposal).signAndSend(account, { nonce: nonce++ });

    if (argv["send-proposal-as"] == "democracy") {
      console.log("Sending proposal");
      await api.tx.democracy
        .propose(encodedHash, PROPOSAL_AMOUNT)
        .signAndSend(account, { nonce: nonce++ });
    } else if (argv["send-proposal-as"] == "council-external") {
      console.log("Sending external motion");
      let external = api.tx.democracy.externalProposeMajority(encodedHash);
      await api.tx.councilCollective
        .propose(collectiveThreshold, external, external.length)
        .signAndSend(account, { nonce: nonce++ });
    }
  }

  await api.disconnect();
};

async function start() {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

start();
