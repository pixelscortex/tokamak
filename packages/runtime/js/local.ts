import { LOCAL_RELOAD_GRACE_MS } from "../../sdk/src/protocol";
import { RemoteFunctionError } from "../../sdk/src/call-error";
import {
  authCaller,
  fail,
  type ActionOptions,
  type ActionTarget,
  functionName,
  LocalReloadTimeout,
  type ActionSignal,
  type ClientTransport,
  type JsonValue,
  type LocalTransport,
} from "@tokamak/sdk";
import { declaresAccessTo } from "../../sdk/src/plugin";
import { WORKER_CAPACITY, WORKER_FRAME_BYTES } from "../../sdk/src/worker-limits";

/** How many not-found plugin ids are remembered before the memory is cleared. */
const RECHECK_CAPACITY = 64;

/** Connecting to the local Runner failed before any call was admitted. */
export class RunnerUnavailable extends Error {}

function unavailable(capability: "serverContracts" | "privateFunctions"): never {
  throw new RemoteFunctionError({
    message: `The window Runner cannot use ${capability} through a public workspace session`,
    plugin: "",
    hook: "",
    stage: "runner",
    kind: "runnerCapabilityUnavailable",
    data: capability,
  });
}

export interface LocalArtifact {
  id: string;
  entryHash: string;
  codeHash: string;
}

type RunnerContractRoute =
  | { plugin: string; incompatible: true }
  | {
      plugin: string;
      owner: string;
      own: boolean;
      registration: string;
      build: string;
      unavailable?: string;
    };

type Manifest = {
  plugin: {
    id: string;
    depends?: Readonly<Record<string, string>>;
    optional?: Readonly<Record<string, string>>;
  };
  entries: { local?: { entry: string; code: string } };
  hashes: Readonly<Record<string, string>>;
  publicFunctions?: readonly string[];
  contracts?: readonly {
    name: string;
    place: "local" | "server";
    declarationHash: string;
    dataMethods?: unknown;
  }[];
  runnerContractRoutes?: Readonly<Record<string, readonly RunnerContractRoute[]>>;
  contractProviders?: readonly {
    name: string;
    place: "local" | "server";
    owner: string;
    registration: string;
    declarationHash: string;
    unavailable?: string;
  }[];
};

export type LaunchLocalWorker = (
  artifact: LocalArtifact,
  receive: (message: JsonValue) => void,
  closed: (reason: string) => void,
  workspace?: string,
) => Promise<{
  pointPlans?: boolean;
  send(message: JsonValue): Promise<void>;
  close(): Promise<void>;
  route(id: number, artifact: LocalArtifact): Promise<void>;
  retire(artifact: LocalArtifact): Promise<void>;
}>;

type Continuation = { depth: number; thread: string | null; hookScope?: number };
type WindowInvocation = {
  destination: "callerWindowRunner";
  note: Continuation;
  artifact: LocalArtifact;
  ownsHookScope?: boolean;
  hooks?: JsonValue & {
    artifacts: Record<string, LocalArtifact>;
    points?: Record<string, { hooks: { owner: string; name: string; before: boolean }[] }>;
  };
};
type WorkerCallContext = {
  continuation?: Continuation;
  signal?: ActionSignal;
  action: boolean;
};
type ServerConnection = ClientTransport & {
  dispatchWindowAction?(
    name: string,
    args: JsonValue,
    on?: ActionTarget,
    signal?: ActionSignal,
  ): Promise<JsonValue>;
  continueLocalCall?(
    kind: "query" | "mutation" | "action",
    name: string,
    args: JsonValue,
    parent: Continuation,
    on?: ActionTarget,
    window?: boolean,
    signal?: ActionSignal,
  ): Promise<JsonValue>;
  hookStage?(scope: number, done?: boolean): Promise<JsonValue>;
  plugins(): Promise<JsonValue>;
  onPluginsChanged(callback: () => void): () => void;
};
type Worker = Awaited<ReturnType<LaunchLocalWorker>>;
type Catalog = {
  plugins: Manifest[];
  functions?: { name: string; kind: string; on?: ActionTarget }[];
};

