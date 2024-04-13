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
  value: any;
}
export interface LineMeta {
  endWithComma: boolean;
  indentSpaces: number;
}

export type Action = "remove" | "keep";

// The State Manipulator is called for everyline having a value, using the last known key
// Ex:
//   "bootNodes": [
//     "/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWC7wPZMC44rnA9X132J6uAudNQyARQq2rRpmvguD4oz2U",
//     "/ip4/127.0.0.1/tcp/30334/ws/p2p/QmSk5HQbn6LhUwDiNMseVUjuRYhEtYj4aUZ6WfWoGURpdV"
//   ],
// Will execute twice with stateLine: {key: "bootNodes", value: "/ip4/127.0.0.1/...."}
//
// Ex:"0xa686a3043d0adcf2fa655e57bc595": "0x000040bd8b5b936b6c00000000000000"
// Will execute with {key: "0xa686a3043d0adcf2fa655e57bc595", value: "0x000040bd8b5b936b6c00000000000000"}
export interface StateManipulator {
  // Will get executed for each line of the state file during the read phase
  processRead: (line: StateLine) => void;

  // Will get executed after the read phase
  prepareWrite: () => void;

  // Will get executed for each line of the state file during the write phase
  // Can decide to remove/keep the original line and also add extra lines
  processWrite: (
    line: StateLine,
  ) => { action: Action; extraLines?: StateLine[] } | undefined | void;
}

export function encodeStorageKey(module, name) {
  return u8aToHex(u8aConcat(xxhashAsU8a(module, 128), xxhashAsU8a(name, 128)));
}

export function encodeStorageBlake128MapKey(module, name, key) {
  return u8aToHex(
    u8aConcat(xxhashAsU8a(module, 128), xxhashAsU8a(name, 128), blake2AsU8a(key, 128), key),
  );
}

export function encodeStorageBlake128DoubleMapKey(module, name, [key1, key2]) {
  return u8aToHex(
    u8aConcat(
      xxhashAsU8a(module, 128),
      xxhashAsU8a(name, 128),
      blake2AsU8a(key1, 128),
      key1,
      blake2AsU8a(key2, 128),
      key2,
    ),
  );
}

// Read, and parse line by line the raw state file, in a fast way
// Parsing has 2 passes:
// - first, to read only (allowing to prepare data) calling processRead
// - second, to delete/write/update the line calling processWrite
//
// It contains a lot of assumptions about the json file related to
// how substrate output the export-state
// (json is 2-spaces indexed, maximum of 1 key or value per line...)
export async function processState(
  inputFile: string,
  destFile: string,
  manipulators: StateManipulator[],
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
    callback: (line: string, stateLine?: StateLine, meta?: LineMeta) => void,
  ) => {
    const inFile = await fs.open(inputFile, "r");
    const lineReaderPass = readline.createInterface({
      input: inFile.createReadStream({ start: 0 }),
      crlfDelay: Infinity,
    });

    let lastKnownKey = "";
    for await (const line of lineReaderPass) {
      const keyValue = line.split('": ');
      let value: string = null;
      if (keyValue.length == 1) {
        // line is not a traditional key:value (but can be an array value)
        let i = 0;
        for (; i < line.length; i += 2) {
          if (line[i] != " ") {
            break;
          }
        }
        if (line[i] == "]" || line[i] == "}" || line[i] == "{" || line[i] == "[") {
          callback(line, null);
          continue;
        }
        if (line[i] == '"') {
          // string value
          value = line.split('"')[1];
        } else {
          value = line[line.length - 1] == "," ? line.slice(-1).trim() : line.trim();
        }
      } else {
        // Where we have key:value line
        lastKnownKey = keyValue[0].split('"')[1];
        value =
          keyValue[1][0] == '"'
            ? keyValue[1].split('"')[1]
            : keyValue[1][0] == "{" || keyValue[1][0] == "["
              ? null
              : keyValue[1].split(",")[0];
      }
      const endWithComma = line[line.length - 1] == ",";
      let indentSpaces;
      for (indentSpaces = 0; indentSpaces < line.length; indentSpaces += 2) {
        if (line[indentSpaces] != " ") {
          break;
        }
      }

      callback(line, { key: lastKnownKey, value }, { endWithComma, indentSpaces });
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
  await processLines(inputFile, (line, stateLine, lineMeta) => {
    let keepLine = true;
    if (stateLine && stateLine.value) {
      manipulators.map((manipulator) => {
        const result = manipulator.processWrite(stateLine);
        if (!result) {
          return;
        }
        const { action, extraLines } = result;
        debug(
          `      - ${chalk.red(action.padStart(6, " "))} ${stateLine.key}: ${stateLine.value.slice(
            0,
            100,
          )}`,
        );
        if (action == "remove") {
          keepLine = false;
        }
        if (extraLines && extraLines.length > 0) {
          for (const line of extraLines) {
            debug(
              `      - ${chalk.green("add".padStart(6, " "))} ${line.key}: ${line.value
                .toString()
                .slice(0, 100)}`,
            );
          }

          lineBuffer[lineSize++] = extraLines
            .map(
              (extraLine) =>
                `${new Array(lineMeta.indentSpaces).fill(" ").join("")}"${extraLine.key}": ${
                  typeof extraLine.value == "string" ? `"${extraLine.value}"` : `${extraLine.value}`
                },\n`,
            )
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
