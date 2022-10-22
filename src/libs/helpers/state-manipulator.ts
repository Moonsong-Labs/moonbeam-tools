import Debug from "debug";
import fs from "node:fs/promises";
import readline from "readline";
import chalk from "chalk";
import { xxhashAsU8a, blake2AsU8a } from "@polkadot/util-crypto";
import { u8aConcat, u8aToHex } from "@polkadot/util";
const debug = Debug("helper:state-manipulator");

// Buffer size in lines used to write to the file
const BUFFER_LINE_SIZE = 200;


// Represent the hex values of a given line
export interface StateLine {
  key: string;
  value: string;
}

export type Action = "remove" | "keep";

export interface Manipulator {
  // Will get executed for each line of the state file during the read phase
  processRead: (line: StateLine) => void;

  // Will get executed after the read phase
  prepareWrite: () => void;

  // Will get executed for each line of the state file during the write phase
  // Can decide to remove/keep the original line and also add extra lines
  processWrite: (line: StateLine) => { action: Action; extraLines: StateLine[] } | undefined;
}

export function encodeStorageKey(module, name) {
  return u8aToHex(u8aConcat(xxhashAsU8a(module, 128), xxhashAsU8a(name, 128)));
}

export function encodeStorageBlake128MapKey(module, name, key) {
  return u8aToHex(
    u8aConcat(xxhashAsU8a(module, 128), xxhashAsU8a(name, 128), blake2AsU8a(key, 128), key)
  );
}

// Read, and parse line by line the raw state file.
// Parsing has 2 passes:
// - first, to read only (allowing to prepare data) calling processRead
// - second, to delete/write/update the line calling processWrite
export async function processState(
  inputFile: string,
  destFile: string,
  manipulators: Manipulator[]
) {
  if (!inputFile || !destFile) {
    throw new Error("Missing input and destination file");
  }
  if (inputFile == destFile) {
    throw new Error("Input and output files are the same");
  }
  // Read each line and callback with the line and extracted key/value if available
  const processLines = async (
    inputFile: string,
    callback: (line: string, stateLine?: StateLine) => void
  ) => {
    const inFile = await fs.open(inputFile, "r");
    const lineReaderPass = readline.createInterface({
      input: inFile.createReadStream({ start: 0 }),
      crlfDelay: Infinity,
    });

    let enteredRawState = false;
    let exitedRawState = false;
    for await (const line of lineReaderPass) {
      if (enteredRawState && exitedRawState) {
        callback(line, null);
        continue;
      }
      if (!enteredRawState) {
        enteredRawState = line.startsWith(`      "top"`);
        callback(line, null);
        continue;
      }
      if (enteredRawState && line.startsWith(`      }`)) {
        exitedRawState = true;
        callback(line, null);
        continue;
      }
      const [, key, , value] = line.split('"');
      callback(line, { key, value });
    }
    await inFile.close();
  };

  await processLines(inputFile, (_, stateLine) => {
    if (!stateLine) {
      return;
    }
    manipulators.forEach((manipulator) => {
      manipulator.processRead(stateLine);
    });
  });

  
  manipulators.forEach((manipulator) => {
    manipulator.prepareWrite();
  });

  const outFile = await fs.open(destFile, "w");
  const outStream = outFile.createWriteStream();

  // Adds extra to the buffer for each manipulator adding lines
  const lineBuffer = new Array(BUFFER_LINE_SIZE + manipulators.length + 1).fill(0);
  let lineSize = 0;
  await processLines(inputFile, (line, stateLine) => {
    let keepLine = true;
    if (stateLine) {
      manipulators.map((manipulator) => {
        const result = manipulator.processWrite(stateLine);
        if (!result) {
          return;
        }
        const { action, extraLines } = result;
        debug(
          `      - ${chalk.red(action.padStart(6, " "))} ${stateLine.key}: ${stateLine.value.slice(
            0,
            100
          )}`
        );
        if (action == "remove") {
          keepLine = false;
        }
        if (extraLines.length > 0) {
          for (const line of extraLines) {
            debug(
              `      - ${chalk.green("add".padStart(6, " "))} ${line.key}: ${line.value.slice(
                0,
                100
              )}`
            );
          }

          lineBuffer[lineSize++] = extraLines
            .map((extraLine) => `        "${extraLine.key}": "${extraLine.value}",\n`)
            .join("");
        }
      });
    }
    if (keepLine) {
      lineBuffer[lineSize++] = `${line}\n`;
    }
    if (lineSize >= BUFFER_LINE_SIZE) {
      outStream.write(lineBuffer.slice(0, lineSize).join(""));
      lineSize = 0;
    }
  });
  if (lineSize >= 0) {
    outStream.write(lineBuffer.slice(0, lineSize).join(""));
    lineSize = 0;
  }
  await outFile.close();
}