export class LocalFunctions implements LocalTransport {
  private readonly workers = new Map<string, LocalWorker>();
  private readonly draining = new Set<LocalWorker>();
  private readonly unlisten: () => void;
  private generation = 0;
  private catalog: Catalog = { plugins: [] };
  /** The generation `catalog` was read for; -1 before the first read. */
  private loaded = -1;
  /** The catalog read in flight, shared by every call that needs it. */
  private loading?: { generation: number; promise: Promise<void> };
  private authRead?: Promise<JsonValue>;
  private closed = false;
  /**
   * Plugins looked up and not found, with the generation the catalog was
   * read again for. One extra read per plugin and generation, so a caller
   * asking for a plugin that truly has no local functions cannot flood the
   * connection with catalog pages.
   */
  private readonly rechecked = new Map<string, number>();

  constructor(
    private readonly server: ServerConnection,
    private readonly launch: LaunchLocalWorker,
    private readonly workspace?: string,
  ) {
    this.unlisten = server.onPluginsChanged(() => {
      const generation = ++this.generation;
      // Catalog notifications may be paged and omit plugin IDs. Reconcile
      // against the complete catalog; a later reload supersedes this read.
      void this.loadCatalog(generation).catch(() => {});
    });
  }

  async action(
    name: string,
    args: JsonValue,
    options?: ActionOptions & { signal?: ActionSignal },
  ): Promise<JsonValue> {
    if (options?.signal?.aborted) throw new Error("Action cancelled");
    if (!this.server.dispatchWindowAction) {
      if (!this.server.action) throw new Error("Transport does not support actions");
      return this.server.action(name, args, options?.on, options?.signal);
    }
    const result = await this.server.dispatchWindowAction(name, args, options?.on, options?.signal);
    return this.finishAction(name, args, result, options?.signal);
  }

  private async finishAction(name: string, args: JsonValue, result: JsonValue, signal?: ActionSignal) {
    const dispatch = result as { destination: "result"; value: JsonValue } | WindowInvocation;
    if (dispatch.destination === "result") return dispatch.value;
    if (dispatch.destination !== "callerWindowRunner") throw new Error("Invalid action destination");

    try {
      return await this.invoke(name, args, signal, dispatch);
    } catch (error) {
      if (error instanceof RunnerUnavailable) return fail("noMachine", null);
      throw error;
    } finally {
      if (dispatch.ownsHookScope && dispatch.note.hookScope !== undefined)
        void this.server.hookStage?.(dispatch.note.hookScope, true).catch(() => {});
    }
  }

  private async ensureCatalog() {
    while (!this.closed && this.loaded !== this.generation) {
      await this.loadCatalog(this.generation);
    }
    if (this.closed) throw new Error("Local functions closed");
  }

  async invoke(
    name: string,
    args: JsonValue,
    signal?: ActionSignal,
    action?: WindowInvocation,
  ): Promise<JsonValue> {
    const slash = name.indexOf("/");
    if (slash < 1) throw new Error("Expected a plugin-qualified local function");
    if (signal?.aborted) throw new Error("Local function cancelled");
    const id = name.slice(0, slash);
    // Read the catalog once per plugin generation, not once per call: a window
    // making many local calls at once (one per message of a long thread) would
    // otherwise flood its connection with catalog pages and be disconnected.
    await this.ensureCatalog();
    const manifest = this.catalog.plugins.find((entry) => entry.plugin.id === id);
    const artifact = manifest && this.artifact(manifest);
    if (!artifact || (action && !sameArtifact(artifact, action.artifact))) {
      // The caller may know about this plugin before this catalog does: an
      // install or reload answers its request before the "plugins changed"
      // notice reaches this connection. Read the catalog once more before
      // saying the plugin has nothing to run.
      if (this.rechecked.get(id) !== this.generation) {
        if (this.rechecked.size >= RECHECK_CAPACITY) this.rechecked.clear();
        this.rechecked.set(id, ++this.generation);
        return this.invoke(name, args, signal, action);
      }
      if (action) return fail("noMachine", null);
      throw new Error(`Plugin ${id} has no local functions`);
    }
    let worker = this.workers.get(id);
    if (worker && !sameArtifact(worker.artifact, artifact)) {
      void worker.close("Local plugin generation retired");
      worker = undefined;
    }
    if (!worker) {
      if (this.workers.size >= WORKER_CAPACITY) throw new Error("Plugin process limit reached");
      const current = new LocalWorker(
        this.launch,
        artifact,
        this.workspace,
        () => this.catalog,
        (catalog, caller, operation, payload, context) =>
          this.serverCall(catalog, caller ?? id, operation, payload, context),
        async (catalog, caller, key, allow, action) => {
          if (action) await this.ensureCatalog();
          return this.contractProviders(catalog, caller ?? id, id, key, allow, action);
        },
        () => {
          if (this.workers.get(id) === current) this.workers.delete(id);
          this.draining.delete(current);
        },
      );
      this.workers.set(id, current);
      worker = current;
    }
    return worker.invoke(name.slice(slash + 1), args, signal, action);
  }

