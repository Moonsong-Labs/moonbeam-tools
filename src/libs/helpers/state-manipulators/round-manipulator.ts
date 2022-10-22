import Debug from "debug";
import { Action, encodeStorageKey, Manipulator } from "../state-manipulator";
import { hexToBn, nToHex } from "@polkadot/util";
const debug = Debug("helper:round-manipulator");

export class RoundManipulator implements Manipulator {
  public storagePrefix: string;

  private roundProcessor: (
    current: number,
    first: number,
    length: number
  ) => { current: number; first: number; length: number };

  constructor(roundProcessor: RoundManipulator["roundProcessor"]) {
    this.storagePrefix = encodeStorageKey("ParachainStaking", "Round");
    this.roundProcessor = roundProcessor;
  }

  processRead = (_) => {};
  prepareWrite = () => {};
  processWrite = ({ key, value }) => {
    if (!key.startsWith(this.storagePrefix)) {
      return;
    }
    const current = hexToBn(value.slice(0, 2 + 8), { isLe: true }).toNumber();
    const first = hexToBn(`0x${value.slice(10, 10 + 8)}`, { isLe: true }).toNumber();
    const length = hexToBn(`0x${value.slice(18, 18 + 8)}`, { isLe: true }).toNumber();
    debug(`Found round info`, { current, first, length });
    const result = this.roundProcessor(current, first, length);
    return {
      action: "remove" as Action,
      extraLines: [
        {
          key,
          value: `${nToHex(result.current, {
            isLe: true,
            bitLength: 32,
          })}${nToHex(result.first, {
            isLe: true,
            bitLength: 32,
          }).slice(2)}${nToHex(result.length, {
            isLe: true,
            bitLength: 32,
          }).slice(2)}`,
        },
      ],
    };
  };
}
