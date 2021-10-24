#!/bin/bash

# It requires to have run "npm run build" and updated the package.json version
# It needs to run from the root directory of this repo
SHA="$(cat dist/index.umd.js | openssl dgst -sha384 -binary | openssl enc -base64 -A)"
VERS="$(cat package.json | grep version | grep -o '[0-9]*\.[0-9]*\.[0-9]*')"

echo "Updating README.md with moonbeam-tools@${VERS} (sha384-${SHA})"

sed -i.bak \
 -e "s/moonbeam-tools@[0-9]*\.[0-9]*\.[0-9]*/moonbeam-tools@$VERS/" \
 -e "s|index.umd.js\" charset=\"UTF-8\" integrity=\"sha384-[^\"]*|index.umd.js\" charset=\"UTF-8\" integrity=\"sha384-$SHA|g" \
 README.md