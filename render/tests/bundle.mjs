// The acceptance fixture uses the shipped Vite config, not a second JSX compiler.
// Composed maps must reach original TSX lines directly; nested inline maps are
// an obsolete Bun encoding detail, not the native source-map contract.
import { build } from "vite";
import { nativeConfig } from "../tools/native-build.ts";
import { assertOriginalMapping } from "./source-maps.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of ["component", "typed-component"]) {
  const entry = fileURLToPath(new URL(`./fixtures/${name}.tsx`, import.meta.url));
  await build({ ...nativeConfig(root, { entry, outDir: "dist/tests", fileName: `${name}.js` }), configFile: false });
  await assertOriginalMapping(`${root}/dist/tests/${name}.js`, entry,
    name === "component" ? [
      ["promise settled", 'setHost("promise settled")'],
      ["fixture listener failure", 'throw new Error("fixture listener failure")'],
    ] : [["initial", 'createSignal("initial")'], ["typed", '<p id="typed">']]);
}
const map = JSON.parse(await readFile(`${root}/dist/tests/component.js.map`, "utf8"));
assert(map.sources.some((p) => p.endsWith("js/index.ts")));
console.log("Acceptance Vite universal/client bundles + composed original TSX line mappings passed");
