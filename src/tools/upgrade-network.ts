// Performs a runtime upgrade through sudo or council (requires polkadot v0.9.32+)
//
// Ex: bun src/tools/upgrade-network.ts \
//    --url ws://localhost:9944 \
//    --send-proposal-as council-external \
//    --collective-threshold 3 \
//    --proxy <council-account> \
//    --account-priv-key <key>
import "@moonbeam-network/api-augment";
import "@polkadot/api-augment";

import { Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { blake2AsHex } from "@polkadot/util-crypto";
import fs from "fs";
import yargs from "yargs";

import { ALITH_PRIVATE_KEY } from "../utils/constants";
import {
  monitorSubmittedExtrinsic,
  waitBlocks,
  waitForAllMonitoredExtrinsics,
} from "../utils/monitoring";
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
    },
    proxy: {
      type: "string",
      demandOption: false,
      describe: "Account being proxied",
      conflicts: ["sudo"],
    },
    "proxy-type": {
      type: "string",
      demandOption: false,
      describe: "Type of proxy",
    },
    sudo: {
      type: "boolean",
      demandOption: false,
      conflicts: ["send-proposal-as", "collective-threshold"],
    },
    enact: {
      type: "boolean",
      demandOption: false,
      conflicts: ["sudo", "send-proposal-as", "collective-threshold"],
    },
    alith: {
      type: "boolean",
      demandOption: false,
      conflicts: ["account-priv-key"],
    },
    runtime: {
      type: "string",
      demandOption: true,
      describe: "path to the runtime was file",
    },
    "send-proposal-as": {
      choices: ["democracy", "council-external"],
      demandOption: false,
      alias: "s",
    },
    "fast-track": { type: "boolean", demandOption: false },
    vote: { type: "boolean", demandOption: false },
    "collective-threshold": { type: "number", demandOption: false, alias: "c" },
    "at-block": { type: "number", demandOption: false },
  })
  .check((argv) => {
    if ((argv.sudo || argv["send-proposal-as"]) && !(argv["account-priv-key"] || argv["alith"])) {
      throw new Error("Missing --account-priv-key or --alith");
    }
    return true;
  }).argv;

async function main() {
  const api = await getApiFor(argv);
  const keyring = new Keyring({ type: "ethereum" });

  try {
    const atBlock =
      argv["at-block"] || (await api.rpc.chain.getBlock()).block.header.number.toNumber();
    const blockHash = await api.rpc.chain.getBlockHash(atBlock);

    const collectiveThreshold =
      argv["collective-threshold"] ||
      Math.ceil(((await api.query.openTechCommitteeCollective.members()).length * 3) / 5);
    const proposalAmount = api.consts?.democracy?.minimumDeposit || 0n;

    let account: KeyringPair;
    let nonce;
    const privKey = argv["alith"] ? ALITH_PRIVATE_KEY : argv["account-priv-key"];
    if (privKey) {
      account = keyring.addFromUri(privKey, null, "ethereum");
      const { nonce: rawNonce, data: balance } = (await api.query.system.account(
        account.address,
      )) as any;
      nonce = BigInt(rawNonce.toString());
    }

    const code = fs.readFileSync(argv["runtime"]);
    const codeHex = `0x${code.toString("hex")}`;
    const codeHash = blake2AsHex(codeHex);
    if (code.length < 1_000_000) {
      console.log(`Unexpected runtime ${codeHash} size: ${code.length}`);
      process.exit(1);
    }
    console.log(`Using runtime wasm with size: ${code.length} [hash: ${codeHash}]`);

    const tryProxy = (call) => {
      return maybeProxyCall(api, call, argv["proxy"], argv["proxy-type"]);
    };

    if (argv["enact"]) {
      await tryProxy(api.tx.system.applyAuthorizedUpgrade(codeHex)).signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: "sudo" }),
      );
    } else if (argv["sudo"]) {
      const proposal = api.tx.system.setCode(codeHex);
      await tryProxy(api.tx.sudo.sudo(proposal)).signAndSend(
        account,
        { nonce: nonce++ },
        monitorSubmittedExtrinsic(api, { id: "sudo" }),
      );
    } else {
      const proposal = api.tx.parachainSystem.authorizeUpgrade(codeHash, true);

      const encodedProposal = proposal.method.toHex();
      const encodedHash = blake2AsHex(encodedProposal);

      let refCount = (await api.query.democracy.referendumCount()).toNumber();

      if (argv["send-proposal-as"] == "democracy") {
        await tryProxy(
          api.tx.democracy.propose(
            {
              Inline: encodedProposal,
            },
            proposalAmount,
          ),
        ).signAndSend(
          account,
          { nonce: nonce++ },
          monitorSubmittedExtrinsic(api, { id: "proposal" }),
        );
      } else if (argv["send-proposal-as"] == "council-external") {
        let external = api.tx.democracy.externalProposeMajority({
          Inline: encodedProposal,
        });

        await tryProxy(
          api.tx.councilCollective.propose(collectiveThreshold, external, external.length),
        ).signAndSend(
          account,
          { nonce: nonce++ },
          monitorSubmittedExtrinsic(api, { id: "proposal" }),
        );

        if (argv["fast-track"]) {
          let fastTrack = api.tx.democracy.fastTrack(encodedHash, 1, 0);

          await tryProxy(
            api.tx.techCommitteeCollective.propose(
              collectiveThreshold,
              fastTrack,
              fastTrack.length,
            ),
          ).signAndSend(
            account,
            { nonce: nonce++ },
            monitorSubmittedExtrinsic(api, { id: "fast-track" }),
          );
        }
      }

      if (argv["vote"]) {
        await tryProxy(
          api.tx.democracy.vote(refCount, {
            Standard: {
              balance: 1n * 10n ** BigInt(api.registry.chainDecimals[0]),
              vote: { aye: true, conviction: 1 },
            },
          }),
        ).signAndSend(account, { nonce: nonce++ }, monitorSubmittedExtrinsic(api, { id: "vote" }));

        await waitBlocks(api, 3);

        await tryProxy(api.tx.parachainSystem.enactAuthorizedUpgrade(codeHex)).signAndSend(
          account,
          { nonce: nonce++ },
          monitorSubmittedExtrinsic(api, { id: "enactment" }),
        );
      }
    }
  } finally {
    await waitForAllMonitoredExtrinsics();
    await api.disconnect();
  }
}

main().catch((err) => console.error("ERR!", err));
