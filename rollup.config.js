import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import dts from "rollup-plugin-dts";
import esbuild from "rollup-plugin-esbuild";
import { preserveShebangs } from "rollup-plugin-preserve-shebangs";
import pkg from "./package.json";

const optimizer = (server) =>
  esbuild({
    include: /\.[jt]sx?$/,
    minify: true,
    target: "es2020",
  });

export default [
  // browser-friendly UMD build
  {
    input: "src/index.ts",
    output: {
      name: "mbTools",
      file: pkg.browser,
      format: "umd",
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false,
        crypto: true,
      }),
      json(),
      commonjs(),
      optimizer(),
    ],
  },

  // CommonJS (for Node) and ES module (for bundlers) build.
  // (We could have three entries in the configuration array
  // instead of two, but it's quicker to generate multiple
  // builds from a single configuration where possible, using
  // an array for the `output` option, where we can specify
  // `file` and `format` for each target)
  {
    input: "src/index.ts",
    output: [
      { file: pkg.main, format: "cjs" },
      { file: pkg.module, format: "es" },
    ],
    plugins: [
      commonjs({
        include: ["node_modules/debug/src/index.js"],
      }),
      optimizer(),
    ],
  },
  {
    input: "./build/src/index.d.ts",
    output: [{ file: "dist/index.d.ts", format: "es" }],
    plugins: [dts()],
  },
];
