import assert from "node:assert/strict";
import { exec as execProcess } from "child_process";
import util from "node:util";
import fs from "fs";
import { setTimeout } from "timers/promises";

import { EvmCoreErrorExitReason } from "@polkadot/types/lookup";
import solc from "solc";
import "@polkadot/api-augment";
import "@moonbeam-network/api-augment";
import { ApiTypes, SubmittableExtrinsic } from "@polkadot/api/types";
import { SubmittableExtrinsic as SubmittableExtrinsicPromise } from "@polkadot/api/promise/types";
import { DispatchError, EventRecord } from "@polkadot/types/interfaces";
import Keyring from "@polkadot/keyring";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { u8aToHex, BN, BN_BILLION, BN_MILLION } from "@polkadot/util";
import { JsonRpcResponse } from "web3-core-helpers";
import { ethers } from "ethers";
import { Contract } from "web3-eth-contract";
import Web3 from "web3";
import * as RLP from "rlp";
import yargs from "yargs";
import { AccessListish } from "ethers/lib/utils";
import {
  ALITH_PRIVATE_KEY,
  BALTATHAR_ADDRESS,
  BALTATHAR_PRIVATE_KEY,
  CHARLETH_ADDRESS,
  CHARLETH_PRIVATE_KEY,
} from "../utils/constants";

const httpUrl = "http://127.0.0.1:9933";
const wssUrl = "ws://127.0.0.1:9944";

const exec = util.promisify(execProcess);
const ethersApi = new ethers.providers.JsonRpcProvider(httpUrl);
const keyringEth = new Keyring({ type: "ethereum" });
export const alith = keyringEth.addFromUri(ALITH_PRIVATE_KEY);
export const baltathar = keyringEth.addFromUri(BALTATHAR_PRIVATE_KEY);
export const charleth = keyringEth.addFromUri(CHARLETH_PRIVATE_KEY);
const web3 = new Web3(wssUrl);
web3.eth.accounts.wallet.add(ALITH_PRIVATE_KEY);

/**
 * This test assumes the following:
 *  + moonbeam
 *    - EVM calls are unfiltered.
 *        NormalFilter - Call::EVM(_) => true
 *    - EVM origin is allowed for all.
 *        type CallOrigin = EnsureAddressAlways;
 *        impl<OuterOrigin> EnsureAddressOrigin<OuterOrigin> for EnsureAddressAlways {
 *           type Success = ();
 *
 *           fn try_address_origin(
 *                   _address: &H160,
 *                   _origin: OuterOrigin,
 *           ) -> Result<Self::Success, OuterOrigin> {
 *                   Ok(())
 *           }
 *
 *           fn ensure_address_origin(
 *                   _address: &H160,
 *                   _origin: OuterOrigin,
 *           ) -> Result<Self::Success, sp_runtime::traits::BadOrigin> {
 *                   Ok(())
 *           }
 *        }
 *  + frontier
 *    - Baltathar pays no EVM fees and full substrate fees, while Charleth pays the opposite.
 *        let baltathar_addr = H160::from_str("0x3cd0a705a2dc65e5b1e1205896baa2be8a07c6e0").unwrap();
 *        let (validate, payable) = if source == baltathar_addr {
 *                (false, Pays::Yes)
 *        } else {
 *                (true, Pays::No)
 *        };
 *
 * Then start the node with the following command
 * ./target/release/moonbeam \
 *    --execution=Native \
 *    --wasm-execution=interpreted-i-know-what-i-do \
 *    --ethapi=txpool \
 *    --no-hardware-benchmarks \
 *    --no-telemetry \
 *    --no-prometheus \
 *    --force-authoring \
 *    --rpc-cors=all \
 *    --alice \
 *    --chain=moonbase-dev \
 *    --sealing=manual \
 *    --in-peers=0 \
 *    --out-peers=0 -linfo \
 *    --port=5502 \
 *    --rpc-port=25502 \
 *    --ws-port=45502 \
 *    --tmp
 * 
 * Examples:
 *  ts-node ./src/tools/fees.ts --name fees --type compute
 *  ts-node ./src/tools/fees.ts --name fees --type length-small
 *  ts-node ./src/tools/fees.ts --name fees --type length-big
 * 
 * The result will open in the browser once done
 */

