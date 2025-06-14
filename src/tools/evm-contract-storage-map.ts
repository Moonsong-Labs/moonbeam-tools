// This script is expected to run against a parachain network (using launch.ts script)
import * as web3Utils from "web3-utils";
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../index";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    contract: {
      type: "string",
      description: "address of the contract",
      demandOption: true,
    },
    key: {
      type: "string",
      description: "address of the contract",
      demandOption: true,
    },
    slot: {
      type: "string",
      description: "address of the contract",
      demandOption: true,
    },
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);
  const apiAt = argv.at ? await api.at(await api.rpc.chain.getBlockHash(argv.at)) : api;

  const contractAddress = api.registry.createType("EthereumAccountId", argv.contract).toString();

  const keyHash = web3Utils.sha3(
    `0x${argv.key.slice(2).padStart(64, "0").concat(argv.slot.toString().padStart(64, "0"))}`,
  );
  const contractStorageValue = (await apiAt.query.evm.accountStorages(
    contractAddress,
    keyHash,
  )) as any;

  console.log(`${keyHash}: ${contractStorageValue}`);

  await api.disconnect();
};

main();
