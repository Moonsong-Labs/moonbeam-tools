import { Keyring } from "@polkadot/api";
import { PalletDemocracyReferendumInfo } from "@polkadot/types/lookup";
import { blake2AsHex } from "@polkadot/util-crypto";
import yargs from "yargs";

import { ALITH_PRIVATE_KEY } from "../utils/constants";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";

import debugPkg from "debug";
const debug = debugPkg("main");

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "private-key": {
      type: "string",
      description: "Private key",
      demandOption: true,
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const keyring = new Keyring({ type: "ethereum" });
  const alith = await keyring.addFromUri(ALITH_PRIVATE_KEY, null, "ethereum");

  console.log(`Keys: ${(await api.query.parachainStaking.delegatorState.keys()).length}`);

  const proposal = api.tx.system.killPrefix(
    api.query.parachainStaking.delegatorState.keyPrefix(),
    1500,
  );
  const encodedProposal = proposal.method.toHex();
  const encodedHash = blake2AsHex(encodedProposal);

  await api.tx.democracy.notePreimage(encodedProposal).signAndSend(alith);
  let nonce = (await api.rpc.system.accountNextIndex(alith.address)).toNumber();
  let referendumNextIndex = (await api.query.democracy.referendumCount()).toNumber();

  let external = api.tx.democracy.externalProposeMajority(encodedHash);
  let fastTrack = api.tx.democracy.fastTrack(encodedHash, 1, 0);
  const voteAmount = 1n * 10n ** BigInt(api.registry.chainDecimals[0]);

  process.stdout.write(`Sending motion + fast-track + vote for ${encodedHash}...`);
  await Promise.all([
    api.tx.councilCollective
      .propose(1, external, external.length)
      .signAndSend(alith, { nonce: nonce++ }),
    api.tx.techCommitteeCollective
      .propose(1, fastTrack, fastTrack.length)
      .signAndSend(alith, { nonce: nonce++ }),
    api.tx.democracy
      .vote(referendumNextIndex, {
        Standard: {
          balance: voteAmount,
          vote: { aye: true, conviction: 1 },
        },
      })
      .signAndSend(alith, { nonce: nonce++ }),
  ]);

  process.stdout.write(`✅\n`);

  process.stdout.write(`Waiting for referendum [${referendumNextIndex}] to be executed...`);
  let referenda: PalletDemocracyReferendumInfo = null;
  while (!referenda) {
    referenda = (await api.query.democracy.referendumInfoOf.entries())
      .find(
        (ref) =>
          ref[1].unwrap().isFinished &&
          api.registry.createType("u32", ref[0].toU8a().slice(-4)).toNumber() ==
            referendumNextIndex,
      )?.[1]
      .unwrap();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write(`${referenda.asFinished.approved ? `✅` : `❌`} \n`);
  if (!referenda.asFinished.approved) {
    process.exit(1);
  }

  api.disconnect();
};

main();
