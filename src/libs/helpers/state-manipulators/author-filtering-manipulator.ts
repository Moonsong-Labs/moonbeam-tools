import Debug from "debug";
import { Action, encodeStorageKey, StateManipulator } from "../genesis-parser";
import { hexToBn, hexToNumber, nToHex } from "@polkadot/util";
const debug = Debug("helper:authoring-manipulator");

export class AuthorFilteringManipulator implements StateManipulator {
  public readonly targetEligibilityRatio: number;
  public readonly highestSlotSeen: number;

  private readonly eligibleRatioKey: string;
  private readonly eligibleCountKey: string;
  private readonly totalSelectedKey: string;
  private readonly highestSlotSeenKey: string;
  private totalSelected: number;

  constructor(targetEligibilityRatio: number, highestSlotSeen = 0) {
    this.highestSlotSeen = highestSlotSeen;
    this.targetEligibilityRatio = targetEligibilityRatio;
    this.totalSelected = 100;
    this.eligibleRatioKey = encodeStorageKey("AuthorFilter", "EligibleRatio");
    this.eligibleCountKey = encodeStorageKey("AuthorFilter", "EligibleCount");
    this.totalSelectedKey = encodeStorageKey("ParachainStaking", "TotalSelected");
    this.highestSlotSeenKey = encodeStorageKey("AuthorInherent", "HighestSlotSeen");
  }

  processRead = ({ key, value }) => {
    if (key.startsWith(this.totalSelectedKey)) {
      this.totalSelected = hexToBn(value.slice(0, 2 + 8), { isLe: true }).toNumber();
    }
  };
  prepareWrite = () => {};
  processWrite = ({ key, value }) => {
    if (key.startsWith(this.eligibleRatioKey)) {
      debug(`Found eligibility ratio: ${hexToNumber(value)}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: `${nToHex(this.targetEligibilityRatio, {
              isLe: true,
              bitLength: 8,
            })}`,
          },
        ],
      };
    }
    if (key.startsWith(this.eligibleCountKey)) {
      debug(`Found eligibility count: ${value}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: `${nToHex(Math.floor((this.totalSelected * this.targetEligibilityRatio) / 100), {
              isLe: true,
              bitLength: 32,
            })}`,
          },
        ],
      };
    }
    if (key.startsWith(this.highestSlotSeenKey)) {
      debug(`Found highest slot seen: ${hexToNumber(value)}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: `${nToHex(this.highestSlotSeen, {
              isLe: true,
              bitLength: 32,
            })}`,
          },
        ],
      };
    }
  };
}
