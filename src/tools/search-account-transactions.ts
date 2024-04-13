import yargs from "yargs";
import fs from "fs";

import { exploreBlockRange, getApiFor, NETWORK_YARGS_OPTIONS, reverseBlocks } from "..";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    from: {
      type: "number",
      description: "highest block nuimber to start with",
    },
    address: {
      type: "string",
      description: "address to search transaction for",
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);
  if (argv.during && argv.to && argv.from) {
    console.log(`--during is incompatible with --to and --from`);
    process.exit(1);
  }

  const from = argv.from || (await api.rpc.chain.getBlock()).block.header.number.toNumber();

  await reverseBlocks(api, { from: from, concurrency: 50 }, async (blockDetails) => {
    if (blockDetails.block.header.number.toNumber() % 1000 == 0) {
      console.log(`${blockDetails.block.header.number.toNumber()}...`);
    }

    const extrinsics = blockDetails.block.extrinsics.filter(
      (e) => e.signer.toString().toLocaleLowerCase() == argv.address.toLocaleLowerCase(),
    );

    if (extrinsics.length > 0) {
      console.log(`[${blockDetails.block.header.number.toNumber().toString().padStart(9, " ")}`);
      extrinsics.map((e) => {
        console.log(`  --`, e.toHuman());
      });
    }
  });
};

main();
