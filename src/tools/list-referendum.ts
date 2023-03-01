import humanizeNumber from "humanize-number";
import { moment } from "moment-parseplus";
import yargs from "yargs";

import { ApiPromise } from "@polkadot/api";
import { BN, BN_TEN } from "@polkadot/util";
import { getBlockDate } from "../utils/block-time";
import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";
import { getReferendumByGroups } from "../utils/referenda";
import { callInterpreter, renderCallInterpretation } from "../utils/transactions";
import { promiseConcurrent } from "../utils/functions";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    "single-line": {
      type: "boolean",
      description: "Display only single line per referendum",
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  await api.isReady;

  console.log(api.runtimeChain.toString());
  const polkadotPrefix = {
    moonbeam: "moonbeam",
    moonriver: "moonriver",
    "Moonbase Alpha": "moonbase",
  }[await api.runtimeChain.toString().toLocaleLowerCase()];
  for (const referendum of await api.derive.democracy.referendums()) {
    let imageText = ""; // TODO refactor
    let subText = null; // TODO refactor
    if (referendum.image && referendum.image.proposal && referendum.image.proposal) {
      const callData = await callInterpreter(api, referendum.image.proposal);
      imageText = callData.text;
      subText =
        callData.depth == 0 || argv["single-line"]
          ? null
          : callData.subCalls
              .map((c) => renderCallInterpretation(c, 1, "                 "))
              .join("  \n");
    } else {
      imageText = referendum.imageHash.toString();
    }

    const yes = referendum.votedAye.div(BN_TEN.pow(new BN(api.registry.chainDecimals[0])));

    const no = referendum.votedNay.div(BN_TEN.pow(new BN(api.registry.chainDecimals[0])));

    const endBlock = referendum.status.end.isubn(1).toNumber();

    console.log(
      `${referendum.isPassing ? `🟢` : `🔴`} ${
        polkadotPrefix
          ? `https://${polkadotPrefix}.polkassembly.network/referendum/${referendum.index}`
          : `${referendum.index.toString().padStart(4, " ")}`
      } - \`${imageText}\` ( 👍${humanizeNumber(yes.toNumber())} vs ${humanizeNumber(
        no.toNumber()
      )}👎 | ${moment
        .duration(moment((await getBlockDate(api, endBlock)).date).diff(moment()))
        .humanize()} left)${subText ? `  \n${subText}` : ""}`
    );
  }

  const totalIssuance = await api.query.balances.totalIssuance();
  const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();

  const toBlockMoment = async (api: ApiPromise, endBlock: BN, symbol: string) => {
    if (currentBlock > endBlock.toNumber()) {
      return `${moment
        .duration(moment((await getBlockDate(api, endBlock.toNumber())).date).diff(moment()))
        .humanize()} ago`;
    }
    return `${moment
      .duration(moment((await getBlockDate(api, endBlock.toNumber())).date).diff(moment()))
      .humanize()}->${symbol}`;
  };

  const referendum = await getReferendumByGroups(api);
  const text = (
    await promiseConcurrent(
      10,
      async (ref) => {
        const enactmentDelayFromNow = ref.ongoing.enactment.isAfter
          ? currentBlock +
            Math.max(
              ref.ongoing.enactment.asAfter.toNumber(),
              ref.track.minEnactmentPeriod.toNumber()
            )
          : Math.max(
              currentBlock + ref.track.minEnactmentPeriod.toNumber(),
              ref.ongoing.enactment.asAt.toNumber()
            );
        const isExecuted =
          ref.info.isApproved &&
          ((ref.ongoing.enactment.isAfter &&
            ref.info.asApproved[0].add(ref.ongoing.enactment.asAfter).toNumber() < currentBlock) ||
            (ref.ongoing.enactment.isAt && ref.ongoing.enactment.asAt.toNumber() < currentBlock));

        const networkIcon =
          polkadotPrefix == "moonbeam" ? "🌒" : polkadotPrefix == "moonriver" ? "⛵" : "?";
        const statusIcon = ref.info.isApproved
          ? isExecuted
            ? "⚡"
            : "✅"
          : ref.info.isCancelled
          ? "⛔"
          : ref.info.isKilled
          ? "💀"
          : ref.info.isRejected
          ? "🟥"
          : ref.info.isTimedOut
          ? "🕑"
          : ref.info.isOngoing
          ? ref.info.asOngoing.deciding.isSome &&
            ref.info.asOngoing.deciding.unwrap().confirming.isSome
            ? "❗"
            : "📰"
          : "?";

        const callData = ref?.image?.proposal && (await callInterpreter(api, ref.image.proposal));
        const imageText =
          callData && callData.text
            ? callData.text.startsWith("whitelist.dispatch") && callData.subCalls.length > 0
              ? `${
                  ref.info.isOngoing
                    ? (
                        await api.query.whitelist.whitelistedCall(
                          callData.subCalls[0].call.hash.toHex()
                        )
                      ).isSome
                      ? `🔓`
                      : `🔐`
                    : ""
                }[${callData.subCalls[0].text}]`
              : callData.text
            : "";
        const subText =
          !callData ||
          callData.depth == 0 ||
          callData.text.startsWith("whitelist.dispatch") ||
          argv["single-line"]
            ? null
            : callData.subCalls
                .map((c) => renderCallInterpretation(c, 1, "                 "))
                .join("  \n");

        const yes = ref.ongoing.tally.ayes.div(BN_TEN.pow(new BN(api.registry.chainDecimals[0])));

        const no = ref.ongoing.tally.nays.div(BN_TEN.pow(new BN(api.registry.chainDecimals[0])));

        const supportPercent =
          ref.ongoing.tally.support.muln(10_000).div(totalIssuance).toNumber() / 100;

        const nextStepTime = ref.info.isApproved
          ? ref.ongoing.enactment.isAfter
            ? `${await toBlockMoment(
                api,
                ref.info.asApproved[0].add(ref.ongoing.enactment.asAfter),
                "⚡"
              )}`
            : `${await toBlockMoment(api, ref.ongoing.enactment.asAt, "⚡")}`
          : ref.info.isOngoing
          ? ref.info.asOngoing.deciding.isSome
            ? ref.info.asOngoing.deciding.unwrap().confirming.isSome
              ? `${await toBlockMoment(
                  api,
                  ref.info.asOngoing.deciding.unwrap().confirming.unwrap(),
                  "✅"
                )}`
              : ref.decidingEnd
              ? `${await toBlockMoment(api, ref.decidingEnd, "❗")}`
              : `${await toBlockMoment(
                  api,
                  ref.track.preparePeriod
                    .add(ref.info.asOngoing.submitted)
                    .add(ref.track.decisionPeriod),
                  "⏱"
                )}`
            : `${await toBlockMoment(
                api,
                ref.track.preparePeriod
                  .add(ref.info.asOngoing.submitted)
                  .add(ref.track.decisionPeriod),
                "⏱"
              )}`
          : "";

        const additionalConfirmingTime =
          ref.info.isOngoing &&
          (ref.info.asOngoing.deciding.isNone ||
            ref.info.asOngoing.deciding.unwrap().confirming.isNone)
            ? `+${moment
                .duration(
                  moment(
                    (await getBlockDate(api, ref.track.confirmPeriod.addn(currentBlock).toNumber()))
                      .date
                  ).diff(moment())
                )
                .humanize()}->✅`
            : null;

        const additionalEnactmentTime =
          ref.info.isOngoing &&
          (ref.info.asOngoing.deciding.isNone ||
            ref.info.asOngoing.deciding.unwrap().confirming.isNone)
            ? `+${moment
                .duration(
                  moment((await getBlockDate(api, enactmentDelayFromNow)).date).diff(moment())
                )
                .humanize()}->⚡`
            : null;

        return (
          `${networkIcon}` +
          `[${ref.track.name.toString().slice(0, 15).padStart(15, " ")}]` +
          `${ref.id.toString().padStart(3, " ")} -` +
          `${imageText.slice(0, 40).padStart(40, " ")}` +
          `${statusIcon}` +
          ` |👍${humanizeNumber(yes.toNumber()).padStart(10, " ")} vs ${humanizeNumber(
            no.toNumber()
          ).padStart(10, " ")}👎` +
          `|${supportPercent.toFixed(2).padStart(5, " ")}%` +
          (nextStepTime ? `|${nextStepTime[isExecuted ? "padStart" : "padStart"](15, " ")}` : "") +
          (additionalConfirmingTime ? `|${additionalConfirmingTime.padStart(15, " ")}` : "") +
          (additionalEnactmentTime ? `|${additionalEnactmentTime.padStart(15, " ")}` : "") +
          `|` +
          (subText ? `\n${subText}` : "")
        );
      },
      referendum
    )
  ).join("\n");
  console.log(text);

  await new Promise((resolve) => setTimeout(resolve, 1000));
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
