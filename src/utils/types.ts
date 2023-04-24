import type {
  DispatchError,
  DispatchInfo,
  EventRecord,
  Extrinsic,
  InclusionFee,
} from "@polkadot/types/interfaces";
import type { u128 } from "@polkadot/types";
import { BN } from "@polkadot/util";

import type { TxWithEvent } from "@polkadot/api-derive/types";
import { ApiPromise } from "@polkadot/api";

export interface ComputedFees {
  baseFee: bigint;
  lenFee: bigint;
  weightFee: bigint;
  totalFees: bigint;
}
export interface TxWithEventAndFee extends TxWithEvent {
  fees: ComputedFees;
}

export const mapExtrinsics = async (
  api: ApiPromise,
  extrinsics: Extrinsic[],
  records: EventRecord[],
  fees: InclusionFee[],
  feeMultiplier: u128,
) => {
  return extrinsics.map((extrinsic, index): TxWithEventAndFee => {
    let dispatchError: DispatchError | undefined;
    let dispatchInfo: DispatchInfo | undefined;

    const events = records
      .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index))
      .map(({ event }) => {
        if (event.section === "system") {
          if (event.method === "ExtrinsicSuccess") {
            dispatchInfo = event.data[0] as DispatchInfo;
          } else if (event.method === "ExtrinsicFailed") {
            dispatchError = event.data[0] as DispatchError;
            dispatchInfo = event.data[1] as DispatchInfo;
          }
        }

        return event;
      });

    let computedFees: ComputedFees;
    const feeDetails = fees[index];

    const frac = 1n;
    const integer = 1n;
    // const frac = weightToFees[0].coeffFrac.mul((dispatchInfo.weight as any).refTime?.toBn());
    // const integer = weightToFees[0].coeffInteger.mul((dispatchInfo.weight as any).refTime?.toBn());

    /*
    const unadjustedWeightFee = await api.call.transactionPaymentApi.queryWeightToFee({
      refTime: 1,
      proofSize: 1,
    });
    */

    const unadjustedFee = frac + integer;
    const adjustedFee = unadjustedFee * feeMultiplier.toBigInt() / 1_000_000_000_000_000_000n;

    computedFees = {
      baseFee: feeDetails.baseFee.toBigInt(),
      lenFee: feeDetails.lenFee.toBigInt(),
      weightFee: adjustedFee,
      totalFees: adjustedFee + feeDetails.baseFee.toBigInt() + feeDetails.lenFee.toBigInt(),
    };
    return { dispatchError, dispatchInfo, events, extrinsic, fees: computedFees };
  });
}