  private artifact(manifest: Manifest): LocalArtifact | undefined {
    const entry = manifest.entries.local;
    if (!entry) return;
    const entryHash = manifest.hashes[entry.entry];
    const codeHash = manifest.hashes[entry.code];
    if (entryHash && codeHash) return { id: manifest.plugin.id, entryHash, codeHash };
  }

  private loadCatalog(generation: number) {
    if (this.loading?.generation === generation) return this.loading.promise;
    const promise = this.refresh(generation);
    this.loading = { generation, promise };
    void promise.catch(() => {
      if (this.loading?.promise === promise) this.loading = undefined;
    });
    return promise;
  }

  private async refresh(generation: number) {
    const catalog = (await this.server.plugins()) as unknown as Catalog;
    const { plugins } = catalog;
    const workers = [...this.workers.values()];
    // Retire only after the process connection is ready to receive the frame.
    await Promise.allSettled(workers.map((worker) => worker.ready));
    if (this.closed || generation !== this.generation) return;
    const previous = this.catalog;
    this.catalog = catalog;
    const artifacts = new Map(plugins.map((manifest) => [manifest.plugin.id, this.artifact(manifest)]));
    for (const worker of workers) {
      const id = worker.artifact.id;
      if (this.workers.get(id) !== worker) continue;
      const change = worker.catalogChange(artifacts);
      if (change) {
        this.workers.delete(id);
        this.draining.add(worker);
        worker.drain();
      }
    }
    // Routed providers may have been used without opening their own socket.
    // Retire releases those leases; the Runner still holds any admitted call.
    for (const manifest of previous.plugins) {
      const old = this.artifact(manifest);
      if (!old) continue;
      if (!sameArtifact(old, artifacts.get(old.id)))
        for (const worker of workers) void worker.retireArtifact(old).catch(() => {});
    }
    this.loaded = generation;
  }

  private contractProviders(
    catalog: Catalog,
    caller: string,
    worker: string,
    payload: JsonValue,
    allow: (owner: string, name: string, registration: string, artifact: LocalArtifact) => void,
    action: boolean,
  ): JsonValue {
    const { name, owner } = payload as { name: string; owner?: string };
    if (owner !== undefined && owner !== caller)
      throw new Error("Only the defining plugin can list contract providers");
    const definingPlugin = catalog.plugins.find(({ plugin }) => plugin.id === caller);
    const declaration = definingPlugin?.contracts?.find((key) => key.name === name && key.place === "local");
    if (!declaration) throw new Error(`Unknown local contract: ${caller}/${name}`);
    if (declaration.dataMethods !== true)
      throw new Error(
        `Local contract ${caller}/${name} is not all plain data; QuickJS requires dataMethods: true. Rebuild or update this plugin.`,
      );
    if (action) {
      const current = this.catalog.plugins.find(({ plugin }) => plugin.id === caller);
      const compatible = current?.contracts?.some(
        (key) =>
          key.name === name && key.place === "local" && key.declarationHash === declaration.declarationHash,
      );
      const routes = compatible ? (current?.runnerContractRoutes?.[name] ?? []) : [];
      const own = (definingPlugin?.runnerContractRoutes?.[name] ?? []).filter(
        (route) => route.plugin === caller,
      );
      const providers = routes.filter((route) => route.plugin !== caller);
      const index = routes.findIndex((route) => route.plugin === caller);
      providers.splice(Math.max(0, index), 0, ...own);
      return providers.map((route) => {
        if ("incompatible" in route) return route;
        const [entryHash, codeHash] = route.build.split(":");
        allow(route.owner, name, route.registration, { id: route.plugin, entryHash, codeHash });
        return { ...route, own: route.plugin === worker };
      });
    }
    const providers = [];
    for (const manifest of catalog.plugins) {
      const plugin = manifest.plugin.id;
      // A registration alone does not grant access to the contract owner.
      if (!declaresAccessTo(manifest.plugin, caller)) continue;
      const registrations = manifest.contractProviders?.filter(
        (p) => p.owner === caller && p.name === name && p.place === "local",
      );
      if (!registrations?.length) continue;
      if (registrations.some((p) => p.declarationHash !== declaration.declarationHash)) {
        // An incompatible build is discoverable but cannot be loaded or routed.
        providers.push({ plugin, incompatible: true });
        continue;
      }
      const artifact = this.artifact(manifest);
      if (!artifact) continue;
      const own = plugin === worker;
      for (const { registration, unavailable } of registrations) {
        // A compatible provider can be replaced independently of its caller.
        const current = this.catalog.plugins.find(({ plugin: candidate }) => candidate.id === plugin);
        const compatible = current?.contractProviders?.some(
          (entry) =>
            entry.place === "local" &&
            entry.owner === caller &&
            entry.name === name &&
            entry.registration === registration &&
            entry.declarationHash === declaration.declarationHash,
        );
        const currentArtifact =
          compatible && current && declaresAccessTo(current.plugin, caller)
            ? this.artifact(current)
            : undefined;
        const target = own ? artifact : (currentArtifact ?? artifact);
        allow(caller, name, registration, target);

        providers.push({
          plugin,
          registration,
          own,
          owner: caller,
          ...(unavailable === undefined ? {} : { unavailable }),
          build: `${target.entryHash}:${target.codeHash}`,
        });
      }
    }
    return providers;
  }

