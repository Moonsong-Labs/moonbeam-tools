#!/usr/bin/env ts-node
/**
 * Usage:
 *
 * Encode storage key:
 *  ./scale.ts key \
 *    --storage system.account \
 *    --key 0x6Df05cBd5113261Dd0f63fb8ce89FC0e236B844e
 *
 * Decode storage item:
 *  ./scale.ts decode \
 *    --ws wss://wss.api.moonbase.moonbeam.network \
 *    --storage system.account \
 *    --value '0x1600...de' \
 *    --explain
 *
 * Encode storage item:
 * ./scale.ts encode \
 *    --ws wss://wss.api.moonbase.moonbeam.network \
 *    --storage system.account \
 *    --value '{  "nonce": "22",
 *       "consumers": "0",
 *        ...
 *      }'
 */
import { ApiPromise, WsProvider } from "@polkadot/api";
import { hexToU8a, isArray, u8aToHex } from "@polkadot/util";
import { blake2AsU8a, xxhashAsU8a } from "@polkadot/util-crypto";
import isObject from "lodash.isobject";
import mergeWith from "lodash.mergewith";
import yargs from "yargs";

const _args = yargs
  .showHelpOnFail(true)
  .command(
    "key",
    "Compute storage key",
    {
      ws: { type: "string", demandOption: true, describe: "The websocket URL" },
      storage: {
        type: "string",
        describe: "The '.' separated storage path, example 'system.account'",
      },
      pallet: {
        type: "string",
        describe: "The pallet's capitalized name, if --storage isn't provided",
      },
      item: {
        type: "string",
        describe: "The storage item's capitalized name, if --storage isn't provided",
      },
      key: {
        type: "string",
        describe: "The key for the storage",
      },
    },
    cmdKey,
  )
  .command(
    "encode",
    "Encode JSON value to SCALE",
    {
      ws: { type: "string", demandOption: true, describe: "The websocket URL" },
      storage: {
        type: "string",
        describe: "The '.' separated storage path, example 'system.account'",
      },
      type: { type: "string", describe: "The type name, if --storage isn't provided" },
      value: { type: "string", demandOption: true, describe: "The JSON or Raw value for the type" },
      explain: { type: "boolean", describe: "Explain the output" },
    },
    cmdEncode,
  )
  .command(
    "decode",
    "Decode SCALE hex value to object",
    {
      ws: { type: "string", demandOption: true, describe: "The websocket URL" },
      storage: {
        type: "string",
        describe: "The '.' separated storage path, example 'system.account'",
      },
      type: { type: "string", describe: "The type name, if --storage isn't provided" },
      value: { type: "string", demandOption: true, describe: "The JSON or Raw value for the type" },
      explain: { type: "boolean", describe: "Explain the output" },
    },
    cmdDecode,
  )
  .help()
  .demandCommand().argv;

async function cmdKey(argv: any) {
  const api = await ApiPromise.create({
    initWasm: false,
    provider: new WsProvider(argv["ws"]),
  });

  try {
    let pallet = argv["pallet"];
    let item = argv["item"];
    if (argv["storage"]) {
      const module = resolveModule(api, argv["storage"]);
      pallet = module.prefix;
      item = module.method;
    }

    const palletEncoder = new TextEncoder().encode(pallet);
    const palletHash = xxhashAsU8a(palletEncoder, 128);
    const storageEncoder = new TextEncoder().encode(item);
    const storageHash = xxhashAsU8a(storageEncoder, 128);

    let parts = [...palletHash, ...storageHash];
    if (argv["key"]) {
      const key = new Uint8Array([...hexToU8a(argv["key"])]);
      const keyHash = blake2AsU8a(key, 128);
      parts = parts.concat([...keyHash, ...key]);
    }

    console.log(u8aToHex(new Uint8Array(parts)));
    process.exit(0);
  } catch (e) {
    await api.disconnect();
    throw e;
  }
}

