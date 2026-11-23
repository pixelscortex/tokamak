// The fake-agent harness for end-to-end turns: the real tokamak-server
// program, real clients over WebSockets, the real plugin build of chat, ai and
// every fake agent plugin in ./agents, a real local part (Bun worker) started
// the way the desktop client starts it, and each agent's replay program on PATH.
//
//   const h = await agentHarness({ binary, name: "ai-turns" });
//   const address = await h.serve("local");
//   const window = await h.connect(address, { local: true });
//   ... drive chat and ai, watch rows with h.watch(...), release h.gate(folder, "go")
//   await h.close();
//
// A replay under ./replays is a new model of every fake agent; a folder under
// ./agents is a new fake agent (see README.md). The helpers below the harness
// (within, build, copySource, startServer, connect, watchQuery) serve other
// end-to-end drivers too.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { TokamakClient, WebSocketTransport } from "../../packages/sdk/src/index.ts";
import { LocalFunctions } from "../../packages/runtime/js/local.ts";
import { agentsFolder, bunPath, fakeAgents, installFakeAgent, localLauncher } from "./local.mjs";

export { bunPath, fakeAgents, installFakeAgent, localLauncher };

export const workspace = fileURLToPath(new URL("../../", import.meta.url));
const TIMEOUT_MS = 20_000;

