import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { delimiter, dirname } from "node:path";
import {
  ClientApp,
  ndJsonStream,
  type ClientConnection,
  type AgentCapabilities,
  type PermissionOption,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/unstable";
import type { JsonObject } from "@tokamak/sdk";
import { BUILTINS, discover, checkFolder, type Agent } from "./discovery";

export type AgentEvent =
  | { type: "update"; update: JsonObject }
  | { type: "permission"; requestId: string; toolCall: JsonObject; options: PermissionOption[] }
  | { type: "done"; stopReason: string };
export interface AgentClient {
  open(input: {
    agent: string;
    cwd: string;
    sessionId?: string;
  }): Promise<{ sessionId: string; restored: boolean }>;
  prompt(input: { agent: string; sessionId: string; text: string }): AsyncIterable<AgentEvent>;
  respond(input: { requestId: string; optionId: string | null }): Promise<void>;
  cancel(input: { agent: string; sessionId: string }): Promise<void>;
}
class Events {
  private queue: AgentEvent[] = [];
  private bytes = 0;
  private wake?: () => void;
  private error?: Error;
  push(event: AgentEvent) {
    this.bytes += Buffer.byteLength(JSON.stringify(event));
    if (this.bytes > 4 * 1024 * 1024) throw new Error("ACP turn event queue exceeds 4 MiB limit");
    this.queue.push(event);
    this.wake?.();
  }
  fail(error: Error) {
    this.error = error;
    this.wake?.();
  }
  async next(): Promise<AgentEvent> {
    while (!this.queue.length) {
      if (this.error) throw this.error;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    const event = this.queue.shift()!;
    this.bytes -= Buffer.byteLength(JSON.stringify(event));
    return event;
  }
}
type Permission = { options: PermissionOption[]; answer(value: RequestPermissionResponse): void };
type Turn = {
  events: Events;
  permissions: Map<string, Permission>;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
class AgentProcess {
  readonly turns = new Map<string, Turn>();
  readonly opening = new Set<string>();
  private readonly connection: ClientConnection;
  private capabilities: AgentCapabilities = {};
  private tail = "";
  private readonly child;
  private readonly guardian;
  private failure?: Error;
  constructor(readonly definition: Agent) {
    const env: Record<string, string> = {};
    for (const name of ["PATH", "HOME", "USER", "LANG"])
      if (process.env[name] !== undefined) env[name] = process.env[name]!;
    env.PATH = [dirname(definition.command), env.PATH].filter(Boolean).join(delimiter);
    this.child = spawn(definition.command, definition.args, { env, stdio: "pipe", detached: true });
    // The adapter has its own group. A separate process watches worker death,
    // including when plugin JavaScript is stuck and cannot run an exit handler.
    this.guardian = spawn(
      "/bin/sh",
      [
        "-c",
        'trap "" TERM; while IFS= read -r line; do :; done; kill -TERM -"$1" 2>/dev/null; /bin/sleep 0.2; kill -KILL -"$1" 2>/dev/null',
        "acp-guardian",
        String(this.child.pid),
      ],
      { env: {}, detached: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    this.guardian.stdin.on("error", () => {});
    this.guardian.on("error", (error) => this.close(error));
    this.guardian.on("exit", () => this.close(new Error("ACP process guardian exited")));
    this.child.stderr.on("data", (data: Buffer) => {
      this.tail = (this.tail + data.toString()).slice(-2048);
    });
    this.child.stdin.on("error", (error) => this.close(error));
    this.child.on("error", (error) => this.close(error));
    this.child.on("exit", (code, signal) =>
      this.close(new Error(`ACP agent exited (${code ?? signal}): ${this.tail}`)),
    );
    const app = new ClientApp({ name: "Tokamak" });
    app.onNotification("session/update", ({ params }) => {
      try {
        this.turns
          .get(params.sessionId)
          ?.events.push({ type: "update", update: params.update as unknown as JsonObject });
      } catch (error) {
        this.close(asError(error));
      }
    });
    app.onRequest("session/request_permission", ({ params }) => {
      const turn = this.turns.get(params.sessionId);
      if (!turn || turn.cancelled) return { outcome: { outcome: "cancelled" as const } };
      return new Promise<RequestPermissionResponse>((answer) => {
        const requestId = crypto.randomUUID();
        turn.permissions.set(requestId, { options: params.options, answer });
        try {
          turn.events.push({
            type: "permission",
            requestId,
            toolCall: params.toolCall as unknown as JsonObject,
            options: params.options,
          });
        } catch (error) {
          this.close(asError(error));
        }
      });
    });
    const output = new WritableStream<Uint8Array>({
      write: (bytes) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const error = new Error("ACP stdin write timed out after 10 s");
            this.close(error);
            reject(error);
          }, 10_000);
          this.child.stdin.write(bytes, (error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
        }),
      close: () => {
        this.child.stdin.end();
      },
      abort: () => {
        this.child.stdin.destroy();
      },
    });
    this.connection = app.connect(
      ndJsonStream(output, Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>, {
        maxMessageBytes: 1024 * 1024,
      }),
    );
    void this.connection.closed.then(() => this.close(new Error(`ACP connection closed: ${this.tail}`)));
  }
  get closed() {
    return !!this.failure || this.connection.signal.aborted;
  }
  async initialize() {
    const timer = setTimeout(() => this.close(new Error("ACP initialize timed out after 30 s")), 30_000);
    try {
      const result = await this.connection.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "Tokamak", version: "0.1.0" },
      });
      if (result.protocolVersion !== 1) throw new Error("ACP agent does not support protocol v1");
      this.capabilities = result.agentCapabilities ?? {};
      return this;
    } catch (error) {
      this.close(asError(error));
      throw this.failure;
    } finally {
      clearTimeout(timer);
    }
  }
  async open(cwd: string, sessionId?: string) {
    if (sessionId && (this.opening.has(sessionId) || this.turns.has(sessionId)))
      throw new Error("ACP session is busy");
    if (sessionId) this.opening.add(sessionId);
    try {
      const resume = this.capabilities.sessionCapabilities?.resume;
      if (sessionId && (resume || this.capabilities.loadSession)) {
        await this.connection.agent.request(resume ? "session/resume" : "session/load", {
          sessionId,
          cwd,
          mcpServers: [],
        });
        return { sessionId, restored: true };
      }
      const result = await this.connection.agent.request("session/new", { cwd, mcpServers: [] });
      return { sessionId: result.sessionId, restored: false };
    } finally {
      if (sessionId) this.opening.delete(sessionId);
    }
  }
  async *prompt(sessionId: string, text: string): AsyncIterable<AgentEvent> {
    if (this.turns.has(sessionId) || this.opening.has(sessionId)) throw new Error("ACP session is busy");
    const turn: Turn = { events: new Events(), permissions: new Map(), cancelled: false };
    this.turns.set(sessionId, turn);
    void this.connection.agent
      .request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
      .then(
        (result) => {
          this.settle(sessionId, turn);
          turn.events.push({ type: "done", stopReason: result.stopReason });
        },
        (error) => {
          this.settle(sessionId, turn);
          turn.events.fail(this.failure ?? asError(error));
        },
      )
      .catch((error) => this.close(asError(error)));
    let finished = false;
    try {
      while (!finished) {
        const event = await turn.events.next();
        finished = event.type === "done";
        yield event;
      }
    } finally {
      if (!finished) await this.cancel(sessionId);
    }
  }
  respond(requestId: string, optionId: string | null) {
    for (const turn of this.turns.values()) {
      const permission = turn.permissions.get(requestId);
      if (!permission) continue;
      if (optionId !== null && !permission.options.some((option) => option.optionId === optionId))
        throw new Error("Unknown ACP permission option");
      turn.permissions.delete(requestId);
      permission.answer({
        outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
      });
      return true;
    }
    return false;
  }
  async cancel(sessionId: string) {
    const turn = this.turns.get(sessionId);
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    this.permissions(turn);
    // SDK request handlers enqueue replies asynchronously. Permission answers
    // must reach the adapter before the cancellation notification.
    await new Promise<void>((resolve) => setImmediate(resolve));
    turn.timer = setTimeout(() => this.close(new Error("ACP cancellation timed out after 5 s")), 5_000);
    await this.connection.agent.notify("session/cancel", { sessionId });
  }
  private permissions(turn: Turn) {
    for (const permission of turn.permissions.values())
      permission.answer({ outcome: { outcome: "cancelled" } });
    turn.permissions.clear();
  }
  private settle(sessionId: string, turn: Turn) {
    clearTimeout(turn.timer);
    this.permissions(turn);
    if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
  }
  close(error = new Error("ACP process closed")) {
    if (this.failure) return;
    this.failure = error;
    this.connection?.close(error);
    const pid = this.child.pid;
    const kill = (signal: NodeJS.Signals) => {
      if (pid) {
        try {
          process.kill(-pid, signal);
        } catch {
          /* group already exited */
        }
      }
    };
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), 200).unref();
    this.guardian.stdin.end();
    for (const [session, turn] of this.turns) {
      this.settle(session, turn);
      turn.events.fail(error);
    }
  }
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class Agents implements AgentClient {
  constructor(private readonly definitions: Agent[] = BUILTINS) {}
  private processes = new Map<string, { process: AgentProcess; ready: Promise<AgentProcess> }>();
  private live = new Map<string, AgentProcess>();
  agents() {
    const found = new Map(
      discover(this.definitions).map((agent) => [agent.id, { id: agent.id, title: agent.title }]),
    );
    for (const [id, process] of this.live)
      if (!process.closed) found.set(id, { id, title: process.definition.title });
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  private async process(agent: string): Promise<AgentProcess> {
    const live = this.live.get(agent);
    if (live && !live.closed) return live;
    let pending = this.processes.get(agent);
    if (!pending) {
      const definition = discover(this.definitions).find((item) => item.id === agent);
      if (!definition) throw new Error(`Unknown ACP agent: ${agent}`);
      const process = new AgentProcess(definition);
      pending = { process, ready: process.initialize() };
      this.processes.set(agent, pending);
    }
    try {
      const process = await pending.ready;
      this.live.set(agent, process);
      return process;
    } finally {
      this.processes.delete(agent);
    }
  }
  async open({ agent, cwd, sessionId }: { agent: string; cwd: string; sessionId?: string }) {
    return (await this.process(agent)).open(checkFolder({ path: cwd }), sessionId);
  }
  async *prompt({ agent, sessionId, text }: { agent: string; sessionId: string; text: string }) {
    yield* (await this.process(agent)).prompt(sessionId, text);
  }
  async respond({ requestId, optionId }: { requestId: string; optionId: string | null }) {
    for (const process of this.live.values()) if (process.respond(requestId, optionId)) return;
    throw new Error("Unknown ACP permission request");
  }
  async cancel({ agent, sessionId }: { agent: string; sessionId: string }) {
    await this.live.get(agent)?.cancel(sessionId);
  }
  close() {
    for (const { process } of this.processes.values()) process.close();
    this.processes.clear();
    for (const process of this.live.values()) process.close();
    this.live.clear();
  }
}
export const agents = new Agents();