async function cmdEncode(argv: any) {
  const api = await ApiPromise.create({
    initWasm: false,
    provider: new WsProvider(argv["ws"]),
  });

  try {
    const type = argv["type"] || resolveType(api, argv["storage"]);
    const obj = api.createType(type, JSON.parse(argv["value"]));
    const encodingExplained = explainEncoding(obj.inspect());
    if (argv["explain"]) {
      console.log(JSON.stringify(recursiveMerge(obj.toHuman(), encodingExplained), null, 2));
    } else {
      console.log(u8aToHex(obj.toU8a()));
    }

    process.exit(0);
  } catch (e) {
    await api.disconnect();
    throw e;
  }
}

async function cmdDecode(argv: any) {
  const api = await ApiPromise.create({
    initWasm: false,
    provider: new WsProvider(argv["ws"]),
  });

  try {
    const type = argv["type"] || resolveType(api, argv["storage"]);
    const obj = api.createType(type, hexToU8a(argv["value"]));
    const encodingExplained = explainEncoding(obj.inspect());
    if (argv["explain"]) {
      console.log(JSON.stringify(recursiveMerge(obj.toHuman(), encodingExplained), null, 2));
    } else {
      console.log(JSON.stringify(obj.toHuman(), null, 2));
    }
    process.exit(0);
  } catch (e) {
    await api.disconnect();
    throw e;
  }
}

// system.account 0x03000000010000000100000000000000a0a87fdf6c7914067c00000000000000000010632d5ec76b05000000000000000000a0dec5adc93536000000000000000000a0dec5adc9353600000000000000
// timestamp.now  0x6f5e6ca682010000
// parachainStaking.delegationScheduledRequests 0x043de1d51f670b9b6780926722f7bfb92615658818a509000000000010632d5ec76b0500000000000000
// parachainStaking.selectedCandidates 0xb4043f726a4eb956a19314386049769bec89dd0f340cfb2bdd20c5edeeeed2d2fbddb9697f0441668a1610fce4655f77d11184fbf31e497b927326ac9024c275f0719fdaec6356c4eb9f39ecb9c4d37ce12e0b60e17a9c386a691525e6dda539fcb2235b6031c5aa398ae12b0dc423f47d47549095aa8c93a532ade1c15f7cefcac4a7a2f92b8abd927ed987b0339a2446f55d31ed5eac81b466ac76f153f09a6d3937b5f83f8e3db413bd202baf4da5a64879690f3a7d3048f3cb0391bb44b518e5729f07bcc7a45d4515e1ce5d4c42da4b0561f52ef12dee19f9c020472dded9e6d2e46171096a64ea15fa6c4f8c60994c5a56ed5a4ff7b09aa86560afd7d383f4831cce623c9e50647a049f92090fe55e22cc0509872fb6645b0a77e7f1c438afacdad9ac7e6b5d3e39db4e7204d30092a5d4afbe41023aececb1ac968c94107c87c666063e4c1047794829ef09b0b9e5f8a0e48107e88c1b7ca91865db614f2765031248288e9b84079b651d4a2831432baf667f5331764a788d6a872b55beb0264c07723d3e86b3042008911f1c28891fdaf72acf4cbf0aa7d33022b0ad41ac1d7c2289c14ef3d6267032f94c4debfb9361d7e2d5c13d9468795910d1463497cc77105e3fb634b0604d6a9658121ae8e9afb2a0134d8c3b5121af915b10b0978fe9250768144eb55a21134012fb87f94fba469a7f1a6dddbc1ec72e7f08d08b0b8edaf182aac49ce1fac72010afe03b1c0be421b731ebe8a8022a9d37c3a2644a706e29b7873496c2e45101dc2e1ea15c96a1ed18b3173c988a098e957776c8ba74a6a3fdb9df4baa75676e646d24b0bdab0765507a57a5a475823f15902e2912825e2b1a7c0bbdb9fd5fa5b355e59587c2d2c8f6765bf68e195c86bfe3baa7b0f111c176d38de683f3f2adb6e3d87944a605aa69bfe78b1022676a70296492b7c7934576100ac2a52fc992ddacb3b37f0ed79629fa4c716b0e4dc436c20efe81cfe8e9a54cf68580d3aedcc5468ccae70022c740f4e39c65be4f0d368643a161d5d4ccebc0e3984bd7894b8654947fee633ac565df04d37d553ad19957204f075e0a27e435d7bc893ba3e5a3472d8388e6cd51484f75a6b9353124fc48c4eda33e2b5ffb97bb8b901b71b87e5791556fd46bf1046a8d2451055bea477799c19fd3fe815b05c5f6aded301c0ad61f30c248b7e5d9031ae993591bf8614f77a1af0fb1cbc612aebd6242ed9565cae7fc20b2ba58156743fc77d9c458c203920314cb95

