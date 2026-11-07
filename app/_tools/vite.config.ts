/** Reuse the renderer's guarded production universal configuration unchanged. */
import { fileURLToPath } from "node:url";
import { nativeConfig } from "../../packages/render/tools/native-build.ts";

const render = fileURLToPath(new URL("../../packages/render/", import.meta.url));
export default nativeConfig(render, {
  entry: fileURLToPath(new URL("../_view/main.tsx", import.meta.url)),
  outDir: fileURLToPath(new URL("../dist/", import.meta.url)),
  fileName: "ui.js",
});
