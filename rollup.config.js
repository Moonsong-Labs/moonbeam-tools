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
];
