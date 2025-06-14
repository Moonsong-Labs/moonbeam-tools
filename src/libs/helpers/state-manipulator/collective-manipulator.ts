import { nToHex } from "@polkadot/util";
import Debug from "debug";

import { Action, encodeStorageKey, StateManipulator } from "./genesis-parser";

const _debug = Debug("helper:collective-manipulator");

export class CollectiveManipulator implements StateManipulator {
  private readonly collectiveName: string;
  private readonly collectiveMembersKey: string;
  private readonly newMembers: string[];

  constructor(collectiveName: string, newMembers: string[]) {
    this.collectiveName = collectiveName;
    this.newMembers = newMembers;
    this.collectiveMembersKey = encodeStorageKey(collectiveName, "Members");
    _debug(`Using key ${this.collectiveMembersKey} for ${this.collectiveName} members`);
  }

  processRead = (_) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.collectiveMembersKey)) {
      _debug(`Replacing ${this.collectiveName} members: ${value}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: `0x${nToHex(this.newMembers.length * 4, { bitLength: 8 }).slice(
              2,
            )}${this.newMembers.map((member) => member.slice(2)).join("")}`,
          },
        ],
      };
    }
  };
}
