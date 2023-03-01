// Extracted from useReference from @polkadot/apps page-referenda

import { ApiPromise } from "@polkadot/api";
import { DeriveProposalImage } from "@polkadot/api-derive/types";
import { ApiDecoration } from "@polkadot/api/types";
import type { Bytes } from "@polkadot/types";
import type { Call, Hash } from "@polkadot/types/interfaces";
import {
  FrameSupportPreimagesBounded,
  PalletConvictionVotingTally,
  PalletPreimageRequestStatus,
  PalletRankedCollectiveTally,
  PalletReferendaCurve,
  PalletReferendaReferendumInfoConvictionVotingTally,
  PalletReferendaReferendumInfoRankedCollectiveTally,
  PalletReferendaReferendumStatusConvictionVotingTally,
  PalletReferendaTrackInfo,
} from "@polkadot/types/lookup";
import {
  BN,
  bnMax,
  bnMin,
  BN_BILLION,
  BN_ONE,
  BN_ZERO,
  isString,
  stringPascalCase,
} from "@polkadot/util";
import { HexString } from "@polkadot/util/types";
import Debug from "debug";
import { promiseConcurrent } from "./functions";
const debug = Debug("tools:referenda");

export interface Referendum {
  decidingEnd?: BN;
  id: number;
  ongoing: PalletReferendaReferendumStatusConvictionVotingTally;
  info:
    | PalletReferendaReferendumInfoConvictionVotingTally
    | PalletReferendaReferendumInfoRankedCollectiveTally;
  isConvictionVote: boolean;
  key: string;
  track?: PalletReferendaTrackInfo;
  trackName?: string;
  image: DeriveProposalImage;
}

export interface TrackDescription {
  id: BN;
  info: PalletReferendaTrackInfo;
}

export interface TrackInfo {
  compare?: (input: BN) => boolean;
  origin: Record<string, string> | Record<string, string>[];
  text?: string;
}

function getTrackName({ name }: PalletReferendaTrackInfo): string {
  return;
}

export function isConvictionTally(
  tally: PalletRankedCollectiveTally | PalletConvictionVotingTally
): tally is PalletConvictionVotingTally {
  return (
    !!(tally as PalletConvictionVotingTally).support &&
    !(tally as PalletRankedCollectiveTally).bareAyes
  );
}

function curveDelay(curve: PalletReferendaCurve, input: BN, div: BN): BN {
  // if divisor is zero, we return the max
  if (div.isZero()) {
    return BN_BILLION;
  }

  const y = input.mul(BN_BILLION).div(div);

  if (curve.isLinearDecreasing) {
    const { ceil, floor, length } = curve.asLinearDecreasing;

    // if y < *floor {
    //   Perbill::one()
    // } else if y > *ceil {
    //   Perbill::zero()
    // } else {
    //   (*ceil - y).saturating_div(*ceil - *floor, Up).saturating_mul(*length)
    // }
    return y.lt(floor)
      ? BN_BILLION
      : y.gt(ceil)
      ? BN_ZERO
      : bnMin(BN_BILLION, bnMax(BN_ZERO, ceil.sub(y).mul(length).div(ceil.sub(floor))));
  } else if (curve.isSteppedDecreasing) {
    const { begin, end, period, step } = curve.asSteppedDecreasing;

    // if y < *end {
    //   Perbill::one()
    // } else {
    //   period.int_mul((*begin - y.min(*begin) + step.less_epsilon()).int_div(*step))
    // }
    return y.lt(end)
      ? BN_BILLION
      : bnMin(
          BN_BILLION,
          bnMax(
            BN_ZERO,
            period
              .mul(begin.sub(bnMin(y, begin)).add(step.isZero() ? step : step.sub(BN_ONE)))
              .div(step)
          )
        );
  } else if (curve.asReciprocal) {
    const { factor, xOffset, yOffset } = curve.asReciprocal;

    // let y = FixedI64::from(y);
    // let maybe_term = factor.checked_rounding_div(y - *y_offset, High);
    // maybe_term
    //   .and_then(|term| (term - *x_offset).try_into_perthing().ok())
    //   .unwrap_or_else(Perbill::one)
    return y.sub(yOffset).eq(BN_ZERO)
      ? BN_ONE
      : bnMin(BN_BILLION, bnMax(BN_ZERO, factor.mul(BN_BILLION).div(y.sub(yOffset)).sub(xOffset)));
  }

  throw new Error(`Unknown curve found ${curve.type}`);
}

function calcDecidingEnd(
  totalEligible: BN,
  tally: PalletRankedCollectiveTally | PalletConvictionVotingTally,
  { decisionPeriod, minApproval, minSupport }: PalletReferendaTrackInfo,
  since: BN
): BN | undefined {
  const support = isConvictionTally(tally) ? tally.support : tally.bareAyes;

  return since.add(
    decisionPeriod
      .mul(
        bnMax(
          curveDelay(minApproval, tally.ayes, tally.ayes.add(tally.nays)),
          curveDelay(minSupport, support, totalEligible)
        )
      )
      .div(BN_BILLION)
  );
}

export function isConvictionVote(
  info:
    | PalletReferendaReferendumInfoConvictionVotingTally
    | PalletReferendaReferendumInfoRankedCollectiveTally
): info is PalletReferendaReferendumInfoConvictionVotingTally {
  return info.isOngoing && isConvictionTally(info.asOngoing.tally);
}

function getPreimageHash(
  hashOrBounded: Hash | HexString | FrameSupportPreimagesBounded
): HexString {
  if (isString(hashOrBounded)) {
    return hashOrBounded;
  }

  const bounded = hashOrBounded as FrameSupportPreimagesBounded;
  return bounded.isInline
    ? bounded.asInline.hash.toHex()
    : bounded.isLegacy
    ? bounded.asLegacy.hash_.toHex()
    : bounded.isLookup
    ? bounded.asLookup.hash_.toHex()
    : hashOrBounded.toHex();
}

