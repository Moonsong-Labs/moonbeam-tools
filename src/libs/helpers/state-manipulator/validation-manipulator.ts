import { nToHex } from "@polkadot/util";
import Debug from "debug";

import { Action, encodeStorageKey, StateManipulator } from "./genesis-parser";

const _debug = Debug("helper:validation-manipulator");

export class ValidationManipulator implements StateManipulator {
  private readonly validationDataKey: string;
  private readonly lastRelayChainBlockNumberKey: string;
  private readonly parentNumber: number;

  constructor(parentNumber = 0) {
    this.parentNumber = parentNumber;
    this.validationDataKey = encodeStorageKey("ParachainSystem", "ValidationData");
    this.lastRelayChainBlockNumberKey = encodeStorageKey(
      "ParachainSystem",
      "LastRelayChainBlockNumber",
    );
  }

  processRead = (_) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.validationDataKey)) {
      const head = value.slice(0, -(8 + 64 + 8));
      const relayParentNumber = nToHex(this.parentNumber, { bitLength: 32 }).slice(2);
      const relayParentStorageRoot = value.slice(-(8 + 64), -8);
      const maxPovSize = value.slice(-8);

      debug(`Reset parachain validation data: ${head}`);
      return {
        action: "remove" as Action,
        extraLines: [
          { key, value: `${head}${relayParentNumber}${relayParentStorageRoot}${maxPovSize}` },
        ],
      };
    }
    if (key.startsWith(this.lastRelayChainBlockNumberKey)) {
      debug(`Reset parachain relay chain block number: ${value}`);
      return {
        action: "remove" as Action,
        extraLines: [{ key, value: nToHex(this.parentNumber, { bitLength: 32 }) }],
      };
    }
  };
}
