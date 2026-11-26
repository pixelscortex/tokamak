// Offline launch hooks shared by the recording agent and the two CLI replays.
import assert from "node:assert/strict";
import { cp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentTurns } from "./agent-turn.mjs";
import { build, workspace } from "./harness.mjs";

export const LAUNCH_VALUE = "tokamak-replay-launch-value";

export async function installLaunchHook(h, id = "launch-first") {
  await install(
    h,
    id,
    `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hook } from "@tokamak/sdk";
import { api } from "plugin:ai/server";

export const launch = hook(api.turn.points.launch, {
  async before(_ctx, initial) {
    const data = await readFile(join(process.env.HOME!, "${id}.json"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (data === undefined) return initial;
    const value = JSON.parse(data);
    if (value.error) throw new Error(value.error);
    return { env: { ...initial.env, ...value.env }, args: [...initial.args, ...value.args] };
  },
});
`,
  );
  return {
    set: (env, args = []) => writeFile(join(h.home, `${id}.json`), JSON.stringify({ env, args })),
    throws: (error) => writeFile(join(h.home, `${id}.json`), JSON.stringify({ error })),
    clear: () => unlink(join(h.home, `${id}.json`)),
  };
}

async function install(h, id, source) {
  const folder = join(h.scratch, "sources", id);
  await mkdir(join(folder, "src/server"), { recursive: true });
  await symlink(join(workspace, "plugins/ai/node_modules"), join(folder, "node_modules"), "dir");
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: id, type: "module" }));
  await writeFile(
    join(folder, "plugin.ts"),
    `
import { definePlugin } from "@tokamak/sdk";
export default definePlugin({ id: "${id}", version: "1.0.0", depends: ["ai"] });
`,
  );
  await writeFile(
    join(folder, "src/server/tsconfig.json"),
    JSON.stringify({
      extends: join(workspace, "tsconfig.json"),
      compilerOptions: { skipLibCheck: true },
    }),
  );
  await writeFile(join(folder, "src/server/launch.ts"), source);
  build(folder);
  await cp(join(folder, "dist"), join(h.plugins, id), { recursive: true });
}

async function installRecordingAgent(h) {
  await install(
    h,
    "recording-agent",
    `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { action, provide } from "@tokamak/sdk";
import { agent, type Info, type Run } from "plugin:ai/contracts";

const info = action({
  on: "caller",
  handler: async (): Promise<Info> => {
    await writeFile(join(process.env.HOME!, "recording-agent-probed"), "");
    return { installed: true, signedIn: true, install: "", signIn: "",
      models: [{ id: "recording", name: "Recording", efforts: [] }], speeds: [], modes: [] };
  },
});
const start = action({
  on: "caller",
  handler: async (_ctx, run: Run) => {
    await writeFile(join(run.folder, "started"), "");
    if (run.prompt === "snapshot") {
      run.text("waiting for the test");
      while (!(await readFile(join(run.folder, "continue"), "utf8").catch(() => "")))
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(join(run.folder, "received.json"), JSON.stringify(run.launchSettings ?? null));
    if (run.prompt === "agent failure") throw new Error(run.launchSettings?.env.TKM_ONE);
    return { sessionId: "recording-session" };
  },
});
export default provide(agent, { id: "recording-agent", name: "Recording agent", info, start });
`,
  );
}

export async function checkLaunchSettings(h) {
  const first = await installLaunchHook(h);
  const second = await installLaunchHook(h, "launch-second");
  await installRecordingAgent(h);
  const address = await h.serve("launch-settings");
  const client = await h.connect(address, { local: true });
  const turns = agentTurns({ h, client, agent: { id: "recording-agent", name: "Recording agent" } });
  const run = async (name, prompt, options) => turns.run(await h.folder(name), prompt, options);
  const received = async ({ folder }) => JSON.parse(await readFile(join(folder, "received.json"), "utf8"));
  const absent = async (path) => assert.equal(await Bun.file(path).exists(), false);
  const probe = join(h.home, "recording-agent-probed");

  const normal = await run("launch-normal", "normal");
  assert.equal(await received(normal), null);
  assert.equal(normal.row.model, "recording");
  assert.equal(normal.row.sessionId, "recording-session");
  await unlink(probe);

  await first.set({ TKM_ONE: LAUNCH_VALUE }, ["one"]);
  const single = await run("launch-single", "snapshot", {
    async during(control) {
      await control.firstText();
      await first.set({ TKM_ONE: "next-value" }, ["one"]);
      await writeFile(join(h.home, "launch-single", "continue"), "go");
    },
  });
  assert.deepEqual(await received(single), { env: { TKM_ONE: LAUNCH_VALUE }, args: ["one"] });
  assert.equal(single.row.sessionId, undefined);
  await absent(probe);

  await second.set({ TKM_TWO: "another-value" }, ["two"]);
  const both = await run("launch-both", "next", { threadId: single.threadId });
  const launch = await received(both);
  assert.deepEqual(launch.env, { TKM_ONE: "next-value", TKM_TWO: "another-value" });
  assert.deepEqual(launch.args.toSorted(), ["one", "two"]);

  // Even returning the exact same value counts as two plugins setting the name.
  await second.set({ TKM_ONE: "next-value" });
  const conflict = await run("launch-conflict", "conflict", { state: "failed" });
  for (const part of ["launch-first", "launch-second", "TKM_ONE"]) {
    assert.ok(conflict.row.error.includes(part));
    assert.ok(conflict.error.includes(part), "the thread message names both plugins");
  }
  await absent(join(conflict.folder, "started"));
  await absent(probe);
  assert.ok(!JSON.stringify(conflict).includes("next-value"));

  await second.throws(LAUNCH_VALUE);
  const badHook = await run("launch-bad-hook", "bad hook", { state: "failed" });
  await absent(join(badHook.folder, "started"));
  assert.ok(!JSON.stringify(badHook).includes(LAUNCH_VALUE));
  await second.clear();

  await first.set({ TKM_ONE: LAUNCH_VALUE });
  const badAgent = await run("launch-bad-agent", "agent failure", { state: "failed" });
  assert.ok(!JSON.stringify(badAgent).includes(LAUNCH_VALUE));
  await first.clear();
  process.stdout.write(
    "PASS launch settings: default, one hook and snapshot, two distinct names and args, conflict, hook error privacy, agent error privacy\n",
  );
}
