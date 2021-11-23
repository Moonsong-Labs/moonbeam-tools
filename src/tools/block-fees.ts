// This script is expected to run against a parachain network (using launch.ts script)
import yargs from "yargs";

import { DispatchInfo } from "@polkadot/types/interfaces";

import { exploreBlockRange, getApiFor, NETWORK_YARGS_OPTIONS } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    from: {
      type: "number",
      description: "from block number (included)",
    },
    to: {
      type: "number",
      description: "to block number (included)",
    },
    verbose: {
      type: "boolean",
      default: false,
      description: "display every tx fees",
    },
  }).argv;

const printMOVRs = (value: bigint, decimals = 4) => {
  const power = 10n ** (18n - BigInt(decimals));
  const decimal_power = 10 ** decimals;
  if (decimals > 0) {
    return (Number(value / power) / decimal_power).toFixed(decimals).padStart(3 + decimals, " ");
  }
  return (value / power).toString().padStart(3, " ");
};

const main = async () => {
  const api = await getApiFor(argv);

  const toBlockNumber = argv.to || (await api.rpc.chain.getBlock()).block.header.number.toNumber();
  const fromBlockNumber = argv.from || toBlockNumber;

  console.log(`========= Checking block ${fromBlockNumber}...${toBlockNumber}`);
  let sumBlockFees = 0n;
  let sumBlockBurnt = 0n;
  let blockCount = 0;

  const fromPreBlockHash = (await api.rpc.chain.getBlockHash(fromBlockNumber - 1)).toString();
  const fromPreSupply = await (await api.at(fromPreBlockHash)).query.balances.totalIssuance();
  let previusBlockHash = fromPreBlockHash;
  await exploreBlockRange(
    api,
    { from: fromBlockNumber, to: toBlockNumber, concurrency: 5 },
    async (blockDetails) => {
      blockCount++;
      let blockFees = 0n;
      let blockBurnt = 0n;

      for (const { events, extrinsic, fee } of blockDetails.txWithEvents) {
        // This hash will only exist if the transaction was executed through ethereum.
        let ethereumAddress = "";

        if (extrinsic.method.section == "ethereum") {
          // Search for ethereum execution
          events.forEach((event) => {
            if (event.section == "ethereum" && event.method == "Executed") {
              ethereumAddress = event.data[0].toString();
            }
          });
        }

        let txFees = 0n;
        let txBurnt = 0n;
        for (const event of events) {
          if (
            event.section == "system" &&
            (event.method == "ExtrinsicSuccess" || event.method == "ExtrinsicFailed")
          ) {
            const dispatchInfo =
              event.method == "ExtrinsicSuccess"
                ? (event.data[0] as DispatchInfo)
                : (event.data[1] as DispatchInfo);
            if (
              dispatchInfo.paysFee.isYes &&
              (!extrinsic.signer.isEmpty || extrinsic.method.section == "ethereum")
            ) {
              if (extrinsic.method.section == "ethereum") {
                txFees =
                  (dispatchInfo.weight.toBigInt() *
                    (extrinsic.method.args[0] as any).gasPrice.toBigInt()) /
                  25000n;
              } else {
                txFees = fee.partialFee.toBigInt();
              }
              txBurnt += (txFees * 80n) / 100n; // 20% goes to treasury

              blockFees += txFees;
              blockBurnt += txBurnt;

              const origin = extrinsic.signer.isEmpty
                ? ethereumAddress
                : extrinsic.signer.toString();

              const fromBalance = await (
                await api.at(previusBlockHash)
              ).query.system.account(origin);
              const toBalance = await (
                await api.at(blockDetails.block.hash)
              ).query.system.account(origin);

              if (argv.verbose) {
                console.log(
                  ` ${extrinsic.method.section == "ethereum" ? "[Eth]" : "[Sub]"}${
                    event.method == "ExtrinsicSuccess" ? "(✔)" : "(X)"
                  }${origin.toString()}: ${txFees.toString().padStart(19, " ")} (${printMOVRs(
                    txFees,
                    5
                  )})} (Balance: ${(toBalance.data.free.toBigInt() - fromBalance.data.free.toBigInt()).toString().padStart(20, " ")})`
                );
              }
            }
          }
        }
        // This is for bug detection when the fees are not matching the expected value
        for (const event of events) {
          if (event.section == "treasury" && event.method == "Deposit") {
            const deposit = (event.data[0] as any).toBigInt();
            if (txFees - txBurnt !== deposit) {
              console.log(`treasury: ${(txFees - txBurnt).toString().padStart(30, " ")}`);
              console.log(` deposit: ${deposit.toString().padStart(30, " ")}`);
            }
          }
        }
      }
      sumBlockFees += blockFees;
      sumBlockBurnt += blockBurnt;
      console.log(
        `#${blockDetails.block.header.number} Fees : ${printMOVRs(blockFees, 4)} MOVRs`
      );
      previusBlockHash = blockDetails.block.hash.toString();
    }
  );
  console.log(
    `Total blocks : ${blockCount}, ${printMOVRs(
      sumBlockFees / BigInt(blockCount),
      4
    )}/block, ${printMOVRs(sumBlockFees, 4)} Total`
  );

  const toBlockHash = (await api.rpc.chain.getBlockHash(toBlockNumber)).toString();
  const toSupply = await (await api.at(toBlockHash)).query.balances.totalIssuance();

  console.log(
    `  supply diff: ${(fromPreSupply.toBigInt() - toSupply.toBigInt())
      .toString()
      .padStart(30, " ")}`
  );
  console.log(`        burnt: ${sumBlockBurnt.toString().padStart(30, " ")}`);
  console.log(`         fees: ${sumBlockFees.toString().padStart(30, " ")}`);

  await api.disconnect();
};

main();
