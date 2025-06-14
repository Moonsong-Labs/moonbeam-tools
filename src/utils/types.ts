import { ApiPromise } from "@polkadot/api";

import { EXTRINSIC_BASE_WEIGHT } from "./constants.ts";

import type {
  DispatchError,
  DispatchInfo,
  EventRecord,
  Extrinsic,
  InclusionFee,
} from "@polkadot/types/interfaces";
import type { u128 } from "@polkadot/types";
import type { TxWithEvent } from "@polkadot/api-derive/types";
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
  return Promise.all(
    extrinsics.map(async (extrinsic, index) => {
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

      const unadjustedWeightFee = dispatchInfo
        ? (
            (await api.call.transactionPaymentApi.queryWeightToFee(dispatchInfo.weight)) as any
          ).toBigInt()
        : 0n;
      const lengthFee = (
        (await api.call.transactionPaymentApi.queryLengthToFee(extrinsic.encodedLength)) as any
      ).toBigInt();

      // TODO: should be doing this at api.at() the original block
      const feeMultiplier = await api.query.transactionPayment.nextFeeMultiplier();
      const weightFee =
        (unadjustedWeightFee * feeMultiplier.toBigInt()) / 1_000_000_000_000_000_000n;

      const baseFee = (
        (await api.call.transactionPaymentApi.queryWeightToFee({
          refTime: EXTRINSIC_BASE_WEIGHT,
          proofSize: 0n,
        })) as any
      ).toBigInt();

      const tip = extrinsic.tip.toBigInt();

      const totalFees = lengthFee + weightFee + baseFee + tip;

      const computedFees: ComputedFees = {
        baseFee,
        lenFee: lengthFee,
        weightFee,
        totalFees,
      };
      return { dispatchError, dispatchInfo, events, extrinsic, fees: computedFees };
    }),
  );
};
