import type { JsonValue } from "@tokamak/sdk";
import { WORKER_CAPACITY, WORKER_FRAME_BYTES } from "../../sdk/src/worker-limits";
import type { LaunchLocalWorker, LocalArtifact } from "./local";

type WorkerEvent =
  | { type: "started"; routed?: boolean }
  | { type: "message"; message: JsonValue }
  | { type: "loaded"; id: number; path?: string; error?: string }
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
export function runnerLauncher(endpoint: () => Promise<RunnerEndpoint>): LaunchLocalWorker {
  return async (artifact, receive, closed) => {
    const { ws, token } = await endpoint();
    if (!token) throw new Error("Missing Runner secret");
    const socket = new WebSocket(new URL("/local-worker", ws), ["tokamak", `tokamak.bearer.${token}`]);
    const worker = new RunnerWorker(socket, artifact, receive, closed);
    await worker.ready;
    return worker;
  };
}

class RunnerWorker {
  private readonly startup = deferred<void>();
  private readonly exited = deferred<void>();
  private readonly loads = new Map<number, ReturnType<typeof deferred<string>>>();
  private readonly deadline = setTimeout(
    () => this.finish("The Runner did not start the local worker"),
    10_000,
  );
  private next = 0;
  private started = false;
  routed = false;
  private ended = false;
  private closing?: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    artifact: LocalArtifact,
    private readonly receive: (message: JsonValue) => void,
    private readonly closed: (reason: string) => void,
  ) {
    socket.addEventListener("open", () => {
      try {
        this.write({ type: "start", artifact });
      } catch (error) {
        this.finish(String(error));
      }
    });
    socket.addEventListener("error", () => this.finish("Could not connect to the Runner's local worker"));
    socket.addEventListener("close", () => this.finish("The Runner closed the local worker connection"));
    socket.addEventListener("message", ({ data }) => {
      try {
        this.event(JSON.parse(String(data)) as WorkerEvent);
      } catch {
        this.finish("Invalid Runner worker event");
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
        this.routed = event.routed === true;
        clearTimeout(this.deadline);
        this.startup.resolve();
        break;
      case "message":
        this.receive(event.message);
        break;
      case "loaded": {
        const pending = this.loads.get(event.id);
        this.loads.delete(event.id);
        if (event.path) pending?.resolve(event.path);
        else pending?.reject(new Error(event.error ?? "Could not load the local provider"));
        break;
      }
      case "closed":
        this.finish(event.reason);
        break;
      default:
        this.finish("Invalid Runner worker event");
    }
  }

  private finish(reason: string) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.deadline);
    const error = new Error(reason);
    this.startup.reject(error);
    for (const pending of this.loads.values()) pending.reject(error);
    this.loads.clear();
    this.socket.close();
    this.exited.resolve();
    if (this.started) this.closed(reason);
  }

  private write(frame: object) {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) throw new Error("Local worker closed");
    if (this.socket.bufferedAmount > 4 * WORKER_FRAME_BYTES) throw new Error("Local worker input queue full");
    this.socket.send(JSON.stringify(frame));
  }

  async send(message: JsonValue) {
    this.write({ type: "write", message });
  }

  async route(id: number, artifact: LocalArtifact) {
    this.write({ type: "route", id, artifact });
  }

  async retire(artifact: LocalArtifact) {
    if (this.routed) this.write({ type: "retire", artifact });
  }

  async load(artifact: LocalArtifact) {
    if (this.loads.size >= WORKER_CAPACITY) throw new Error("Local provider queue full");
    const id = ++this.next;
    this.write({ type: "load", id, artifact });
    const pending = deferred<string>();
    this.loads.set(id, pending);
    return pending.promise;
  }

  close() {
    return (this.closing ??= this.stop());
  }

  private async stop() {
    if (this.ended) return;
    try {
      this.write({ type: "close" });
    } catch {
      this.finish("Local worker closed");
      return;
    }
    const deadline = setTimeout(() => this.finish("Local worker did not close in time"), 5_000);
    await this.exited.promise;
    clearTimeout(deadline);
  }
}
