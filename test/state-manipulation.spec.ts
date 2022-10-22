import path from "node:path";
import fs from "node:fs/promises";
import { processState } from "../src/libs/helpers/genesis-parser";
import { RoundManipulator } from "../src/libs/helpers/state-manipulators/round-manipulator";
import { AuthorFilteringManipulator } from "../src/libs/helpers/state-manipulators/author-filtering-manipulator";
import { BalancesManipulator } from "../src/libs/helpers/state-manipulators/balances-manipulator";
import { CollatorManipulator } from "../src/libs/helpers/state-manipulators/collator-manipulator";
import { HRMPManipulator } from "../src/libs/helpers/state-manipulators/hrmp-manipulator";
import { XCMPManipulator } from "../src/libs/helpers/state-manipulators/xcmp-manipulator";
import { CollectiveManipulator } from "../src/libs/helpers/state-manipulators/collective-manipulator";
import { ValidationManipulator } from "../src/libs/helpers/state-manipulators/validation-manipulator";
import {
  CHARLETH_ADDRESS,
  CHARLETH_SESSION_ADDRESS,
  HEATH_ADDRESS,
  JUDITH_ADDRESS,
  BALTATHAR_ADDRESS,
} from "../src/utils/constants";
import { hexToBigInt, nToHex } from "@polkadot/util";

