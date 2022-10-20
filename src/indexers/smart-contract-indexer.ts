// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";
import { Knex, knex } from "knex";
import sqlite3 from "sqlite3";
import axios from "axios";

import "@moonbeam-network/api-augment";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const debug = require("debug")("indexer:smart-contract");

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    verbose: {
      type: "boolean",
      default: false,
      description: "display every tx fees",
    },
    concurrency: {
      type: "number",
      description: "number of concurrent requests",
      default: 10,
      demandOption: true,
    },
    at: {
      type: "number",
      description: "Block number to look into",
    },
    reindex: {
      type: "boolean",
      description: "will reindex all the smart contracts",
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

  // Instantiate Api
  const api = await getApiFor(argv);
  await api.isReady;

  const runtimeName = api.runtimeVersion.specName.toString();
  const paraId = (await api.query.parachainInfo.parachainId()).toNumber();
  const atBlockNumber = argv.at || (await api.rpc.chain.getHeader()).number.toNumber();

  const config: Knex.Config = {
    client: argv.client,
    connection:
      argv.client == "sqlite3"
        ? ({
            filename: `./db-smart-contract.${runtimeName}.${paraId}.at-${atBlockNumber}.db`,
            mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            useNullAsDefault: true,
          } as any)
        : argv.connection,
  };

  console.log(`Using database ${argv.client}`);
  const db = knex(config);

  //Initialize
  const createScDbQuery = `CREATE TABLE IF NOT EXISTS smart_contracts (
    key VARCHAR(138) NOT NULL PRIMARY KEY,
    address VARCHAR(42),
    bytecode TEXT,
    source TEXT,
    name VARCHAR(255),
    compiler_version VARCHAR(255),
    constructor_arguments TEXT,
    erc20 NUMERIC,
    tokens NUMERIC
  );`;

  try {
    await db.raw(createScDbQuery);
  } catch (e) {
    console.trace(e);
    process.exit(1);
  }

  const apiAt = await api.at(await api.rpc.chain.getBlockHash(atBlockNumber));

  let last_key = argv.reindex
    ? undefined
    : (await db.select("key").table("smart_contracts").orderBy("key", "desc").limit(1))?.[0]?.key ||
      undefined;

  const limit = 100;
  console.log(`Querying smart contract from ${last_key || "0"} [limit: ${limit}]`);
  let count = 0;
  const queryNextPage = async () => {
    let query = await apiAt.query.evm.accountCodes.entriesPaged({
      args: [],
      pageSize: limit,
      startKey: last_key,
    });

    if (query.length == 0) {
      return true;
    }
    count += query.length;

    for (const accountCode of query) {
      const address = `0x${accountCode[0].toHex().slice(-40)}`;
      const bytecode = accountCode[1].toHex();
      const key = accountCode[0].toString();

      const sourceData = await axios
        .get(
          `https://api-${runtimeName}.moonscan.io/api?module=contract&action=getsourcecode&address=${address}`
        )
        .then((res) => {
          const jsonResp = res.data;
          if (res.status !== 200 || jsonResp.message != "OK") {
            throw new Error(`Error returned: ${jsonResp.message}`);
          }

          const codeData = jsonResp.result[0];
          // {
          //   "SourceCode":"",
          //   "ABI":"Contract source code not verified",
          //   "ContractName":"",
          //   "CompilerVersion":"",
          //   "OptimizationUsed":"",
          //   "Runs":"",
          //   "ConstructorArguments":"",
          //   "EVMVersion":"Default",
          //   "Library":"",
          //   "LicenseType":"Unknown",
          //   "Proxy":"0",
          //   "Implementation":"",
          //   "SwarmSource":""
          // }
          const { SourceCode, ContractName, CompilerVersion, ConstructorArguments } = codeData;

          return {
            name: ContractName,
            compiler_version: CompilerVersion,
            constructor_arguments: ConstructorArguments,
            source: SourceCode,
          };
        })
        .catch((err) => {
          console.log("Error: ", err.message);
          process.exit(1);
        });

      await db("smart_contracts")
        .insert({
          key,
          ...sourceData,
          bytecode,
          address,
          tokens: (await apiAt.query.system.account(address)).data.free.toBigInt().toString(),
        })
        .onConflict("key")
        .merge();
      console.log(`${address}: ${sourceData.name}`);
      await new Promise((resolve) => setTimeout(resolve, 200));

      last_key = key;
    }

    // Debug logs to make sure it keeps progressing
    if (count % (10 * limit) == 0) {
      debug(`Retrieved ${count} accountCodes`);
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
  await api.disconnect();
};

main();
