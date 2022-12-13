import { bnToHex, hexToBigInt, nToHex } from "@polkadot/util";
import Debug from "debug";
import {
  Action,
  encodeStorageBlake128MapKey,
  encodeStorageBlake128DoubleMapKey,
  encodeStorageKey,
  StateManipulator,
} from "./genesis-parser";
const debug = Debug("helper:balances-manipulator");

export class AssetsManipulator implements StateManipulator {
  private readonly assetsData: {
    account: string;
    assetId: bigint;
    amount: bigint;
    injected: boolean;
    key: string;
  }[];
  private readonly assetsGeneralPrefix = encodeStorageKey("Assets", "Account");

  // TODO: Increase asset total issuance by injected amount
  //       if required by tests

  // const amount = nToHex(15_000_000_000_000, { isLe: true });
  // const newAlithTokenBalanceData = "0x" + amount.slice(2).padEnd(35, "0") + "1";

  constructor(balances: { account: string; amount: bigint; id: bigint }[]) {
    this.assetsData = balances.map(({ account, amount, id }) => ({
      account,
      amount,
      injected: false,
      assetId: id,
      key: encodeStorageBlake128DoubleMapKey("Assets", "Account", [
        bnToHex(id, { isLe: true, bitLength: 128 }),
        account,
      ]),
    }));
  }

  processRead = ({ key, value }) => {
    const balance = this.assetsData.find((balance) => key.startsWith(balance.key));
    if (balance) {
      balance.amount = hexToBigInt(value.slice(2, 12), { isLe: true });
      balance.injected = true;
    }
  };

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (!key.startsWith(this.assetsGeneralPrefix)) {
      return;
    }

     this.assetsData.map((assetData) => {
      if (!assetData.injected) {
        return {
          action: "keep" as Action,
          extraLines: [
            {
              key,
              value: "0x" + nToHex(assetData.amount, { isLe: true }).slice(2).padEnd(35, "0") + "1",
            },
          ],
        };
      }
    });
  };
}
