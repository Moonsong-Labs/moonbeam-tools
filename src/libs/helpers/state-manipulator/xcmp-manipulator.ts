import Debug from "debug";

import { Action, encodeStorageKey, StateManipulator } from "./genesis-parser";

const _debug = Debug("helper:xcmp-manipulator");

export class XCMPManipulator implements StateManipulator {
  private readonly inboundXcmpMessagesKey: string;
  private readonly inboundXcmpStatusKey: string;
  private readonly outboundXcmpMessagesKey: string;
  private readonly outboundXcmpStatusKey: string;
  private readonly overweightKey: string;
  private readonly overweightCountKey: string;
  private readonly signalMessagesKey: string;

  constructor() {
    this.inboundXcmpMessagesKey = encodeStorageKey("XcmpQueue", "InboundXcmpMessages");
    this.inboundXcmpStatusKey = encodeStorageKey("XcmpQueue", "InboundXcmpStatus");
    this.outboundXcmpMessagesKey = encodeStorageKey("XcmpQueue", "OutboundXcmpMessages");
    this.outboundXcmpStatusKey = encodeStorageKey("XcmpQueue", "OutboundXcmpStatus");
    this.overweightKey = encodeStorageKey("XcmpQueue", "Overweight");
    this.overweightCountKey = encodeStorageKey("XcmpQueue", "OverweightCount");
    this.signalMessagesKey = encodeStorageKey("XcmpQueue", "SignalMessages");
  }

  processRead = (_) => {};

  prepareWrite = () => {};

  processWrite = ({ key, value }) => {
    if (key.startsWith(this.inboundXcmpMessagesKey)) {
      _debug(`Clearing InboundXcmpMessages: ${value}`);
      return { action: "remove" as Action };
    }
    if (key.startsWith(this.inboundXcmpStatusKey)) {
      _debug(`Clearing InboundXcmpStatus: ${value}`);
      return { action: "remove" as Action };
    }
    if (key.startsWith(this.outboundXcmpMessagesKey)) {
      _debug(`Clearing OutboundXcmpMessages: ${value}`);
      return { action: "remove" as Action };
    }
    if (key.startsWith(this.outboundXcmpStatusKey)) {
      _debug(`Clearing OutboundXcmpStatus: ${value}`);
      return { action: "remove" as Action };
    }
    if (key.startsWith(this.overweightKey)) {
      _debug(`Clearing Overweight: ${value}`);
      return { action: "remove" as Action };
    }
    if (key.startsWith(this.overweightCountKey)) {
      _debug(`Clearing OverweightCount: ${value}`);
      return { action: "remove" as Action };
    }
    if (key.startsWith(this.signalMessagesKey)) {
      _debug(`Clearing SignalMessages: ${value}`);
      return { action: "remove" as Action };
    }
  };
}
