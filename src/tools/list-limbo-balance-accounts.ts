// This script is expected to run against a parachain network (using launch.ts script)
import { bnMax } from "@polkadot/util";
import { table } from "table";
import Web3 from "web3";
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../index";
import { getAccountIdentity } from "../utils/monitoring";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
  }).argv;

const main = async () => {
  // Instantiate Api
  const api = await getApiFor(argv);
  const blockHash = await api.rpc.chain.getBlockHash();
  const apiAt = await api.at(blockHash);

  const allLocks = await apiAt.query.balances.locks.entries();

  const addressesToCheck: string[] = [];

  allLocks.map((lock) => {
    if (lock[1].length > 0) {
      addressesToCheck.push(`0x${lock[0].toHex().slice(-40)}`);
    }
  });

  const systemAccounts = await apiAt.query.system.account.multi(addressesToCheck);

  const identities = await Promise.all(addressesToCheck.map((d) => getAccountIdentity(api, d)));

  const affectedAccounts = [];
  systemAccounts.map(async ({ data: { free, reserved, frozen } }, idx) => {
    if (free.lt(frozen)) {
      const _transferableNew = free.add(reserved).sub(bnMax(reserved, frozen));
      affectedAccounts.push([
        addressesToCheck[idx],
        identities[idx],
        Web3.utils.fromWei(free.toString(), "ether"),
        Web3.utils.fromWei(reserved.toString(), "ether"),
        Web3.utils.fromWei(frozen.toString(), "ether"),
        Web3.utils.fromWei(frozen.sub(free).toString(), "ether"),
      ]);
    }
  });

  const tableData = (
    [
      ["Account", "Identity", "Free", "Reserved", "Frozen", "Negative Transferable Balance"],
    ] as any[]
  ).concat(affectedAccounts);

  console.log(`preparing the table: ${tableData.length} entries`);
  console.log(
    table(tableData, {
      drawHorizontalLine: (lineIndex: number) =>
        lineIndex === 0 || lineIndex === 1 || lineIndex === tableData.length,
      columns: [
        { alignment: "left" },
        { alignment: "left" },
        { alignment: "left" },
        { alignment: "right" },
        { alignment: "right" },
      ],
    }),
  );
  await api.disconnect();
};

main();
