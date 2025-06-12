import { bnToHex, hexToBigInt, nToHex } from "@polkadot/util";
import Debug from "debug";

import {
  Action,
  encodeStorageBlake128DoubleMapKey,
  encodeStorageBlake128MapKey,
  encodeStorageKey,
  StateManipulator,
} from "./genesis-parser";

const _debug = Debug("helper:balances-manipulator");

export class AssetManipulator implements StateManipulator {
  account: string;
  assetId: string;
  amount: bigint;
  injected: boolean;
  key: string;
  assetSupplyPrefix: string;
  assetsGeneralPrefix = encodeStorageKey("Assets", "Account");

  constructor(account: string, assetId: string, amount: bigint) {
    this.account = account;
    this.amount = amount;
    this.assetId = assetId;
    this.injected = false;
    this.key = encodeStorageBlake128DoubleMapKey("Assets", "Account", [
      bnToHex(BigInt(assetId), { isLe: true, bitLength: 128 }),
      account,
    ]);
    this.assetSupplyPrefix = encodeStorageBlake128MapKey(
      "Assets",
      "Asset",
      bnToHex(BigInt(assetId), { isLe: true, bitLength: 128 }),
    );
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

    // This section is overly verbose so that future maintainers can extend this section as they wish
    if (key.startsWith(this.assetSupplyPrefix)) {
      const currentTotal = hexToBigInt(value.slice(162, 194), { isLe: true });
      const supply = bnToHex(currentTotal + this.amount, { isLe: true, bitLength: 128 }).slice(2);
      const _address = "6d6f646c617373746d6e67720000000000000000";
      const owner = _address;
      const issuer = _address;
      const admin = _address;
      const freezer = _address;
      const deposit = nToHex(0, { isLe: true, bitLength: 128 }).slice(2);
      const minBalance = nToHex(1, { isLe: true, bitLength: 128 }).slice(2);
      const isSufficient = nToHex(1, { isLe: true }).slice(2);
      const accounts = bnToHex(hexToBigInt(value.slice(259, 267)) + BigInt(1), {
        isLe: true,
      }).slice(2);
      const sufficients = value.slice(267, 275);
      const approvals = value.slice(275, 283);
      const isFrozen = nToHex(0, { isLe: true }).slice(2);
      const newValue =
        "0x" +
        owner +
        issuer +
        admin +
        freezer +
        supply +
        deposit +
        minBalance +
        isSufficient +
        accounts +
        sufficients +
        approvals +
        isFrozen;
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: newValue,
          },
        ],
      };
    } else {
      return { action: "keep" as Action };
    }
  };
}
