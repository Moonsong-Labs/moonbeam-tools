import { exec as execProcess } from "child_process";
import fs from "fs";
import assert from "node:assert/strict";
import util from "node:util";
import { setTimeout } from "timers/promises";

import "@moonbeam-network/api-augment";
import { ApiPromise, WsProvider } from "@polkadot/api";
import "@polkadot/api-augment";
import { SubmittableExtrinsic as SubmittableExtrinsicPromise } from "@polkadot/api/promise/types";
import { ApiTypes, SubmittableExtrinsic } from "@polkadot/api/types";
import Keyring from "@polkadot/keyring";
import { DispatchError, EventRecord } from "@polkadot/types/interfaces";
import { EvmCoreErrorExitReason } from "@polkadot/types/lookup";
import { BN, u8aToHex } from "@polkadot/util";
import { ethers } from "ethers";
import { AccessListish } from "ethers/lib/utils.js";
import * as RLP from "rlp";
import solc from "solc";
import { JsonRpcResponseWithResult, Web3 } from "web3";
import { Contract } from "web3-eth-contract";
import yargs from "yargs";
import {
  ALITH_PRIVATE_KEY,
  BALTATHAR_ADDRESS,
  BALTATHAR_PRIVATE_KEY,
  CHARLETH_ADDRESS,
  CHARLETH_PRIVATE_KEY,
  DOROTHY_PRIVATE_KEY,
} from "../utils/constants";

const httpUrl = "http://127.0.0.1:9933";
const wssUrl = "ws://127.0.0.1:9944";

const exec = util.promisify(execProcess);
const ethersApi = new ethers.providers.JsonRpcProvider(httpUrl);
const keyringEth = new Keyring({ type: "ethereum" });
export const alith = keyringEth.addFromUri(ALITH_PRIVATE_KEY);
export const baltathar = keyringEth.addFromUri(BALTATHAR_PRIVATE_KEY);
export const charleth = keyringEth.addFromUri(CHARLETH_PRIVATE_KEY);
export const dorothy = keyringEth.addFromUri(DOROTHY_PRIVATE_KEY);
const web3 = new Web3(wssUrl);
web3.eth.accounts.wallet.add(ALITH_PRIVATE_KEY);

/**
 * This test assumes the following:
 *  + moonbeam
 *    - EVM calls are unfiltered.
 *        NormalFilter - Call::EVM(_) => true
 *    - EVM origin is allowed for all.
 *        type CallOrigin = EnsureAddressAlways;
 *
 *        pub struct EnsureAddressAlways;
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
 *        let (validate, payable) = if source === baltathar_addr {
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
 *    --tmp
 *
 * Examples:
 *  ts-node ./src/tools/fees.ts --name fees --type compute
 *  ts-node ./src/tools/fees.ts --name fees --type compute --multiplier 300000000
 *  ts-node ./src/tools/fees.ts --name fees --type length-small
 *  ts-node ./src/tools/fees.ts --name fees --type length-big
 *
 * The result will open in the browser once done
 */

