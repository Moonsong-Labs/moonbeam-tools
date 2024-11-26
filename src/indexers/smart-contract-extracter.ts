// This script is expected to run against a parachain network (using launch.ts script)
import fs from "fs";
import { Knex, knex } from "knex";
import path from "path";
import sqlite3 from "sqlite3";
import yargs from "yargs";

// Usage:
// bun src/indexers/smart-contract-extracter.ts --client pg --connection postgresql://mws.com/moonbeam_smart_contracts --folder moonbeam-sc
// for v in $(find moonbeam-sc/ -type f -iname "*.sol" -exec grep -o -h '0\.[0-9]\.[0-9][0-9]*' {} \+ | sort | uniq); do solc-select install $v; done

const debug = require("debug")("indexer:smart-contract");

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    verbose: {
      type: "boolean",
      default: false,
      description: "display every tx fees",
    },
    client: {
      type: "string",
      description: "type of database client",
      choices: ["sqlite3", "pg"],
      demandOption: true,
    },
    connection: {
      type: "string",
      description: "path to the database",
    },
    folder: {
      type: "string",
      description: "folder to put solidity contract in",
      demandOption: true,
    },
    file: {
      type: "string",
      description: "path to the sqlite3 database",
    },
  }).argv;

// Prevent getting stuck
setTimeout(() => {
  process.exit(1); // exit=true;
}, 1800000); // 30min

const main = async () => {
  if (argv.client == "pg" && !argv.connection) {
    console.log(`Missing connection parameter for pg database`);
    process.exit(1);
  }
  if (argv.client == "sqlite3" && !argv.file) {
    console.log(`Missing file parameter for sqlite3 database`);
    process.exit(1);
  }

  if (!fs.existsSync(`${argv.folder}`)) {
    fs.mkdirSync(`${argv.folder}`);
  }

  const config: Knex.Config = {
    client: argv.client,
    connection:
      argv.client == "sqlite3"
        ? ({
            filename: argv.file,
            mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            useNullAsDefault: true,
          } as any)
        : argv.connection,
  };

  console.log(`Using database ${argv.client}`);
  const db = knex(config);

  const limit = 100;
  let count = 0;
  const queryNextPage = async () => {
    const data = (await db
      .select("address", "source")
      .table("smart_contracts")
      .where("source", "!=", "")
      .orderBy("key", "asc")
      .limit(limit)
      .offset(count)) as { address: string; source: string }[];

    for (const { address, source } of data) {
      if (!fs.existsSync(`${argv.folder}/${address}`)) {
        fs.mkdirSync(`${argv.folder}/${address}`);
      }
      if (source[0] == "{") {
        try {
          const jsonData = JSON.parse(source[1] == "{" ? source.slice(1, -1) : source);
          const sources = source[1] == "{" ? jsonData.sources : jsonData;
          for (const index in Object.keys(sources)) {
            const name = Object.keys(sources)[index];
            const filePath = path.join(`${argv.folder}/${address}/`, name);
            const sourceCode = sources[Object.keys(sources)[index]].content;
            console.log(`${address}: ${Object.keys(sources)[index]}`);
            if (!fs.existsSync(path.dirname(filePath))) {
              fs.mkdirSync(path.dirname(filePath), { recursive: true });
            }
            fs.writeFileSync(filePath, sourceCode, { flag: "w+" });
          }
        } catch (e) {
          console.log(`Failure on ${argv.folder}/${address}/source.txt`);
          fs.writeFileSync(`${argv.folder}/${address}/source.txt`, source, { flag: "w+" });
          console.log(e);
          return true;
        }
      } else {
        fs.writeFileSync(`${argv.folder}/${address}/main.sol`, source, { flag: "w+" });
      }
    }

    if (data.length != limit) {
      return true;
    }
    count += data.length;

    // Debug logs to make sure it keeps progressing
    if (count % (10 * limit) == 0) {
      debug(`Retrieved ${count} sources`);
    }

    return false;
  };

  await new Promise<void>((resolve) => {
    const run = async () => {
      let done = await queryNextPage();
      if (done) {
        resolve();
      } else {
        setTimeout(run, 100);
      }
    };

    setTimeout(run, 100);
  });

  // Print total and average for the block range
  console.log(`Total smart contracts : ${count}`);

  await db.destroy();
};

main();
