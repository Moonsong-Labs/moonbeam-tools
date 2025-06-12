import Debug from "debug";

import {
  Action,
  encodeStorageBlake128MapKey,
  encodeStorageKey,
  StateLine,
  StateManipulator,
} from "./genesis-parser";

const _debug = Debug("helper:collator-manipulator");

export class CollatorManipulator implements StateManipulator {
  private readonly newCollator: string;
  private readonly newSessionKey: string;

  // Used to select a collator from the list
  private collators: string[];
  // Needed to avoid selecting an orbiter
  private orbiters: string[];
  // Needed to avoid selecting a collator without keys
  private authorMapping: { [collator: string]: StateLine };

  private replacedCollator: string;

  private readonly selectedCandidatesKey: string;
  private readonly orbiterCollatorsPoolKey: string;
  private readonly authorMappingKey: string;
  private readonly newAuthorMappingKey: string;
  private replacedAuthorMappingCollatorKey: string;
  private replacedNimbusLookupKey: string;

  constructor(newCollator: string, newSessionKey: string) {
    this.newCollator = newCollator;
    this.newSessionKey = newSessionKey;
    this.collators = [];
    this.orbiters = [];
    this.authorMapping = {};
    this.selectedCandidatesKey = encodeStorageKey("ParachainStaking", "SelectedCandidates");
    this.orbiterCollatorsPoolKey = encodeStorageKey("MoonbeamOrbiters", "CollatorsPool");
    this.authorMappingKey = encodeStorageKey("AuthorMapping", "MappingWithDeposit");
    this.newAuthorMappingKey = encodeStorageBlake128MapKey(
      "AuthorMapping",
      "MappingWithDeposit",
      newSessionKey,
    );
  }

  processRead = ({ key, value }) => {
    if (key.startsWith(this.selectedCandidatesKey)) {
      for (let i = value.length; i > 40; i -= 40) {
        // the data contains arbitrary size as bytes at the
        // beginning so we parse from the end;
        this.collators.push(`0x${value.slice(i - 40, i)}`);
      }
      debug(`Found candidates: ${this.collators.length}`);
    }
    if (key.startsWith(this.orbiterCollatorsPoolKey)) {
      this.orbiters.push(`0x${key.slice(-40)}`);
    }
    if (key.startsWith(this.authorMappingKey)) {
      const collator = value.slice(0, 42);
      this.authorMapping[collator] = { key, value };
    }
  };

  prepareWrite = () => {
    this.replacedCollator =
      this.collators.find((c) => !this.orbiters.includes(c) && this.authorMapping[c]) || "";

    if (!this.replacedCollator) {
      throw new Error("No collator available");
    }
    this.replacedAuthorMappingCollatorKey = this.authorMapping[this.replacedCollator].key;
    this.replacedNimbusLookupKey = encodeStorageBlake128MapKey(
      "AuthorMapping",
      "NimbusLookup",
      this.replacedCollator,
    );
  };

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.newAuthorMappingKey)) {
      debug(`Found new collator already existing session key: ${value}`);
      return { action: "remove" as Action };
    }
    if (key.startsWith(this.newAuthorMappingKey)) {
      debug(`Found new collator already existing session key: ${value}`);
      return { action: "remove" as Action };
    }
    if (key.startsWith(this.replacedAuthorMappingCollatorKey)) {
      debug(`Found replaced collator mapping key: ${value}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key: encodeStorageBlake128MapKey(
              "AuthorMapping",
              "MappingWithDeposit",
              this.newSessionKey,
            ),
            value: `${value.slice(0, -64)}${this.newSessionKey.slice(2)}`,
          },
        ],
      };
    }
    if (key.startsWith(this.replacedNimbusLookupKey)) {
      debug(`Found nimbus lookup for replaced collator: ${value}`);
      return {
        action: "remove" as Action,
        extraLines: [
          {
            key,
            value: this.newSessionKey,
          },
        ],
      };
    }
  };
}
