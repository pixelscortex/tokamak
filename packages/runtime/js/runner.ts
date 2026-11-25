import type { JsonValue } from "@tokamak/sdk";
import { WORKER_FRAME_BYTES } from "../../sdk/src/worker-limits";
import { RunnerUnavailable, type LaunchLocalWorker, type LocalArtifact } from "./local";

type WorkerEvent =
  | { type: "started"; routed?: boolean; pointPlans?: boolean }
  | { type: "message"; message: JsonValue }
  | { type: "closed"; reason: string };

type RunnerEndpoint = { ws: string; token: string | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

/** The socket belongs to the local Runner, even if the window uses a shared workspace. */
export function runnerLauncher(
  endpoint: () => Promise<RunnerEndpoint>,
  onClosedFrame?: (event: Extract<WorkerEvent, { type: "closed" }>) => void,
): LaunchLocalWorker {
  return async (artifact, receive, closed, workspace) => {
    const { ws, token } = await endpoint().catch((error) => {
      throw new RunnerUnavailable(String(error), { cause: error });
    });
    if (!token) throw new RunnerUnavailable("Missing Runner secret");
    const socket = new WebSocket(new URL("/local-worker", ws), ["tokamak", `tokamak.bearer.${token}`]);
    const origin = new URL(ws);
    const worker = new RunnerWorker(
      socket,
      artifact,
      receive,
      closed,
      workspace ?? origin.origin + origin.pathname,
      onClosedFrame,
    );
    await worker.ready;
    return worker;
  };
}

class RunnerWorker {
  private readonly startup = deferred<void>();
  private readonly exited = deferred<void>();
  private readonly deadline = setTimeout(
    () => this.finish("The Runner did not start the plugin process"),
    10_000,
  );
  pointPlans = false;
  private started = false;
  private ended = false;
  private closing?: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    artifact: LocalArtifact,
    private readonly receive: (message: JsonValue) => void,
    private readonly closed: (reason: string) => void,
    workspace: string | undefined,
    private readonly onClosedFrame?: (event: Extract<WorkerEvent, { type: "closed" }>) => void,
  ) {
    socket.addEventListener("open", () => {
      try {
        this.write({ type: "start", artifact, workspace });
      } catch (error) {
        this.finish(String(error));
      }
    });
    socket.addEventListener("error", () =>
      this.finish("Could not connect to the Runner's plugin process", !this.started),
    );
    socket.addEventListener("close", () => this.finish("The Runner closed the plugin process connection"));
    socket.addEventListener("message", ({ data }) => {
      try {
        this.event(JSON.parse(String(data)) as WorkerEvent);
      } catch {
        this.finish("Invalid Runner plugin process event");
      }
    });
  }

  get ready() {
    return this.startup.promise;
  }

  private event(event: WorkerEvent) {
    switch (event.type) {
      case "started":
        this.started = true;
        if (event.routed !== true) {
          this.finish("The Runner does not support plugin process routing");
          break;
        }
        this.pointPlans = event.pointPlans === true;
        clearTimeout(this.deadline);
        this.startup.resolve();
        break;
      case "message":
        this.receive(event.message);
        break;
      case "closed":
        this.finish(event.reason);
        this.onClosedFrame?.(event);
        break;
      default:
        this.finish("Invalid Runner plugin process event");
    }
  }

  private finish(reason: string, unavailable = false) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.deadline);
    const error = unavailable ? new RunnerUnavailable(reason) : new Error(reason);
    this.startup.reject(error);
    this.socket.close();
    this.exited.resolve();
    if (this.started) this.closed(reason);
  }

  private write(frame: object) {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) throw new Error("Plugin process closed");
    if (this.socket.bufferedAmount > 4 * WORKER_FRAME_BYTES)
      throw new Error("Plugin process input queue full");
    this.socket.send(JSON.stringify(frame));
  }

  async send(message: JsonValue) {
    this.write({ type: "write", message });
  }

  async route(id: number, artifact: LocalArtifact) {
    this.write({ type: "route", id, artifact });
  }

  async retire(artifact: LocalArtifact) {
    this.write({ type: "retire", artifact });
  }

  close() {
    return (this.closing ??= this.stop());
  }

  private async stop() {
    if (this.ended) return;
    try {
      this.write({ type: "close" });
    } catch {
      this.finish("Plugin process closed");
      return;
    }
    const deadline = setTimeout(() => this.finish("Plugin process did not close in time"), 5_000);
    await this.exited.promise;
    clearTimeout(deadline);
  }
}
