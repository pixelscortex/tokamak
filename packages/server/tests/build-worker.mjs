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
    "public.d.ts",
    "worker-entry.js",
    "worker.js",
    "worker.js.map",
  ])
    files[name] = await readFile(join(temporary, "dist", name), "utf8");
  console.log(JSON.stringify(files));
} finally {
  await rm(temporary, { force: true, recursive: true });
}
