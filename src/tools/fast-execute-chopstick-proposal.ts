// This script is expected to run against a parachain network (using launch.ts script)
import { ApiPromise, Keyring } from "@polkadot/api";
import { FrameSupportPreimagesBounded } from "@polkadot/types/lookup";
import { blake2AsHex } from "@polkadot/util-crypto";
import chalk from "chalk";
import yargs from "yargs";

import { ALITH_PRIVATE_KEY, getApiFor, NETWORK_YARGS_OPTIONS } from "../index";

import debugPkg from "debug";
const _debug = debugPkg("fast-executor");
const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "proposal-index": {
      type: "number",
      description: "Proposal index",
    },
    "generate-proposal": {
      type: "boolean",
      description: "Proposal index",
    },
  }).argv;

async function moveScheduledCallTo(
  api: ApiPromise,
  blockCounts: number,
  verifier: (call: FrameSupportPreimagesBounded) => boolean,
) {
  const blockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  // Fast forward the nudge referendum to the next block to get the refendum to be scheduled
  const agenda = await api.query.scheduler.agenda.entries();
  let found = false;
  for (const agendaEntry of agenda) {
    for (const scheduledEntry of agendaEntry[1]) {
      if (scheduledEntry.isSome && verifier(scheduledEntry.unwrap().call)) {
        found = true;
        console.log(`${chalk.blue("SetStorage")} scheduler.agenda`);
        const _result = await api.rpc("dev_setStorage", [
          [agendaEntry[0]], // require to ensure unique id
          [await api.query.scheduler.agenda.key(blockNumber + blockCounts), agendaEntry[1].toHex()],
        ]);
        if (scheduledEntry.unwrap().maybeId.isSome) {
          const id = scheduledEntry.unwrap().maybeId.unwrap().toHex();
          const lookup = await api.query.scheduler.lookup(id);
          _debug(
            `Checking lookup ${scheduledEntry.unwrap().maybeId.unwrap().toHex()}: ${lookup.isSome}`,
          );
          if (lookup.isSome) {
            const lookupKey = await api.query.scheduler.lookup.key(id);
            const _lookupJson = lookup.unwrap().toJSON();
            const fastLookup = api.registry.createType("Option<(u32,u32)>", [
              blockNumber + blockCounts,
              0,
            ]);
            const _result = await api.rpc("dev_setStorage", [[lookupKey, fastLookup.toHex()]]);
            _debug(`Updated lookup to ${fastLookup.toJSON()}`);
          }
        }
      }
    }
  }
  if (!found) {
    throw new Error("No scheduled call found");
  }
}

const generateProposal = async (api: ApiPromise, proposalIndex: number) => {
  const keyring = new Keyring({ type: "ethereum" });
  const alith = await keyring.addFromUri(ALITH_PRIVATE_KEY);
  // Create a fake proposal for testing purposes

  // setInflation is allowed for GeneralAdmin and also sends an event for verification.
  const preimage = api.tx.parachainStaking.setInflation({
    min: Number(proposalIndex) % 99,
    ideal: Number(proposalIndex) % 99,
    max: Number(proposalIndex) % 99,
  });

  console.log("Generating proposal...'parachainStaking.setInflation' (GeneralAdmin)");
  await new Promise<void>((resolve, reject) => {
    let unsub: () => void;
    api.tx.utility
      .batch([
        api.tx.preimage.notePreimage(preimage.method.toHex()),
        api.tx.referenda.submit(
          {
            System: "Root",
          } as any,
          { Lookup: { Hash: preimage.method.hash.toHex(), len: preimage.method.encodedLength } },
          { At: 0 },
        ),
        api.tx.referenda.placeDecisionDeposit(proposalIndex),
      ])
      .signAndSend(alith, (status: any) => {
        if (status.blockNumber) {
          if (unsub) unsub();
          resolve();
        }
      })
      .then((unsubscribe) => {
        unsub = unsubscribe;
      })
      .catch(reject);
  });
};

