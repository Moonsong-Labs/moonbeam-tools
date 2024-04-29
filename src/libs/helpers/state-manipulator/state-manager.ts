import Debug from "debug";
import fs from "node:fs/promises";
import { Client } from "undici";
import path from "node:path";
import { processState, StateManipulator } from "./genesis-parser";
import { RoundManipulator } from "./round-manipulator";
import { AuthorFilteringManipulator } from "./author-filtering-manipulator";
import { CollatorManipulator } from "./collator-manipulator";
import { HRMPManipulator } from "./hrmp-manipulator";
import { CollectiveManipulator } from "./collective-manipulator";
import { ValidationManipulator } from "./validation-manipulator";
import { XCMPManipulator } from "./xcmp-manipulator";
import { BalancesManipulator } from "./balances-manipulator";
import {
  ALITH_ADDRESS,
  ALITH_SESSION_ADDRESS,
  BALTATHAR_ADDRESS,
  CHARLETH_ADDRESS,
  RELAY_ASSET_ID,
  USDT_ASSET_ID,
} from "../../../utils/constants";
import { SpecManipulator } from "./spec-manipulator";
import { SudoManipulator } from "./sudo-manipulator";
import { AssetManipulator } from "./asset-manipulator";
import { AuthorizeUpgradeManipulator } from "./authorize-upgrade-manipulator";
const debug = Debug("helper:state-manager");

export type NetworkName = "moonbeam" | "moonriver" | "alphanet" | "stagenet";

export const STORAGE_NAMES: { [name in NetworkName]: string } = {
  moonbeam: "moonbeam",
  moonriver: "moonriver",
  alphanet: "moonbase-alpha",
  stagenet: "stagenet",
};

export interface StateInfo {
  file: string;
  cleanFile?: string;
  name: string;
  chainId: string;
  blockHash: string;
  blockNumber: number;
  runtime: {
    specName: string;
    implName: string;
    authoringVersion: number;
    specVersion: number;
    implVersion: number;
    apis: [string, number][];
    transactionVersion: 2;
    stateVersion: 0;
  };
}

export interface DownloadOptions {
  network: string;
  outPath: string;

  // Download new state if available
  checkLatest?: boolean;

  // Prefers clean state (without heavy contract, 80% smaller on moonbeam)
  useCleanState?: boolean;
}

// Downloads the exported state from s3. Only if the xxx-chain-info.json file hasn't changed
// 2 files are created:
export async function downloadExportedState(
  options: DownloadOptions,
  onStart?: (size: number) => void,
  onProgress?: (bytes: number) => void,
  onComplete?: () => void,
): Promise<{ stateFile: string; stateInfo: StateInfo }> {
  const { network, outPath, checkLatest, useCleanState } = options;

  if (!STORAGE_NAMES[network]) {
    console.warn(`Invalid network ${network}, expecting ${Object.keys(STORAGE_NAMES).join(", ")}`);
  }

  const stateInfoFileName = `${network}-state.info.json`;
  const stateInfoFile = path.join(outPath, stateInfoFileName);

  debug(`Checking ${STORAGE_NAMES[network]} in ${stateInfoFile}`);

  await fs.mkdir(outPath, { recursive: true });

  const stateInfoExists = await fs
    .access(stateInfoFile)
    .then(() => true)
    .catch(() => null);

  const stateInfo: StateInfo = await fs
    .readFile(stateInfoFile)
    .then((d) => JSON.parse(d.toString()))
    .catch(() => null);

  // No check for latest, skip if files already exists
  if (stateInfoExists && !checkLatest) {
    const stateFileName =
      useCleanState && stateInfo.cleanFile ? stateInfo.cleanFile : stateInfo.file;
    const stateFile = path.join(outPath, stateFileName);

    const stateExist = await fs
      .access(stateFile)
      .then(() => true)
      .catch(() => false);

    if (stateExist) {
      return { stateFile, stateInfo };
    }
  }
  const client = new Client(`https://states.kaki.dev`);
  const downloadedStateInfo: StateInfo = await (
    await client.request({
      path: `/${network}-state.info.json`,
      method: "GET",
    })
  ).body.json();

  // Already latest version
  if (stateInfo && stateInfo.blockHash == downloadedStateInfo.blockHash) {
    const stateFileName =
      useCleanState && stateInfo.cleanFile ? stateInfo.cleanFile : stateInfo.file;
    const stateFile = path.join(outPath, stateFileName);

    const stateExist = await fs
      .access(stateFile)
      .then(() => true)
      .catch(() => false);

    if (stateExist) {
      client.close();
      return { stateFile, stateInfo };
    }
  }

  const stateFileName =
    useCleanState && downloadedStateInfo.cleanFile
      ? downloadedStateInfo.cleanFile
      : downloadedStateInfo.file;
  const stateFile = path.join(outPath, stateFileName);

  const fileStream = (await fs.open(stateFile, "w")).createWriteStream();

  debug(
    `Preparing to download ${stateFileName} (best-hash: ${downloadedStateInfo.blockHash}) to ${stateFile}`,
  );

  let transferredBytes = 0;
  await new Promise<void>((resolve, reject) => {
    client.dispatch(
      {
        path: `/${stateFileName}`,
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
              parseInt(headerStrings[headerStrings.findIndex((h) => h == "Content-Length") + 1]),
            );
          return true;
        },
        onData: (chunk) => {
          transferredBytes += chunk.length;
          fileStream.write(chunk);
          onProgress && onProgress(transferredBytes);
          return true;
        },
        onComplete: (_) => {
          client.close();
          fileStream.close();
          onComplete && onComplete();
          resolve();
        },
      },
    );
  });

  // Writing the chain-info after the full state to ensure it is not updated
  // in case of state download failure
  await fs.writeFile(stateInfoFile, JSON.stringify(downloadedStateInfo));
  debug(`Downloaded ${stateFileName} to ${stateFile}`);

  return { stateFile, stateInfo: downloadedStateInfo };
}

