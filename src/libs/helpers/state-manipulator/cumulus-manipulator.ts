import Debug from "debug";

import { Action, encodeStorageKey, StateManipulator } from "./genesis-parser";
import { nToHex } from "@polkadot/util";

const _debug = Debug("helper:cumulus-manipulator");

export class CumulusManipulator implements StateManipulator {
  private readonly newTimestamp: bigint;

  private readonly slotInfoKey: string;

  constructor(newTimestamp: bigint) {
    this.newTimestamp = newTimestamp;
    this.slotInfoKey = encodeStorageKey("AsyncBacking", "SlotInfo");
  }

  processRead = (_: any) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.slotInfoKey)) {
      _debug(`Found async backing SlotInfo: ${value}. Resetting to ${this.newTimestamp}`);
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
  };
}