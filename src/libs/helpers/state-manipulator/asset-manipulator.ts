import { bool } from "@polkadot/types-codec";
import { bnToHex, hexToBigInt, nToHex } from "@polkadot/util";
import Debug from "debug";
import { ALITH_ADDRESS, USDT_ASSET_ID } from "../../../utils/constants";
import {
  Action,
  encodeStorageBlake128MapKey,
  encodeStorageBlake128DoubleMapKey,
  encodeStorageKey,
  StateManipulator,
  StateLine,
} from "./genesis-parser";
const debug = Debug("helper:balances-manipulator");

export class AssetManipulator implements StateManipulator {
  account: string;
  assetId: string;
  amount: bigint;
  injected: boolean;
  key: string;
  private readonly assetsGeneralPrefix = encodeStorageKey("Assets", "Account");

  // TODO: Increase asset total issuance by injected amount
  //       if required by tests

  constructor(account: string, assetId: string, amount: bigint) {
    this.account = account;
    this.amount = amount;
    this.assetId = assetId;
    this.injected = false;
    this.key = encodeStorageBlake128DoubleMapKey("Assets", "Account", [
      bnToHex(BigInt(assetId), { isLe: true, bitLength: 128 }),
      account,
    ]);
  }

  processRead = () => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (this.injected === false && key.startsWith(this.assetsGeneralPrefix)) {
      this.injected = true;
      return {
        action: "keep" as Action,
        extraLines: [
          {
            key: this.key,
            value: "0x" + nToHex(this.amount, { isLe: true }).slice(2).padEnd(35, "0") + "1",
          },
        ],
      };
    }

    return { action: "keep" as Action };
  };
}
