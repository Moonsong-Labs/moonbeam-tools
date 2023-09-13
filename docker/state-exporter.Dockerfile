# Node for Moonbase Alphanet.
#
# Requires to run from repository root and to copy the binary in the build folder (part of the release workflow)

FROM node:20-bookworm AS builder

RUN mkdir /build
WORKDIR /build

COPY src src
COPY package.json package.json
COPY package-lock.json package-lock.json
COPY tsconfig.json tsconfig.json
RUN npm ci && npm run build:bins &&  ls -la /build/dist/

FROM node:slim
LABEL maintainer "alan@moonsonglabs.com"

RUN mkdir -p /networks/stagenet
RUN mkdir -p /networks/alphanet
RUN mkdir -p /networks/moonriver
RUN mkdir -p /networks/moonbeam
COPY networks/stagenet/moonbase-raw-specs.json /networks/stagenet/moonbase-raw-specs.json
COPY networks/alphanet/moonbase-raw-specs.json /networks/alphanet/moonbase-raw-specs.json
COPY networks/moonriver/moonriver-raw-specs.json /networks/moonriver/moonriver-raw-specs.json
COPY networks/moonbeam/moonbeam-raw-specs.json /networks/moonbeam/moonbeam-raw-specs.json

COPY --from=builder /build/dist/export-state /export-state

# Prepare generate all networks folder

VOLUME ["/data"]

ENTRYPOINT ["/export-state"]