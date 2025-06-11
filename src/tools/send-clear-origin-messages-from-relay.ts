import "@polkadot/api-augment";

import { Keyring } from "@polkadot/api";
import { BN } from "@polkadot/util";
import yargs from "yargs";

import { getApiFor } from "../utils/networks";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    url: {
      type: "string",
      description: "Relay Websocket url",
      string: true,
      demandOption: true,
    },
    para: {
      type: "number",
      description: "ParaId to which the messages are sent",
    },
    numMessages: {
      type: "number",
      description: "Number of messages to be sent",
    },
    privKey: {
      type: "string",
      description: "private key of the account to send the tx",
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  let sendExtrinsic = api.tx.xcmPallet.send(
    { V5: { parents: new BN(0), interior: { X1: { Parachain: argv.para } } } },
    {
      V5: [{ ClearOrigin: null }],
    },
  );
  let Txs = [];

  // If several calls, we just push alltogether to batch
  for (let i = 0; i < argv.numMessages; i++) {
    Txs.push(sendExtrinsic);
  }

  const batchCall = api.tx.utility.batchAll(Txs);
  let account;
  let nonce;
  [account, nonce] = await accountWrapper(api, argv.privKey);
  console.log(account);
  await api.tx(batchCall.toHex()).signAndSend(account);

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

async function accountWrapper(api, privateKey) {
  // Keyring
  const keyring = new Keyring({ type: "sr25519" });

  // Create account and get nonce
  let account = await keyring.addFromUri(privateKey, null, "sr25519");
  console.log(account.address);
  const { nonce: rawNonce } = (await api.query.system.account(account.address)) as any;
  let nonce = BigInt(rawNonce.toString());

  return [account, nonce];
}

start();