  private async serverCall(
    catalog: Catalog,
    callerId: string,
    operation: string,
    payload: JsonValue,
    { continuation, signal, action }: WorkerCallContext,
  ) {
    if (operation === "hook.stage") {
      if (!action || !this.server.hookStage || typeof payload !== "number")
        throw new Error("Runner hook scope unavailable");
      return this.server.hookStage(payload);
    }
    if (operation === "auth.current") {
      // A burst of routed calls need the same caller. Share only the read in
      // flight so the workspace queue is not filled with duplicate replies.
      return (this.authRead ??= this.server.query(authCaller[functionName], {}).finally(() => {
        this.authRead = undefined;
      }));
    }
    if (action && operation === "contract.list") unavailable("serverContracts");
    const {
      name,
      args,
      on,
      kind: requested,
    } = payload as {
      name: string;
      args: JsonValue;
      on?: ActionTarget;
      kind?: "query" | "mutation" | "action";
    };
    const slash = typeof name === "string" ? name.indexOf("/") : -1;
    if (slash < 1) throw new Error("Expected a plugin-qualified server function");
    const id = name.slice(0, slash);
    if (action && operation === "plugin.call" && !catalog.functions?.some((fn) => fn.name === name))
      unavailable("privateFunctions");
    if (id !== callerId) {
      // The session can call more functions than a plugin declares. Preserve
      // the plugin's dependency and public export boundary on this bridge.
      const caller = catalog.plugins.find((entry) => entry.plugin.id === callerId)?.plugin;
      const target = this.catalog.plugins.find((entry) => entry.plugin.id === id);
      if (
        !caller ||
        !declaresAccessTo(caller, id) ||
        !target?.publicFunctions?.includes(name.slice(slash + 1))
      )
        throw new Error(`Plugin ${callerId} cannot call ${name}`);
    }
    // Use client dispatch even for the same plugin: the server checks the
    // requested kind and keeps internal functions out of this session's API.
    const kind =
      operation === "local.runQuery"
        ? "query"
        : operation === "local.runMutation"
          ? "mutation"
          : operation === "local.runAction"
            ? "action"
            : operation === "plugin.call"
              ? (requested ?? this.catalog.functions?.find((fn) => fn.name === name)?.kind)
              : undefined;
    if ((kind === "query" || kind === "mutation" || kind === "action") && continuation) {
      if (!this.server.continueLocalCall) throw new Error("Server transport cannot continue a Runner call");
      const window = kind === "action" && this.server.dispatchWindowAction !== undefined;
      const result = await this.server.continueLocalCall(
        kind,
        name,
        args,
        continuation,
        on,
        window,
        kind === "action" ? signal : undefined,
      );
      return window ? this.finishAction(name, args, result, signal) : result;
    }
    if (operation === "local.runQuery") return this.server.query(name, args);
    if (operation === "local.runMutation") return this.server.mutation(name, args);
    if (operation === "local.runAction" && this.server.action) return this.server.action(name, args);
    throw new Error(`Unknown local host operation: ${operation}`);
  }

  async close() {
    this.closed = true;
    this.unlisten();
    this.generation++;
    const workers = [...this.workers.values(), ...this.draining];
    this.workers.clear();
    this.draining.clear();
    await Promise.allSettled(workers.map((worker) => worker.close("Local plugin generation retired")));
  }
}

