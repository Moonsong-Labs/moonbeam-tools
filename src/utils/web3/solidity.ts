import solc from "solc";

import { SolidityContractBundle } from "./contracts";

export function compileSolidity(
  contractContent: string,
  contractName: string = "Test",
): SolidityContractBundle {
  let result = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: {
          "main.sol": {
            content: contractContent,
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
    ),
  );

  return result.contracts["main.sol"][contractName] as SolidityContractBundle;
}
