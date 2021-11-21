# moonbeam-tools

Tools related to Moonbeam blockchains

# Requirements

* NodeJS v14+

# Tools

## Installation

```
sudo npm install -g moonbeam-tools@latest
```

## moonbeam-monitor

Allows to monitor a moonbeam network. Ex:  
`moonbeam-network --network moonriver`

```
Options:
  --help       Show help                                               [boolean]
  --version    Show version number                                     [boolean]
  --url        Websocket url                                            [string]
  --networks   Known networks
             [array] [choices: "stagenet", "alphanet", "moonsama", "moonsilver",
                                                                    "moonriver"]
  --finalized  listen to finalized only               [boolean] [default: false]
  ```

# Exemple in html page

```
<!DOCTYPE html>
<html>
  <head>
    <title>Monitoring</title>
    <script src="https://unpkg.com/moonbeam-tools@0.0.17/dist/index.umd.js" charset="UTF-8" integrity="sha384-h1Tlpvh3alCla5xdTBnewfWbej6HSOr6LeV0Zlq0w68QksAUbqskbaqMoZjTpwOu" crossorigin="anonymous"></script>
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