function parseImage(
  api: ApiPromise | ApiDecoration<"promise">,
  [status, bytes]: [PalletPreimageRequestStatus | null, Bytes | null]
): DeriveProposalImage | undefined {
  if (!status) {
    return undefined;
  }

  const [proposer, balance] = status.isUnrequested
    ? status.asUnrequested.deposit
    : status.asRequested.deposit.unwrapOrDefault();
  let proposal: Call | undefined;

  if (bytes) {
    try {
      proposal = api.registry.createType("Call", bytes.toU8a(true));
    } catch (error) {
      console.error(error);
    }
  }

  return { at: BN_ZERO, balance, proposal, proposer };
}

async function getImageProposal(api: ApiPromise | ApiDecoration<"promise">, hash: string) {
  const optStatus = await api.query.preimage.statusFor(hash);
  const status = optStatus.unwrapOr(null) as PalletPreimageRequestStatus;
  if (!status) {
    return null;
  }
  const len = status.isRequested
    ? status.asRequested.len.unwrapOr(0)
    : status.asUnrequested.len || 0;
  const h256Hash = api.registry.createType("H256", hash);

  try {
    const preImage = await api.query.preimage.preimageFor([h256Hash, len]);
    return parseImage(api, [status, preImage.unwrap()]);
  } catch (e) {
    debug(e);
  }
  return null;
}

// Returns the block at which the referendum ended, 0 if onGoing;
function getReferendumConclusionBlock(
  info: PalletReferendaReferendumInfoConvictionVotingTally
): number {
  if (info.isOngoing) {
    return 0;
  }

  const blockNumber: number = info.isApproved
    ? info.asApproved[0].toNumber()
    : info.isCancelled
    ? info.asCancelled[0].toNumber()
    : info.isKilled
    ? info.asKilled[0].toNumber()
    : info.isRejected
    ? info.asRejected[0].toNumber()
    : info.isTimedOut
    ? info.asTimedOut[0].toNumber()
    : 0;

  return blockNumber;
}

async function getReferendumOnGoing(
  api: ApiPromise,
  id: number,
  info: PalletReferendaReferendumInfoConvictionVotingTally
) {
  if (info.isOngoing) {
    return { apiAt: api, ongoing: info.asOngoing };
  }
  const blockNumber = getReferendumConclusionBlock(info);

  debug(`Ref: ${id} - retrieving past OnGoingfrom block #${blockNumber - 1}`);
  const apiAt = await api.at(await api.rpc.chain.getBlockHash(blockNumber - 1));
  const referendumInfo = await apiAt.query.referenda.referendumInfoFor(id);

  if (!referendumInfo.isSome) {
    throw new Error("Referendum not found");
  }
  if (!referendumInfo.unwrap().isOngoing) {
    throw new Error("Referendum not going");
  }
  return { apiAt, ongoing: referendumInfo.unwrap().asOngoing };
}

function extendReferendum(
  totalIssuance?: BN,
  referenda?: Referendum[],
  tracks?: TrackDescription[]
): Referendum[] {
  if (!referenda || !totalIssuance) {
    // return an empty group when we have no referenda
    return [];
  } else if (!tracks) {
    // if we have no tracks, we just return the referenda sorted
    return referenda;
  }

  // sort the referenda by track inside groups
  return referenda
    .map((ref) => {
      // only ongoing have tracks
      const trackInfo = ref.ongoing ? tracks.find(({ id }) => id.eq(ref.ongoing.track)) : undefined;

      if (trackInfo) {
        ref.trackName = `${trackInfo.info.name
          .replace(/_/g, " ")
          .split(" ")
          .map(stringPascalCase)
          .join(" ")}`;
        ref.track = trackInfo.info;

        if (ref.isConvictionVote) {
          const { deciding, tally } = ref.ongoing;

          if (deciding.isSome) {
            const { since } = deciding.unwrap();

            ref.decidingEnd = calcDecidingEnd(totalIssuance, tally, trackInfo.info, since);
          }
        }
      }
      return ref;
    })
    .sort((a, b) => {
      return b.id - a.id;
    });
}

export type ReferendumLimits = {
  blocks: number;
};

export async function getReferendumByGroups(
  api: ApiPromise,
  limits: ReferendumLimits = { blocks: 7200 * 7 }
) {
  if (!api.query.referenda) {
    return [];
  }
  const blockNumber = (await api.rpc.chain.getHeader()).number.toNumber();
  const { blocks } = limits;
  const referendumInfos = (
    await promiseConcurrent(
      10,
      async ([key, optInfo]): Promise<Referendum> => {
        const info = optInfo.unwrap();
        const id = new BN(key.toHex().slice(-8), "hex", "le").toNumber();
        if (!info.isOngoing && getReferendumConclusionBlock(info) + blocks < blockNumber) {
          return;
        }
        const { apiAt, ongoing } = await getReferendumOnGoing(api, id, info);
        // Old proposal had the hash directly
        const proposalHash = getPreimageHash(ongoing.proposal || (ongoing as any).proposalHash);
        return {
          id,
          ongoing,
          info,
          isConvictionVote: isConvictionVote(info),
          key: id.toString(),
          image: await getImageProposal(apiAt, proposalHash),
        };
      },
      await api.query.referenda.referendumInfoFor.entries()
    )
  ).filter((result) => !!result);
  const tracks = await (api.query.referenda && api.consts.referenda.tracks);

  return extendReferendum(
    await api.query.balances.totalIssuance(),
    referendumInfos,
    tracks &&
      tracks.map(([id, info]) => ({
        id,
        info,
      }))
  );
}
