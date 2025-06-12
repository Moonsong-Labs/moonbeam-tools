import Debug from "debug";

import { Action, encodeStorageKey, StateManipulator } from "./genesis-parser";

const _debug = Debug("helper:sudo-manipulator");

export class SudoManipulator implements StateManipulator {
  public storagePrefix: string;
  private sudoAccount: string;

  constructor(sudoAccount: string) {
    this.storagePrefix = encodeStorageKey("Sudo", "Key");
    this.sudoAccount = sudoAccount;
  }

  processRead = (_) => {};
  prepareWrite = () => {};
  processWrite = ({ key, value }) => {
    if (!key.startsWith(this.storagePrefix)) {
      return;
    }
    _debug(`Found sudo key: ${value}`);
    return {
      action: "remove" as Action,
      extraLines: [{ key, value: this.sudoAccount }],
    };
  };
}
