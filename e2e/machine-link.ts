// Two disposable loopback servers; every agent comes from the sealed sandbox.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareChatSandbox } from "./chat-sandbox";
import { TokamakClient, WebSocketTransport } from "../packages/sdk/src/index";
import { api } from "../plugins/chat/src/server/_generated/api";

const root = resolve(import.meta.dirname, "..");
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  ms = 25_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await wait(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function connect(origin: string, token: string) {
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("token", token);
  const socket = new WebSocket(url);
  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", () => fail(new Error("Loopback socket failed")), { once: true });
  });
  const transport = new WebSocketTransport(socket);
  return { client: new TokamakClient(transport), close: () => transport.close() };
}

export async function machineLinkScenario(build = true) {
  await mkdir(resolve(root, "target/e2e"), { recursive: true });
  const directory = await mkdtemp(resolve(root, "target/e2e/machine-link-"));
  const children: ChildProcess[] = [];
  const connections: { close(): void }[] = [];
  const outputs: string[] = [];
  const ownerToken = crypto.randomUUID() + crypto.randomUUID();
  const localToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  try {
    const sandbox = await prepareChatSandbox(`${directory}/machine`, { build });
    const plugins = `${directory}/hub/plugins`;
    await mkdir(`${plugins}/chat`, { recursive: true });
    await cp(`${directory}/machine/plugins/chat/dist`, `${plugins}/chat/dist`, { recursive: true });
    await mkdir(`${directory}/web`);
    await writeFile(`${directory}/web/index.html`, "<html>Disposable hub</html>");
    await mkdir(`${directory}/local`, { mode: 0o700 });
    await writeFile(`${directory}/local/server.token`, localToken, { mode: 0o600 });

    async function server(kind: "hub" | "machine") {
      const child = spawn(
        resolve(root, "target/debug/tokamak"),
        [
          "--plugins",
          kind === "hub" ? plugins : sandbox.env.TOKAMAK_PLUGIN_DIR,
          "--data",
          `${directory}/${kind}/store`,
          "--listen",
          "127.0.0.1:0",
          ...(kind === "hub" ? ["--web", `${directory}/web`] : ["--local-dir", `${directory}/local`]),
        ],
        {
          cwd: root,
          env: { ...process.env, ...sandbox.env, TOKAMAK_ACCESS_TOKEN: ownerToken },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      const index = outputs.push("") - 1;
      child.stdout?.on("data", (data) => {
        outputs[index] += String(data);
      });
      child.stderr?.on("data", (data) => {
        outputs[index] += String(data);
      });
      const output = await until(
        async () => {
          if (child.exitCode !== null) throw new Error(`${kind} exited: ${outputs[index]}`);
          return outputs[index];
        },
        (s) => /Tokamak listening on ws:\/\/127\.0\.0\.1:\d+\/ws/.test(s),
        `${kind} readiness`,
      );
      const ws = output.match(/Tokamak listening on (ws:\/\/127\.0\.0\.1:\d+)\/ws/)![1]!;
      return { child, origin: ws.replace("ws:", "http:") };
    }
    const hub = await server("hub");
    let machine = await server("machine");
    const headers = { authorization: `Bearer ${ownerToken}`, "content-type": "text/plain" };
    const invited = await fetch(`${hub.origin}/members`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Member B" }),
    });
    assert.equal(invited.status, 200);
    const memberToken = ((await invited.json()) as { token: string }).token;
    assert.equal(
      (await fetch(`${hub.origin}/machine/hubs`, { method: "POST", headers, body: "[]" })).status,
      405,
      "hub has no machine bootstrap",
    );
    assert.equal(
      (await fetch(`${machine.origin}/machine/hubs`, { method: "POST", body: "[]" })).status,
      401,
      "bootstrap is authenticated",
    );
    const activate = async (hubs = [{ url: hub.origin, token: ownerToken }]) => {
      const response = await fetch(`${machine.origin}/machine/hubs`, {
        method: "POST",
        headers: { authorization: `Bearer ${localToken}`, "content-type": "text/plain" },
        body: JSON.stringify(hubs),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as { machineId: string };
    };
    const a = await connect(hub.origin, ownerToken);
    const b = await connect(hub.origin, memberToken);
    connections.push(a, b);
    const identity = await activate();
    assert.deepEqual(await activate(), identity, "activation is idempotent");
    const options = await until(
      () => a.client.query(api.backends.available, {}),
      (o) => Boolean(o?.length),
      "own agents online",
    );
    assert.equal(options?.length, 2);
    assert.deepEqual(await b.client.query(api.backends.available, {}), [], "B never sees A's agents");
    const threadId = await a.client.action(api.threads.create, {});
    const messages = () => b.client.query(api.messages.list, { threadId });
    let streamed = false;
    const stop = b.client.subscribe(api.messages.list, { threadId }, (event) => {
      if (
        "value" in event &&
        event.value.some((m) => m.role === "assistant" && m.status === "streaming" && m.parts.length)
      )
        streamed = true;
    });
    const send = (text: string) =>
      a.client.action(api.chat.send, { threadId, text, machineId: identity.machineId });
    const complete = () =>
      until(
        messages,
        (rows) => rows.at(-1)?.role === "assistant" && rows.at(-1)?.status !== "streaming",
        "reply settled",
      );
    try {
      await assert.rejects(
        b.client.action(api.chat.send, { threadId, text: "Use A's agent", machineId: identity.machineId }),
        /Your machine is not connected or has no agents/,
      );
      assert.equal((await messages()).length, 0, "refused sends do not queue or write messages");
      assert.equal((await send("Explain this workspace")).status, "running");
      let rows = await complete();
      assert.equal(rows.at(-1)?.status, "complete");
      assert(streamed, "B sees streamed output over its independent connection");
      assert.match(JSON.stringify(rows.at(-1)?.parts), /Tokamak workspace/);
      assert(rows[0]?.author?.id && rows[1]?.askedBy?.id === rows[0].author.id);
      // A second offered machine receives only explicitly addressed work. Claims
      // and output retries are arbitrated by hub mutations, not window state.
      const epoch = crypto.randomUUID();
      const machineId = "claim-test-" + crypto.randomUUID();
      const registration = await a.client.mutation(api.machines.register, {
        machineId,
        epoch,
        name: "Claim test",
        agents: [{ id: "claude", title: "Claude" }],
      });
      const addressed = await a.client.action(api.chat.send, { threadId, text: "Claim test", machineId });
      const [workId] = await a.client.query(api.machines.pending, { machine: registration, epoch });
      assert(workId);
      const claim = {
        machine: registration,
        epoch,
        workId,
        token: crypto.randomUUID() + crypto.randomUUID(),
      };
      await assert.rejects(b.client.mutation(api.machines.claim, claim), /Machine lease expired/);
      const claims = await Promise.all([
        a.client.mutation(api.machines.claim, claim),
        a.client.mutation(api.machines.claim, claim),
      ]);
      assert.equal(claims.filter(Boolean).length, 1, "exactly one atomic claimant");
      const update = { runId: addressed.runId, token: claim.token, delta: "Once", sequence: 1 };
      await assert.rejects(b.client.mutation(api.send.update, update), /Run does not belong to you/);
      await a.client.mutation(api.send.update, update);
      await a.client.mutation(api.send.update, update);
      await assert.rejects(
        a.client.mutation(api.send.update, { ...update, sequence: 3 }),
        /Invalid output sequence/,
      );
      await a.client.mutation(api.send.update, { ...update, delta: "", sequence: 2, outcome: "done" });
      assert.deepEqual((await messages()).find((m) => m._id === addressed.messageId)?.parts, [
        { type: "text", text: "Once" },
      ]);
      await a.client.mutation(api.machines.disconnect, { machine: registration, epoch });
      await assert.rejects(
        a.client.action(api.chat.send, { threadId, text: "Offline preferred machine", machineId }),
        /Your machine is not connected or has no agents/,
      );
      // Selecting B's agent cannot change A's selection or give B access to it.
      await b.client.mutation(api.threads.setBackend, {
        threadId,
        backend: { kind: "plugin", plugin: "acp", backendId: "codex" },
      });
      await assert.rejects(
        b.client.action(api.chat.send, { threadId, text: "No machine" }),
        /Your machine is not connected or has no agents/,
      );
      await send("permission");
      rows = await until(
        messages,
        (rows) => rows.at(-1)?.parts.some((p) => p.type === "permission" && p.status === "pending") ?? false,
        "permission prompt",
      );
      const prompt = rows.at(-1)!;
      const permission = prompt.parts.find((p) => p.type === "permission")!;
      assert(permission.type === "permission");
      const answer = { messageId: prompt._id, requestId: permission.requestId, optionId: "allow" };
      await assert.rejects(b.client.mutation(api.permissions.answer, answer), /Only the agent owner/);
      await a.client.mutation(api.permissions.answer, answer);
      assert.equal((await complete()).at(-1)?.status, "complete");
      await send("machine identity");
      const briefing = JSON.stringify((await complete()).at(-1)?.parts);
      assert.match(briefing, /Your tools, files and logins belong to that owner/);
      assert.match(briefing, /Each message is marked with its author/);
      assert.match(briefing, /Participants in this thread/);
      assert.match(briefing, /Say plainly/);
      assert.match(briefing, /user \([^;]+; [^)]+\): machine identity/);
      const slow = await send("slow");
      await until(
        () => a.client.query(api.runs.active, { threadId }),
        (value) => Boolean(value),
        "active run",
      );
      await assert.rejects(send("duplicate"), /already has an active run/);
      // The same agent name belongs to independent owners, even in one thread.
      const memberEpoch = crypto.randomUUID();
      const memberMachineId = crypto.randomUUID();
      const memberMachine = await b.client.mutation(api.machines.register, {
        machineId: memberMachineId,
        epoch: memberEpoch,
        name: "B's claim test",
        agents: [{ id: "claude", title: "Claude" }],
      });
      await b.client.mutation(api.threads.setBackend, {
        threadId,
        backend: { kind: "plugin", plugin: "acp", backendId: "claude" },
      });
      const memberRun = await b.client.action(api.chat.send, { threadId, text: "B's own agent" });
      const [memberWork] = await b.client.query(api.machines.pending, {
        machine: memberMachine,
        epoch: memberEpoch,
      });
      assert(memberWork);
      const memberClaim = await b.client.mutation(api.machines.claim, {
        machine: memberMachine,
        epoch: memberEpoch,
        workId: memberWork,
        token: crypto.randomUUID() + crypto.randomUUID(),
      });
      assert(memberClaim);
      assert.equal(memberClaim.runId, memberRun.runId);
      await b.client.mutation(api.send.update, {
        runId: memberRun.runId,
        token: memberClaim.token,
        delta: "B's reply",
        sequence: 1,
        outcome: "done",
      });
      await b.client.mutation(api.machines.disconnect, { machine: memberMachine, epoch: memberEpoch });
      await b.client.mutation(api.runs.cancel, { runId: slow.runId });
      assert.equal(
        (await messages()).find((row) => row._id === slow.messageId)?.status,
        "cancelled",
        "any member may stop",
      );
      // Both agents can run for the owner in the same thread.
      await send("slow");
      await a.client.mutation(api.threads.setBackend, {
        threadId,
        backend: { kind: "plugin", plugin: "acp", backendId: "codex" },
      });
      const parallel = await send("Explain this workspace");
      await until(
        messages,
        (rows) => rows.find((r) => r._id === parallel.messageId)?.status === "complete",
        "second agent in same thread",
      );
      const active = await a.client.query(api.runs.active, { threadId });
      assert(active);
      await b.client.mutation(api.runs.cancel, { runId: active._id });
      // Kill only this test's machine while a claimed run is active. The hub's
      // maintenance timer must settle it with no view or recovery observer.
      const doomed = await send("slow");
      await until(
        messages,
        (rows) => rows.find((r) => r._id === doomed.messageId)?.parts.length !== 0,
        "claimed run output",
      );
      stop();
      const exited = new Promise<void>((done) => machine.child.once("exit", () => done()));
      machine.child.kill("SIGKILL");
      await exited;
      rows = await until(
        messages,
        (rows) => rows.find((r) => r._id === doomed.messageId)?.status === "error",
        "server-owned lease expiry",
      );
      assert.match(rows.find((r) => r._id === doomed.messageId)?.error ?? "", /Interrupted/);
      await until(
        () => a.client.query(api.backends.available, {}),
        (o) => o?.length === 0,
        "agents offline",
      );
      const count = rows.length;
      machine = await server("machine");
      await activate();
      await until(
        () => a.client.query(api.backends.available, {}),
        (o) => Boolean(o?.length),
        "machine reconnect",
      );
      await wait(1_000);
      assert.equal((await messages()).length, count, "interrupted work never replays");
      assert.equal((await messages()).find((r) => r._id === doomed.messageId)?.status, "error");
      // Sessions and folder choices are machine-local; the hub stores neither.
      assert(
        (await readFile(`${directory}/local/machine-data/acp/sessions.json`, "utf8")).includes(threadId),
      );
      const threads = await a.client.query(api.threads.list, {});
      assert(!JSON.stringify(threads).includes("sessionId"));
      await activate([]);
      await until(
        () => a.client.query(api.backends.available, {}),
        (o) => o?.length === 0,
        "stop serving hub",
      );
    } finally {
      stop();
    }
    for (const output of outputs)
      assert(
        !output.includes(ownerToken) && !output.includes(localToken) && !output.includes(memberToken),
        "tokens never enter server logs",
      );
    console.log(
      "PASS machine link: owner isolation, streaming, permission ownership, cancel, parallel agents, lease interruption, no replay, local state, token hygiene",
    );
  } catch (error) {
    // Outputs are asserted credential-free above; avoid printing URLs or tokens on failure.
    throw new Error(`Machine link scenario: ${String(error)}`);
  } finally {
    for (const connection of connections) connection.close();
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const built = spawnSync("cargo", ["build", "--locked", "-p", "server", "--bin", "tokamak", "--jobs", "2"], {
    cwd: root,
    stdio: "inherit",
  });
  if (built.status !== 0) throw new Error("Server build failed");
  await machineLinkScenario(!process.argv.includes("--no-build"));
}
