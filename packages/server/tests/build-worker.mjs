import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = join(root, "packages/server/target");
await mkdir(target, { recursive: true });
const temporary = await mkdtemp(join(target, "worker-fixture-"));
try {
  await cp(new URL("./fixtures/worker/", import.meta.url), temporary, { recursive: true });
  await symlink(join(root, "app/node_modules"), join(temporary, "node_modules"), "dir");
  await writeFile(
    join(temporary, "src/server/tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      compilerOptions: {
        types: ["node"],
        lib: ["ES2022", "DOM"],
      },
    }),
  );
  const build = Bun.spawn([process.execPath, join(root, "packages/build/src/build.ts"), temporary], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await build.exited) throw new Error("Worker fixture build failed");
  const files = {};
  for (const name of [
    "manifest.json",
    "bundle.js",
    "bundle.js.map",
    "api.ts",
    "worker-entry.js",
    "worker.js",
    "worker.js.map",
  ])
    files[name] = await readFile(join(temporary, "dist", name), "utf8");
  // Keep both variants so the same old artifact exercises Bun teardown and
  // QuickJS's refusal of imports that the current builder would not allow.
  const legacy = { ...files };
  legacy["worker.js"] += '\nimport { spawn as fixtureSpawn } from "node:child_process";\n';
  legacy["worker.js"] += 'import { writeFileSync as fixtureWriteFile } from "node:fs";\n';
  const manifest = JSON.parse(legacy["manifest.json"]);
  manifest.hashes["worker.js"] = createHash("sha256").update(legacy["worker.js"]).digest("hex");
  legacy["manifest.json"] = JSON.stringify(manifest);
  console.log(JSON.stringify({ portable: files, legacy }));
} finally {
  await rm(temporary, { force: true, recursive: true });
}
