import path from "node:path";
import fs from "node:fs/promises";
import { Manipulator, processState } from "../src/libs/helpers/state-manipulator";
import { RoundManipulator } from "../src/libs/helpers/state-manipulators/round-manipulator";
import { AuthorFilteringManipulator } from "../src/libs/helpers/state-manipulators/author-filtering-manipulator";
import { CollatorManipulator } from "../src/libs/helpers/state-manipulators/collator-manipulator";
import { ALITH_ADDRESS, ALITH_SESSION_ADDRESS } from "../src/utils/constants";

const ROUND_MANIPULATOR: Manipulator = new RoundManipulator((current, first, length) => {
  return { current, first: 0, length: 100 };
});
const AUTHOR_FILTERING_MANIPULATOR: Manipulator = new AuthorFilteringManipulator(100);
const COLLATOR_MANIPULATION: Manipulator = new CollatorManipulator(
  ALITH_ADDRESS,
  ALITH_SESSION_ADDRESS
);

describe("State Manipulation", () => {
  const inFile = path.join(__dirname, "sample-state.json");
  const outFile = path.join(__dirname, "sample-state-result.json");
  let finalState: any;

  beforeAll(async () => {
    await processState(inFile, outFile, [
      ROUND_MANIPULATOR,
      AUTHOR_FILTERING_MANIPULATOR,
      COLLATOR_MANIPULATION,
    ]);
    const genesis = await JSON.parse((await fs.readFile(outFile)).toString());
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
});
