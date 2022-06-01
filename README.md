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
    <script src="https://unpkg.com/moonbeam-tools@0.0.22/dist/index.umd.js" charset="UTF-8" integrity="sha384-NqJsVZtNakKSMzAXimUFrtDvfps+u5+V3NpVNB7OWG76ND2tjkR43UEcHrJS/fR5" crossorigin="anonymous"></script>
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