// Customize a Moonbeam exported state spec to make it usable locally
// It makes Alith the main collator and restore XCMP/HRMP data.
export async function neutralizeExportedState(
  inFile: string,
  outFile: string,
  option: { dev: boolean; authorizeUpgrade: string } = { dev: false, authorizeUpgrade: "" },
) {
  const { dev, authorizeUpgrade } = {
    dev: false,
    authorizeUpgrade: "",
    ...option,
  };

  const manipulators: StateManipulator[] = [
    new RoundManipulator((current, first, length) => {
      return { current, first: 0, length: 100 };
    }),
    new AuthorFilteringManipulator(100),
    new SudoManipulator(ALITH_ADDRESS),
    new CollatorManipulator(ALITH_ADDRESS, ALITH_SESSION_ADDRESS),
    new HRMPManipulator(),
    dev
      ? new SpecManipulator({
          name: `Forked Dev Network`,
          chainType: `Development`,
          relayChain: `dev-service`,
          devService: true,
          paraId: 0,
          protocolId: "",
        })
      : new SpecManipulator({
          name: `Fork Network`,
          relayChain: `rococo-local`,
        }),
    new CollectiveManipulator("OpenTechCommitteeCollective", [ALITH_ADDRESS]),
    new ValidationManipulator(),
    new XCMPManipulator(),
    new BalancesManipulator([
      { account: ALITH_ADDRESS, amount: 10_000n * 10n ** 18n },
      { account: BALTATHAR_ADDRESS, amount: 10_000n * 10n ** 18n },
      { account: CHARLETH_ADDRESS, amount: 10_000n * 10n ** 18n },
    ]),
    new AssetManipulator(ALITH_ADDRESS, USDT_ASSET_ID, 20_000n * 10n ** 6n),
    new AssetManipulator(ALITH_ADDRESS, RELAY_ASSET_ID, 20_000n * 10n ** 10n),
  ];
  if (authorizeUpgrade) {
    manipulators.push(new AuthorizeUpgradeManipulator(authorizeUpgrade));
  }

  await processState(inFile, outFile, manipulators);
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
    new CollectiveManipulator("OpenTechCommitteeCollective", [ALITH_ADDRESS]),
    new ValidationManipulator(),
    new XCMPManipulator(),
    new BalancesManipulator([{ account: ALITH_ADDRESS, amount: 10_000n * 10n ** 18n }]),
  ]);
}
