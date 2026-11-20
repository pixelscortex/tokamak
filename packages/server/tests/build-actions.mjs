import { bunPluginReferences } from "../../sdk/tools/plugin-boundary.mjs";
// Extend the existing isolated-fixture build pattern to public plugin artifacts
// and a checked consumer of the actual generated action references.
import { symlink, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  for (const id of ["chat", "acp"]) {
    await cp(join(workspace, `plugins/${id}`), join(root, id), {
      recursive: true,
      filter: (path) => !["dist", "_generated", "node_modules", ".tokamak"].includes(path.split("/").at(-1)),
    });
    // The fixture calls the checkout's builder directly and installs only the plugin's runtime packages.
    const path = join(root, id, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    delete manifest.devDependencies;
    await writeFile(path, JSON.stringify(manifest));
  }
  await cp(join(workspace, "packages/server/tests/fixtures/record"), join(root, "record"), {
    recursive: true,
    filter: (path) => !["dist", "_generated", "node_modules", ".tokamak"].includes(path.split("/").at(-1)),
  });
  // Resolve fixture libraries from the checkout while building in dependency order.
  for (const id of ["record", "a", "b"])
    await symlink(join(workspace, "app/node_modules"), join(root, id, "node_modules"), "dir");
  for (const id of ["record", "b", "a", "chat", "acp"]) {
    const path = join(root, id);
    // Replace the copied workspace-relative client config; SDK dependencies
    // resolve through the installed package symlinks above.
    if (id === "chat")
      await writeFile(join(path, "tsconfig.json"), JSON.stringify({ extends: join(root, "tsconfig.json") }));
    await writeFile(
      join(
        path,
        ["chat", "acp", "record"].includes(id) ? "src/server/tsconfig.json" : "backend/tsconfig.json",
      ),
      JSON.stringify({
        extends: join(workspace, "tsconfig.json"),
        compilerOptions: {
          ...(["chat", "acp"].includes(id) ? { skipLibCheck: true } : {}),
          ...(id === "acp" ? { types: ["node"], lib: ["ES2022", "DOM"] } : {}),
        },
      }),
    );
    // Migrated packages use their real descriptor; only legacy transport
    // fixtures still need an inline definition.
    const options = ["record", "chat", "acp"].includes(id)
      ? { ui: false }
      : {
          ui: false,
          plugin: {
            id,
            version: "1.0.0",
            ...(id === "a"
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
          },
        };
    await writeFile(
      join(path, "vite.config.ts"),
      `import { tokamak } from ${JSON.stringify(join(workspace, "packages/build/src/vite.ts"))};
export default { plugins: [tokamak(${JSON.stringify(options)})] };`,
    );
    if (id === "acp") {
      await writeFile(
        join(path, "src/server/testing.ts"),
        `import {action} from "@tokamak/sdk"; export const crash = action({handler: () => process.exit(9)});`,
      );
      const discovery = join(path, "src/server/agents/discovery.ts");
      const original = await readFile(discovery, "utf8");
      await writeFile(
        discovery,
        original.replace(
          /export const BUILTINS: Agent\[\] = \[[\s\S]*?\n\];/,
          `export const BUILTINS: Agent[] = [
        {id: "fake", title: "fake", command: process.env.ACP_TEST_AGENT ?? "/missing-agent", args: ["fake"]},
        {id: "fresh", title: "fresh", command: process.env.ACP_TEST_AGENT ?? "/missing-agent", args: ["fresh"]},
      ];`,
        ),
      );
      const descriptor = join(path, "plugin.ts");
      await writeFile(
        descriptor,
        (await readFile(descriptor, "utf8")).replace(
          'runtime: "worker",',
          'runtime: "worker", permissions: ["env:ACP_TEST_AGENT"],',
        ),
      );
    }
    if (id === "acp") {
      const permissions = join(path, "src/server/turn/permission-poller.ts");
      await writeFile(permissions, (await readFile(permissions, "utf8")).replace("30 * 60_000", "1_500"));
      const buffer = join(path, "src/server/turn/turn-buffer.ts");
      await writeFile(
        buffer,
        (await readFile(buffer, "utf8")).replace("HEARTBEAT_MS = 10_000", "HEARTBEAT_MS = 200"),
      );
    }
    if (id === "chat")
      await writeFile(
        join(path, "src/server/testing.ts"),
        `
import { v } from "@tokamak/sdk";
import { mutation, query } from "./_functions";
import { api } from "./_generated/api";
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
export const lateHeartbeat = mutation({
  args: { runId: v.id("runs"), token: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, { expiresAt: Date.now() - 1 });
    // Expire and attempt the write in the same transaction, before the sweep can run.
    return ctx.use(api.send).update({ ...args, sequence: 1, delta: "" });
  },
});
export const seedTranscript = mutation({
  args: { threadId: v.id("threads"), count: v.number(), size: v.number() },
  handler: async ({ db }, { threadId, count, size }) => {
    const latest = await db.query("messages").withIndex("by_threadId_createdAt", (q) => q.eq("threadId", threadId)).order("desc").first();
    const start = Math.max(Date.now(), (latest?.createdAt ?? 0) + 1);
    const body = "💬".repeat(size);
    for (let i = 0; i < count; i++) await db.insert("messages", {
      threadId, role: "user", status: "complete", createdAt: start + i,
      parts: [{ type: "text", text: i + ":" + body }], author: { id: "other", name: "Other" },
    });
    return null;
  },
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
    for (const name of [
      "manifest.json",
      "bundle.js",
      "bundle.js.map",
      "api.ts",
      "public.d.ts",
      ...(id === "acp" ? ["worker-entry.js", "worker.js", "worker.js.map"] : []),
    ])
      files[`${id}/${name}`] = await readFile(join(path, "dist", name), "utf8");
  }
  const driver = join(root, "driver.ts");
  await cp(new URL("./actions-driver.ts", import.meta.url), driver);
  await cp(new URL("./chat-driver.ts", import.meta.url), join(root, "chat-driver.ts"));
  await cp(new URL("./chat-acp-driver.ts", import.meta.url), join(root, "chat-acp-driver.ts"));
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(workspace, "tsconfig.json"),
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        types: ["node"],
        allowImportingTsExtensions: true,
        paths: {
          "plugin:b/server": [join(root, "a/.tokamak/types/b/server.d.ts")],
          "plugin:chat/server": [join(root, "acp/.tokamak/types/chat/server.d.ts")],
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
  const built = await Bun.build({
    entrypoints: [driver],
    target: "bun",
    format: "esm",
    plugins: [bunPluginReferences(join(root, "acp"))],
  });
  if (!built.success) throw new AggregateError(built.logs, "Action driver build failed");
  files["driver.mjs"] = await built.outputs[0].text();
  console.log(JSON.stringify(files));
} finally {
  await rm(root, { recursive: true, force: true });
}