/// === test methods === ///

const TESTER_CONTRACT = `// SPDX-License-Identifier: GPL-3.0-only
 pragma solidity >=0.8.3;
 
 contract Tester {
  
    uint256 public count;
 
    function infinite() public pure {
        while (true) {}
    }
 
    function incrementalLoop(uint256 n) public {
        uint256 i = 0;
        while (i < n) {
            count = count + 1;
            i += 1;
        }
    }
 
    function bigData(bytes memory b) public {
      // do nothing  
    }
 }`;
const TESTER_JSON = compileSolidity(TESTER_CONTRACT);
const TESTER_INTERFACE = new ethers.utils.Interface(TESTER_JSON.contract.abi);

async function runTest(api: ApiPromise, callType: "compute" | "length-small" | "length-big") {
  const result = [];
  console.log("callType", callType);
  let contractAddr = "0xc01Ee7f10EA4aF4673cFff62710E1D7792aBa8f3";

  // override nextFeeMultiplier if needed, note that its value will change immediately after block creation
  const nextFeeMultiplierOverride = null;
  if (nextFeeMultiplierOverride) {
    await createBlock(api, [
      await api.tx.balances.transfer(contractAddr, 0).signAsync(alith),
      await api.tx.sudo
        .sudo(
          await api.tx.system
            .setStorage([
              [
                "0x3f1467a096bcd71a5b6a0c8155e208103f2edf3bdf381debe331ab7446addfdc",
                u8aToHex(api.createType("u128", nextFeeMultiplierOverride).toU8a()),
              ],
            ])
            .signAsync(alith)
        )
        .signAsync(alith),
    ]);
  } else {
    const nextFeeMultiplier = await api.query.transactionPayment.nextFeeMultiplier();
    assert.equal(
      nextFeeMultiplier.toString(),
      "1000000000000000000",
      "nextFeeMultiplier is not at its base value"
    );
    console.log("nextFeeMul", nextFeeMultiplier.toString());
  }

  // deploy contract
  const maxBlockWeight = api.consts.system.blockWeights.maxBlock.toBn();
  const blockNumber = (await api.rpc.chain.getBlock()).block.header.number.toNumber();
  if (blockNumber === 0) {
    const { contract, rawTx } = await createContract(TESTER_JSON, {
      ...ALITH_TRANSACTION_TEMPLATE,
      gas: 900_000,
      gasPrice: 1_250_000_000,
    });
    assert.equal(await createBlock(api, rawTx), true, "failure during block creation");
    await expectEVMSuccess(api);
    console.log("addr", contract.options.address);
    contractAddr = contract.options.address;
  }

  // use the specified call type
  const contractCall = (() => {
    switch (callType) {
      case "compute":
        return TESTER_INTERFACE.encodeFunctionData("incrementalLoop", [1000]);
      case "length-small":
        return TESTER_INTERFACE.encodeFunctionData("bigData", [new Array(100).fill(0x01)]);
      case "length-big":
        return TESTER_INTERFACE.encodeFunctionData("bigData", [new Array(50 * 1024).fill(0x01)]);
      default:
        throw new Error(`invalid callType ${callType}`);
    }
  })();

  // start load test
  const loadFactors = [...generateLoad(60, 2), ...Array(10).fill(0)];
  const repsPerLoad = 30;
  for await (const loadFactor of loadFactors) {
    console.log(`load: ${loadFactor} (${repsPerLoad} reps)`);
    for await (const rep of new Array(repsPerLoad).keys()) {
      const multiplierBefore = await api.query.transactionPayment.nextFeeMultiplier();
      const fees = await txObserveFeeDiff(api, async () => {
        const txs = [
          // fill block
          await api.tx.sudo
            .sudo(await api.tx.system.fillBlock(loadFactor * 10_000_000).signAsync(alith))
            .signAsync(alith),

          // charge substrate fees
          await api.tx.evm
            .call(baltathar.address, contractAddr, contractCall, 0, 900_000n, 0n, null, null, [])
            .signAsync(baltathar),

          // charge EVM fees
          await api.tx.evm
            .call(
              charleth.address,
              contractAddr,
              contractCall,
              0,
              900_000n,
              2_000_000_000n,
              null,
              null,
              []
            )
            .signAsync(charleth),
        ];

        return txs;
      });

      // compute block weight, from events
      const events = await api.query.system.events();
      let totalBlockWeight = new BN(0);
      for (const event of events) {
        if (api.events.system.ExtrinsicSuccess.is(event.event)) {
          totalBlockWeight = totalBlockWeight.add(event.event.data.dispatchInfo.weight.toBn());
        }
      }
      const multiplierAfter = await api.query.transactionPayment.nextFeeMultiplier();

      result.push({
        fullPercent: totalBlockWeight.muln(100).div(maxBlockWeight).toNumber(),
        ...fees,
        multiplier: {
          before: multiplierBefore.toString(),
          after: multiplierAfter.toString(),
        },
        block: (await api.rpc.chain.getBlock()).block.header.number.toNumber(),
      });
    }
  }

  return result;
}

