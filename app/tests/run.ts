/** Bun-first test preparation: compile the real optional Solid helper against
 * its client runtime, never Solid's Node SSR entry, then run bounded checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { nativeConfig } from "../../packages/render/tools/native-build";

await build({
  ...nativeConfig(fileURLToPath(new URL("../../packages/render/", import.meta.url)), {
    entry: fileURLToPath(new URL("./bridge.tsx", import.meta.url)),
    outDir: fileURLToPath(new URL("../dist/tests", import.meta.url)),
    fileName: "bridge.js",
  }),
  configFile: false,
});

await build({
  configFile: false,
  resolve: { conditions: ["browser"] },
  build: {
    target: "esnext",
    outDir: "dist/tests",
    emptyOutDir: false,
    lib: { entry: "tests/query-lifecycle.ts", formats: ["es"], fileName: () => "query-lifecycle.js" },
    rolldownOptions: { external: ["node:assert/strict"] },
  },
});
const child = spawnSync(process.execPath, ["dist/tests/query-lifecycle.js"], {
  stdio: "inherit",
  timeout: 30_000,
});
assert.ifError(child.error);
assert.equal(child.status, 0, "SDK lifecycle regression failed");
