# State manipulator

Allows to download Moonbeam exported state (daily snapshot) and tweak it to make it
authored/controllable

Exemple to allow [Alith](https://github.com/PureStake/moonbeam-tools/blob/main/src/utils/constants.ts#L1) to produce more blocks

```typescript
// Downloads the exported state for Moonbeam
// This will generate 2 files:
// - moonbeam-state-info.json: contains the metadata about the snapshot
// - moonbeam-state.json: contains the exported state as genesis spec file
const stateFile = await downloadExportedState("moonbeam", `/tmp/fork-test/states`);

// Processes the exported state by replacing some storage items
// into the given moonbeam-state.mod.json
await processState(stateFile, stateFile.replace(/.json$/, ".mod.json"), [
  // Reset the round to first block and length 100 for fast rounds
  new RoundManipulator((current, first, length) => {
    return { current, first: 0, length: 100 };
  }),

  // Allows all collators to produce at each block height
  new AuthorFilteringManipulator(100),

  // Replace one of the collator by Alith to allow producing blocks
  new CollatorManipulator(ALITH_ADDRESS, ALITH_SESSION_ADDRESS),

  // Reset the HRMP data
  new HRMPManipulator(),
    
  // Removes real networking data from th4e specs
  new SpecManipulator({
    name: `Fork Network`,
    relayChain: `rococo-local`,
  }),

  // Make the Open Technical committee governed by Alith
  new CollectiveManipulator("OpenTechCommitteeCollective", [ALITH_ADDRESS]),

  // Reset the validation data
  new ValidationManipulator(),

  // Reset the XCMP data
  new XCMPManipulator(),

  // Ensure Alith gets enough token
  new BalancesManipulator([{ account: ALITH_ADDRESS, amount: 10_000n * 10n ** 18n }]),
]);
```

