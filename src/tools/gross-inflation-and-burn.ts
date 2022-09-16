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
  let onlyRewards = new BN(0);

  // Get to block hash and totalSupply
  const toBlockHash = (await api.rpc.chain.getBlockHash(toBlockNumber)).toString();
  const toSupply = await (await api.at(toBlockHash)).query.balances.totalIssuance();
  const toTreasuryPre = (await (await api.at(toBlockHash)).query.system.account(TREASURY)).data.free;

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
      for (const event of events) {
        const [account, amount] = event.event.data as any;
        theoreticalSupplyIncrease = theoreticalSupplyIncrease.add(new BN(amount));
      }
    },
    blockNumbers
  );

  const burntFees = new BN(theoreticalSupplyIncrease).sub(toSupply);

  console.log(
    `  supply diff: ${(fromPreSupply.toBigInt() - toSupply.toBigInt())
      .toString()
      .padStart(30, " ")}`
  );
  console.log(`  burnt fees : ${burntFees.toString().padStart(30, " ")}`);
  console.log(`  gross inflation : ${theoreticalSupplyIncrease.toString().padStart(30, " ")}`);
  await api.disconnect();  
};

main();