const main = async () => {
  if (argv["generate-proposal"] && "proposal-index" in argv) {
    console.log("--generate-proposal not compatible with --proposal-index");
    return;
  }
  if (!argv["generate-proposal"] && !("proposal-index" in argv)) {
    console.log("Missing --generate-proposal or --proposal-index");
    return;
  }

  // Instantiate Api
  const api = await getApiFor(argv);
  const totalIssuance = (await api.query.balances.totalIssuance()).toBigInt();
  const proposalIndex = argv["generate-proposal"]
    ? (await api.query.referenda.referendumCount()).toNumber()
    : argv["proposal-index"];

  console.log(
    `[#${chalk.green((await api.rpc.chain.getHeader()).number.toNumber())}]: Referedum ${chalk.red(
      proposalIndex,
    )}`,
  );

  if (argv["generate-proposal"]) {
    await generateProposal(api, proposalIndex);
  }

  const referendumData = await api.query.referenda.referendumInfoFor(proposalIndex);
  const referendumKey = api.query.referenda.referendumInfoFor.key(proposalIndex);
  if (!referendumData.isSome) {
    throw new Error(`Referendum ${proposalIndex} not found`);
  }
  const referendumInfo = referendumData.unwrap();
  if (!referendumInfo.isOngoing) {
    throw new Error(`Referendum ${proposalIndex} is not ongoing`);
  }

  const ongoingData = referendumInfo.asOngoing;
  const ongoingJson = ongoingData.toJSON();
  // Support Lookup, Inline or Legacy
  const callHash = ongoingData.proposal.isLookup
    ? ongoingData.proposal.asLookup.toHex()
    : ongoingData.proposal.isInline
      ? blake2AsHex(ongoingData.proposal.asInline.toHex())
      : ongoingData.proposal.asLegacy.toHex();

  const proposalBlockTarget = (await api.rpc.chain.getHeader()).number.toNumber();
  const fastProposalData = {
    ongoing: {
      ...ongoingJson,
      enactment: { after: 0 },
      deciding: {
        since: proposalBlockTarget - 1,
        confirming: proposalBlockTarget - 1,
      },
      tally: {
        ayes: totalIssuance - 1n,
        nays: 0,
        support: totalIssuance - 1n,
      },
      alarm: [proposalBlockTarget + 1, [proposalBlockTarget + 1, 0]],
    },
  };

  let fastProposal;
  try {
    fastProposal = api.registry.createType(
      `Option<PalletReferendaReferendumInfo>`,
      fastProposalData,
    );
  } catch {
    fastProposal = api.registry.createType(
      `Option<PalletReferendaReferendumInfoConvictionVotingTally>`,
      fastProposalData,
    );
  }

  console.log(
    `${chalk.blue("SetStorage")} Fast Proposal: ${chalk.red(
      proposalIndex.toString(),
    )} referendumKey ${referendumKey}`,
  );
  const _result = await api.rpc("dev_setStorage", [[referendumKey, fastProposal.toHex()]]);

  // Fast forward the nudge referendum to the next block to get the refendum to be scheduled
  console.log(
    `${chalk.yellow("Rescheduling")} ${chalk.red("scheduler.nudgeReferendum")} to #${chalk.green(
      (await api.rpc.chain.getHeader()).number.toNumber() + 2,
    )}`,
  );
  await moveScheduledCallTo(api, 1, (call) => {
    if (!call.isInline) {
      return false;
    }
    const callData = api.createType("Call", call.asInline.toHex());
    return (
      callData.method === "nudgeReferendum" &&
      (callData.args[0] as any).toNumber() === proposalIndex
    );
  });

  console.log(
    `${chalk.yellow("Fast forward")} ${chalk.green(1)} to #${chalk.green(
      (await api.rpc.chain.getHeader()).number.toNumber() + 1,
    )}`,
  );
  await api.rpc("dev_newBlock", { count: 1 });

  // Fast forward the scheduled proposal
  console.log(
    `${chalk.yellow("Rescheduling")} proposal ${chalk.red(proposalIndex)} to #${chalk.green(
      (await api.rpc.chain.getHeader()).number.toNumber() + 2,
    )}`,
  );
  await moveScheduledCallTo(api, 1, (call) =>
    call.isLookup
      ? call.asLookup.toHex() === callHash
      : call.isInline
        ? blake2AsHex(call.asInline.toHex()) === callHash
        : call.asLegacy.toHex() === callHash,
  );

  console.log(
    `${chalk.yellow("Fast forward")} ${chalk.green(1)} to #${chalk.green(
      (await api.rpc.chain.getHeader()).number.toNumber() + 1,
    )}`,
  );
  await api.rpc("dev_newBlock", { count: 1 });
  await api.disconnect();
  process.exit(0);
};

process.on("unhandledRejection", (reason, p) => {
  console.error("Unhandled Rejection at:", p, "reason:", reason);
  process.exit(1);
});

try {
  main();
} catch (e) {
  console.log(e);
  process.exit(1);
}
