# Retrieves block number from https://polkadot.subscan.io/event?address=&module=system&event=codeupdated&startDate=&endDate=&startBlock=&endBlock=&timeType=date&version=9110

WESTEND_BLOCKS=(
    7982889
    7968866
    7911691
    7766394
    7752186
    7568453
    6979141
    6379314
    6210274
    6117927
    5897316
)

KUSAMA_BLOCKS=(
    9866422
    9625129
    9611377
    8945245
    8555825
    8073833
    8010981
    7812476
    7668600
    7468792
    7100891
)

POLKADOT_BLOCKS=(
    7229126
    7217907
    6713249
    6321619
    5661442
    4876134
)


for network in westend kusama polkadot; do
    for block in $(eval echo "\${${network^^}_BLOCKS[@]}"); do
        echo "${network} block for ${block}"
        ./node_modules/.bin/ts-node src/tools/get-relay-runtime.ts --network $network \
            --at $block --output runtime.wasm
        INFO=`subwasm --json info runtime.wasm | jq -r .core_version | cut -f1 -d' '`
        echo "   $INFO"
        mv runtime.wasm "${INFO}.wasm"
    done
done