function sameArtifact(a: LocalArtifact, b: LocalArtifact | undefined) {
  return a.entryHash === b?.entryHash && a.codeHash === b.codeHash;
}

function routeKey(plugin: string, owner: string, name: string, registration: string) {
  return JSON.stringify([plugin, owner, name, registration]);
}

class LocalWorker {
  private readonly endpoint: Promise<Worker>;
  private readonly calls = new Map<
    number,
    {
      finish(error: Error | string | undefined, value?: JsonValue): void;
      cancelled: boolean;
      signal?: ActionSignal;
      action: boolean;
      providers: Set<string>;
      routes: Map<string, LocalArtifact>;
      catalog: Catalog;
    }
  >();
  private next = 0;
  private closing?: Promise<void>;
  private draining = false;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private invoking = 0;

  constructor(
    launch: LaunchLocalWorker,
    readonly artifact: LocalArtifact,
    workspace: string | undefined,
    private readonly catalog: () => Catalog,
    private readonly serverCall: (
      catalog: Catalog,
      caller: string | undefined,
      op: string,
      payload: JsonValue,
      context: WorkerCallContext,
    ) => Promise<JsonValue>,
    private readonly contractProviders: (
      catalog: Catalog,
      caller: string | undefined,
      key: JsonValue,
      allow: (owner: string, name: string, registration: string, artifact: LocalArtifact) => void,
      action: boolean,
    ) => Promise<JsonValue>,
    private readonly retire: () => void,
  ) {
    this.endpoint = launch(
      artifact,
      (message) => {
        void this.receive(message).catch((error) => this.close(String(error)));
      },
      (reason) => {
        void this.close(reason);
      },
      workspace,
    );
  }

  get ready() {
    return this.endpoint;
  }

  async invoke(name: string, args: JsonValue, signal?: ActionSignal, action?: WindowInvocation) {
    const catalog = this.catalog();
    this.invoking++;
    try {
      return await this.call(name, args, catalog, signal, action);
    } finally {
      this.invoking--;
      this.finishDraining();
    }
  }

