import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import json from "@rollup/plugin-json";
import alias from "@rollup/plugin-alias";
import { terser } from "rollup-plugin-terser";
import babel from "@rollup/plugin-babel";
import { preserveShebangs } from "rollup-plugin-preserve-shebangs";
import nodePolyfills from "rollup-plugin-polyfill-node";
import pkg from "./package.json";

export default [
  // browser-friendly UMD build
  {
    input: "src/index.ts",
    output: {
      name: "mbTools",
      file: pkg.browser,
      format: "umd",
      sourcemap: true,
    },
    plugins: [
      alias({ debug: "node_modules/debug/dist/debug.js" }),
      resolve({
        browser: true,
        preferBuiltins: false,
        crypto: true,
      }),
      json(),
      typescript({ tsconfig: "./tsconfig.json", sourceMap: true }),
      commonjs(),
      nodePolyfills(),
      babel({
        babelHelpers: "bundled",
      }),
      terser(),
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
      typescript({ tsconfig: "./tsconfig.json" }),
    ],
  },
  {
    input: "src/monitor.ts",
    output: [{ file: pkg.bin["moonbeam-monitor"], format: "cjs" }],
    plugins: [
      commonjs({
        include: ["node_modules/debug/src/index.js"],
      }),
      preserveShebangs(),
      typescript({ tsconfig: "./tsconfig.json" }),
    ],
  },
];
