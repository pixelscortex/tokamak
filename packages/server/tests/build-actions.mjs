// Extend the existing isolated-fixture build pattern to public plugin artifacts
// and a checked consumer of the actual generated action references.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const target = join(workspace, "packages/server/target");
await mkdir(target, { recursive: true });
const root = await mkdtemp(join(target, "tkm45-actions-"));
try {
  const files = {};
  for (const id of ["a", "b"])
    await cp(new URL(`./fixtures/actions/${id}/`, import.meta.url), join(root, id), { recursive: true });
  for (const id of ["chat", "acp"])
    await cp(join(workspace, `plugins/${id}`), join(root, id), {
      recursive: true,
      filter: (path) => !["dist", "_generated", "node_modules"].includes(path.split("/").at(-1)),
    });
  await cp(join(workspace, "app/tests/fixtures/record"), join(root, "record"), {
    recursive: true,
    filter: (path) => !["dist", "_generated", "node_modules"].includes(path.split("/").at(-1)),
  });
  for (const id of ["record", "a", "b", "chat", "acp"]) {
    const path = join(root, id);
    await writeFile(
      join(path, "backend/tsconfig.json"),
      JSON.stringify({
        extends: join(workspace, "tsconfig.json"),
        compilerOptions: {
          ...(["chat", "acp"].includes(id) ? { skipLibCheck: true } : {}),
          paths: {
            "@tokamak/sdk": [join(workspace, "packages/sdk/src/index.ts")],
            "@tokamak/sdk/web": [join(workspace, "packages/sdk/web.d.ts")],
          },
        },
      }),
    );
    await writeFile(
      join(path, "vite.config.ts"),
      `
import { tokamak } from ${JSON.stringify(join(workspace, "packages/build/src/vite.ts"))};
export default { plugins: [tokamak({ ui: false, plugin: ${JSON.stringify({
        id,
        version: "1.0.0",
        ...(id === "record"
          ? { exports: "./api.ts" }
          : id === "chat"
            ? {
                exports: "./api.ts",
                consumes: ["chat.backend"],
              }
            : id === "acp"
              ? {
                  exports: "./api.ts",
                  depends: { chat: "*" },
                  provides: ["chat.backend"],
                  permissions: ["acp"],
                }
              : id === "a"
                ? { depends: { b: "^1" }, permissions: ["net:127.0.0.1", "env:ACTION_TEST_SECRET"] }
                : {
                    exports: "./api.ts",
                    permissions: [
                      "net:localhost",
                      "net:loopback.tkm.test",
                      "net:private.tkm.test",
                      "net:metadata.tkm.test",
                      "net:mapped.tkm.test",
                      "net:held.tkm.test",
                    ],
                  }),
      })} })] };
`,
    );
    if (id === "chat") {
      const permissions = join(path, "backend/permission-wait.ts");
      await writeFile(permissions, (await readFile(permissions, "utf8")).replace("30 * 60_000", "1_500"));
      const buffer = join(path, "backend/stream-buffer.ts");
      await writeFile(
        buffer,
        (await readFile(buffer, "utf8")).replace("HEARTBEAT_MS = 10_000", "HEARTBEAT_MS = 200"),
      );
    }
    if (id === "chat")
      await writeFile(
        join(path, "backend/testing.ts"),
        `
import { v } from "@tokamak/sdk";
import { mutation, query } from "./_functions";
// Simulate two prior observations of a now-abandoned permission run.
export const abandon = mutation({
  args: { runId: v.id("runs") },
  handler: async ({ db }, { runId }) => {
    const run = await db.get(runId);
    return db.patch(runId, { observations: [{ sweepId: "abandoned", tick: 1, heartbeat: run!.heartbeat ?? 0, unchanged: 2 }] });
  },
});
export const run = query({
  args: { runId: v.id("runs") },
  handler: async ({ db }, { runId }) => {
    const run = await db.get(runId);
    if (!run) return null;
    const { token, ...visible } = run;
    return { ...visible, hasToken: !!token };
  },
});
export const age = mutation({
  args: { runId: v.id("runs"), offset: v.number() },
  handler: ({ db }, { runId, offset }) => db.patch(runId, { startedAt: Date.now() + offset, updatedAt: Date.now() + offset }),
});
`,
      );
    const child = Bun.spawn([process.execPath, join(workspace, "packages/build/src/build.ts"), path], {
      cwd: workspace,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) throw new Error(`Public plugin build failed: ${id}`);
    if (id === "chat") {
      const exported = JSON.parse(await readFile(join(path, "dist/manifest.json"), "utf8")).publicFunctions;
      assert.ok(!exported.includes("threads:setBackend"));
      assert.ok(exported.includes("permissions:request"));
      assert.ok(!exported.includes("permissions:answer"));
    }
    for (const name of ["manifest.json", "bundle.js", "bundle.js.map", "api.ts"])
      files[`${id}/${name}`] = await readFile(join(path, "dist", name), "utf8");
  }
  const driver = join(root, "driver.ts");
  await cp(new URL("./actions-driver.ts", import.meta.url), driver);
  await cp(new URL("./chat-driver.ts", import.meta.url), join(root, "chat-driver.ts"));
  await cp(new URL("./acp-driver.ts", import.meta.url), join(root, "acp-driver.ts"));
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(workspace, "tsconfig.json"),
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        types: ["node"],
        allowImportingTsExtensions: true,
        paths: {
          "@tokamak/sdk": [join(workspace, "packages/sdk/src/index.ts")],
          "@tokamak/sdk/web": [join(workspace, "packages/sdk/web.d.ts")],
        },
      },
      files: [driver],
      include: [],
    }),
  );
  const checked = Bun.spawn(
    [process.execPath, "check", "--no-script", "--no-pretty", "--project", join(root, "tsconfig.json")],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await checked.exited) !== 0) throw new Error("Generated client action references did not type-check");
  const built = await Bun.build({ entrypoints: [driver], target: "bun", format: "esm" });
  if (!built.success) throw new AggregateError(built.logs, "Action driver build failed");
  files["driver.mjs"] = await built.outputs[0].text();
  console.log(JSON.stringify(files));
} finally {
  await rm(root, { recursive: true, force: true });
}
