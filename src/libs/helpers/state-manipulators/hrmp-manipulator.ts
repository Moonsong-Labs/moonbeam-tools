import Debug from "debug";
import { Action, encodeStorageKey, Manipulator } from "../genesis-parser";
const debug = Debug("helper:hrmp-manipulator");

export class HRMPManipulator implements Manipulator {
  private readonly revelantMessagingKey: string;
  private readonly lastDmqMqcHeadKey: string;

  constructor() {
    this.revelantMessagingKey = encodeStorageKey("ParachainSystem", "RelevantMessagingState");
    this.lastDmqMqcHeadKey = encodeStorageKey("ParachainSystem", "LastDmqMqcHead");
  }

  processRead = (_) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.revelantMessagingKey)) {
      debug(`Clearing RelevantMessaging dmq_mqc_head: ${value.slice(0, 66)}`);
      return {
        action: "remove" as Action,
        extraLines: [{ key, value: `0x${new Array(64).fill(0).join("")}${value.slice(66)}` }],
      };
    }
    if (key.startsWith(this.lastDmqMqcHeadKey)) {
      debug(`Clearing LastDmqMqcHead: ${value}`);
      return {
        action: "remove" as Action,
        extraLines: [],
      };
    }
  };
}
