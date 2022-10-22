import Debug from "debug";
import fs from "node:fs/promises";
import { request, stream } from "undici";
import path from "node:path";
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
    return;
  }

  const fileStream = (await fs.open(stateFile, "w")).createWriteStream();

  debug(`Preparing to download ${stateFileName} to ${stateFile}`);
  await stream(
    `https://s3.us-east-2.amazonaws.com/` +
      `snapshots.moonbeam.network/${STORAGE_NAMES[network]}/` +
      `latest/${stateFileName}`,
    { method: "GET" },
    () => fileStream
  );
  debug(`Downloaded ${stateFileName} to ${stateFile}`);
}
