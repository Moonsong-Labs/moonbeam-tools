import chalk from "chalk";
import yargs from "yargs";

import { getApiFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    networks: {
      type: "array",
      string: true,
      description: "List of known networks to compare (e.g. --networks moonbeam moonriver)",
    },
    urls: {
      type: "array",
      string: true,
      description: "List of websocket urls to compare",
    },
    csv: {
      type: "boolean",
      default: false,
      description: "Output as CSV instead of a table",
    },
  })
  .conflicts("network", "networks")
  .conflicts("url", "urls").argv as any;

const toCamelCase = (name: string): string => {
  // Metadata pallet names are usually in PascalCase without spaces.
  // The polkadot-js section name is the same but with a lowercased first letter.
  if (!name) {
    return name;
  }
  return name.charAt(0).toLowerCase() + name.slice(1);
};

const formatPalletVersion = (version: any): string => {
  if (!version) {
    return "N/A";
  }

  // Try to format common PalletVersion { major, minor, patch } structure
  try {
    const json = version.toJSON ? version.toJSON() : version;
    if (json && typeof json === "object" && "major" in json && "minor" in json && "patch" in json) {
      return `${json.major}.${json.minor}.${json.patch}`;
    }
  } catch {
    // ignore and fallback
  }

  return version.toString();
};

type NetworkTarget = {
  label: string;
  argv: { network?: string; url?: string };
};

const escapeCsv = (value: string): string => {
  const str = value ?? "";
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const main = async () => {
  const targets: NetworkTarget[] = [];

  if (Array.isArray(argv.networks) && argv.networks.length > 0) {
    for (const network of argv.networks as string[]) {
      targets.push({
        label: network,
        argv: { network },
      });
    }
  }

  if (Array.isArray(argv.urls) && argv.urls.length > 0) {
    for (const url of argv.urls as string[]) {
      targets.push({
        label: url,
        argv: { url },
      });
    }
  }

  if (targets.length === 0) {
    // Fallback to single network/url from shared NETWORK_YARGS_OPTIONS
    const singleLabel = (argv.network as string) || (argv.url as string) || "default";
    targets.push({
      label: singleLabel,
      argv: {
        network: argv.network as string | undefined,
        url: argv.url as string | undefined,
      },
    });
  }

  const allPalletNames = new Set<string>();
  const versionsByNetwork: { [label: string]: Map<string, string> } = {};

  for (const target of targets) {
    const api = await getApiFor(target.argv);
    const metadata = api.runtimeMetadata.asLatest;
    const pallets = metadata.pallets;

    const networkMap = new Map<string, string>();

    for (const pallet of pallets) {
      const name = pallet.name.toString();
      const sectionName = toCamelCase(name);

      const section: any = (api.query as any)[sectionName];

      let versionText = "N/A";

      if (section && typeof section.palletVersion === "function") {
        try {
          const version = await section.palletVersion();
          versionText = formatPalletVersion(version);
        } catch (e) {
          const err = e as Error;
          versionText = `Error: ${err && err.message ? err.message : String(e)}`;
        }
      }

      allPalletNames.add(name);
      networkMap.set(name, versionText);
    }

    versionsByNetwork[target.label] = networkMap;

    await api.disconnect();
  }

  const sortedPalletNames = Array.from(allPalletNames).sort((a, b) => a.localeCompare(b));
  const networkLabels = targets.map((t) => t.label);

  if (argv.csv) {
    const headers = ["Pallet", ...networkLabels];
    console.log(headers.map(escapeCsv).join(","));

    for (const palletName of sortedPalletNames) {
      const row = [
        palletName,
        ...networkLabels.map((label) => versionsByNetwork[label]?.get(palletName) ?? "N/A"),
      ];
      console.log(row.map(escapeCsv).join(","));
    }
  } else {
    const headers = ["Pallet", ...networkLabels];
    const rows: string[][] = [];

    for (const palletName of sortedPalletNames) {
      const row = [
        palletName,
        ...networkLabels.map((label) => versionsByNetwork[label]?.get(palletName) ?? "N/A"),
      ];
      rows.push(row);
    }

    const colWidths = headers.map((h, i) =>
      Math.max(
        h.length,
        ...rows.map((r) => (r[i] ? r[i].length : 0)),
      ),
    );

    const formatRow = (cols: string[]) =>
      cols
        .map((c, i) => c.padEnd(colWidths[i], " "))
        .join(" | ");

    console.log(
      chalk.cyan(
        "Pallet versions from runtime storage (aggregated across networks):\n",
      ),
    );

    console.log(formatRow(headers));
    console.log(colWidths.map((w) => "-".repeat(w)).join("-+-"));
    for (const row of rows) {
      // Highlight pallet name column slightly
      const displayRow = [...row];
      displayRow[0] = chalk.yellow(displayRow[0]);
      console.log(formatRow(displayRow));
    }
  }
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