function generateLoad(middle: number, inc: number = 1): number[] {
  const load = [];
  for (let i = 0; i <= middle; i += inc) {
    load.push(i);
  }
  for (let i = middle; i >= 0; i -= inc) {
    load.push(i);
  }

  return load;
}

async function txObserveFeeDiff(
  api: ApiPromise,
  txFunc: () => Promise<SubmittableExtrinsicPromise[]>
) {
  const txs = await txFunc();
  const balanceBeforeBaltathar = await api.query.system.account(BALTATHAR_ADDRESS);
  const balanceBeforeCharleth = await api.query.system.account(CHARLETH_ADDRESS);
  await createBlock(api, txs);
  const balanceAfterBaltathar = await api.query.system.account(BALTATHAR_ADDRESS);
  const balanceAfterCharleth = await api.query.system.account(CHARLETH_ADDRESS);

  return {
    substrate: balanceBeforeBaltathar.data.free.sub(balanceAfterBaltathar.data.free).toString(),
    evm: balanceBeforeCharleth.data.free.sub(balanceAfterCharleth.data.free).toString(),
  };
}

/// === block creation methods === ///

async function expectEVMSuccess(api: ApiPromise) {
  const events = await api.query.system.events();
  const ethereumResult = events.find(
    ({ event: { section, method } }) => section == "ethereum" && method == "Executed"
  ).event.data[3] as EvmCoreErrorExitReason;
  assert.equal(ethereumResult.isSucceed, true, "EVM operation failed");
}

function extractError(events: EventRecord[] = []): DispatchError | undefined {
  return events
    .filter(({ event }) => "system" === event.section && ["ExtrinsicFailed"].includes(event.method))
    .map(
      ({
        event: {
          data: [dispatchError],
        },
      }) => dispatchError as DispatchError
    )[0];
}

async function customWeb3Request(web3: Web3, method: string, params: any[]) {
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    (web3.currentProvider as any).send(
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      },
      (error: Error | null, result?: JsonRpcResponse) => {
        if (error) {
          reject(
            `Failed to send custom request (${method} (${params
              .map((p) => {
                const str = p.toString();
                return str.length > 128 ? `${str.slice(0, 96)}...${str.slice(-28)}` : str;
              })
              .join(",")})): ${error.message || error.toString()}`
          );
        }
        resolve(result);
      }
    );
  });
}

interface BlockCreation {
  parentHash?: string;
  finalize?: boolean;
}
type ExtrinsicCreation = boolean;
async function createBlock<
  ApiType extends ApiTypes,
  Call extends
    | SubmittableExtrinsic<ApiType>
    | Promise<SubmittableExtrinsic<ApiType>>
    | string
    | Promise<string>,
  Calls extends Call | Call[]