const VECTOR_ITEM_COUNT_SCALE_KEY = "_COUNT_";
function explainEncoding(o: any, scaleObj: any = {}) {
  if (!o.inner && o.outer) {
    if (o.name) {
      // object-field
      scaleObj[o.name] = u8aToHex(o.outer[0], null, false);
    } else {
      // primitive
      return u8aToHex(o.outer[0], null, false);
    }
  } else if (o.inner && !o.outer) {
    // object
    if (o.name) {
      // nested
      for (const inner of o.inner) {
        scaleObj[o.name] = explainEncoding(inner, scaleObj[o.name]);
      }
    } else {
      // leaf
      for (const inner of o.inner) {
        scaleObj = explainEncoding(inner, scaleObj);
      }
    }
  } else if (o.inner && o.outer) {
    // array
    scaleObj = [];
    for (const inner of o.inner) {
      scaleObj.push(explainEncoding(inner));
    }

    scaleObj.push({
      [VECTOR_ITEM_COUNT_SCALE_KEY]: {
        value: o.outer[0][0],
        scale: u8aToHex(o.outer[0], null, false),
      },
    });
  }

  return scaleObj;
}

function resolveModule(api: ApiPromise, storagePath: string): { prefix: string; method: string } {
  const parts = storagePath.split(".");
  let storage: any = api.query;
  for (const p of parts) {
    if (!storage[p]) {
      throw new Error(`No handler found for "${storagePath}" - part "${p}"`);
    }
    storage = storage[p];
  }

  return storage["creator"].toJSON()["storage"];
}

function resolveType(api: ApiPromise, storagePath: string): string {
  const parts = storagePath.split(".");
  let storage: any = api.query;
  for (const p of parts) {
    if (!storage[p]) {
      throw new Error(`No handler found for "${storagePath}" - part "${p}"`);
    }
    storage = storage[p];
  }
  const storageType = storage["creator"]["meta"]["type"].toJSON();
  const value = (() => {
    if (storageType["plain"]) {
      return storageType["plain"];
    } else if (storageType["map"]) {
      return storageType["map"]["value"];
    } else {
      throw new Error(`No matching type found for "${storagePath}" - checked 'plain', 'map'"`);
    }
  })();

  return (
    api.registry.lookup.getTypeDef(value).lookupName || api.registry.lookup.getTypeDef(value).type
  );
}

function ensureLengthKeyFirst(a: any) {
  if (!isArray(a)) {
    return a;
  }

  if (a[a.length - 1][VECTOR_ITEM_COUNT_SCALE_KEY]) {
    a.unshift(a.pop());
  }

  return a;
}

function recursiveMerge(a: any, b: any) {
  if (isObject(a) && isObject(b)) {
    return ensureLengthKeyFirst(mergeWith(a, b, recursiveMerge));
  }

  // check for VECTOR_ITEM_COUNT_SCALE_KEY in arrays
  if (a === undefined && b) {
    return b;
  }

  return {
    value: a,
    scale: b,
  };
}
