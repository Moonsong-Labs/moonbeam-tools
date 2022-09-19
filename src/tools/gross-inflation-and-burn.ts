// This script is expected to run against a parachain network (using launch.ts script)
import { ApiPromise, WsProvider } from "@polkadot/api";
import yargs from "yargs";
import { promiseConcurrent, getApiFor } from "..";
import { BN } from "@polkadot/util";

const TREASURY = "0x6d6f646C70792f74727372790000000000000000";
const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    url: {
      type: "string",
      description: "Websocket url",
      string: true,
      demandOption: true,
    },
    from: {
      type: "number",
      description: "from block number (included)",
      demandOption: true,
    },
    to: {
      type: "number",
      description: "to block number (included)",
      demandOption: true,
    },
  }).argv;


const main = async () => {
  const api = await getApiFor(argv);

  const toBlockNumber = argv.to;
  const fromBlockNumber = argv.from;
  // Get from block hash and totalSupply
  const fromPreBlockHash = (await api.rpc.chain.getBlockHash(fromBlockNumber - 1)).toString();
  const fromPreSupply = await (await api.at(fromPreBlockHash)).query.balances.totalIssuance();
  const fromTreasuryPre = (await (await api.at(fromPreBlockHash)).query.system.account(TREASURY)).data.free;

  let theoreticalSupplyIncrease = new BN(fromPreSupply);

  // Get to block hash and totalSupply
  const toBlockHash = (await api.rpc.chain.getBlockHash(toBlockNumber)).toString();
  const toSupply = await (await api.at(toBlockHash)).query.balances.totalIssuance();
  let trappedAmount = new BN(0);

  // Get Pallet balances index
  const metadata = await api.rpc.state.getMetadata();
  const balancesPalletIndex = (metadata.asLatest.toHuman().pallets as Array<any>).find(
    (pallet) => {
      return pallet.name === "Balances";
    }
  ).index;

  console.log(`========= Checking block ${fromBlockNumber}...${toBlockNumber}`);
  let blockNumbers = [];
  for (let i = argv.from; i <= argv.to; i++) {
    blockNumbers.push(i);
  }

  await promiseConcurrent(
    80,
    async (blockNumber) => {
      const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
      const apiAt = await api.at(blockHash);
      const records = (await apiAt.query.system.events()) as any;

      const events = records.filter(
        ({ event }) => event.section == "parachainStaking" && (event.method == "Rewarded" || event.method == "ReservedForParachainBond")
      );
      // AssetTrap events will burn issuance. Hence we need to track them
      const assetTrapEvents = records.filter(
        ({ event }) => event.section == "polkadotXcm" && event.method == "AssetsTrapped"
      );

      for (const event of events) {
        const [account, amount] = event.event.data as any;
        theoreticalSupplyIncrease = theoreticalSupplyIncrease.add(new BN(amount));
      }

      for (const event of assetTrapEvents) {
        const [hash, origin, multiasset] = event.event.data as any;
        // V1 only, we didnt work with v0
        if (multiasset.isV1 && multiasset.asV1[0].id.toString() == `{"concrete":{"parents":0,"interior":{"x1":{"palletInstance":${balancesPalletIndex}}}}}`) {
          trappedAmount = trappedAmount.add(new BN(multiasset.asV1[0].fun.asFungible.toBigInt()))
        }
      }
    },
    blockNumbers
  );

  const burntFees = new BN(theoreticalSupplyIncrease).sub(toSupply).sub(trappedAmount);

  console.log(
    `  supply diff: ${(fromPreSupply.toBigInt() - toSupply.toBigInt())
      .toString()
      .padStart(30, " ")}`
  );
  console.log(`  burnt fees : ${burntFees.toString().padStart(30, " ")}`);
  console.log(`  Trapped amount : ${trappedAmount.toString().padStart(30, " ")}`);
  console.log(`  gross inflation : ${theoreticalSupplyIncrease.toString().padStart(30, " ")}`);
  await api.disconnect();  
};

main();