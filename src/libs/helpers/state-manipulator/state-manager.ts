import Debug from "debug";
import fs from "node:fs/promises";
import { Client } from "undici";
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
import { SudoManipulator } from "./sudo-manipulator";
const debug = Debug("helper:state-manager");

export type NetworkName = "moonbeam" | "moonriver" | "alphanet";

export const STORAGE_NAMES: { [name in NetworkName]: string } = {
  moonbeam: "moonbeam",
  moonriver: "moonriver",
  alphanet: "moonbase-alpha",
};

// Downloads the exported state from s3. Only if the xxx-chain-info.json file hasn't changed
// 2 files are created:
export async function downloadExportedState(
  network: NetworkName,
  outPath: string,
  checkLatest = true,
  onStart?: (size: number) => void,
  onProgress?: (bytes: number) => void,
  onComplete?: () => void
) {
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

  await fs.mkdir(outPath, { recursive: true });

  const stateInfoExists = await fs
    .access(stateInfoFile)
    .then(() => true)
    .catch(() => null);
  const stateExist = await fs
    .access(stateInfoFile)
    .then(() => true)
    .catch(() => false);

  // No check for latest, skip if files already exists
  if (stateInfoExists && stateExist && !checkLatest) {
    return stateFile;
  }
  
  const stateInfo = await fs
    .readFile(stateInfoFile)
    .then((d) => JSON.parse(d.toString()))
    .catch(() => null);
    
  const client = new Client(`https://s3.us-east-2.amazonaws.com`);
  const downloadedStateInfo = await (
    await client.request({
      path:
        `/snapshots.moonbeam.network/${STORAGE_NAMES[network]}/` +
        `latest/${STORAGE_NAMES[network]}-chain-info.json`,
      method: "GET",
    })
  ).body.json();
  
  // Already latest version
  if (stateInfo && stateInfo.best_hash == downloadedStateInfo.best_hash) {
    client.close();
    return stateFile;
  }

  const fileStream = (await fs.open(stateFile, "w")).createWriteStream();

  debug(
    `Preparing to download ${stateFileName} (best-hash: ${downloadedStateInfo.best_hash}) to ${stateFile}`
  );

  let transferredBytes = 0;
  await new Promise<void>((resolve, reject) => {
    client.dispatch(
      {
        path:
          `/snapshots.moonbeam.network/${STORAGE_NAMES[network]}/` +
          `latest/${STORAGE_NAMES[network]}-state.json`,
        method: "GET",
      },
      {
        onConnect: () => {},
        onError: (error) => {
          reject(error);
        },
        onHeaders: (statusCode, headers) => {
          const headerStrings = headers.map((h) => h.toString());
          onStart &&
            onStart(
              parseInt(headerStrings[headerStrings.findIndex((h) => h == "Content-Length") + 1])
            );
          return true;
        },
        onData: (chunk) => {
          transferredBytes += chunk.length;
          fileStream.write(chunk);
          onProgress && onProgress(transferredBytes);
          return true;
        },
        onComplete: (trailers) => {
          client.close();
          onComplete && onComplete();
          resolve();
        },
      }
    );
  });

  // Writing the chain-info after the full state to ensure it is not updated
  // in case of state download failure
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
    new SudoManipulator(ALITH_ADDRESS),
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


// Customize a Moonbeam exported state spec to make it usable locally
// It makes Alith the main collator and restore XCMP/HRMP data.
export async function insertParachainCodeIntoRelay(inFile: string, outFile: string) {
  await processState(inFile, outFile, [
    new RoundManipulator((current, first, length) => {
      return { current, first: 0, length: 100 };
    }),
    new AuthorFilteringManipulator(100),
    new SudoManipulator(ALITH_ADDRESS),
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