>(api: ApiPromise, transactions?: Calls, options: BlockCreation = {}) {
  const results: ({ type: "eth"; hash: string } | { type: "sub"; hash: string })[] = [];
  const txs =
    transactions == undefined ? [] : Array.isArray(transactions) ? transactions : [transactions];
  for await (const call of txs) {
    if (typeof call == "string") {
      // Ethereum
      results.push({
        type: "eth",
        hash: (await customWeb3Request(web3, "eth_sendRawTransaction", [call])).result,
      });
    } else if (call.isSigned) {
      results.push({
        type: "sub",
        hash: (await call.send()).toString(),
      });
    } else {
      results.push({
        type: "sub",
        hash: (await call.signAndSend(alith)).toString(),
      });
    }
  }

  const { parentHash, finalize } = options;
  const block = parentHash
    ? await api.rpc.engine.createBlock(true, finalize, parentHash)
    : await api.rpc.engine.createBlock(true, finalize);
  const blockHash = block.get("hash").toString();

  // No need to extract events if no transactions
  if (results.length == 0) {
    return {
      block,
      result: null,
    };
  }

  // We retrieve the events for that block
  const allRecords: EventRecord[] = (await (await api.at(blockHash)).query.system.events()) as any;
  // We retrieve the block (including the extrinsics)
  const blockData = await api.rpc.chain.getBlock(blockHash);

  const result: ExtrinsicCreation[] = results.map((result) => {
    const extrinsicIndex =
      result.type == "eth"
        ? allRecords
            .find(
              ({ phase, event: { section, method, data } }) =>
                phase.isApplyExtrinsic &&
                section == "ethereum" &&
                method == "Executed" &&
                data[2].toString() == result.hash
            )
            ?.phase?.asApplyExtrinsic?.toNumber()
        : blockData.block.extrinsics.findIndex((ext) => ext.hash.toHex() == result.hash);
    // We retrieve the events associated with the extrinsic
    const events = allRecords.filter(
      ({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.toNumber() === extrinsicIndex
    );
    const failure = extractError(events);
    const successful = extrinsicIndex !== undefined && !failure;
    return successful;
  });

  // Adds extra time to avoid empty transaction when querying it
  if (results.find((r) => r.type == "eth")) {
    await setTimeout(2);
  }

  return Array.isArray(transactions) ? result : (result[0] as boolean);
}

const ALITH_TRANSACTION_TEMPLATE: TransactionOptions = {
  from: alith.address,
  privateKey: ALITH_PRIVATE_KEY,
  nonce: null,
  gas: 500_000,
  gasPrice: 1_000_000_000,
  value: "0x00",
};
interface TransactionOptions {
  from?: string;
  to?: string;
  privateKey?: string;
  nonce?: number;
  gas?: string | number;
  gasPrice?: string | number;
  maxFeePerGas?: string | number;
  maxPriorityFeePerGas?: string | number;
  value?: string | number;
  data?: string;
  accessList?: AccessListish; // AccessList | Array<[string, Array<string>]>
}
async function createTransaction(
  options: TransactionOptions,
  ethTransactionType = "Legacy"
): Promise<string> {
  const isLegacy = ethTransactionType === "Legacy";
  const isEip2930 = ethTransactionType === "EIP2930";
  const isEip1559 = ethTransactionType === "EIP1559";

  const gasPrice = options.gasPrice !== undefined ? options.gasPrice : 1_000_000_000;
  const maxPriorityFeePerGas =
    options.maxPriorityFeePerGas !== undefined ? options.maxPriorityFeePerGas : 0;
  const value = options.value !== undefined ? options.value : "0x00";
  const from = options.from || alith.address;
  const privateKey = options.privateKey !== undefined ? options.privateKey : ALITH_PRIVATE_KEY;

  // Instead of hardcoding the gas limit, we estimate the gas
  const gas =
    options.gas ||
    (await web3.eth.estimateGas({
      from: from,
      to: options.to,
      data: options.data,
    }));

  const maxFeePerGas = options.maxFeePerGas || 1_000_000_000;
  const accessList = options.accessList || [];
  const nonce =
    options.nonce != null ? options.nonce : await web3.eth.getTransactionCount(from, "pending");

  let data, rawTransaction;
  if (isLegacy) {
    data = {
      from,
      to: options.to,
      value: value && value.toString(),
      gasPrice,
      gas,
      nonce: nonce,
      data: options.data,
    };
    const tx = await web3.eth.accounts.signTransaction(data, privateKey);
    rawTransaction = tx.rawTransaction;
  } else {
    const signer = new ethers.Wallet(privateKey, ethersApi);
    const chainId = await web3.eth.getChainId();
    if (isEip2930) {
      data = {
        from,
        to: options.to,
        value: value && value.toString(),
        gasPrice,
        gasLimit: gas,
        nonce: nonce,
        data: options.data,
        accessList,
        chainId,
        type: 1,
      };
    } else if (isEip1559) {
      data = {
        from,
        to: options.to,
        value: value && value.toString(),
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: gas,
        nonce: nonce,
        data: options.data,
        accessList,
        chainId,
        type: 2,
      };
    }
    rawTransaction = await signer.signTransaction(data);
  }

  return rawTransaction;
}

async function createContract(
  contractCompiled: Compiled,
  options: TransactionOptions = ALITH_TRANSACTION_TEMPLATE,
  contractArguments: any[] = []
): Promise<{ rawTx: string; contract: Contract; contractAddress: string }> {
  const from = options.from !== undefined ? options.from : alith.address;
  const nonce = options.nonce || (await web3.eth.getTransactionCount(from));

  const contractAddress =
    "0x" +
    web3.utils
      .sha3(RLP.encode([from, nonce]) as any)
      .slice(12)
      .substring(14);

  const contract = new web3.eth.Contract(contractCompiled.contract.abi, contractAddress);
  const data = contract
    .deploy({
      data: contractCompiled.byteCode,
      arguments: contractArguments,
    })
    .encodeABI();

  const rawTx = await createTransaction({ ...options, from, nonce, data });

  return {
    rawTx,
    contract,
    contractAddress,
  };
}

/// === solidity compile methods === ///

export interface Compiled {
  byteCode: string;
  contract: any;
  sourceCode: string;
}
function compileSolidity(fileContents: string): Compiled {
  // const fileContents = fs.readFileSync(filepath).toString();
  const result = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: {
          "main.sol": {
            content: fileContents,
          },
        },
        settings: {
          outputSelection: {
            "*": {
              "*": ["*"],
            },
          },
        },
      }),
      {
        import: (_: string) => {
          return { error: "imports not supported" };
        },
      }
    )
  );
  if (!result.contracts) {
    throw result;
  }
  const allContractNames = Object.keys(result.contracts["main.sol"]);
  const reduced = allContractNames.reduce((p, contractName) => {
    p[contractName] = {
      byteCode: "0x" + result.contracts["main.sol"][contractName].evm.bytecode.object,
      contract: result.contracts["main.sol"][contractName],
      sourceCode: fileContents,
    };
    return p;
  }, {});
  return reduced[allContractNames[0]];
}

