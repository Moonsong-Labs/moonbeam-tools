import Debug from "debug";

import {
  Action,
  encodeStorageBlake128MapKey,
  encodeStorageKey,
  StateLine,
  StateManipulator,
} from "./genesis-parser";
import { nToHex } from "@polkadot/util";

const _debug = Debug("helper:cumulus-manipulator");

export class CumulusManipulator implements StateManipulator {
  private readonly newTimestamp: bigint;

  private readonly slotInfoKey: string;

  constructor(newTimestamp: bigint) {
    this.newTimestamp = newTimestamp;
    this.slotInfoKey = encodeStorageKey("AsyncBacking", "SlotInfo");
  }

  processRead = (_) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.slotInfoKey)) {
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
  };
}
