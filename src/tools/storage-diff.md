# Script that shows the storage diff between 2 blocks:

1. Compares storage between two Substrate blocks - detects new keys, removed keys, and changed values
2. Decodes storage keys - shows human-readable pallet and storage item names
3. Groups output by pallet - organized display for better readability
4. Multiple output formats - console output or JSON
5. Filtering - filter results by specific pallet
6. Save to file - optionally save full diff to JSON

## Usages:

```sh
bun storage-diff.ts ws://localhost:9944 0 1
bun storage-diff.ts ws://localhost:9944 0 1 --filter Balances
bun storage-diff.ts ws://localhost:9944 0 1 --save
bun storage-diff.ts ws://localhost:9944 0 1 --json > diff.json
```

## Example

### Command

```sh
bun src/tools/storage-diff.ts ws://localhost:9901 1 2 --save
```

### Output

```sh
Comparing blocks:
  Block 1: 0x0d9da8c459024fc7701c755b826a0f92b4a87098a06366259c0fc2add5351f1d
  Block 2: 0xf9aae04cce328ed5bdf43410feb6affae54bd7f1214b9f5e492521ebd4f397fa

Fetching storage keys...
Comparing storage values...
Processed 100/199 keys...

=== Storage Diff Summary ===
New keys: 3
Removed keys: 1
Changed values: 14
Unchanged keys: 185
Total keys in block 1: 200
Total keys in block 2: 202

=== New Keys ===

Babe:
  + UnderConstruction:
    Key: 0x1cb6f36e027abb2091cfb5110ab5087fb9093659d7a856809757134d2bc86e62b4def25cfda6ef3a00000000
    Value: 0x04561dc2a537280b401fd5d802cc38f4786116874954b1998c940ebae9c29114...

System:
  + BlockHash:
    Key: 0x26aa394eea5630e07c48ae0c9558cef7a44704b568d21667356a5a050c1187465153cb1f00942ff401000000
    Value: 0x0d9da8c459024fc7701c755b826a0f92b4a87098a06366259c0fc2add5351f1d

Mmr:
  + Nodes:
    Key: 0xa8c65209d47ee80f56b0011e8fd91f50519dfc7fdad21b84f64a5310fa178ef20200000000000000
    Value: 0xedabf3eb881bcde12894be139275cbd93d523706441a96d11188d831961e9f84

=== Removed Keys ===

Mmr:
  - Nodes:
    Key: 0xa8c65209d47ee80f56b0011e8fd91f50519dfc7fdad21b84f64a5310fa178ef20000000000000000
    Value: 0x0d90d52601726dbb73c02d0678b82c8bd7310fab46122e48b35f75d90f0f5789

=== Changed Values ===

Babe:
  ~ CurrentSlot:
    Key: 0x1cb6f36e027abb2091cfb5110ab5087f06155b3cd9a8c9e5e9a23fd5dc13a5ed
    Old: 0xaa96681100000000
    New: 0xab96681100000000
  ~ AuthorVrfRandomness:
    Key: 0x1cb6f36e027abb2091cfb5110ab5087fd077dfdb8adb10f78f10a5df8742c545
    Old: 0x01f55b87676e09624165ae53cb2404b11972681c46ca7ead4cfd91fce9f7d468...
    New: 0x01561dc2a537280b401fd5d802cc38f4786116874954b1998c940ebae9c29114...

System:
  ~ Number:
    Key: 0x26aa394eea5630e07c48ae0c9558cef702a5c1b19ab7a04f536c519aca4983ac
    Old: 0x01000000
    New: 0x02000000
  ~ BlockWeight:
    Key: 0x26aa394eea5630e07c48ae0c9558cef734abf5cb34d6244378cddbf18e849d96
    Old: 0x0000000007cc508fc403ca6b0300
    New: 0x00000000073c576ff00386750300
  ~ Events:
    Key: 0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7
    Old: 0x0800000000000000420c923f551702000000010000000000222d0d1e08020000
    New: 0x0800000000000000420c923f551702000000010000000000e2468dcd31020200...
  ~ ParentHash:
    Key: 0x26aa394eea5630e07c48ae0c9558cef78a42f33323cb5ced3b44dd825fda9fcc
    Old: 0x297c7de0aa54191608b2fc0a09f89d9ffa0e39b50cc0d5d285a41b0ddf9e9228
    New: 0x0d9da8c459024fc7701c755b826a0f92b4a87098a06366259c0fc2add5351f1d
  ~ Digest:
    Key: 0x26aa394eea5630e07c48ae0c9558cef799e7f93fc6a98f0874fd057f111c4d2d
    Old: 0x0c0642414245b5010301000000aa966811000000006ad911b55e13da65d2c00c...
    New: 0x080642414245b5010100000000ab966811000000008012bb360df9a4254bc801...

OnDemand:
  ~ Revenue:
    Key: 0x331bae0b419c2dbbae4e5226b4516ba328944b13cabb1477f1327120c2946737
    Old: 0x0400000000000000000000000000000000
    New: 0x0800000000000000000000000000000000000000000000000000000000000000...

TransactionPayment:
  ~ NextFeeMultiplier:
    Key: 0x3f1467a096bcd71a5b6a0c8155e208103f2edf3bdf381debe331ab7446addfdc
    Old: 0x8249c71ea6a5e00d0000000000000000
    New: 0x49e41eab9894e00d0000000000000000

Staking:
  ~ ErasRewardPoints:
    Key: 0x5f3e4907f716ac89b6347d15ececedca80cc6574281671b299c1727d7ac68cabb4def25cfda6ef3a00000000
    Old: 0x1400000004fe65717dad0447d715f660a0a58411de509b42e6efb8375f562f58...
    New: 0x2800000008be5ddb1579b72e84524fc29e78609e3caf42e85aa118ebfe0b0ad4...

Mmr:
  ~ NumberOfLeaves:
    Key: 0xa8c65209d47ee80f56b0011e8fd91f508156209906244f2341137c136774c91d
    Old: 0x0100000000000000
    New: 0x0200000000000000
  ~ RootHash:
    Key: 0xa8c65209d47ee80f56b0011e8fd91f50d42f676807518c67bb427546ba406fa1
    Old: 0x0d90d52601726dbb73c02d0678b82c8bd7310fab46122e48b35f75d90f0f5789
    New: 0xedabf3eb881bcde12894be139275cbd93d523706441a96d11188d831961e9f84

ParasShared:
  ~ AllowedRelayParents:
    Key: 0xb341e3a63e58a188839b242d17f8c9f89d1fb17def62216d598940d64654f69e
    Old: 0x04297c7de0aa54191608b2fc0a09f89d9ffa0e39b50cc0d5d285a41b0ddf9e92...
    New: 0x08297c7de0aa54191608b2fc0a09f89d9ffa0e39b50cc0d5d285a41b0ddf9e92...

Timestamp:
  ~ Now:
    Key: 0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb
    Old: 0x65304b0398010000
    New: 0xd2474b0398010000

Full diff saved to storage-diff-1-2.json
```