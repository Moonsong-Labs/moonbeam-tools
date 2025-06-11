import { u8aConcat } from "@polkadot/util";
import { blake2AsU8a, xxhashAsU8a } from "@polkadot/util-crypto";
import chalk from "chalk";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import yargs from "yargs";

import { getViemAccountFor, getViemFor, NETWORK_YARGS_OPTIONS } from "../utils/networks";

import debugPkg from "debug";
const debug = debugPkg("main");

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    ...NETWORK_YARGS_OPTIONS,
    address: {
      type: "number",
      description: "Filter given address",
    },
    "update-dummy-code": {
      type: "boolean",
      description: "Updates the dummy contract code",
    },
    "private-key": {
      type: "string",
      description: "Private key to use to update the dummy code",
    },
  })
  .strict().argv;

const getAddress = (addressNumber: number): `0x${string}` => {
  return `0x${addressNumber.toString(16).padStart(40, "0")}`;
};

const getPrecompileStorageKey = (addressNumber: number) => {
  const address = getAddress(addressNumber);
  return `0x${Buffer.from(
    u8aConcat(
      xxhashAsU8a("EVM", 128),
      xxhashAsU8a("AccountCodes", 128),
      blake2AsU8a(address, 128),
      address,
    ),
  ).toString("hex")}`;
};

const KNOWN_PRECOMPILES = [
  {
    index: 1,
    name: "ECRecover",
  },
  {
    index: 2,
    name: "Sha256",
  },
  {
    index: 3,
    name: "ShRipemd160a256",
  },
  {
    index: 4,
    name: "Identity",
  },
  {
    index: 5,
    name: "Modexp",
  },
  {
    index: 6,
    name: "Bn128Add",
  },
  {
    index: 7,
    name: "Bn128Mul",
  },
  {
    index: 8,
    name: "Bn128Pairing",
  },
  {
    index: 9,
    name: "Blake2F",
  },
  {
    index: 1024,
    name: "Sha3FIPS256",
  },
  {
    index: 1025,
    name: "Dispatch - generic",
  },
  {
    index: 1026,
    name: "ECRecoverPublicKey",
  },
  {
    index: 2048,
    name: "ParachainStakingWrapper",
  },
  {
    index: 2049,
    name: "CrowdloanRewardsWrapper",
  },
  {
    index: 2050,
    name: "NativeErc20Metadata",
  },
  {
    index: 2051,
    name: "DemocracyWrapper",
  },
  {
    index: 2052,
    name: "XtokensWrapper",
  },
  {
    index: 2053,
    name: "RelayEncoderWrapper",
  },
  {
    index: 2054,
    name: "XcmTransactorWrapper",
  },
  {
    index: 2055,
    name: "AuthorMappingWrapper",
  },
  {
    index: 2056,
    name: "Batch",
  },
  {
    index: 2057,
    name: "RandomnessWrapper",
  },
  {
    index: 2058,
    name: "CallPermit",
  },
  {
    index: 2059,
    name: "ProxyWrapper",
  },
  {
    index: 2060,
    name: "XcmUtilsWrapper",
  },
  {
    index: 2061,
    name: "XcmTransactorWrapperV2",
  },
  {
    index: 2062,
    name: "CouncilInstance",
  },
  {
    index: 2063,
    name: "TechCommitteeInstance",
  },
  {
    index: 2064,
    name: "TreasuryCouncilInstance",
  },
  {
    index: 2065,
    name: "Referenda",
  },
  {
    index: 2066,
    name: "ConvictionVoting",
  },
  {
    index: 2067,
    name: "Preimage",
  },
  {
    index: 2068,
    name: "OpenTechCommittee",
  },
  {
    index: 2069,
    name: "PrecompileRegistry",
  },
];

const main = async () => {
  if (argv["update-dummy-code"] && !argv["private-key"]) {
    console.error("Private key is required to update the dummy code");
    process.exit(1);
  }
  const viem = getViemFor(argv);

  const addresses = argv.address ? [argv.address] : KNOWN_PRECOMPILES.map((p) => p.index);

  const precompileCodes: { [key: string]: boolean } = {};
  for (const addressNumber of addresses) {
    const name = KNOWN_PRECOMPILES.find((p) => p.index == addressNumber)?.name || "";
    const storageKey = getPrecompileStorageKey(addressNumber);
    const code = await viem.getBytecode({ address: getAddress(addressNumber) });
    const hasCode = !!code;
    precompileCodes[addressNumber] = hasCode;
    const color = hasCode ? chalk.green : chalk.red;
    console.log(
      `${color(
        `${(name ? `(${name}) ` : "").padStart(26)}${addressNumber.toString().padEnd(5)}`,
      )} [${storageKey}]: ${hasCode ? code : "None"}`,
    );
  }

  if (argv["update-dummy-code"]) {
    const abiItem = {
      inputs: [{ internalType: "address", name: "a", type: "address" }],
      name: "updateAccountCode",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    };

    const account = privateKeyToAccount(argv["private-key"] as `0x${string}`);
    const wallet = getViemAccountFor(argv, account);
    let nonce = await viem.getTransactionCount({ address: account.address });
    const receipts = (
      await Promise.all(
        addresses.map(async (addressNumber) => {
          if (!precompileCodes[addressNumber]) {
            try {
              const data = encodeFunctionData({
                abi: [abiItem],
                functionName: "updateAccountCode",
                args: [getAddress(addressNumber)],
              });
              const hash = await wallet.sendTransaction({
                chain: null,
                account,
                to: "0x0000000000000000000000000000000000000815",
                data,
                nonce: nonce++,
                gas: 200000n,
              });
              console.log(`Updating precompile ${addressNumber}: ${hash}...`);
              return { addressNumber, hash };
            } catch (err) {
              debug(err);
              console.log(
                `Failed to update precompile ${addressNumber}: ${
                  err.details || err.message || err
                }}`,
              );
              return null;
            }
          }
          return null;
        }),
      )
    ).filter((data) => !!data);
    console.log(`Waiting for receipts...${receipts.length}`);
    await Promise.all(
      receipts.map(async ({ hash, addressNumber }) => {
        if (!hash) {
          return;
        }
        const receipt = await viem.waitForTransactionReceipt({ hash });
        console.log(
          `|${addressNumber.toString().padStart(5, " ")}] ${
            receipt.status
          } - ${hash} (#${receipt.gasUsed.toString()})`,
        );
      }),
    );
    console.log(`Done`);
  }
  (await viem.transport.getSocket()).close();
};

main();
