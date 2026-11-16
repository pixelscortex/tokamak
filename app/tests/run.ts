/** Bun-first test preparation: compile the real optional Solid helper against
 * its client runtime, never Solid's Node SSR entry, then run bounded checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { nativeSolid } from "../../packages/build/src/native";
import { nativeConfig } from "../../packages/render/tools/native-build";

for (const fixture of ["bridge", "fairness"]) {
  await build({
    ...nativeConfig(fileURLToPath(new URL("../../packages/render/", import.meta.url)), {
      entry: fileURLToPath(new URL(`./${fixture}.tsx`, import.meta.url)),
      outDir: fileURLToPath(new URL("../dist/tests", import.meta.url)),
      fileName: `${fixture}.js`,
    }),
    configFile: false,
  });
}

for (const fixture of ["query-lifecycle", "backend-discovery", "client-extensions"]) {
  await build({
    configFile: false,
    resolve: { conditions: ["browser"] },
    plugins: [nativeSolid()],
    build: {
      target: "esnext",
      outDir: "dist/tests",
      emptyOutDir: false,
      lib: {
        entry: `tests/${fixture}.${fixture === "client-extensions" ? "tsx" : "ts"}`,
        formats: ["es"],
        fileName: () => `${fixture}.js`,
      },
      rolldownOptions: { external: ["node:assert/strict"] },
    },
  });
  const child = spawnSync(process.execPath, [`dist/tests/${fixture}.js`], {
    stdio: "inherit",
    timeout: 30_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${fixture} regression failed`);
}
