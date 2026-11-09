// Extend the existing isolated-fixture build pattern to public plugin artifacts
// and a checked consumer of the actual generated action references.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const target = join(workspace, "packages/server/target");
await mkdir(target, { recursive: true });
const root = await mkdtemp(join(target, "tkm45-actions-"));
try {
  const files = {};
  for (const id of ["a", "b"])
    await cp(new URL(`./fixtures/actions/${id}/`, import.meta.url), join(root, id), { recursive: true });
  for (const id of ["a", "b"]) {
    const path = join(root, id);
    await writeFile(join(path, "backend/tsconfig.json"), JSON.stringify({
      extends: join(workspace, "tsconfig.json"),
      compilerOptions: { paths: { "@tokamak/sdk": [join(workspace, "packages/sdk/src/index.ts")] } },
    }));
    await writeFile(join(path, "vite.config.ts"), `
import { tokamak } from ${JSON.stringify(join(workspace, "packages/build/src/vite.ts"))};
export default { plugins: [tokamak({ ui: false, plugin: ${JSON.stringify({
      id, version: "1.0.0", ...(id === "a"
        ? { depends: { b: "^1" }, permissions: ["net:127.0.0.1"] }
        : { exports: "./api.ts" }),
    })} })] };
`);
    const child = Bun.spawn([process.execPath, join(workspace, "packages/build/src/build.ts"), path], {
      cwd: workspace, stdout: "inherit", stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error(`Public plugin build failed: ${id}`);
    for (const name of ["manifest.json", "bundle.js", "bundle.js.map", "api.ts"])
      files[`${id}/${name}`] = await readFile(join(path, "dist", name), "utf8");
  }
  const driver = join(root, "driver.ts");
  await cp(new URL("./actions-driver.ts", import.meta.url), driver);
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({
    extends: join(workspace, "tsconfig.json"),
    compilerOptions: { lib: ["ES2022", "DOM"], types: ["node"], allowImportingTsExtensions: true,
      paths: { "@tokamak/sdk": [join(workspace, "packages/sdk/src/index.ts")] } },
    files: [driver], include: [],
  }));
  const checked = Bun.spawn([process.execPath, "check", "--no-script", "--no-pretty", "--project", join(root, "tsconfig.json")], { stdout: "inherit", stderr: "inherit" });
  if (await checked.exited !== 0) throw new Error("Generated client action references did not type-check");
  const built = await Bun.build({ entrypoints: [driver], target: "bun", format: "esm" });
  if (!built.success) throw new AggregateError(built.logs, "Action driver build failed");
  files["driver.mjs"] = await built.outputs[0].text();
  console.log(JSON.stringify(files));
} finally {
  await rm(root, { recursive: true, force: true });
}
