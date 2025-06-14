import Debug from "debug";

import { Action, encodeStorageKey, StateManipulator } from "./genesis-parser";
import { nToHex } from "@polkadot/util";

const debug = Debug("helper:cumulus-manipulator");

export class CumulusManipulator implements StateManipulator {
  private readonly newTimestamp: bigint;

  private readonly slotInfoKey: string;
  private readonly totalIssuanceKey: string;
  private slotInfoProcessed = false;

  constructor(newTimestamp: bigint) {
    this.newTimestamp = newTimestamp;
    this.slotInfoKey = encodeStorageKey("AsyncBacking", "SlotInfo");
    this.totalIssuanceKey = encodeStorageKey("Balances", "TotalIssuance");
  }

  processRead = (_: any) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.slotInfoKey)) {
      this.slotInfoProcessed = true;
      debug(`Found async backing SlotInfo: ${value}. Resetting to ${this.newTimestamp}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key: key,
            value: `0x${nToHex(this.newTimestamp, { isLe: true, bitLength: 64 }).slice(2)}01000000`,
          },
        ],
      };
    }

    // Add the SlotInfo key when we encounter totalIssuance
    if (key === this.totalIssuanceKey && !this.slotInfoProcessed) {
      this.slotInfoProcessed = true;
      debug(`Adding async backing SlotInfo with timestamp ${this.newTimestamp}`);
      return {
        action: "keep" as Action,
        extraLines: [
          {
            key: this.slotInfoKey,
            value: `0x${nToHex(this.newTimestamp, { isLe: true, bitLength: 64 }).slice(2)}01000000`,
          },
        ],
      };
    }
  };
}
