// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";
import { Knex, knex } from "knex";
import sqlite3 from "sqlite3";

import "@moonbeam-network/api-augment";

import type { u128 } from "@polkadot/types";
import type {
  EthereumTransactionTransactionV2,
  PalletCollectiveVotes,
} from "@polkadot/types/lookup";
import type {
  DispatchInfo,
  LegacyTransaction,
  ParachainInherentData,
  AccountId20,
} from "@polkadot/types/interfaces";

import { printTokens, promiseWhile, getBlockDetails, getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const debug = require("debug")("indexer:fee");

const WEIGHT_PER_GAS = 1_000_000_000_000n / 40_000_000n;

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
    first: {
      type: "number",
      description: "Number of block to start indexing (default: 1)",
    },
    blocks: {
      type: "number",
      description: "Number of block",
      default: 2000,
      demandOption: true,
    },
    concurrency: {
      type: "number",
      description: "number of concurrent requests",
      default: 10,
      demandOption: true,
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
}, 1800000);

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

  const config: Knex.Config = {
    client: argv.client,
    connection:
      argv.client == "sqlite3"
        ? ({
            filename: `./db-fee.${runtimeName}.${paraId}.db`,
            mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            useNullAsDefault: true,
          } as any)
        : argv.connection,
  };

  console.log(`Using database ${argv.client}`);
  const db = knex(config);

  //Initialize
  const createTxDbQuery = `CREATE TABLE IF NOT EXISTS extrinsics (
    extrinsic_id VARCHAR(255) PRIMARY KEY,
    block_number INTEGER,
    bytes INTEGER,
    section TEXT,
    method TEXT,
    success BOOL,
    pay_fee BOOL,
    weight NUMERIC,
    partial_fee NUMERIC,
    treasury_deposit NUMERIC,
    fee NUMERIC,
    runtime INTEGER,
    collator_mint NUMERIC
  );`;
  const indexTxDbQuery = `CREATE INDEX IF NOT EXISTS idx_extrinsics_block on extrinsics(block_number);`;

  const createBlockDbQuery = `CREATE TABLE IF NOT EXISTS blocks (
    block_number INTEGER PRIMARY KEY,
    weight NUMERIC,
    treasury_deposit NUMERIC,
    treasury_amount NUMERIC,
    total_issuance NUMERIC,
    fee NUMERIC,
    runtime INTEGER,
    created_at ${argv.client == "sqlite3" ? "DATETIME" : "TIMESTAMP"}
  );`;
  const indexblockRuntimeDbQuery = `CREATE INDEX IF NOT EXISTS idx_blocks_runtime on blocks(runtime);`;
  const indexblockCreatedAtDbQuery = `CREATE INDEX IF NOT EXISTS idx_blocks_created_at on blocks(created_at);`;

  try {
    await db.raw(createTxDbQuery);
    await db.raw(indexTxDbQuery);
    await db.raw(createBlockDbQuery);
    await db.raw(indexblockRuntimeDbQuery);
    await db.raw(indexblockCreatedAtDbQuery);
  } catch (e) {
    console.trace(e);
    process.exit(1);
  }

  // Retrieve latest known block to resume operation.
  // If a block was partially processed already, the block table wouldn't be updated and
  // that given block would get processed again (extrinsic are unique so no duplicates)
  const latestKnownBlock =
    (await db.select("block_number").table("blocks").orderBy("block_number", "desc").limit(1))?.[0]
      ?.block_number || 0;

  console.log(`Latest known block: ${latestKnownBlock}`);

  let fromBlockNumber: number;
  if (argv.first !== undefined && argv.first !== null) {
    fromBlockNumber = argv.first;
  } else if (latestKnownBlock != 0) {
    fromBlockNumber = latestKnownBlock + 1;
  } else {
    fromBlockNumber = 1;
  }
  console.log(` Starting at block: ${fromBlockNumber}`);

  // Set to and from block numbers
  const toBlockNumber = (await api.rpc.chain.getBlock()).block.header.number.toNumber() - 1;

  if (toBlockNumber < fromBlockNumber) {
    return;
  }

  console.log(`========= Checking block ${fromBlockNumber}...${toBlockNumber}`);
  let sumBlockFees = 0n;
  let sumBlockBurnt = 0n;
  let blockCount = 0;

  // Get from block hash and totalSupply
  const fromPreBlockHash = (await api.rpc.chain.getBlockHash(fromBlockNumber - 1)).toString();
  const fromPreSupply = await (await api.at(fromPreBlockHash)).query.balances.totalIssuance();

  // Get to block hash and totalSupply
  const toBlockHash = (await api.rpc.chain.getBlockHash(toBlockNumber)).toString();
  const toSupply = await (await api.at(toBlockHash)).query.balances.totalIssuance();

  // Load data
  const treasuryAccountId = `0x6d6f646C${(await api.consts.treasury.palletId)
    .toString()
    .slice(2)}0000000000000000`;

  // fetch block information for all blocks in the range

  const indexBlock = async (blockDetails) => {
    try {
      blockCount++;
      let blockFees = 0n;
      let blockBurnt = 0n;
      let blockWeight = 0n;
      let blockTreasure = 0n;
      debug(
        `Processing ${blockDetails.block.header.number.toString()}: ${blockDetails.block.header.hash.toString()}`
      );

      const apiAt = await api.at(blockDetails.block.header.hash);
      const apiPreviousAt = await api.at(blockDetails.block.header.parentHash);

      const upgradeInfo = (await apiAt.query.system.lastRuntimeUpgrade()).unwrap();
      const runtimeVersion = upgradeInfo.specVersion.toNumber();
      const baseFeePerGas =
        runtimeVersion >= 1200 ? (await apiAt.query.baseFee.baseFeePerGas()).toBigInt() : 0n;

      // Might not work on first moonbase runtimes
      const authorId =
        blockDetails.block.extrinsics
          .find((tx) => tx.method.section == "authorInherent" && tx.method.method == "setAuthor")
          ?.args[0]?.toString() ||
        blockDetails.block.header.digest.logs
          .find(
            (l) =>
              l.isPreRuntime && l.asPreRuntime.length > 0 && l.asPreRuntime[0].toString() == "nmbs"
          )
          ?.asPreRuntime[1]?.toString();

      // Stores if a member did vote for the same proposal in the same block
      const hasMemberVoted: {
        [accountId: string]: { proposal: { [proposalKey: string]: true } };
      } = {};

      // iterate over every extrinsic
      for (const index of blockDetails.txWithEvents.keys()) {
        const { events, extrinsic, fees } = blockDetails.txWithEvents[index];
        // This hash will only exist if the transaction was executed through ethereum.

        let txFees = 0n;
        let txBurnt = 0n;
        let collatorDeposit = 0n;

        // For every extrinsic, iterate over every event and search for ExtrinsicSuccess or ExtrinsicFailed
        const extrinsicResult = events.find(
          (event) =>
            event.section == "system" &&
            (event.method == "ExtrinsicSuccess" || event.method == "ExtrinsicFailed")
        );
        const isSuccess = extrinsicResult.method == "ExtrinsicSuccess";

        const dispatchInfo = isSuccess
          ? (extrinsicResult.data[0] as DispatchInfo)
          : (extrinsicResult.data[1] as DispatchInfo);
        debug(`  - Extrinsic ${extrinsic.method.toString()}: ${isSuccess ? "Ok" : "Failed"}`);

        if (
          extrinsic.method.section == "parachainSystem" &&
          extrinsic.method.method == "setValidationData"
        ) {
          // XCM transaction are not extrinsic but consume fees.

          const payload = extrinsic.method.args[0] as ParachainInherentData;
          if (runtimeVersion < 1900) {
            // There is no precise way to compute fees for now:
            events
              .filter((event, index) => event.section == "treasury" && event.method == "Deposit")
              .forEach((depositEvent) => {
                const deposit = (depositEvent.data[0] as u128).toBigInt();
                txFees += deposit * 5n;
                txBurnt += deposit * 4n;
              });
          }
        } else if (
          dispatchInfo.paysFee.isYes &&
          (!extrinsic.signer.isEmpty ||
            extrinsic.method.section == "ethereum" ||
            extrinsic.method.section == "parachainSystem")
        ) {
          // We are only interested in fee paying extrinsics:
          // Either ethereum transactions or signed extrinsics with fees (substrate tx)

          if (extrinsic.method.section == "ethereum") {
            const payload = extrinsic.method.args[0] as EthereumTransactionTransactionV2;
            // For Ethereum tx we caluculate fee by first converting weight to gas
            let gasUsed = dispatchInfo.weight.toBigInt() / WEIGHT_PER_GAS;

            let gasPriceParam = payload.isLegacy
              ? payload.asLegacy?.gasPrice.toBigInt()
              : payload.isEip2930
              ? payload.asEip2930?.gasPrice.toBigInt()
              : payload.isEip1559
              ? // If gasPrice is not indicated, we should use the base fee defined in that block
                payload.asEip1559?.maxFeePerGas.toBigInt() || baseFeePerGas
              : (payload as any as LegacyTransaction).gasPrice.toBigInt();

            let gasLimitParam =
              (payload.isLegacy
                ? payload.asLegacy?.gasLimit.toBigInt()
                : payload.isEip2930
                ? payload.asEip2930?.gasLimit.toBigInt()
                : payload.isEip1559
                ? payload.asEip1559?.gasLimit.toBigInt()
                : (payload as any as LegacyTransaction)?.gasLimit.toBigInt()) || 15000000n;

            let gasBaseFee = payload.isEip1559 ? baseFeePerGas : gasPriceParam;
            let gasTips = payload.isEip1559
              ? payload.asEip1559.maxPriorityFeePerGas.toBigInt() <
                payload.asEip1559.maxFeePerGas.toBigInt() - gasBaseFee
                ? payload.asEip1559.maxPriorityFeePerGas.toBigInt()
                : payload.asEip1559.maxFeePerGas.toBigInt() - gasBaseFee
              : 0n;

            if (isSuccess && runtimeVersion >= 800 && runtimeVersion < 1000) {
              // Bug where an account with balance == gasLimit * fee loses all its balance into fees
              const treasuryDepositEvent = events.find(
                (event, index) => event.section == "treasury" && event.method == "Deposit"
              );
              const treasuryDeposit = (treasuryDepositEvent.data[0] as any).toBigInt();

              if (
                treasuryDeposit !=
                gasUsed * gasPriceParam - (gasUsed * gasPriceParam * 80n) / 100n
              ) {
                gasUsed = gasLimitParam;
              }
            }

            if (payload.isEip1559 && runtimeVersion < 1400) {
              // Bug where maxPriorityFee is added to the baseFee even if over the maxFeePerGas.
              // Is removed in runtime 1400
              gasTips = payload.asEip1559.maxPriorityFeePerGas.toBigInt();
            }
            let gasFee = gasBaseFee + gasTips;

            // Bug where a collator receives unexpected fees ("minted")
            const collatorDepositEvent = events.find(
              (event) =>
                event.section == "balances" &&
                event.method == "Deposit" &&
                authorId == event.data[0].toString()
            );

            if (collatorDepositEvent) {
              const extraFees = payload.isEip1559 ? gasTips : gasFee - baseFeePerGas;
              collatorDeposit = (collatorDepositEvent.data[1] as any).toBigInt();
              // console.log(`collator deposit : ${collatorDeposit.toString().padStart(30, " ")}`);

              if (collatorDeposit !== extraFees * gasUsed) {
                console.log(
                  `[Bug] Collator Mint Discrepancy: [${blockDetails.block.header.number.toString()}-${index}:` +
                    ` ${extrinsic.method.section.toString()}.${extrinsic.method.method.toString()} (${
                      payload.type
                    })- ${runtimeVersion}]`
                );
                console.log(`collator deposit : ${collatorDeposit.toString().padStart(30, " ")}`);
                console.log(`         gasCost : ${gasBaseFee.toString().padStart(30, " ")}`);
                console.log(`          gasFee : ${gasFee.toString().padStart(30, " ")}`);
                console.log(` gasPrice(param) : ${gasPriceParam.toString().padStart(30, " ")}`);
                console.log(
                  `    priority fee : ${
                    payload.isEip1559
                      ? payload.asEip1559.maxPriorityFeePerGas
                          .toBigInt()
                          .toString()
                          .padStart(30, " ")
                      : ""
                  }`
                );
                console.log(
                  `         max fee : ${
                    payload.isEip1559
                      ? payload.asEip1559.maxFeePerGas.toBigInt().toString().padStart(30, " ")
                      : ""
                  }`
                );
                console.log(`         gasUsed : ${gasUsed.toString().padStart(30, " ")}`);
                console.log(
                  `            fees : ${(gasUsed * gasBaseFee).toString().padStart(30, " ")}`
                );
                console.log(`       extraFees : ${extraFees.toString().padStart(30, " ")}`);
                console.log(
                  `   expected mint : ${(extraFees * gasUsed).toString().padStart(30, " ")}`
                );
                console.log(extrinsic.toHex());
                process.exit(1);
              }
            }

            // Bug where invalidNonce Tx could get included
            txFees = isSuccess ? gasUsed * gasFee : 0n;

            // 20% of Ethereum fees goes to treasury (after runtime 800)
            txBurnt = runtimeVersion >= 800 ? (txFees * 80n) / 100n : txFees;
          } else {
            let payFees = true;
            if (
              extrinsic.method.section == "parachainSystem" &&
              extrinsic.method.method == "enactAuthorizedUpgrade" &&
              isSuccess
            ) {
              // No fees to pay if successfully enacting an authorized upgrade
              payFees = false;
            } else if (extrinsic.method.section == "sudo") {
              // No fees to pay if sudo
              payFees = false;
            } else if (
              extrinsic.method.section == "evm" &&
              extrinsic.method.method == "hotfixIncAccountSufficients"
            ) {
              // No fees to pay if sudo
              payFees = runtimeVersion < 1500;
            } else if (
              // Vote for collective doesn't pay fee if it is the first vote for an account for the given proposal
              ["councilCollective", "techCommitteeCollective", "techComitteeCollective"].includes(
                extrinsic.method.section
              ) &&
              isSuccess
            ) {
              if (extrinsic.method.method == "close") {
                const disapproved = events.find((event) => event.method == "Disapproved");
                // No fees are paid if collective disapproved the proposal
                payFees = !disapproved;
              }
              if (extrinsic.method.method == "vote") {
                const votedEvent = events.find((event) => event.method == "Voted");
                const account = votedEvent.data[0] as AccountId20;
                const hash = (extrinsic.method.args[0] as any).toString();
                // combine the committee type with the hash to make it unique.
                const hashKey = `${extrinsic.method.section}_${hash}`;
                const votes = (
                  (await apiPreviousAt.query[extrinsic.method.section].voting(hash)) as any
                ).unwrap() as PalletCollectiveVotes;

                const firstVote =
                  !votes.ayes.includes(account) &&
                  !votes.nays.includes(account) &&
                  !hasMemberVoted[account.toString()]?.proposal[hashKey];

                if (!hasMemberVoted[account.toString()]) {
                  hasMemberVoted[account.toString()] = {
                    proposal: {},
                  };
                }
                hasMemberVoted[account.toString()].proposal[hashKey] = true;

                payFees = !firstVote;
              }
            }

            if (payFees) {
              // TODO: add link to formula for totalFees; (see types.ts for now)
              txFees = fees.totalFees;
              txBurnt = (txFees * 80n) / 100n; // 80% goes to burnt (20% - round-up will go to treasury)
            }
          }
          debug(`    Validated`);
        }
        blockWeight += dispatchInfo.weight.toBigInt();
        blockFees += txFees;
        blockBurnt += txBurnt;
        // Then search for Deposit event from treasury
        // This is for bug detection when the fees are not matching the expected value
        const treasureDepositEvents = events.filter(
          (event) => event.section == "treasury" && event.method == "Deposit"
        );
        const treasureDeposit = treasureDepositEvents.reduce(
          (p, e) => p + (e.data[0] as any).toBigInt(),
          0n
        );
        blockTreasure += treasureDeposit;

        if (txFees - txBurnt !== treasureDeposit && runtimeVersion >= 1400) {
          console.log(
            `Desposit Amount Discrepancy: [${blockDetails.block.header.number.toString()}-${index}:` +
              ` ${extrinsic.method.section.toString()}.${extrinsic.method.method.toString()} - ${runtimeVersion}]`
          );
          console.log(`     base fees : ${fees.baseFee.toString().padStart(30, " ")}`);
          console.log(` +    len fees : ${fees.lenFee.toString().padStart(30, " ")}`);
          console.log(` + weight fees : ${fees.weightFee.toString().padStart(30, " ")}`);
          console.log(` =  total fees : ${fees.totalFees.toString().padStart(30, " ")}`);
          console.log(`fees not burnt : ${(txFees - txBurnt).toString().padStart(30, " ")}`);
          console.log(`       deposit : ${treasureDeposit.toString().padStart(30, " ")}`);
          console.log(extrinsic.toHex());
          process.exit();
        }

        await db("extrinsics")
          .insert({
            extrinsic_id: `${blockDetails.block.header.number.toNumber()}-${index}`,
            block_number: blockDetails.block.header.number.toNumber(),
            bytes: extrinsic.toU8a().length,
            section: extrinsic.method.section,
            method: extrinsic.method.method,
            success: isSuccess,
            pay_fee: dispatchInfo.paysFee.isYes,
            weight: dispatchInfo.weight.toBigInt().toString(),
            partial_fee: fees.totalFees.toString(),
            treasury_deposit: treasureDeposit.toString(),
            fee: txFees.toString(),
            runtime: runtimeVersion,
            collator_mint: collatorDeposit.toString(),
          })
          .onConflict("extrinsic_id")
          .ignore();
      }

      sumBlockFees += blockFees;
      sumBlockBurnt += blockBurnt;
      console.log(
        `    - ${blockDetails.block.header.number} (${runtimeVersion}) Fees : ${blockFees} - ${sumBlockFees} - ${blockBurnt} - ${sumBlockBurnt}`
      );

      const [previousTreasure, treasure, issuance] = await Promise.all([
        apiPreviousAt.query.system.account(treasuryAccountId).then((d) => d.data.free.toBigInt()),
        apiAt.query.system.account(treasuryAccountId).then((d) => d.data.free.toBigInt()),
        apiAt.query.balances.totalIssuance().then((d) => d.toBigInt()),
      ]);

      if (previousTreasure + blockTreasure !== treasure) {
        console.log(
          `Treasury Amount Discrepancy: [${blockDetails.block.header.number.toString()} [${runtimeVersion}]`
        );
        console.log(`previous treasury: ${previousTreasure.toString().padStart(30, " ")}`);
        console.log(`         treasury: ${treasure.toString().padStart(30, " ")}`);
        console.log(
          `expected treasury: ${(blockTreasure + previousTreasure).toString().padStart(30, " ")}`
        );
        console.log(`    block deposit: ${blockTreasure.toString().padStart(30, " ")}`);
      }

      await db("blocks").insert({
        block_number: blockDetails.block.header.number.toNumber(),
        weight: blockWeight.toString(),
        treasury_deposit: blockTreasure.toString(),
        treasury_amount: treasure.toString(),
        total_issuance: issuance.toString(),
        fee: blockFees.toString(),
        runtime: runtimeVersion,
      });
    } catch (e) {
      console.log(e);
      process.exit(1);
    }
  };

  await promiseWhile(argv.concurrency, (index) => {
    if (fromBlockNumber + index > toBlockNumber) {
      return;
    }
    return async () => {
      const current = index + fromBlockNumber;

      const alreadyIndexed =
        (
          await db
            .select("block_number")
            .table("blocks")
            .where("block_number", "=", current)
            .limit(1)
        )?.length > 0;
      if (alreadyIndexed) {
        return;
      }

      const blockDetails = await api.rpc.chain
        .getBlockHash(current)
        .then((hash) => getBlockDetails(api, hash));
      await indexBlock(blockDetails);
      return true;
    };
  });

  // Print total and average for the block range
  console.log(
    `Total blocks : ${blockCount}, ${printTokens(
      api,
      sumBlockFees / BigInt(blockCount),
      4
    )}/block, ${printTokens(api, sumBlockFees, 4)} Total`
  );

  // Log difference in supply, we should be equal to the burnt fees
  console.log(
    `  supply diff: ${(fromPreSupply.toBigInt() - toSupply.toBigInt())
      .toString()
      .padStart(30, " ")}`
  );
  console.log(`  burnt fees : ${sumBlockBurnt.toString().padStart(30, " ")}`);
  console.log(`  total fees : ${sumBlockFees.toString().padStart(30, " ")}`);

  await db.destroy();
  await api.disconnect();
};

main();
