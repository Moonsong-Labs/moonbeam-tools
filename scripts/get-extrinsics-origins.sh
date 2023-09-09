#!/bin/bash

echo -n "Enter the relative path (from $(pwd)) to the directory that contains all of Moonbeam's repos (moonbeam, polkadot-sdk, frontier, etc..): "
read projects_root

# Paths to all the pallets being used in Moonbeam
dirs=(
    # Moonbeam
    "moonbeam/pallets/asset-manager"
    "moonbeam/pallets/moonbeam-orbiters"
    "moonbeam/pallets/parachain-staking"
    "moonbeam/pallets/xcm-transactor"
    "moonbeam/pallets/ethereum-xcm"
    # Substrate
    "polkadot-sdk/substrate/frame/assets"
    "polkadot-sdk/substrate/frame/balances"
    "polkadot-sdk/substrate/frame/collective"
    "polkadot-sdk/substrate/frame/conviction-voting"
    "polkadot-sdk/substrate/frame/democracy"
    "polkadot-sdk/substrate/frame/identity"
    "polkadot-sdk/substrate/frame/multisig"
    "polkadot-sdk/substrate/frame/preimage"
    "polkadot-sdk/substrate/frame/proxy"
    "polkadot-sdk/substrate/frame/referenda"
    "polkadot-sdk/substrate/frame/root-testing"
    "polkadot-sdk/substrate/frame/scheduler"
    "polkadot-sdk/substrate/frame/sudo"
    "polkadot-sdk/substrate/frame/timestamp"
    "polkadot-sdk/substrate/frame/treasury"
    "polkadot-sdk/substrate/frame/utility"
    "polkadot-sdk/substrate/frame/whitelist"
    "polkadot-sdk/substrate/frame/system"
    # Polkadot
    "polkadot-sdk/polkadot/xcm/pallet-xcm"
    # Cumulus
    "polkadot-sdk/cumulus/pallets/parachain-system"
    "polkadot-sdk/cumulus/pallets/dmp-queue"
    "polkadot-sdk/cumulus/pallets/xcmp-queue"
    # Moonkit
    "moonkit/pallets/author-inherent"
    "moonkit/pallets/author-mapping"
    "moonkit/pallets/author-slot-filter"
    "moonkit/pallets/maintenance-mode"
    "moonkit/pallets/randomness"
    # Frontier
    "frontier/frame/evm"
    "frontier/frame/ethereum"
    # ORML
    "open-runtime-module-library/xtokens"
)

for i in "${dirs[@]}"; do
    echo "$i"
    dirname=$(basename "$i")
    echo "$(grep -hR -A25 'pallet::call_index' $projects_root/$i/src/lib.rs | egrep -o 'pub fn [^\(]*|ensure_signed|ensure_root|ensure_none|T::\w*::ensure_[\_a-z]*origin' | egrep -v 'removed|ensure_reserved' | paste -d ","  - - | sed "s/pub fn //; s/::ensure_.*//; s/T::/$dirname::/")"
    echo ""
done