/** Rejects with `label` when `promise` takes longer than `ms`. */
export async function within(promise, label, ms = TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Builds a plugin from source with the real build. */
export function build(folder) {
  const result = Bun.spawnSync([bunPath(), join(workspace, "packages/build/src/build.ts"), folder], {
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(result.exitCode, 0, `build ${folder}`);
}

/**
 * Copies a plugin's source to `into`, so a plugin that imports it
 * (`plugin:<id>/…`) can build beside it. The copy uses `modules` as its
 * node_modules and its server config points at the workspace directly.
 */
export async function copySource(from, into, modules) {
  await cp(from, into, {
    recursive: true,
    filter: (path) => !["dist", "node_modules", ".tokamak", "target"].includes(path.split("/").at(-1)),
  });
  await symlink(modules, join(into, "node_modules"), "dir");
  await mkdir(join(into, "src/server"), { recursive: true });
  await writeFile(
    join(into, "src/server/tsconfig.json"),
    JSON.stringify({ extends: join(workspace, "tsconfig.json"), compilerOptions: { skipLibCheck: true } }),
  );
}

/**
 * Builds chat, ai and every fake agent and installs copies of their builds at
 * `install(id)`, by default `<scratch>/plugins/<id>`. Fake agents build beside
 * copies of chat's and ai's sources, where the build finds `plugin:ai/contracts`.
 */
export async function buildAgentPlugins(scratch, install = (id) => join(scratch, "plugins", id)) {
  build(join(workspace, "plugins/chat"));
  build(join(workspace, "plugins/ai"));
  const sources = join(scratch, "sources");
  for (const id of ["chat", "ai"])
    await copySource(
      join(workspace, "plugins", id),
      join(sources, id),
      join(workspace, "plugins", id, "node_modules"),
    );
  const builds = [
    ["chat", join(workspace, "plugins/chat/dist")],
    ["ai", join(workspace, "plugins/ai/dist")],
  ];
  for (const id of await fakeAgents()) {
    const source = join(sources, id);
    await copySource(join(agentsFolder, id), source, join(workspace, "plugins/ai/node_modules"));
    // Each fake agent links to the shared agents/factory.ts; the build takes only files inside the plugin.
    const factory = join(source, "src/server/factory.ts");
    await unlink(factory).catch(() => {});
    await cp(join(agentsFolder, "factory.ts"), factory);
    build(source);
    builds.push([id, join(source, "dist")]);
  }
  // Serve copies so a concurrent rebuild of the checkout cannot change the plugins under test.
  for (const [id, dist] of builds) await cp(dist, install(id), { recursive: true });
}

/** Starts the real server in `dir`; resolves its WebSocket address once it listens. */
export async function startServer({
  binary,
  dir,
  pluginsDir,
  shared,
  localDir,
  ownerToken,
  servers,
  cleanup,
  env = {},
  started = () => {},
}) {
  await mkdir(dir);
  const args = ["--plugins", pluginsDir, "--data", join(dir, "store"), "--listen", "127.0.0.1:0"];
  if (localDir) args.push("--local-dir", localDir);
  if (shared) {
    await writeFile(join(dir, "index.html"), "End-to-end server");
    args.push("--web", dir);
  }
  const child = Bun.spawn([binary, ...args], {
    env: { ...process.env, TOKAMAK_OWNER_NAME: "Sam", TOKAMAK_ACCESS_TOKEN: ownerToken, ...env },
    ...(localDir && { stdin: "pipe" }),
    stdout: "pipe",
    stderr: "inherit",
  });
  servers.push(child);
  started(child);
  const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
  cleanup.push(() => lines.close());
  return within(
    new Promise((resolve, reject) => {
      lines.on("line", (line) => {
        const match = line.match(/ws:\/\/127\.0\.0\.1:\d+\/ws/);
        if (match) resolve(match[0]);
      });
      lines.on("close", () => reject(new Error("Server exited before readiness")));
    }),
    "server readiness",
  );
}

/** A window on `address` with device key `token`; with `launch`, also a local part. */
export async function connect(
  address,
  { token, launch, cleanup, onClose = /** @type {((event: CloseEvent) => void) | undefined} */ (undefined) },
) {
  const socket = new WebSocket(address, token ? ["tokamak", `tokamak.bearer.${token}`] : undefined);
  await within(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    }),
    "WebSocket connection",
  );
  if (onClose) socket.addEventListener("close", onClose, { once: true });
  const transport = new WebSocketTransport(socket);
  cleanup.push(() => transport.close());
  if (!launch) return new TokamakClient(transport);
  const part = new LocalFunctions(transport, launch);
  cleanup.push(() => part.close());
  socket.addEventListener("close", ({ code }) => {
    if (code === 4001) void part.close();
  });
  return new TokamakClient(transport, part);
}

/** Subscribes to one query; `until(label, predicate, ms?)` waits for rows that match. */
export function watchQuery(client, reference, args, cleanup) {
  let latest;
  let failure;
  const waiters = new Set();
  const stop = client.subscribe(reference, args, (event) => {
    if ("error" in event) failure = event.error;
    else latest = event.value;
    for (const waiter of waiters) waiter();
  });
  cleanup.push(stop);
  return {
    current: () => latest,
    until(label, predicate, ms) {
      return within(
        new Promise((resolve, reject) => {
          const check = () => {
            if (failure) return reject(failure);
            if (latest !== undefined && predicate(latest)) {
              waiters.delete(check);
              resolve(latest);
            }
          };
          waiters.add(check);
          check();
        }),
        label,
        ms,
      );
    },
  };
}

/** Posts JSON to a server route with a bearer key; resolves the JSON answer. */
async function post(address, path, key, body, status = 200) {
  const response = await fetch(new URL(path, address.replace(/^ws:/, "http:")), {
    method: "POST",
    headers: { ...(key && { authorization: `Bearer ${key}` }), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

/** Installs the built sign-in provider beside the other plugins. */
export async function installBasicAuth(plugins) {
  const source = join(workspace, "plugins/basic-auth");
  build(source);
  await cp(join(source, "dist"), join(plugins, "basic-auth", "dist"), { recursive: true });
}

/** Adds a member and issues a device key only after their first password change. */
export async function signInMember(address, ownerKey, username) {
  const method = "basic-auth";
  const password = "temporary member password";
  const user = await post(address, "/members", ownerKey, {
    method,
    fields: { username, email: `${username.toLowerCase()}@example.com`, password },
  });
  const signIn = { method, deviceName: "Test device", fields: { usernameOrEmail: username, password } };
  const required = await post(address, "/auth/sign-in", undefined, signIn, 403);
  assert.equal(required.kind, "PasswordChangeRequired");
  const device = await post(address, "/auth/sign-in", undefined, {
    ...signIn,
    newPassword: "member's own password",
  });
  assert.ok(device.key, "password change issues a device key");
  return { ...device, user };
}

/**
 * One harness: a scratch folder under packages/server/target, the built
 * plugins, a person's home folder and a PATH holding each fake agent's command.
 */
export async function agentHarness({ binary, name, ownerToken = "agent-harness-owner-token-for-tests" }) {
  assert.ok(binary, "Expected the path to the tokamak-server binary");
  const target = join(workspace, "packages/server/target");
  await mkdir(target, { recursive: true });
  const scratch = await mkdtemp(join(target, `${name}-`));
  const cleanup = [];
  const servers = [];
  /** Each window's own closers, so a test can quit one window (`quit`) before the end. */
  const windows = new Map();
  /** Each started server by its address, so a test can halt one. */
  const running = new Map();
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  const plugins = join(scratch, "plugins");
  await mkdir(home);
  await installFakeAgent(bin, await fakeAgents());
  await buildAgentPlugins(scratch);
  // The desktop's short list (HOME, USER, LANG, … and PATH); nothing else reaches agents.
  const localEnv = {
    TOKAMAK_APP_DATA_DIR: join(scratch, "app-data"),
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    ...(process.env.USER && { USER: process.env.USER }),
    ...(process.env.LANG && { LANG: process.env.LANG }),
  };

  return {
    async assertLocalRuntime() {
      const folder = join(scratch, "runtime-probe");
      await mkdir(folder);
      const entry = await readFile(join(plugins, "ai", "local-entry.js"));
      const code =
        'export const functions = { probe: { kind: "local", args: { kind: "any" }, invoke: () => typeof Bun } };';
      await writeFile(join(folder, "local-entry.js"), entry);
      await writeFile(join(folder, "local.js"), code);

      const hash = (content) => createHash("sha256").update(content).digest("hex");
      const launch = localLauncher(() => folder, localEnv);
      let worker;
      const result = new Promise((resolve, reject) => {
        const receive = (frame) => {
          if (frame.type === "op" && frame.name === "auth.current") {
            void worker.send({ type: "opResult", id: frame.id, value: null }).catch(reject);
          } else if (frame.type === "result") {
            resolve(frame);
          }
        };
        void launch(
          { id: "runtime-probe", entryHash: hash(entry), codeHash: hash(code) },
          receive,
          (reason) => reject(new Error(reason)),
        )
          .then((endpoint) => {
            worker = endpoint;
            return worker.send({ type: "invoke", id: 1, fn: "probe", args: null });
          })
          .catch(reject);
      });

      try {
        const runtime = process.env.TOKAMAK_PLUGIN_RUNTIME === "quickjs" ? "quickjs" : "bun";
        const frame = await within(result, `${runtime} local runtime probe`);
        assert.equal(
          frame.value,
          runtime === "quickjs" ? "undefined" : "object",
          `${runtime} local call returned ${JSON.stringify(frame)}`,
        );
      } finally {
        await worker?.close();
      }
    },

    scratch,
    home,
    /** Where each fake agent's command sits on the local part's PATH: unlink one to "uninstall" it. */
    bin,
    plugins,
    ownerToken,
    api: {
      ai: (await import(join(workspace, "plugins/ai/src/server/_generated/api.ts"))).api,
      chat: (await import(join(workspace, "plugins/chat/src/server/_generated/api.ts"))).api,
    },

    /**
     * Starts the real server on `pluginsDir` (chat, ai and the fake agents by
     * default); resolves its WebSocket address. `shared` makes it a shared server.
     */
    async serve(label, { shared = false, pluginsDir = plugins } = {}) {
      if (shared) await installBasicAuth(pluginsDir);
      let child;
      const address = await startServer({
        binary,
        dir: join(scratch, label),
        pluginsDir,
        shared,
        ownerToken,
        servers,
        cleanup,
        started: (server) => (child = server),
      });
      running.set(address, child);
      return address;
    },

    /** Kills the server at `address`, as a crash or a lost network cuts the apps off from it. */
    async halt(address) {
      const server = running.get(address);
      server?.kill("SIGKILL");
      await server?.exited;
    },

    signInMember: (address, username) => signInMember(address, ownerToken, username),

    revokeDevice: (address, deviceId) =>
      post(address, `/devices/${encodeURIComponent(deviceId)}/revoke`, ownerToken, {}),

    /** A new device key for the owner on a shared server: the same person on another computer. */
    ownerDevice: async (address, deviceName) =>
      (await post(address, "/auth/owner", ownerToken, { deviceName })).key,

    /**
     * A window on `address`; with `local`, also this computer's local part.
     * `env` changes the local part's environment (`undefined` leaves a variable out).
     */
    async connect(address, { token, local = false, pluginsDir = plugins, onClose, env, observe } = {}) {
      const own = [];
      try {
        const client = await connect(address, {
          token,
          onClose,
          launch: local
            ? localLauncher(
                (id) => join(pluginsDir, id),
                Object.fromEntries(
                  Object.entries({ ...localEnv, ...env }).filter(([, value]) => value !== undefined),
                ),
                observe,
              )
            : undefined,
          cleanup: own,
        });
        windows.set(client, own);
        return client;
      } finally {
        cleanup.push(...own);
      }
    },

    /** Closes one window and its local part, as quitting the app does; the others stay. */
    async quit(client) {
      for (const stop of (windows.get(client) ?? []).reverse()) await stop();
      windows.delete(client);
    },

    /** Live rows of one query, with a way to wait until they look a certain way. */
    watch: (client, reference, args) => watchQuery(client, reference, args, cleanup),

    /** Lets a replay waiting at `{"gate": name}` in `folder` carry on. */
    gate: (folder, gateName) => writeFile(join(folder, gateName), ""),

    /** Waits for a marker a replay writes to signal it has reached a wire step. */
    async waitFor(folder, name) {
      const marker = Bun.file(join(folder, name));
      const deadline = Date.now() + TIMEOUT_MS;
      while (!(await marker.exists())) {
        assert.ok(Date.now() < deadline, `timeout: replay marker ${name}`);
        await Bun.sleep(20);
      }
    },

    /** Closes the gate again, so the next replay in `folder` waits there too. */
    closeGate: (folder, gateName) => unlink(join(folder, gateName)),

    /** A folder in the person's home, as a chosen thread folder. */
    async folder(folderName) {
      const path = join(home, folderName);
      await mkdir(path, { recursive: true });
      return path;
    },

    async close() {
      for (const stop of cleanup.reverse()) await Promise.resolve(stop()).catch(() => {});
      for (const server of servers) {
        server.kill("SIGTERM");
        await server.exited;
      }
      await rm(scratch, { recursive: true });
    },
  };
}
