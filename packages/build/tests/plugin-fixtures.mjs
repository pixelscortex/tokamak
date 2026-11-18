// Public-builder fixtures for import boundary regressions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = fileURLToPath(new URL("../../../", import.meta.url));
export async function source(root, id, code, options = { backend: false }) {
  const path = resolve(root, id);
  await mkdir(resolve(path, "src"), { recursive: true });
  try {
    await symlink(resolve(workspace, "app/node_modules"), resolve(path, "node_modules"), "dir");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await writeFile(
    resolve(path, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", type: "module" }),
  );
  await writeFile(
    resolve(path, "tsconfig.json"),
    JSON.stringify({ extends: resolve(workspace, "app/tsconfig.json"), include: ["src"] }),
  );
  await writeFile(
    resolve(path, "vite.config.ts"),
    `import { tokamak } from "${workspace}/packages/build/src/vite.ts"; export default { plugins: [tokamak(${JSON.stringify(options)})] };`,
  );
  await writeFile(resolve(path, "src/main.tsx"), code);
  return path;
}
export function build(path) {
  const result = spawnSync(process.execPath, [resolve(workspace, "packages/build/src/build.ts"), path], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}
export function built(path) {
  const result = build(path);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