/**
 * Observations
 * - The first EVM call causes the SmartContract storage to be initialized and costs around 20,000 gas (we avoid this by pre-initializing the storage)
 * - The fees sometime jump abruptly and stay at that level, this is due to nonce going from 1 byte to 2 bytes and so on
 * - The block fill ratio is computed differently by transaction-payment; the multiplier is updated only due to `Normal` weight class (actual / max).
 *   The actual weight also contains some extra weight that doesn't belong to extrinsics (maybe coming from on_initialize/on_finalize)
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

async function runTest(
  api: ApiPromise,
  options: { callType: "compute" | "length-small" | "length-big"; multiplier: BN | null },
) {
  const _result = [];
  console.log(`options: ${JSON.stringify(options)}`);
  let contractAddr = "0xc01Ee7f10EA4aF4673cFff62710E1D7792aBa8f3";

  // deploy contract
  const maxBlockWeight = api.consts.system.blockWeights.maxBlock.refTime.toBn();
  const blockNumber = (await api.rpc.chain.getBlock()).block.header.number.toNumber();
  const nextFeeMultiplierOriginal = await api.query.transactionPayment.nextFeeMultiplier();
  if (blockNumber === 0) {
    const { contract, rawTx } = await createContract(TESTER_JSON, {
      ...ALITH_TRANSACTION_TEMPLATE,
      gas: 900_000,
      gasPrice: 1_250_000_000,
    });

    const results = await createBlock(api, rawTx);
    assert.equal(results, true, "failure during block creation");
    await expectEVMSuccess(api);
    console.log(`contractAddress: ${contract.options.address.toString()}`);
    contractAddr = contract.options.address;
  }

  // use the specified call type
  const contractCall = (() => {
    switch (options.callType) {
      case "compute":
        return TESTER_INTERFACE.encodeFunctionData("incrementalLoop", [10]);
      case "length-small":
        return TESTER_INTERFACE.encodeFunctionData("bigData", [new Array(100).fill(0x01)]);
      case "length-big":
        return TESTER_INTERFACE.encodeFunctionData("bigData", [new Array(50 * 1024).fill(0x01)]);
      default:
        throw new Error(`invalid options.callType ${options.callType}`);
    }
  })();

  // init the smart contract storage, if not done then the first tx has a storage initialization cost of around 20,000
  await createBlock(api, [
    await api.tx.evm
      .call(
        dorothy.address,
        contractAddr,
        contractCall,
        0,
        900_000n,
        2_000_000_000n,
        null,
        null,
        [],
      )
      .signAsync(dorothy),
  ]);

  // override nextFeeMultiplier if needed, note that its value will change immediately after block creation
  const nextFeeMultiplierOverride = options.multiplier || nextFeeMultiplierOriginal;
  if (nextFeeMultiplierOverride) {
    console.log(`overriding nextFeeMultiplier to ${nextFeeMultiplierOverride}`);
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
            .signAsync(alith),
        )
        .signAsync(alith),
    ]);
  }

  // start load test
  // const loadFactors = [...generateLoad(60, 1), ...Array(10).fill(0)];
  // const loadFactors = [...Array(183).fill(19)];
  const loadFactors = [...Array(183).fill(55)];
  // const loadFactors = [...Array(1).fill(0)];
  const repsPerLoad = 30;
  for await (const [loadFactorIndex, loadFactor] of loadFactors.entries()) {
    console.log(
      `load: ${loadFactor} (${repsPerLoad} reps)  ${loadFactorIndex + 1}/${loadFactors.length}`,
    );
    for await (const rep of new Array(repsPerLoad).keys()) {
      // uncomment the following code to reduce feeMultiplier by 10 each 100 blocks
      //   if (blockN % 100 === 0) {
      //     console.log(`feeMultiplier ${feeMultiplier.toString()}`);
      //     await createBlock(api, [
      //       await api.tx.sudo
      //         .sudo(
      //           await api.tx.system
      //             .setStorage([
      //               [
      //                 "0x3f1467a096bcd71a5b6a0c8155e208103f2edf3bdf381debe331ab7446addfdc",
      //                 u8aToHex(api.createType("u128", feeMultiplier).toU8a()),
      //               ],
      //             ])
      //             .signAsync(alith)
      //         )
      //         .signAsync(alith),
      //     ]);
      //     if (feeMultiplier.eqn(1)) {
      //       feeMultiplier = BN_ZERO;
      //       break;
      //     }
      //     feeMultiplier = feeMultiplier.divn(10);
      //   }
      //   blockN++;

      const multiplierBefore = await api.query.transactionPayment.nextFeeMultiplier();
      const fees = await txObserveFeeDiff(api, async () => {
        const txs = [
          // fill block
          await api.tx.sudo
            .sudo(await api.tx.system.fillBlock(loadFactor * 10_000_000).signAsync(alith))
            .signAsync(alith),

          // charge substrate fees
          await api.tx.evm
            .call(baltathar.address, contractAddr, contractCall, 0, 11_000_000n, 0n, null, null, [])
            .signAsync(baltathar, { tip: 1n * 10n ** 15n }),

          // charge EVM fees
          await api.tx.evm
            .call(
              charleth.address,
              contractAddr,
              contractCall,
              0,
              11_000_000n,
              2_000_000_000_000_000n,
              null,
              null,
              [],
            )
            .signAsync(charleth, { tip: 1n * 10n ** 15n }),
        ];

        txs.forEach((t) => {
          console.log(t.hash.toString());
        });

        return txs;
      });

      // get block details
      const transactions = {
        substrate: null,
        evm: null,
      };
      const block = await api.rpc.chain.getBlock();
      for (const [i, ext] of block.block.extrinsics.entries()) {
        if (ext.signer.eq(BALTATHAR_ADDRESS)) {
          transactions.substrate = {
            index: i,
            extrinsicLength: ext.encodedLength,
            extrinsic: ext,
          };
        } else if (ext.signer.eq(CHARLETH_ADDRESS)) {
          transactions.evm = {
            index: i,
            extrinsicLength: ext.encodedLength,
            extrinsic: ext,
          };
        }
      }

      // compute block weight, from events
      const weights = {};
      const events = await api.query.system.events();
      let totalBlockWeight = new BN(0);
      for (const { phase, event } of events) {
        if (phase.isApplyExtrinsic) {
          if (
            api.events.system.ExtrinsicSuccess.is(event) ||
            api.events.system.ExtrinsicFailed.is(event)
          ) {
            weights[phase.asApplyExtrinsic.toNumber()] =
              event.data.dispatchInfo.weight.refTime.toBn();
          }
        }
      }
      if (!transactions.substrate || transactions.evm) {
        // TODO: Handle case when substrate is missing or evm exists
      }
      for (const i of Object.keys(weights)) {
        const key = parseInt(i);
        if (transactions.substrate && transactions.substrate.index === key) {
          transactions.substrate.weight = weights[i].toString();
        } else if (transactions.evm && transactions.evm.index === key) {
          transactions.evm.weight = weights[i].toString();
        }
        switch (parseInt(i)) {
          case transactions.substrate.index:
            transactions.substrate.weight = weights[i].toString();
            break;
          case transactions.evm.index:
            transactions.evm.weight = weights[i].toString();
            break;
        }
        totalBlockWeight = totalBlockWeight.add(weights[i]);
      }

      // get feeDetails

      const feeDetails = (
        await api.rpc.payment.queryFeeDetails(transactions.substrate.extrinsic.toHex())
      ).inclusionFee.unwrap();
      const supplyFactor = 1; // 100 for moonbeam, 1 otherwise
      const substrateFeeDetails = {
        baseFee: feeDetails.baseFee.toString(),
        lengthFee: feeDetails.lenFee.toString(),
        adjustedWeightFee: multiplierBefore
          .mul(new BN(transactions.substrate.weight).muln(50_000 * supplyFactor))
          .div(new BN("1000000000000000000"))
          .toString(),
        total: null,
      };
      substrateFeeDetails.total = Object.values(substrateFeeDetails)
        .reduce((acc, v) => acc.add(new BN(v)), new BN(0))
        .toString();

      const multiplierAfter = await api.query.transactionPayment.nextFeeMultiplier();

      delete transactions.substrate.extrinsic;
      delete transactions.evm.extrinsic;
      const data = {
        fullPercent: totalBlockWeight.muln(100).div(maxBlockWeight).toNumber(),
        ...fees,
        transactions,
        substrateFeeDetails,
        multiplier: {
          before: multiplierBefore.toString(),
          after: multiplierAfter.toString(),
        },
        block: (await api.rpc.chain.getBlock()).block.header.number.toNumber(),
      };
      result.push(data);
      if (data.block === 4) {
        throw Error("FOUR!");
      }
    }
  }

  return {
    multiplier: nextFeeMultiplierOverride.toString(),
    callType: options.callType,
    result,
  };
}

function generateLoad(middle: number, inc: number = 1): number[] {
  const load = [];
  for (let i = 0; i <= middle; i += inc) {
    load.push(i);
  }
  for (let i = 0; i <= 50; i++) {
    load.push(middle);
  }
  for (let i = middle; i >= 0; i -= inc) {
    load.push(i);
  }

  return load;
}

async function txObserveFeeDiff(
  api: ApiPromise,
  txFunc: () => Promise<SubmittableExtrinsicPromise[]>,
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
    ({ event: { section, method } }) => section === "ethereum" && method === "Executed",
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
      }) => dispatchError as DispatchError,
    )[0];
}

async function customWeb3Request(web3: Web3, method: string, params: any[]) {
  return new Promise<JsonRpcResponseWithResult>((resolve, reject) => {
    (web3.currentProvider as any).send(
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      },
      (error: Error | null, result?: JsonRpcResponseWithResult) => {
        if (error) {
          reject(
            `Failed to send custom request (${method} (${params
              .map((p) => {
                const str = p.toString();
                return str.length > 128 ? `${str.slice(0, 96)}...${str.slice(-28)}` : str;
              })
              .join(",")})): ${error.message || error.toString()}`,
          );
        }
        resolve(result);
      },
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
  Calls extends Call | Call[],
>(api: ApiPromise, transactions?: Calls, options: BlockCreation = {}) {
  const results: ({ type: "eth"; hash: string } | { type: "sub"; hash: string })[] = [];
  const txs =
    transactions === undefined ? [] : Array.isArray(transactions) ? transactions : [transactions];
  for await (const call of txs) {
    if (typeof call === "string") {
      // Ethereum
      results.push({
        type: "eth",
        hash: (await customWeb3Request(web3, "eth_sendRawTransaction", [call])).result.toString(),
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
  if (results.length === 0) {
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
      result.type === "eth"
        ? allRecords
            .find(
              ({ phase, event: { section, method, data } }) =>
                phase.isApplyExtrinsic &&
                section === "ethereum" &&
                method === "Executed" &&
                data[2].toString() === result.hash,
            )
            ?.phase?.asApplyExtrinsic?.toNumber()
        : blockData.block.extrinsics.findIndex((ext) => ext.hash.toHex() === result.hash);
    // We retrieve the events associated with the extrinsic
    const events = allRecords.filter(
      ({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.toNumber() === extrinsicIndex,
    );
    const failure = extractError(events);
    const successful = extrinsicIndex !== undefined && !failure;
    return successful;
  });

  // Adds extra time to avoid empty transaction when querying it
  if (results.find((r) => r.type === "eth")) {
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
  ethTransactionType = "Legacy",
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
    options.nonce !== null ? options.nonce : await web3.eth.getTransactionCount(from, "pending");

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
  contractArguments: any[] = [],
): Promise<{ rawTx: string; contract: Contract<any>; contractAddress: string }> {
  const from = options.from !== undefined ? options.from : alith.address;
  const nonce = options.nonce || Number(await web3.eth.getTransactionCount(from));

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
  const _result = JSON.parse(
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
      },
    ),
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
  const labels = data.result.map((x: any) => x["block"]);
  const fullPercent = data.result.map((x: any) => x["fullPercent"]);
  const substrateFees = data.result.map((x: any) => new BN(x["substrate"]).toString());
  const evmFees = data.result.map((x: any) => new BN(x["evm"]).toString());
  const multiplier = data.result.map((x: any) => new BN(x["multiplier"]["before"]).toString());
  const diff = data.result.map((x: any) => {
    const a = new BN(x["substrate"]);
    const b = new BN(x["evm"]);
    return a.sub(b).abs().muln(100).div(a.add(b).divn(2)).toString();
  });
  const diffSubstrate = data.result.map((x: any) => {
    const a = new BN(x["substrate"]);
    const b = new BN(x["evm"]);
    return a.sub(b).toString();
  });

  // editorconfig-checker-disable
  fs.writeFileSync(
    output,
    `<html>
    <head>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.7.1/chart.min.js" integrity="sha512-QSkVNOCYLtj73J4hbmVoOV6KVZuMluZlioC+trLpewV8qMjsWqlIQvkn1KGX2StWvPMdWGBqim1xlC8krl1EKQ===" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
      <script src="https://cdn.jsdelivr.net/combine/npm/hammerjs@2.0.8"></script>
      <script src="https://cdn.jsdelivr.net/combine/npm/chartjs-plugin-zoom@1.2.1"></script>
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
      <div class="chart"><canvas id="fees-substrate"></canvas></div>  
      <div class="chart"><canvas id="fees-evm"></canvas></div>

      <div class="chart"><canvas id="fees-substrate-log"></canvas></div>  
      <div class="chart"><canvas id="fees-evm-log"></canvas></div>
      
      <div class="chart"><canvas id="fees-all"></canvas></div>
      <div class="chart"><canvas id="fees-diff"></canvas></div>
      
      <div class="chart"><canvas id="fees-multiplier"></canvas></div>
      <div class="chart"><canvas id="fees-multiplier-log"></canvas></div>

      <div class="chart"><canvas id="fees-diff-substrate"></canvas></div>
      <div class="chart"><canvas id="placeholder"></canvas></div>
      
      <script>
        const up = (ctx, value) => ctx.p0.parsed.y < ctx.p1.parsed.y ? value : undefined;
        const down = (ctx, value) => ctx.p0.parsed.y > ctx.p1.parsed.y ? value : undefined;

        const rawData = ${JSON.stringify(data)};

        drawChart('fees-substrate', 'Substrate Fees', [{
          label: "Fees",
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
        drawChart('fees-evm', 'EVM Fees', [{
          label: "Fees",
          data: ${JSON.stringify(evmFees)},
          fill: false,
          borderColor: "rgb(115, 23, 145)",
          tension: 0.4,
          cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 211)') || down(ctx, 'rgb(235, 52, 174)'),
          },
        }]);
        drawChart('fees-substrate-log', 'Substrate Fees (log)', [{
          label: "Fees",
          data: ${JSON.stringify(substrateFees)},
          fill: false,
          borderColor: "rgb(6, 87, 7)",
          tension: 0.4,
          cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 73)') || down(ctx, 'rgb(235, 64, 52)'),
          },
        }], {
          y: {
            type: 'logarithmic',
          }
        });
        drawChart('fees-evm-log', 'EVM Fees (log)', [{
          label: "Fees",
          data: ${JSON.stringify(evmFees)},
          fill: false,
          borderColor: "rgb(115, 23, 145)",
          tension: 0.4,
          cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 211)') || down(ctx, 'rgb(235, 52, 174)'),
          },
        }], {
          y: {
            type: 'logarithmic',
          }
        });
        drawChart('fees-all', 'Combined Fees (log)', [
          {
            label: "Substrate",
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
            label: "EVM",
            data: ${JSON.stringify(evmFees)},
            fill: false,
            borderColor: "rgb(115, 23, 145)",
            tension: 0.4,
            cubicInterpolationMode: 'monotone',
            yAxisID: 'y',
            segment: {
              borderColor: ctx => up(ctx, 'rgb(52, 235, 211)') || down(ctx, 'rgb(235, 52, 174)'),
            },
          }
        ], {
          y: {
            type: 'logarithmic',
          }
        });
        drawChart('fees-multiplier', 'Multiplier', [{
          label: "Multiplier",
          data: ${JSON.stringify(multiplier)},
          fill: false,
          borderColor: "rgb(66, 245, 215)",
          tension: 0.4,
          cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 73)') || down(ctx, 'rgb(235, 64, 52)'),
          },
        }], {
          y: {
            title: {
              text: "Value",
            }
          }
        });
        drawChart('fees-multiplier-log', 'Multiplier (log)', [{
          label: "Multiplier",
          data: ${JSON.stringify(multiplier)},
          fill: false,
          borderColor: "rgb(66, 245, 215)",
          tension: 0.4,
          cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 73)') || down(ctx, 'rgb(235, 64, 52)'),
          },
        }], {
          y: {
            type: 'logarithmic',
            title: {
              text: "Value",
            }
          }
        });
        drawChart('fees-diff', 'Diff %', [{
          label: "Percentage",
          data: ${JSON.stringify(diff)},
          fill: false,
          borderColor: "rgb(66, 245, 215)",
          tension: 0.4,
          cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 73)') || down(ctx, 'rgb(235, 64, 52)'),
          },
        }], {
          y: {
            title: {
              text: "Percent",
            }
          }
        });
        drawChart('fees-diff-substrate', 'Substrate Excess', [{
          label: "Fees",
          data: ${JSON.stringify(diffSubstrate)},
          fill: false,
          borderColor: "rgb(66, 245, 215)",
          tension: 0.4,
          cubicInterpolationMode: 'monotone',
          yAxisID: 'y',
          segment: {
            borderColor: ctx => up(ctx, 'rgb(52, 235, 73)') || down(ctx, 'rgb(235, 64, 52)'),
          },
        }], {
          y: {
            title: {
              text: "Extra Fees",
            }
          }
        });

        function drawChart(id, title, data, options) {
          const yAxis = Object.assign({
            title: {
              display: true,
              text: "Fees",
              font: { weight: "bold" },
            }
          }, options && options.y || {});
          
          console.log(title, yAxis);
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
                  y: yAxis,
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
                  zoom: {
                    pan: {
                      enabled: true,
                      modifierKey: 'ctrl',
                      mode: 'y',
                    },
                    zoom: {
                      wheel: {
                        enabled: true,
                        modifierKey: 'ctrl',
                      },
                      pinch: {
                        enabled: true
                      },
                      mode: 'y',
                    }
                  }
                },
              },
            });
        }
      </script>
    <body>
  </html>`,
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
    multiplier: {
      type: "string",
      description: "The multiplier override",
      default: "",
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
    const results = await runTest(api, {
      callType: argv.type as any,
      multiplier: argv.multiplier.length === 0 ? null : new BN(argv.multiplier),
    });
    fs.writeFileSync(`${name}.json`, JSON.stringify(results, null, 2));
    await view(`${name}.json`, `${name}.html`, true);
  } finally {
    await api.disconnect();
  }
}

main()
  .catch((err) => console.error("ERR!", err))
  .finally(() => process.exit(0));
