import "@polkadot/api-augment";

import { BN, u8aToBn } from "@polkadot/util";
import yargs from "yargs";

import { getApiFor } from "../utils/networks";

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
  duration: number;
  lease_period: number;
};

const auctionMap = new Map<BN, AuctionInfo>();

function addSeconds(date, seconds) {
  date.setSeconds(date.getSeconds() + seconds);
  return date;
}

async function calculateTimestamp(api, futureblock: number) {
  const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  const timestamp = (await api.query.timestamp.now()).toNumber();

  const currentDate = new Date(timestamp);

  const blockDifference = futureblock - currentBlock;

  const futureDate = addSeconds(currentDate, blockDifference * 6);
  return [futureDate.getTime(), futureDate];
}

async function calculateCurrentLeasePeriod(api, leasePeriod, leaseOffset) {
  const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  return (currentBlock - leaseOffset) / leasePeriod;
}

const main = async () => {
  const api = await getApiFor(argv);

  const scheduled = await api.query.scheduler.agenda.entries();

  //scheduled.find()
  for (const i in scheduled) {
    for (const index in scheduled[i][1]) {
      if (scheduled[i][1][index].isSome) {
        let call;
        if (scheduled[i][1][index].unwrap().call.isLookup) {
          const lookup = scheduled[i][1][index].unwrap().call.asLookup;
          const callOption = await api.query.preimage.preimageFor([lookup.hash_, lookup.len]);
          if (callOption.isSome) {
            call = callOption.unwrap();
          }
        } else {
          call = scheduled[i][1][index].unwrap().call.asInline;
        }

        const extrinsic = (api.createType("GenericExtrinsicV4", call)).toHuman();

        if (extrinsic.method.method == "newAuction" && extrinsic.method.section == "auctions") {
          const key = scheduled[i][0];
          const sliced = key.slice(-4);

          auctionMap.set(u8aToBn(sliced, { isLe: true }), {
            duration: extrinsic.method.args.duration.replace(/,/g, ""),
            lease_period: extrinsic.method.args.lease_period_index,
          });
        }
      }
    }
  }

  const sortedKeys = [...auctionMap.keys()].sort();

  const currentAuctionIndex = await api.query.auctions.auctionCounter();
  const leasePeriod = await api.consts.slots.leasePeriod;
  const leaseOffset = await api.consts.slots.leaseOffset;

  const endingPeriod = await api.consts.auctions.endingPeriod;

  const currentLeasePeriod = await calculateCurrentLeasePeriod(api, leasePeriod, leaseOffset);

  for (const index in sortedKeys) {
    const nextAuction = auctionMap.get(sortedKeys[index]);

    const [auctionStartTimestamp, auctionStartDate] = await calculateTimestamp(
      api,
      Number(sortedKeys[index].toString()),
    );

    const slotsLeasedlready =
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

    const candleBeginBlock = Number(sortedKeys[index].toString()) + Number(nextAuction.duration);

    const [candleStartTimestamp, candleStartDate] = await calculateTimestamp(api, candleBeginBlock);

    console.log(
      "Candle will happen at block %s, timestamp %s, date %s",
      candleBeginBlock,
      candleStartTimestamp,
      candleStartDate,
    );

    const biddingEndBlock =
      Number(sortedKeys[index].toString()) +
      Number(nextAuction.duration) +
      Number(endingPeriod.toString());

    const [biddingEndTimestamp, biddingDate] = await calculateTimestamp(api, biddingEndBlock);

    console.log(
      "Bidding end will happen at block %s, timestamp %s, date %s",
      biddingEndBlock,
      biddingEndTimestamp,
      biddingDate,
    );

    const yourLeaseStartSlot =
      slotsLeasedlready == undefined
        ? nextAuction.lease_period
        : currentLeasePeriod + (slotsLeasedlready as any).length;
    const leasePeriodPerSlot = await api.consts.auctions.leasePeriodsPerSlot;
    const yourLeaseEndSlot =
      Number(nextAuction.lease_period) + Number(leasePeriodPerSlot.toString()) - 1;

    const lease_start_block = new BN(nextAuction.lease_period.toString())
      .mul(u8aToBn(leasePeriod.toU8a()))
      .add(u8aToBn(leaseOffset.toU8a()));
    const [leaseStartimestamp, leaseStartDate] = await calculateTimestamp(
      api,
      Number(lease_start_block.toString()),
    );

    console.log(
      "The new lease will start at block %s, timestamp %s, date %s",
      lease_start_block.toString(),
      leaseStartimestamp,
      leaseStartDate,
    );

    const lease_end_block =
      Number(lease_start_block.toString()) +
      Number(leasePeriodPerSlot.toString()) * Number(leasePeriod.toString());
    const [leaseEndtimestamp, leaseEndDate] = await calculateTimestamp(
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
