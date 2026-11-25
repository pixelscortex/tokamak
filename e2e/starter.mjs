// Fresh packaged installation. Without --real this exercises only the server.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { buildStarterPlugins, installStarterPlugins } from "../app/scripts/starter-plugins.ts";
import { createApi } from "../packages/sdk/src/index.ts";
import { agentTurns } from "./fake-agent/agent-turn.mjs";
import { startRunner } from "./fake-agent/start-runner.ts";
import { connect, startServer, workspace } from "./fake-agent/harness.mjs";

const [flag, ...requested] = process.argv.slice(2);
const names = { claude: "Claude", codex: "Codex" };
assert.ok(
  flag === undefined ||
    (flag === "--real" &&
      !process.env.CI &&
      requested.length > 0 &&
      requested.every((id) => Object.hasOwn(names, id))),
  "Use --real claude and/or codex locally to opt in to real turns",
);

const target = join(workspace, "target");
const binary = resolve(target, "debug", `tokamak-server${process.platform === "win32" ? ".exe" : ""}`);
const root = await mkdtemp(join(target, "starter-"));
const pluginsDir = join(root, "plugins");
const localDir = join(root, "local");
const project = join(root, "project");
const token = randomBytes(32).toString("hex");
const cleanup = [];
const servers = [];
try {
  buildStarterPlugins();
  await installStarterPlugins(pluginsDir);
  await mkdir(localDir);
  await mkdir(project);
  await writeFile(join(localDir, "server.token"), token, { mode: 0o600 });
  const address = await startServer({
    binary,
    dir: join(root, "server"),
    localDir,
    pluginsDir,
    cleanup,
    servers,
  });
  const list = await fetch(new URL("/plugins", address.replace(/^ws:/, "http:")), {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(list.status, 200);
  const catalog = await list.json();
  assert.deepEqual(catalog.plugins.map((item) => item.plugin.id).sort(), [
    "agent-proxy",
    "ai",
    "ai-profiles",
    "basic-auth",
    "chat",
    "claude",
    "code",
    "codex",
  ]);
  assert.ok(!catalog.failures?.length);
  const api = { ai: createApi("ai"), chat: createApi("chat") };
  const browser = await connect(address, { token, cleanup });
  const first = await browser.mutation(api.chat.threads.start, {
    text: "Fresh install",
    folder: { kind: "own" },
  });
  const [message] = await browser.query(api.chat.messages.list, { threadId: first.threadId });
  assert.equal(message.parts[0].text, "Fresh install");
  console.log(
    "Starter install: all eight plugins loaded, local device authenticated, Chat stored a message.",
  );

  if (requested.length) {
    const env = {
      HOME: homedir(),
      // The desktop gives its local part a data folder (own-folder threads, snapshot records).
      TOKAMAK_APP_DATA_DIR: join(root, "app-data"),
      // The local part inherits the documented CLI profile paths.
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    };
    for (const key of [
      "USER",
      "LANG",
      "CODEX_HOME",
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
      "CLAUDE_CONFIG_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const runner = await startRunner({
      binary: binary.replace(/tokamak-server(?=\.exe$|$)/, "tokamak-runner"),
      plugins: pluginsDir,
      directory: join(root, "runner"),
      env,
    });
    cleanup.push(runner.stop);
    const client = await connect(address, { token, cleanup, launch: runner.launch });
    const available = await client.local(api.ai.agents.list, {});
    for (const id of new Set(requested)) {
      const info = available.find((agent) => agent.id === id)?.info;
      assert.ok(info?.installed && info.signedIn, `${names[id]} must be installed and signed in`);
      const subject = agentTurns({
        h: { api },
        client,
        agent: { id, name: names[id] },
        model: info.models[0]?.id,
        effort: info.models[0]?.efforts.includes("low") ? "low" : undefined,
        timeout: 120_000,
      });
      const result = await subject.run(project, "Reply with exactly TOKAMAK_READY. Do not use tools.");
      assert.match(result.text, /TOKAMAK_READY/);
      assert.ok(result.row.sessionId, "the agent session was saved");
      console.log(`${names[id]}: one real turn completed; reply and session saved through ai.`);
    }
  }
} finally {
  for (const stop of cleanup.reverse()) await stop();
  for (const child of servers) {
    child.kill();
    await child.exited;
  }
  await rm(root, { recursive: true, force: true });
}
