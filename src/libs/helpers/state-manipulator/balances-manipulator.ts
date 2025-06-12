import { hexToBigInt, nToHex } from "@polkadot/util";
import Debug from "debug";

import {
  Action,
  encodeStorageBlake128MapKey,
  encodeStorageKey,
  StateManipulator,
} from "./genesis-parser";

const _debug = Debug("helper:balances-manipulator");

export class BalancesManipulator implements StateManipulator {
  private readonly balancesData: {
    account: string;
    targetAmount: bigint;
    currentAmount: bigint;
    alreadyExists: boolean;
    key: string;
  }[];
  private totalIssuance: bigint;

  private readonly totalIssuanceKey: string;

  constructor(balances: { account: string; amount: bigint }[]) {
    this.balancesData = balances.map(({ account, amount }) => ({
      account,
      targetAmount: amount,
      currentAmount: 0n,
      alreadyExists: false,
      key: encodeStorageBlake128MapKey("System", "Account", account),
    }));
    this.totalIssuanceKey = encodeStorageKey("Balances", "TotalIssuance");
  }

  processRead = ({ key, value }) => {
    if (key.startsWith(this.totalIssuanceKey)) {
      this.totalIssuance = hexToBigInt(value, { isLe: true });
    }
    const balance = this.balancesData.find((balance) => key.startsWith(balance.key));
    if (balance) {
      balance.currentAmount = hexToBigInt(value.slice(34, 66), { isLe: true });
      balance.alreadyExists = true;
    }
  };

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.totalIssuanceKey)) {
      const diff = this.balancesData.reduce(
        (p, { currentAmount, targetAmount }) => p + targetAmount - currentAmount,
        0n,
      );
      debug(
        `Found total issuance from ${this.totalIssuance} to ${this.totalIssuance + diff} [${
          diff > 0 ? "+" : ""
        }${diff}]`,
        value,
      );
      const newTotalIssuance = this.totalIssuance + diff;
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: nToHex(newTotalIssuance, {
              isLe: true,
              bitLength: 128,
            }),
          },
          ...this.balancesData
            .filter((b) => !b.alreadyExists)
            .map(({ account, key, targetAmount }) => {
              const nonce = nToHex(0, { bitLength: 32, isLe: true }).slice(2);
              const consumers = nToHex(0, { bitLength: 32, isLe: true }).slice(2);
              const providers = nToHex(1, { bitLength: 32, isLe: true }).slice(2);
              const sufficients = nToHex(0, { bitLength: 32, isLe: true }).slice(2);
              const free = nToHex(targetAmount, { bitLength: 128, isLe: true }).slice(2);
              const reserved = nToHex(0, { bitLength: 128, isLe: true }).slice(2);
              const miscFrozen = nToHex(0, { bitLength: 128, isLe: true }).slice(2);
              const feeFrozen = nToHex(0, { bitLength: 128, isLe: true }).slice(2);
              debug(`Adding account ${account}`);
              return {
                key,
                value: `0x${nonce}${consumers}${providers}${sufficients}${free}${reserved}${miscFrozen}${feeFrozen}`,
              };
            }),
        ],
      };
    }
    const balance = this.balancesData.find((balance) => key.startsWith(balance.key));
    if (balance) {
      debug(
        `Found balance account ${balance.account}, from ${balance.currentAmount} to ${balance.targetAmount}`,
      );
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: `${value.slice(0, 34)}${nToHex(balance.targetAmount, {
              isLe: true,
              bitLength: 128,
            }).slice(2)}${value.slice(66)}`,
          },
        ],
      };
    }
  };
}
