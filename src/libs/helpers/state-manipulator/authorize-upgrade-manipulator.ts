import Debug from "debug";
import { Action, encodeStorageKey, StateManipulator } from "./genesis-parser";
const debug = Debug("helper:authorize-upgrade-manipulator");

export class AuthorizeUpgradeManipulator implements StateManipulator {
  private readonly runtimeHash: string;
  private readonly storageKey: string;
  private readonly lastRelayChainBlockNumberKey: string;

  constructor(runtimeHash: string) {
    this.runtimeHash = runtimeHash;
    this.storageKey = encodeStorageKey("ParachainSystem", "AuthorizedUpgrade");
    this.lastRelayChainBlockNumberKey = encodeStorageKey(
      "ParachainSystem",
      "LastRelayChainBlockNumber",
    );
  }

  processRead = (_) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.lastRelayChainBlockNumberKey)) {
      debug(`Adding Authorized Upgrade Hash: ${this.runtimeHash}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key: this.storageKey,
            value: `${this.runtimeHash}01`, // 01 for "true" check version
          },
        ],
      };
    }
    if (key.startsWith(this.storageKey)) {
      debug(`Removing Authorized Upgrade Hash: ${value}`);
      return {
        action: "remove" as Action,
        extraLines: [],
      };
    }
  };
}
