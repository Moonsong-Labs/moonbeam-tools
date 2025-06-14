import Debug from "debug";

import { Action, StateManipulator } from "./genesis-parser";

const _debug = Debug("helper:spec-manipulator");

export interface SpecOptions {
  clearBootnodes?: boolean;
  name?: string;
  protocolId?: string;
  relayChain?: string;
  chainType?: string;
  paraId?: number;
  devService?: boolean;
}

export class SpecManipulator implements StateManipulator {
  public storagePrefix: string;

  private readonly options: SpecOptions;

  constructor(options: SpecOptions) {
    this.options = {
      clearBootnodes: true,
      chainType: "Local",
      protocolId: `fork${Math.floor(Math.random() * 100000)}`, //random protocol to reduce issues
      ...(options || {}),
    };
  }

  processRead = (_) => {};
  prepareWrite = () => {};
  processWrite = ({ key, value }) => {
    if (this.options.clearBootnodes && key === "bootNodes") {
      return { action: "remove" as Action };
    } else if (this.options.name && key === "name") {
      return { action: "remove" as Action, extraLines: [{ key, value: this.options.name }] };
    } else if (this.options.chainType && key === "chainType") {
      return { action: "remove" as Action, extraLines: [{ key, value: this.options.chainType }] };
    } else if (this.options.protocolId && key === "protocolId") {
      return { action: "remove" as Action, extraLines: [{ key, value: this.options.protocolId }] };
    } else if (this.options.relayChain && key === "relayChain") {
      return { action: "remove" as Action, extraLines: [{ key, value: this.options.relayChain }] };
    } else if (this.options.paraId && key === "paraId") {
      return { action: "remove" as Action, extraLines: [{ key, value: this.options.paraId }] };
    } else if (this.options.devService) {
      if (key === "id") {
        return { action: "remove" as Action, extraLines: [{ key, value: value.concat("_dev") }] };
      }
    }
  };
}
