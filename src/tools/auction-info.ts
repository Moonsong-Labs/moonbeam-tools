import yargs from "yargs";
import "@polkadot/api-augment";

import { getApiFor } from "../utils/networks";
import { getAccountIdentity } from "../utils/monitoring";
import { BN } from "@polkadot/util";
import {
  isBigInt,
  isBn,
  isHex,
  isNumber,
  isU8a,
  u8aConcat,
  u8aToBn,
  u8aToHex,
  u8aToU8a,
} from "@polkadot/util";

const argv = yargs(process.argv.slice(2))
  .usage("Usage: $0")
  .version("1.0.0")
  .options({
    url: {
      type: "string",
      description: "Relay Websocket url",
      string: true,
      demandOption: true,
    },
    para: {
      type: "number",
      description: "Para for which a lease exists",
    },
  }).argv;

type AuctionInfo = {
  duration: Number;
  lease_period: Number;
};

let auctionMap = new Map<BN, AuctionInfo>();

function addSeconds(date, seconds) {
  date.setSeconds(date.getSeconds() + seconds);
  return date;
}

async function calculateTimestamp(api, futureblock: number) {
  let currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  let timestamp = (await api.query.timestamp.now()).toNumber();

  let currentDate = new Date(timestamp);

  let blockDifference = futureblock - currentBlock;

  let futureDate = addSeconds(currentDate, blockDifference * 6);
  return [futureDate.getTime(), futureDate];
}

async function calculateCurrentLeasePeriod(api, leasePeriod, leaseOffset) {
  let currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  return (currentBlock - leaseOffset) / leasePeriod;
}

const main = async () => {
  const api = await getApiFor(argv);

  const scheduled = await api.query.scheduler.agenda.entries();

  //scheduled.find()
  for (var i in scheduled) {
    for (var index in scheduled[i][1]) {
      if (scheduled[i][1][index].isSome) {
        let call;
        if (scheduled[i][1][index].unwrap().call.isLookup) {
          let lookup = scheduled[i][1][index].unwrap().call.asLookup;
          let callOption = await api.query.preimage.preimageFor([lookup.hash_, lookup.len]);
          if (callOption.isSome) {
            call = callOption.unwrap();
          }
        } else {
          call = scheduled[i][1][index].unwrap().call.asInline;
        }

        let extrinsic = (api.createType("GenericExtrinsicV4", call) as any).toHuman();

        if (extrinsic.method.method == "newAuction" && extrinsic.method.section == "auctions") {
          let key = scheduled[i][0];
          let sliced = key.slice(-4);

          auctionMap.set(u8aToBn(sliced, { isLe: true }), {
            duration: extrinsic.method.args.duration.replace(/,/g, ""),
            lease_period: extrinsic.method.args.lease_period_index,
          });
        }
      }
    }
  }

  let sortedKeys = [...auctionMap.keys()].sort();

  let currentAuctionIndex = await api.query.auctions.auctionCounter();
  let leasePeriod = await api.consts.slots.leasePeriod;
  let leaseOffset = await api.consts.slots.leaseOffset;

  let endingPeriod = await api.consts.auctions.endingPeriod;

  let currentLeasePeriod = await calculateCurrentLeasePeriod(api, leasePeriod, leaseOffset);

  for (var index in sortedKeys) {
    let nextAuction = auctionMap.get(sortedKeys[index]);

    let [auctionStartTimestamp, auctionStartDate] = await calculateTimestamp(
      api,
      Number(sortedKeys[index].toString()),
    );

    let slotsLeasedlready =
      argv.para == undefined ? undefined : await api.query.slots.leases(argv.para);

    console.log(
      "Auction number %s will happen at block %s, timestamp %s, date %s",
      Number(currentAuctionIndex) + Number(index) + Number(1),
      sortedKeys[index],
      auctionStartTimestamp,
      auctionStartDate,
    );
    console.log(
      "It will have a duration of %s blocks for lease period %s",
      nextAuction.duration,
      nextAuction.lease_period,
    );

    let candleBeginBlock = Number(sortedKeys[index].toString()) + Number(nextAuction.duration);

    let [candleStartTimestamp, candleStartDate] = await calculateTimestamp(api, candleBeginBlock);

    console.log(
      "Candle will happen at block %s, timestamp %s, date %s",
      candleBeginBlock,
      candleStartTimestamp,
      candleStartDate,
    );

    let biddingEndBlock =
      Number(sortedKeys[index].toString()) +
      Number(nextAuction.duration) +
      Number(endingPeriod.toString());

    let [biddingEndTimestamp, biddingDate] = await calculateTimestamp(api, biddingEndBlock);

    console.log(
      "Bidding end will happen at block %s, timestamp %s, date %s",
      biddingEndBlock,
      biddingEndTimestamp,
      biddingDate,
    );

    let yourLeaseStartSlot =
      slotsLeasedlready == undefined
        ? nextAuction.lease_period
        : currentLeasePeriod + (slotsLeasedlready as any).length;
    let leasePeriodPerSlot = await api.consts.auctions.leasePeriodsPerSlot;
    let yourLeaseEndSlot =
      Number(nextAuction.lease_period) + Number(leasePeriodPerSlot.toString()) - 1;

    let lease_start_block = new BN(nextAuction.lease_period.toString())
      .mul(u8aToBn(leasePeriod.toU8a()))
      .add(u8aToBn(leaseOffset.toU8a()));
    let [leaseStartimestamp, leaseStartDate] = await calculateTimestamp(
      api,
      Number(lease_start_block.toString()),
    );

    console.log(
      "The new lease will start at block %s, timestamp %s, date %s",
      lease_start_block.toString(),
      leaseStartimestamp,
      leaseStartDate,
    );

    let lease_end_block =
      Number(lease_start_block.toString()) +
      Number(leasePeriodPerSlot.toString()) * Number(leasePeriod.toString());
    let [leaseEndtimestamp, leaseEndDate] = await calculateTimestamp(
      api,
      Number(lease_end_block.toString()),
    );

    console.log(
      "The new lease will end at block %s, timestamp %s, date %s",
      lease_end_block.toString(),
      leaseEndtimestamp,
      leaseEndDate,
    );

    console.log(
      "For this auction you need to bid from %s to %s",
      Math.floor(yourLeaseStartSlot).toString(),
      yourLeaseEndSlot.toString(),
    );
  }

  await api.disconnect();
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
