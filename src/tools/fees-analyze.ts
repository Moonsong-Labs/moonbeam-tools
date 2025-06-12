import fs from "fs";
import { exec } from "child_process";

const data = [
  "fees-v2-4-1000-1-1_000_000_000-movr-compute.json",
  "fees-v2-4-1000-1-1_000-movr-1000000000000000-compute.json",
  "fees-v2-4-1000-1-10-movr-high-load-100000000000000000-compute.json",
  "fees-v2-4-1000-1-10-movr-high-load-1000000000000000000-compute.json",
  "fees-v2-4-1000-1-10-movr-high-load-10000000000000000000-compute.json",
  "fees-v2-4-1000-1-10-movr-high-load-100000000000000000000-compute.json",
].map((f) => {
  const d = JSON.parse(fs.readFileSync(f).toString("utf8"));
  const feeSubstrate = BigInt(d["result"][0]["substrate"]);
  const feeEvm = BigInt(d["result"][0]["evm"]);
  const diff = feeSubstrate - feeEvm;
  const diffPercent = (diff * 1000n) / ((feeSubstrate + feeEvm) / 2n);
  return {
    multiplier: d["multiplier"],
    scale: parseFloat((BigInt(d["multiplier"]) / 1000000000000n).toString()) / 1000000,
    fees: {
      substrate: feeSubstrate.toLocaleString(),
      evm: feeEvm.toLocaleString(),
      diff: diff.toLocaleString(),
      diffPercent: parseFloat(diffPercent.toString()) / 10.0,
      substrateDetails: {
        baseFee: BigInt(d["result"][0]["substrateFeeDetails"]["baseFee"]).toLocaleString(),
        adjustedWeightFee: BigInt(
          d["result"][0]["substrateFeeDetails"]["adjustedWeightFee"],
        ).toLocaleString(),
      },
    },
    raw: d,
  };
});

console.log(`${"Multiplier".padStart(10)} ${"Fees".padStart(25)}
------------------------------------`);
for (const d of data) {
  console.log(`${d.scale.toString().padStart(10)} ${d.fees.substrate.padStart(25)} | substrate
${"".padStart(10)} ${d.fees.evm.padStart(25)} | evm
${"".padStart(10)} ${d.fees.diff.toLocaleString().padStart(25)} | diff
${"".padStart(10)} ${d.fees.diffPercent.toLocaleString().concat("%").padStart(25)} | diff%
${"".padStart(10)} ${d.fees.substrateDetails.adjustedWeightFee.padStart(
    25,
  )} | substrate-weight-fee-part
${"".padStart(10)} ${d.fees.substrateDetails.baseFee.padStart(25)} | substrate-base-fee-part
${"-".repeat(36)} ${"| "}`);
}

const outputFile = "fees-analyze.html";
// editorconfig-checker-disable
fs.writeFileSync(
  outputFile,
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
    
    <script>
      const rawData = ${JSON.stringify(data)};
      for (const d of rawData) {
        const canvasDiv = document.createElement("div");
        canvasDiv.className ="chart";
        const canvas = document.createElement("canvas");
        canvas.id = 'fees-all-' + d["scale"];
        canvasDiv.appendChild(canvas);
        document.body.appendChild(canvasDiv);

        drawChart('fees-all-' + d["scale"], 'Combined Fees (log) - ' + d["scale"], [
          {
            label: "Substrate",
            data: d["raw"]["result"].map((x) => BigInt(x["substrate"]).toString()),
            fill: false,
            borderColor: "rgb(23, 207, 84)",
            tension: 0.4,
            cubicInterpolationMode: 'monotone',
            yAxisID: 'y',
          },
          {
            label: "EVM",
            data: d["raw"]["result"].map((x) => BigInt(x["evm"]).toString()),
            fill: false,
            borderColor: "rgb(207, 23, 130)",
            tension: 0.4,
            cubicInterpolationMode: 'monotone',
            yAxisID: 'y',
          }
        ], 
        d["raw"]["result"].map((x) => x["block"]));
      }
      
      
      function drawChart(id, title, data, labels) {
        new Chart(
          document.getElementById(id).getContext('2d'), 
          {
            type: 'line',
            responsive: true,
            data: {
              labels,
              datasets:[
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
                  type: 'logarithmic',
                  title: {
                    display: true,
                    text: "Fees",
                    font: { weight: "bold" },
                  }
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

exec(`${openCmd} ${outputFile}`);
