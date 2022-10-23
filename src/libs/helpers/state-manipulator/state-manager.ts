import Debug from "debug";
import fs from "node:fs/promises";
import { request, stream } from "undici";
import path from "node:path";
import { processState } from "./genesis-parser";
import { RoundManipulator } from "./round-manipulator";
import { AuthorFilteringManipulator } from "./author-filtering-manipulator";
import { CollatorManipulator } from "./collator-manipulator";
import { HRMPManipulator } from "./hrmp-manipulator";
import { CollectiveManipulator } from "./collective-manipulator";
import { ValidationManipulator } from "./validation-manipulator";
import { XCMPManipulator } from "./xcmp-manipulator";
import { BalancesManipulator } from "./balances-manipulator";
import { ALITH_ADDRESS, ALITH_SESSION_ADDRESS } from "../../../utils/constants";
import { SpecManipulator } from "./spec-manipulator";
const debug = Debug("helper:state-manager");

export type NetworkName = "moonbeam" | "moonriver" | "alphanet";

export const STORAGE_NAMES: { [name in NetworkName]: string } = {
  moonbeam: "moonbeam",
  moonriver: "moonriver",
  alphanet: "moonbase-alpha",
};

// Downloads the exported state from s3. Only if the xxx-chain-info.json file hasn't changed
// 2 files are created:
export async function downloadExportedState(network: NetworkName, outPath: string) {
  if (!STORAGE_NAMES[network]) {
    throw new Error(
      `Invalid network ${network}, expecting ${Object.keys(STORAGE_NAMES).join(", ")}`
    );
  }

  const stateInfoFileName = `${network}-chain-info.json`;
  const stateInfoFile = path.join(outPath, stateInfoFileName);
  const stateFileName = `${network}-state.json`;
  const stateFile = path.join(outPath, stateFileName);

  debug(`Checking ${STORAGE_NAMES[network]} in ${stateInfoFile}`);
  const downloadedStateInfo = await (
    await request(
      `https://s3.us-east-2.amazonaws.com/` +
        `snapshots.moonbeam.network/${STORAGE_NAMES[network]}/` +
        `latest/${stateInfoFileName}`
    )
  ).body.json();

  await fs.mkdir(outPath, { recursive: true });

  const stateInfo = await fs
    .readFile(stateInfoFile)
    .then((d) => JSON.parse(d.toString()))
    .catch(() => null);
  if (stateInfo && stateInfo.best_hash == downloadedStateInfo.best_hash) {
    return stateFile;
  }

  const fileStream = (await fs.open(stateFile, "w")).createWriteStream();

  debug(
    `Preparing to download ${stateFileName} (best-hash: ${downloadedStateInfo.best_hash}) to ${stateFile}`
  );
  await stream(
    `https://s3.us-east-2.amazonaws.com/` +
      `snapshots.moonbeam.network/${STORAGE_NAMES[network]}/` +
      `latest/${stateFileName}`,
    { method: "GET" },
    () => fileStream
  );
  await fs.writeFile(stateInfoFile, JSON.stringify(downloadedStateInfo));
  debug(`Downloaded ${stateFileName} to ${stateFile}`);

  return stateFile;
}

// Customize a Moonbeam exported state spec to make it usable locally
// It makes Alith the main collator and restore XCMP/HRMP data.
export async function neutralizeExportedState(inFile: string, outFile: string) {
  await processState(inFile, outFile, [
    new RoundManipulator((current, first, length) => {
      return { current, first: 0, length: 100 };
    }),
    new AuthorFilteringManipulator(100),
    new CollatorManipulator(ALITH_ADDRESS, ALITH_SESSION_ADDRESS),
    new HRMPManipulator(),
    new SpecManipulator({
      name: `Fork Network`,
      relayChain: `rococo-local`,
    }),
    new CollectiveManipulator("TechCommitteeCollective", [ALITH_ADDRESS]),
    new CollectiveManipulator("CouncilCollective", [ALITH_ADDRESS]),
    new ValidationManipulator(),
    new XCMPManipulator(),
    new BalancesManipulator([{ account: ALITH_ADDRESS, amount: 10_000n * 10n ** 18n }]),
  ]);
}