describe("State Manipulation", () => {
  const inFile = path.join(__dirname, "sample-state.json");
  const outFile = path.join(__dirname, "sample-state-result.json");
  let genesis: any;
  let finalState: any;

  beforeAll(async () => {
    await processState(inFile, outFile, [
      new RoundManipulator((current, first, length) => {
        return { current, first: 0, length: 100 };
      }),
      new AuthorFilteringManipulator(100),
      new CollatorManipulator(CHARLETH_ADDRESS, CHARLETH_SESSION_ADDRESS),
      new HRMPManipulator(),
      new CollectiveManipulator("TechCommitteeCollective", [CHARLETH_ADDRESS, HEATH_ADDRESS]),
      new CollectiveManipulator("CouncilCollective", [JUDITH_ADDRESS]),
      new ValidationManipulator(),
      new XCMPManipulator(),
      new BalancesManipulator([
        { account: BALTATHAR_ADDRESS, amount: 10n * 10n ** 18n },
        { account: CHARLETH_ADDRESS, amount: 10_000_000n * 10n ** 18n },
        { account: HEATH_ADDRESS, amount: 10_000_000n * 10n ** 18n },
        { account: JUDITH_ADDRESS, amount: 10_000_000n * 10n ** 18n },
      ]),
    ]);
    genesis = await JSON.parse((await fs.readFile(outFile)).toString());
    finalState = genesis.genesis.raw.top;
  });

  it("Should replace the round", async () => {
    expect(
      finalState["0xa686a3043d0adcf2fa655e57bc595a7813792e785168f725b60e2969c7fc2552"]
    ).toEqual("0x010000000000000064000000");
  });

  it("Should set the authoring ratio to 100", async () => {
    expect(
      finalState["0x76310ee24dbd609d21d08ad7292757d0e48df801946c7a0cc54f1a4e51592741"]
    ).toEqual("0x64");
  });

  it("Should set the highest slot seen to 0", async () => {
    expect(
      finalState["0xab2a8d5eca218f218c6fda6b1d22bb926bc171ab77f6a731a6e80c34ee1eda19"]
    ).toEqual("0x00000000");
  });

  it("Should set the relay block block to 0", async () => {
    expect(
      finalState["0x45323df7cc47150b3930e2666b0aa313a2bca190d36bd834cc73a38fc213ecbd"]
    ).toEqual("0x00000000");
  });

  it("Should remove replaced collator mapping key", async () => {
    expect(
      finalState[
        "0x5b372fc04a0451c794728fe29e402669e9e0ec07005839bd9935e1fc3cd7a790de1e86a9a8c739864cf3cc5ec2bea59fd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
      ]
    ).toBeUndefined();
  });

  it("Should add new Charleth mapping key", async () => {
    expect(
      finalState[
        "0x5b372fc04a0451c794728fe29e402669e9e0ec07005839bd9935e1fc3cd7a790b0edae20838083f2cde1c4080db8cf8090b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe22"
      ]
    ).toBeDefined();
  });

  it("Should replace collator nimbus lookup", async () => {
    expect(
      finalState[
        "0x5b372fc04a0451c794728fe29e402669fc15f39d72afe5bef1d5e072b584e92e9dfefc73f89d24437a9c2dce5572808af24ff3a9cf04c71dbc94d0b566f7a27b94566cac"
      ]
    ).toEqual("0x90b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe22");
  });

  it("Should reset hrmp dmq head", async () => {
    expect(
      finalState["0x45323df7cc47150b3930e2666b0aa3132a47b0ddcc4fcdffe6c6b0b119e45c28"]
    ).toEqual(
      "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000004e9030000e80300000090010000900100000000000000000001c24aa1fd60158a40d794729120bc52664e2d5c479541df142237fe2ed9141dea04e9030000e80300000090010000900100000000000000000000"
    );
  });

  it("Should reset last dmq head", async () => {
    expect(
      finalState["0x45323df7cc47150b3930e2666b0aa313911a5dd3f1155f5b7d0c5aa102a757f9"]
    ).toBeUndefined();
  });

  it("Should replace the council members with JUDITH_ADDRESS", async () => {
    expect(
      finalState["0xd59b9be6f0a7187ca6630c1d0a9bb045ba7fb8745735dc3be2a2c61a72c39e78"]
    ).toEqual(`0x04${JUDITH_ADDRESS.slice(2)}`);
  });

  it("Should replace the technical committee members with Charleth and Heath", async () => {
    expect(
      finalState["0xa06bfb73a86f8f98d5c5dc14e20e8a03ba7fb8745735dc3be2a2c61a72c39e78"]
    ).toEqual(`0x08${CHARLETH_ADDRESS.slice(2)}${HEATH_ADDRESS.slice(2)}`);
  });

  it("Should reset the parent number to 0", async () => {
    expect(
      finalState["0x45323df7cc47150b3930e2666b0aa313d422e17d2affdce4a912d187a734dd67"]
    ).toEqual(
      "0x09068fb148029ac3482b5096b7ab8a196720f445474b612378ed272d9e1da91830b73e86ab00e92b950bf6be4eb982268d0a9168f5b42c7d5f025f33f20ecf5c5b5941272f9ff507348b0b431154f273fb96eec37dd294b66b366a19a9f5f738dd3745be589c10066e6d627380f2548664997fc77e7a04adeb0f60263fe67877f8a41084565ead7f555f3a25490672616e648101b2d83cbbe336e457b369bfc3aa53882fa39539e526fa52dadd87f990846bf1147b5990ccfeb79231b7fdd510c85365cdf699a4e975250978111aca28c960680c6016ff503e7916cf2808242d57d6d3d0725a1f0fae3b1e9b0f59a32ae9ef1b040466726f6e090101a8b8a6f7ac20215d00a5dfc3c63c0553bf240706a120e9e3a04c9482692a41b304f5f08c9b881f0dbcfccfaaf409d5b978522cc139e456b2f8be8c2ab0da3e473d056e6d62730101288cb5034e627fd3b6eb0e43cfb643cd1252f801019d169ba6379bb9067de51aa79ce5b8055c2fcb80e904ba2716e49f4be16b00e6e51041b449d7705f130b8f000000003134427780f1b1ddf031572862912382837f80d931bd43292906196596c59f2e00005000"
    );
  });

  it("Should not have any bootnode", async () => {
    expect(genesis.bootNodes.length).toEqual(0);
  });

  it("Should set Charleth, Heath and Judith to 1000 tokens", async () => {
    expect(
      finalState[
        "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9651aca4ff68afaf3e32977bd43127854798d4ba9baf0064ec19eb4f0a1a45785ae9d6dfc"
      ]
    ).toEqual(
      "0x000000000000000001000000000000000000004a480114169545080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
    );
    expect(
      finalState[
        "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9681ea14d90174bedb87d7c2f17b01c7b931f3600a299fd9b24cefb3bff79388d19804bea"
      ]
    ).toEqual(
      "0x000000000000000001000000000000000000004a480114169545080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
    );
    expect(
      finalState[
        "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9451add8cf6b8de2b5366771c94b931bf2898fe7a42be376c8bc7af536a940f7fd5add423"
      ]
    ).toEqual(
      "0x000000000000000001000000000000000000004a480114169545080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
    );
  });

  it("Should have reduced Baltathar to 10 tokens", async () => {
    expect(
      finalState[
        "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da91776cb37549363b87202d975457c9e0e3cd0a705a2dc65e5b1e1205896baa2be8a07c6e0"
      ]
    ).toEqual(
      "0x000000000100000001000000000000000000e8890423c78a0000000000000000000010632d5ec76b05000000000000000000a0dec5adc93536000000000000000000a0dec5adc9353600000000000000"
    );
  });

  it("Should have recompute totalIssuance", async () => {
    const difference =
      10_000_000n * 10n ** 18n - // charleth
      1208925819614629174706176n +
      2n * (10_000_000n * 10n ** 18n) + // heath and judith
      (10n * 10n ** 18n - 1208825819614629174706176n); // baltathar
    expect(
      finalState["0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80"]
    ).toEqual(
      nToHex(hexToBigInt("0x000000e3c8666c53467b060000000000", { isLe: true }) + difference, {
        isLe: true,
        bitLength: 128,
      })
    );
  });
});
