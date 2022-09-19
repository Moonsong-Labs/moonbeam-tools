// Import
import { ApiPromise, WsProvider } from '@polkadot/api';
import {u8aToHex} from '@polkadot/util';
import {encodeAddress, decodeAddress} from '@polkadot/util-crypto'
import { formatBalance } from "@polkadot/util";

import type { SubmittableExtrinsic } from "@polkadot/api/promise/types";
import {blake2AsHex} from '@polkadot/util-crypto';
import yargs from 'yargs';
import { Keyring } from "@polkadot/api";

const args = yargs.options({
    'ws-provider': {type: 'string', demandOption: true, alias: 'w'},
    'asset': {type: 'string', demandOption: true, alias: 'a'},
    'units-per-second': {type: 'string', demandOption: true, alias: 'u'},
    'name': {type: 'number', demandOption: true, alias: 'n'},
    'symbol': {type: 'string', demandOption: false, alias: 'sym'},
    'frozen': {type: 'string', demandOption: false, alias: 'f'},
    'sufficient': {type: 'string', demandOption: false, alias: 'suf'},
    'send-preimage-hash': {type: 'boolean', demandOption: false, alias: 'h'},
    'at-block': {type: 'number', demandOption: true},
    'send-proposal-as': {choices: ['democracy', 'council-external'], demandOption: false, alias: 's'},
    'collective-threshold': {type: 'number', demandOption: false, alias: 'c'},
  }).argv;


interface XcmAsset {
    XCM: {
        parents: Number,
        interior: JSON
    };
}

const PROPOSAL_AMOUNT = 1000000000000000000000n
// Construct
const wsProvider = new WsProvider(args['ws-provider']);

async function main () {
    const api = await ApiPromise.create({ provider: wsProvider });
    const collectiveThreshold = (args['collective-threshold']) ? args['collective-threshold'] :1;
    console.log(collectiveThreshold)

    const keyring = new Keyring({ type: "ethereum" });

    const asset: XcmAsset = JSON.parse(args["asset"]);
    console.log(asset)
}

main().catch(console.error).finally(() => process.exit());