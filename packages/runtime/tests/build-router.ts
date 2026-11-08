import { build } from "vite";
import { resolve } from "node:path";
import { nativeConfig } from "../../build/src/native.ts";
await build({
  ...nativeConfig(resolve(import.meta.dirname, "../../render"), {
    entry: resolve(import.meta.dirname, "router.tsx"),
    outDir: resolve(import.meta.dirname, "../dist/tests"),
    fileName: "router.js",
  }),
  configFile: false,
});
