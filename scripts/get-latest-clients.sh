#!/bin/bash

# Note this will download the pre-compiled binaries from GitHub
# These by default will not work with Apple Silicon CPUs (incompatible arch)
# Instead, compile natively from their respective repos.

PARENT_PATH=$( cd "$(dirname "${BASH_SOURCE[0]}")" ; pwd -P )
cd $PARENT_PATH
cd ../binaries


# Update script to checksum MD5 hashes of binaries to see if already most uptodate
echo "Retrieving binaries..."
MOONBEAM_CLIENT_TAG=$(curl -s https://api.github.com/repos/purestake/moonbeam/releases | jq -r '.[] | select(.assets|.[]|.name|test("\\bmoonbeam\\b")) | .tag_name' | grep '^v' | head -1)
POLKADOT_CLIENT_TAG=$(curl -s https://api.github.com/repos/paritytech/polkadot/releases | jq -r '.[] | select(.assets|.[]|.name|test("\\bpolkadot\\b")) | .tag_name' | grep '^v' | head -1)

echo "Downloading polkadot ${POLKADOT_CLIENT_TAG}"
wget -q https://github.com/paritytech/polkadot/releases/download/${POLKADOT_CLIENT_TAG}/polkadot  

echo "Downloading moonbeam ${MOONBEAM_CLIENT_TAG}"
wget -q https://github.com/PureStake/moonbeam/releases/download/${MOONBEAM_CLIENT_TAG}/moonbeam 

chmod uog+x moonbeam
chmod uog+x polkadot