  private async call(
    name: string,
    args: JsonValue,
    catalog: Catalog,
    signal: ActionSignal | undefined,
    action?: WindowInvocation,
  ) {
    let endpoint: Worker;
    try {
      endpoint = await this.endpoint;
    } catch (error) {
      void this.close(String(error));
      throw error;
    }
    if (!endpoint.pointPlans && action?.hooks?.points) {
      for (const [point, stages] of Object.entries(action.hooks.points)) {
        const hook = stages.hooks[0];
        if (!hook) continue;
        throw new RemoteFunctionError({
          message: `The Runner cannot run hook ${hook.owner}/${hook.name} at point ${name}#${point}`,
          plugin: hook.owner,
          hook: hook.name,
          point,
          stage: hook.before ? "pointBefore" : "pointAfter",
          kind: "hookRunnerUnavailable",
          data: null,
        });
      }
    }
    if (this.closing) throw new Error("Plugin process retired");
    if (this.draining) throw new Error("Local plugin build retired");
    if (signal?.aborted) throw new Error("Local function cancelled");
    if (this.calls.size >= WORKER_CAPACITY) throw new Error("Plugin process invocation limit reached");
    const id = ++this.next;
    const invocation = {
      type: "invoke",
      id,
      fn: name,
      args,
      ...(action ? { action: true, note: action.note, hooks: action.hooks } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(invocation)).length >= WORKER_FRAME_BYTES)
      throw new Error("Local function arguments exceed 1 MiB");
    return new Promise<JsonValue>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        call.cancelled = true;
        // A handler can ignore abort; close the connection if it
        // cannot finish cooperative cleanup before the deadline.
        timer = setTimeout(() => {
          void this.close("Local function cancellation timed out");
        }, 1000);
        void endpoint.send({ type: "cancel", id }).catch((error) => this.close(String(error)));
      };
      const call = {
        cancelled: false,
        signal,
        action: action !== undefined,
        providers: new Set(Object.keys(action?.hooks?.artifacts ?? {})),
        routes: new Map<string, LocalArtifact>(),
        catalog,
        finish: (error: Error | string | undefined, value?: JsonValue) => {
          clearTimeout(timer);
          this.calls.delete(id);
          signal?.removeEventListener("abort", cancel);
          if (error !== undefined || call.cancelled)
            reject(error instanceof Error ? error : new Error(error ?? "Local function cancelled"));
          else resolve(value!);
        },
      };
      this.calls.set(id, call);
      signal?.addEventListener("abort", cancel, { once: true });
      void endpoint.send(invocation).catch((error) => this.close(String(error)));
    });
  }

  private async receive(message: JsonValue) {
    if (this.closing) return;
    const frame = message as {
      type: string;
      id: number;
      call: number;
      name: string;
      plugin?: string;
      payload: JsonValue;
      continuation?: Continuation;
      error?: string;
      details?: ConstructorParameters<typeof RemoteFunctionError>[0] | null;
      value: JsonValue;
    };
    if (frame.type === "result") {
      const error = frame.details ? new RemoteFunctionError(frame.details) : frame.error;
      this.calls.get(frame.id)?.finish(error, frame.value);
    } else if (frame.type === "op") {
      const call = this.calls.get(frame.call);
      if (!call || call.cancelled) return;
      let response: JsonValue;
      try {
        if (frame.plugin !== undefined && !call.providers.has(frame.plugin))
          throw new Error("Local provider is not active in this invocation");
        const worker = await this.endpoint;
        if (frame.name === "local.contract.call" || frame.name === "local.contract.describe") {
          const { plugin, owner, name, registration, method } = frame.payload as {
            plugin: string;
            owner: string;
            name: string;
            registration: string;
            method?: string;
          };
          const route = call.routes.get(routeKey(plugin, owner, name, registration));
          if (
            (frame.plugin ?? this.artifact.id) !== owner ||
            !route ||
            (frame.name === "local.contract.call" && !method)
          )
            throw new Error(`Invalid local contract route for ${owner}/${name}.${method ?? "describe"}`);
          if (this.calls.get(frame.call) === call && !call.cancelled) {
            call.providers.add(plugin);
            await worker.route(frame.id, route);
          }
          return;
        }
        const value =
          frame.name === "local.contracts"
            ? await this.contractProviders(
                call.catalog,
                frame.plugin,
                frame.payload,
                (owner, name, registration, artifact) => {
                  call.routes.set(routeKey(artifact.id, owner, name, registration), artifact);
                },
                call.action,
              )
            : await this.serverCall(call.catalog, frame.plugin, frame.name, frame.payload, {
                continuation: frame.continuation,
                signal: call.signal,
                action: call.action,
              });
        response = {
          type: "opResult",
          id: frame.id,
          value,
        };
        if (new TextEncoder().encode(JSON.stringify(response)).length >= WORKER_FRAME_BYTES)
          throw new Error("Server result exceeds the plugin process's 1 MiB limit");
      } catch (error) {
        response = {
          type: "opResult",
          id: frame.id,
          error:
            error instanceof RemoteFunctionError && error.kind
              ? {
                  message: error.message,
                  plugin: error.plugin ?? "",
                  hook: error.hook ?? "",
                  stage: error.stage ?? "",
                  kind: error.kind,
                  data: error.data ?? null,
                }
              : String(error).slice(0, 8192),
        };
      }
      if (this.calls.get(frame.call) === call && !call.cancelled) await (await this.endpoint).send(response);
    } else if (frame.type !== "log") {
      throw new Error("Invalid plugin process message");
    }
  }

  catalogChange(artifacts: ReadonlyMap<string, LocalArtifact | undefined>) {
    return !sameArtifact(this.artifact, artifacts.get(this.artifact.id));
  }

  drain() {
    this.draining = true;
    if (this.invoking > 0) {
      // Give this build's admitted calls a bounded chance to settle on reload.
      const retired = "Local plugin build retired";
      this.reloadTimer = setTimeout(() => void this.close(new LocalReloadTimeout()), LOCAL_RELOAD_GRACE_MS);
      void this.endpoint.then((worker) => worker.retire(this.artifact)).catch(() => this.close(retired));
    }
    this.finishDraining();
  }

  private finishDraining() {
    if (!this.draining || this.invoking !== 0) return;
    void this.close("Local plugin build retired", true);
  }

  async retireArtifact(artifact: LocalArtifact) {
    if (this.draining && artifact.id === this.artifact.id && sameArtifact(artifact, this.artifact)) return;
    await (await this.endpoint).retire(artifact);
  }

  close(reason: Error | string, retire = false) {
    if (!this.closing) {
      clearTimeout(this.reloadTimer);
      this.closing = this.endpoint
        .then(async (worker) => {
          if (retire) await worker.retire(this.artifact).catch(() => {});
          await worker.close();
        })
        .catch(() => {});
      this.retire();
      for (const call of this.calls.values()) call.finish(reason);
    }
    return this.closing;
  }
}
