/** Compile native acceptance TSX with the shipped Vite production helper. */
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { nativeConfig } from "../../render/tools/native-build";
const root = fileURLToPath(new URL("../../render/", import.meta.url));
await build({
  ...nativeConfig(root, {
    entry: fileURLToPath(new URL("fixture.tsx", import.meta.url)),
    outDir: "dist/tests",
    fileName: "ui-elements.js",
  }),
  configFile: false,
});
