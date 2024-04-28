import Web3 from "web3";
import * as rlp from "rlp";
import { customWeb3Request } from "./transactions";
import { TransactionReceipt } from "web3";
import { Web3BaseWalletAccount } from "web3-types";

export interface SolidityContractBundle {
  abi: any;
  evm: {
    bytecode: {
      object: string;
    };
  };
}

export const deployContract = async (
  web3: Web3,
  contract: SolidityContractBundle,
  deployer: Web3BaseWalletAccount,
  nonce: number,
  gasLimit = 1000000,
) => {
  // 1M gas contract call (big_loop)
  const response = (await customWeb3Request(web3, "eth_getBalance", [deployer.address]));
  
  const tokens = "result" in response ? response.result : null;
  console.log(`Using account ${deployer.address} [nonce: ${nonce}]: ${tokens} DEVs`);
  const contractAddress =
    "0x" + web3.utils.sha3(rlp.encode([deployer.address, nonce]) as any).substr(26);

  const code = await customWeb3Request(web3, "eth_getCode", [contractAddress]);
  if (code && "result" in code && code.result != "0x") {
    console.log(`Contract already deployed: ${code.result.toString().length} bytes`);
    return;
  }

  const tx = await web3.eth.accounts.signTransaction(
    {
      from: deployer.address,
      data: `0x${contract.evm.bytecode.object}`,
      value: "0x00",
      gasPrice: web3.utils.toWei("100", "Gwei"),
      gas: gasLimit,
      nonce,
    },
    deployer.privateKey,
  );
  const result = await customWeb3Request(web3, "eth_sendRawTransaction", [tx.rawTransaction]);
  if ("error" in result) {
    console.error(`Error deploying contract!`);
    console.error(result.error);
    return;
  }
  console.log(`Transaction sent: ${tx.transactionHash}`);
  const startTime = Date.now();
  while (Date.now() - startTime < 40000) {
    let rcpt: TransactionReceipt = await web3.eth.getTransactionReceipt(tx.transactionHash);
    if (rcpt) {
      console.log(`Transaction done - block #${rcpt.blockNumber} (${rcpt.blockHash})`);
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
  }
  throw new Error("Failed to verify contract deployment (timeout)");
};

export const callContract = async (
  web3: Web3,
  contractBundle: SolidityContractBundle,
  contractAddress: string,
  call: { funcName: string; params: any[]; gasLimit: number },
  caller: Web3BaseWalletAccount,
  nonce: number
) => {
  const contract = new web3.eth.Contract(contractBundle.abi, contractAddress);

  const encoded = await contract.methods[call.funcName](...call.params).encodeABI();

  const tx = await web3.eth.accounts.signTransaction(
    {
      from: caller.address,
      to: contractAddress,
      data: encoded,
      maxPriorityFeePerGas: 2_000_000_000n,
      maxFeePerGas: 135_000_000_000n,
      gas: call.gasLimit,
      nonce,
    },
    caller.privateKey,
  );

  const result = await customWeb3Request(web3, "eth_sendRawTransaction", [tx.rawTransaction]);
  if ("error" in result) {
    console.error(result.error);
    throw new Error(`Error calling contract!`);
  }

  //   console.log(
  //     `Transaction for ${call.funcName} (${call.params.join(",")}) sent: ${tx.transactionHash}`
  //   );
  const startTime = Date.now();
  while (Date.now() - startTime < 60000) {
    let rcpt: TransactionReceipt = await web3.eth.getTransactionReceipt(tx.transactionHash);
    if (rcpt) {
      //   console.log(`- block #${rcpt.blockNumber} (${rcpt.blockHash})`);
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
  }
  throw new Error("Failed to verify contract call (timeout)");
};
