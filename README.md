# moonbeam-tools

Tools related to Moonbeam blockchains

# Requirements

* NodeJS v14+

# Tools

## Installation

```
sudo npm install -g moonbeam-tools@latest
```

## Running moonbeam-monitor

Allows to monitor a Moonbeam network. To do so, run the following command:

```  
moonbeam-monitor --networks moonriver
```

```
Options:
  --help       Show help                                               [boolean]
  --version    Show version number                                     [boolean]
  --url        WebSocket url                                            [string]
  --networks   Known networks
             [array] [choices: "stagenet", "alphanet", "moonsama", "moonsilver",
                                                                    "moonriver"]
  --finalized  listen to finalized only               [boolean] [default: false]
  ```

# Example in HTML page

```
<!DOCTYPE html>
<html>
  <head>
    <title>Monitoring</title>
    <script src="https://unpkg.com/moonbeam-tools@0.0.40/dist/index.umd.js" charset="UTF-8" integrity="sha384-HQFyKfRwho51fZdaPCYG7kUJ9t3FnPxVVjqmPKGaBLUrvCBpVk+TuIoPtk7qISqr" crossorigin="anonymous"></script>
    <style>
      body {
        padding: 2rem;
      }
      pre {
        margin: 0;
      }
    </style>
  </head>
  <body>
    <div id="main-alphanet"></div>
    <div id="main-moonriver"></div>
    <div id="main-moonbeam"></div>
    <script>
      const monitorNetwork = async (api, networkName) => {
        const pre = document.createElement("pre");
        const title = document.createElement("h2");
        title.append(networkName);
        const main = document.getElementById(`main-${networkName}`);
        main.appendChild(title);
        main.appendChild(pre);
        let previousBlockDetails = null;
        mbTools.listenBlocks(api, false, async (blockDetails) => {
          const line = `${mbTools.generateBlockDetailsLog(
            blockDetails,
            {},
            previousBlockDetails
          )}\n`;
          pre.prepend(line);
          previousBlockDetails = blockDetails;
        });
        return api;
      };

      const start = async () => {
        const api = await mbTools.getApiFor({ network: "moonriver" });
        // You can also directly to the node using url
        // const api = await mbTools.getApiFor({ url: "ws://127.0.0.1:9944" });

        const networkName =
          mbTools.NETWORK_CHAIN_MAPPING[
            (await api.rpc.system.chain()).toString()
          ];
        monitorNetwork(api, networkName);
      };

      start();
    </script>
  </body>
</html>
```

------------------------

## Forking the Live Network

The script `run-moonbeam-fork.ts` has been provided which allows you to fork the live state of the network and run them locally. 

### Usage

The simplest way to run a forked-network of `Moonbeam` is by calling:

```
npm run fork
```

Which will grab the latest polkadot and moonbeam binaries, grab the latest snapshot of live state, modify some values (such as validator keys, and inject balances),
 and run it as a new local network. From here you can perform any interaction as if it was the real state, such as runtime upgrades, interactions on deployed contracts,
 staking operations etc.


If however, you are more interested in intereacting with the contracts in the Moonbeam emulated EVM environment, but not so much parachain staking or XCM, you can run
the forked network in development mode. This allows for manual sealing of blocks which dramatically reduces execution times of tests (reduction of 12s blocktime into milliseconds).

```
npx ts-node npx ts-node ./src/tools/run-moonbeam-fork.ts -n moonbeam --dev
```

### Further Examples

Calling the script directly can be done via: `npx ts-node ./src/tools/run-moonbeam-fork.ts`

The minimal command is: `npx ts-node ./src/tools/run-moonbeam-fork.ts -n moonbeam`

By default the polkadot and moonbeam binaries will be downloaded from github if none found in the `binaries` folder, but if for whatever reason you need to provide your own (e.g. you are on an Apple Silicon chip)
use the `--polkadot-binary` option to provide the path to the binary to use (or copy them into the folder). If doing this option, make sure the correct binary version is supplied via `--moonbeam-version` and 
`--polkadot-version` respectively, otherwise the script will still attempt to download the latest.

:information_source: When running the node in manual-seal mode, to create a block you can run the following `curl` command:
```
curl --location --request POST 'http://127.0.0.1:9933/' \
--header 'Content-Type: application/json' \
--data-raw '{
    "jsonrpc":"2.0",
    "id"     :1,
    "method" :"engine_createBlock",
    "params" :[true,true]
}'
```


The full list of options can be found in the `--help` :
```
Options:
      --help              Show help                                    [boolean]
      --version           Show version number                          [boolean]
  -n, --network           Network to retrieve the exported state for.
                                                             [string] [required]
  -l, --latest            Verifies if a more recent state snapshot is able to
                          download.                   [boolean] [default: false]
  -r, --reset-to-genesis  Resets the network back to the initial state at
                          genesis block.              [boolean] [default: false]
  -k, --purge-all         Removes ALL files at the base-path directory, use with
                          CAUTION.                    [boolean] [default: false]
  -s, --sealing           Specify block sealing strategy for the forked chain
                          when running a development node (i.e. only works with
                          --dev/-d).                [string] [default: "manual"]
  -g, --regenerate        Creates a new genesis file based on state
                          manipulators.               [boolean] [default: false]
  -d, --dev               Runs network as a single manual-sealed development
                          node.                       [boolean] [default: false]
  -t, --ephemeral         Closes network immediately after it has completed
                          setup, used for CI.         [boolean] [default: false]
  -m, --moonbeam-binary   Absolute file path (e.g. /tmp/fork-chain/moonbeam) of
                          moonbeam binary OR version number (e.g. 0.31) to
                          download.                 [string] [default: "latest"]
  -p, --polkadot-binary   Absolute file path (e.g. /tmp/fork-chain/polkadot) of
                          polkadot binary OR version number (e.g. 0.9.28) to
                          download.                 [string] [default: "latest"]
  -o, --base-path         Specifies where all generated files are to be stored.
                                           [string] [default: "/tmp/fork-data/"]
```
