import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = join(root, "packages/server/target");
await mkdir(target, { recursive: true });
const temporary = await mkdtemp(join(target, "worker-fixture-"));
try {
  await cp(new URL("./fixtures/worker/", import.meta.url), temporary, { recursive: true });
  await symlink(join(root, "app/node_modules"), join(temporary, "node_modules"), "dir");
  const build = Bun.spawn([process.execPath, join(root, "packages/build/src/build.ts"), temporary], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await build.exited) throw new Error("Worker fixture build failed");
  const files = {};
  const manifestText = await readFile(join(temporary, "dist/manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const local = Object.values(manifest.entries.local ?? {});
  files["manifest.json"] = manifestText;
  for (const name of [
    "bundle.js",
    "bundle.js.map",
    "api.ts",
    "transactions.js",
    "transactions.js.map",
    ...local,
  ])
    files[name] = await readFile(join(temporary, "dist", name), "utf8");
  // An installed legacy action bundle must still be inspected by QuickJS.
  const legacy = {
    ...files,
    "bundle.js": files["transactions.js"],
    "bundle.js.map": files["transactions.js.map"],
    "worker-entry.js": "",
    "worker.js": 'import "node:child_process"; export const functions = {};',
    "worker.js.map": files["bundle.js.map"],
  };
  delete legacy["transactions.js"];
  delete legacy["transactions.js.map"];
  delete manifest.entries.local;
  for (const name of local) {
    delete legacy[name];
    delete manifest.hashes[name];
  }
  manifest.plugin.runtime = "worker";
  manifest.entries.worker = { entry: "worker-entry.js", code: "worker.js", map: "worker.js.map" };
  delete manifest.hashes["transactions.js"];
  delete manifest.hashes["transactions.js.map"];
  for (const [name, source] of Object.entries(legacy))
    if (name !== "manifest.json") manifest.hashes[name] = createHash("sha256").update(source).digest("hex");
  legacy["manifest.json"] = JSON.stringify(manifest);
  console.log(JSON.stringify({ portable: files, legacy }));
} finally {
  await rm(temporary, { force: true, recursive: true });
}
