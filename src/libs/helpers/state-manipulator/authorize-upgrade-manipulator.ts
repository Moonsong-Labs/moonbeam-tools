import Debug from "debug";
import { Action, encodeStorageKey, StateManipulator } from "./genesis-parser";
const debug = Debug("helper:collective-manipulator");

export class AuthorizeUpgradeManipulator implements StateManipulator {
  private readonly runtimeHash: string;
  private readonly authorizedUpgradeKey: string;
  private readonly newMembers: string[];

  constructor(runtimeHash: string) {
    this.runtimeHash = runtimeHash;
    this.authorizedUpgradeKey = encodeStorageKey("ParachainSystem", "AuthorizedUpgrade");
  }

  processRead = (_) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.authorizedUpgradeKey)) {
      debug(`Replacing Authorized Upgrade Hash: ${value}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: this.runtimeHash,
          },
        ],
      };
    }
  };
}