/// === main  === ///

async function view(input: string, output: string, open: boolean) {
  const data = JSON.parse(fs.readFileSync(input).toString("utf-8"));
  const labels = data.map((x: any, i: number) => i);
  const fullPercent = data.map((x: any) => x["fullPercent"]);
  const substrateFees = data.map((x: any) => new BN(x["substrate"]).toNumber());
  const evmFees = data.map((x: any) => new BN(x["evm"]).toNumber());

  // editorconfig-checker-disable
  fs.writeFileSync(
    output,
    `<html>
    <head>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.7.1/chart.min.js" integrity="sha512-QSkVNOCYLtj73J4hbmVoOV6KVZuMluZlioC+trLpewV8qMjsWqlIQvkn1KGX2StWvPMdWGBqim1xlC8krl1EKQ==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
      <style>
        .chart {
          display: inline-block;
          width: 1500px;
          height: 800px;
          margin: 10px;
        }
      </style>
    </head>
    <body>
      <div class="chart">
        <canvas id="fees-substrate"></canvas>
      </div>  
      <div class="chart">
        <canvas id="fees-evm"></canvas>
      </div>
      <div class="chart">
        <canvas id="fees-all"></canvas>
      </div>  
      <script>
        const up = (ctx, value) => ctx.p0.parsed.y < ctx.p1.parsed.y ? value : undefined;
        const down = (ctx, value) => ctx.p0.parsed.y > ctx.p1.parsed.y ? value : undefined;

        const rawData = ${JSON.stringify(data)};

        drawChart('fees-substrate', 'Fees Substrate', [{
          label: "Substrate Fees",
          data: ${JSON.stringify(substrateFees)},
          fill: false,
          borderColor: "rgb(6, 87, 7)",
          tension: 0.4,
          cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 73)') || down(ctx, 'rgb(235, 64, 52)'),
          },
        }]);
        drawChart('fees-evm', 'Fees EVM', [{
          label: "EVM Fees",
          data: ${JSON.stringify(evmFees)},
          fill: false,
          borderColor: "rgb(115, 23, 145)",
          tension: 0.4,
          // cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 211)') || down(ctx, 'rgb(235, 52, 174)'),
          },
        }]);
        drawChart('fees-all', 'Fees Combined', [
          {
            label: "Substrate Fees",
            data: ${JSON.stringify(substrateFees)},
            fill: false,
            borderColor: "rgb(6, 87, 7)",
            tension: 0.4,
            cubicInterpolationMode: 'monotone',
            yAxisID: 'y',
            segment: {
              borderColor: ctx => up(ctx, 'rgb(52, 235, 73)') || down(ctx, 'rgb(235, 64, 52)'),
            },
          },
          {
            label: "EVM Fees",
            data: ${JSON.stringify(evmFees)},
            fill: false,
            borderColor: "rgb(115, 23, 145)",
            tension: 0.4,
            // cubicInterpolationMode: 'monotone',
            yAxisID: 'y',
            segment: {
              borderColor: ctx => up(ctx, 'rgb(52, 235, 211)') || down(ctx, 'rgb(235, 52, 174)'),
            },
          }
        ]);

        function drawChart(id, title, data) {
          new Chart(
            document.getElementById(id).getContext('2d'), 
            {
              type: 'line',
              responsive: true,
              data: {
                labels: ${JSON.stringify(labels)},
                datasets:[
                  {
                    label: "Block Full %",
                    data: ${JSON.stringify(fullPercent)},
                    fill: false,
                    borderColor: "rgb(235, 211, 52)",
                    tension: 0.4,
                    cubicInterpolationMode: 'monotone',
                    yAxisID: 'y1'
                  },
                  ...data,
                ]
              },
              options: {
                radius: 0,
                responsive: true,
                scales: {
                  x: {
                    title: {
                      display: true,
                      text: "Blocks",
                      font: { weight: "bold" },
                    }
                  },
                  y: {
                    title: {
                      display: true,
                      text: "Fees Charged",
                      font: { weight: "bold" },
                    }
                  },
                  y1: {
                    title: {
                      display: true,
                      text: "Block Full %",
                      font: { weight: "bold" },
                    },
                    position: "right",
                    grid: {
                      drawOnChartArea: false,
                    },
                  },
                },
                plugins: {
                  legend: {
                    position: 'top',
                  },
                  title: {
                    display: true,
                    text: title,
                  },
                },
              },
            });
        }
      </script>
    <body>
  </html>`
  );
  // editorconfig-checker-enable

  const openCmd = (() => {
    switch (process.platform) {
      case "darwin":
        return "open";
      case "win32":
        return "start";
      default:
        return "xdg-open";
    }
  })();

  if (open) {
    await exec(`${openCmd} ${output}`);
  }
}

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    name: {
      type: "string",
      description: "The output file name",
      demandOption: true,
    },
    view: {
      type: "boolean",
      description: "View existing file",
    },
    type: {
      type: "string",
      description: "View existing file",
      choices: ["compute", "length-small", "length-big"],
      demandOption: false,
      default: "compute",
    },
  }).argv;

async function main() {
  const name = `${argv.name}-${argv.type}`;
  if (argv.view) {
    await view(`${name}.json`, `${name}.html`, true);
    return;
  }

  const api = await ApiPromise.create({
    initWasm: false,
    provider: new WsProvider(wssUrl),
  });

  try {
    const results = await runTest(api, argv.type as any);
    fs.writeFileSync(`${name}.json`, JSON.stringify(results, null, 2));
    await view(`${name}.json`, `${name}.html`, true);
  } finally {
    await api.disconnect();
  }
}

main()
  .catch((err) => console.error("ERR!", err))
  .finally(() => process.exit(0));
