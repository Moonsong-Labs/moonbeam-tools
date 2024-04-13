import yargs from "yargs";
import "@polkadot/api-augment";

import { getApiFor } from "../utils/networks";
import { getAccountIdentity } from "../utils/monitoring";

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
    at: {
      type: "number",
      description: "Block number to look into",
    },
  }).argv;

const main = async () => {
  const api = await getApiFor(argv);

  const apiAt = argv["at"]
    ? await api.at(await api.rpc.chain.getBlockHash(argv["at"]))
    : await api.at(await api.rpc.chain.getBlockHash());
  const coreSchedules = (await apiAt.query.paraScheduler.scheduled()) as any;
  const validatorGroups = (await apiAt.query.paraScheduler.validatorGroups()) as any;
  const validatorIndices = (await apiAt.query.parasShared.activeValidatorIndices()) as any;
  const validators = (await apiAt.query.session.validators()) as any;
  for (const schedule of coreSchedules) {
    console.log(
      `${schedule.paraId.toString().padStart(4, " ")}: group: ${schedule.groupIdx
        .toString()
        .padStart(3, " ")} - core: ${schedule.core.toString().padStart(3, " ")} - [${(
        await Promise.all(
          validatorGroups[schedule.groupIdx].map(
            async (index) =>
              `${validatorIndices[index].toString().padStart(4, " ")} ${await getAccountIdentity(
                apiAt,
                validators[validatorIndices[index]],
              )}`,
          ),
        )
      ).join(", ")}]`,
    );
  }

  await api.disconnect();
};

async function start() {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

start();
