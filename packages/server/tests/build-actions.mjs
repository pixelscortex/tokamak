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
  await cp(join(workspace, "plugins/chat"), join(root, "chat"), {
    recursive: true,
    filter: (path) => !["dist", "_generated", "node_modules"].includes(path.split("/").at(-1)),
  });
  await cp(join(workspace, "plugins/todo"), join(root, "todo"), {
    recursive: true,
    filter: (path) => !["dist", "_generated", "node_modules"].includes(path.split("/").at(-1)),
  });
  for (const id of ["todo", "a", "b", "chat"]) {
    const path = join(root, id);
    await writeFile(
      join(path, "backend/tsconfig.json"),
      JSON.stringify({
        extends: join(workspace, "tsconfig.json"),
        compilerOptions: {
          ...(id === "chat" ? { skipLibCheck: true } : {}),
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
        ...(id === "todo"
          ? { exports: "./api.ts", provides: ["chat.tools"] }
          : id === "chat"
            ? {
                exports: "./api.ts",
                consumes: ["chat.tools"],
                permissions: ["acp", "net:127.0.0.1", "env:OPENROUTER_API_KEY", "env:OPENROUTER_BASE_URL"],
              }
            : id === "a"
              ? { depends: { b: "^1" }, permissions: ["net:127.0.0.1"] }
              : {
                  exports: "./api.ts",
                  provides: ["chat.tools"],
                  consumes: ["chat.tools"],
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
      const permissions = join(path, "backend/permissions.ts");
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
  handler: ({ db }, { runId }) => db.get(runId),
});
export const identities = mutation({
  args: { runId: v.id("runs"), starter: v.string(), owner: v.string() },
  handler: async ({ db }, { runId, starter, owner }) => {
    const run = await db.get(runId);
    await db.patch(runId, { startedBy: starter });
    await db.patch(run!.threadId, { ownerId: owner });
    return null;
  },
});
// Seed completed history to exercise rolling guest quotas without 100 HTTP calls.
export const quota = mutation({
  args: { memberId: v.string(), messageId: v.id("messages"), count: v.number(), age: v.number() },
  handler: async ({ db }, { memberId, messageId, count, age }) => {
    for (const run of await db.query("runs").withIndex("by_starter", q => q.eq("startedBy", memberId)).collect()) await db.delete(run._id);
    const message = await db.get(messageId);
    for (let i = 0; i < count; i++) await db.insert("runs", {
      threadId: message!.threadId, messageId, startedBy: memberId, status: "done",
      model: "openrouter/free", startedAt: Date.now() - age,
    });
    return null;
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
      assert.ok(!exported.some((name) => name.startsWith("permissions:")));
    }
    for (const name of ["manifest.json", "bundle.js", "bundle.js.map", "api.ts"])
      files[`${id}/${name}`] = await readFile(join(path, "dist", name), "utf8");
  }
  const driver = join(root, "driver.ts");
  await cp(new URL("./actions-driver.ts", import.meta.url), driver);
  await cp(new URL("./chat-driver.ts", import.meta.url), join(root, "chat-driver.ts"));
  await cp(new URL("./helpers/completions.ts", import.meta.url), join(root, "completions.ts"));
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
