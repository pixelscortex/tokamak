import {
  authCaller,
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

export interface LocalArtifact {
  id: string;
  entryHash: string;
  codeHash: string;
}

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
  send(message: JsonValue): Promise<void>;
  close(): Promise<void>;
  load?(artifact: LocalArtifact): Promise<string>;
  routed?: boolean;
  route?(id: number, artifact: LocalArtifact): Promise<void>;
  retire?(artifact: LocalArtifact): Promise<void>;
}>;

type ServerConnection = ClientTransport & {
  plugins(): Promise<JsonValue>;
  onPluginsChanged(callback: () => void): () => void;
};
type Worker = Awaited<ReturnType<LaunchLocalWorker>>;
type Catalog = {
  plugins: Manifest[];
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

  async invoke(name: string, args: JsonValue, signal?: ActionSignal): Promise<JsonValue> {
    const slash = name.indexOf("/");
    if (slash < 1) throw new Error("Expected a plugin-qualified local function");
    if (signal?.aborted) throw new Error("Local function cancelled");
    const id = name.slice(0, slash);
    // Read the catalog once per plugin generation, not once per call: a window
    // making many local calls at once (one per message of a long thread) would
    // otherwise flood its connection with catalog pages and be disconnected.
    while (!this.closed && this.loaded !== this.generation) {
      // A reload overtook the catalog read. Retry without discarding workers
      // that still match their installed artifacts.
      await this.loadCatalog(this.generation);
    }
    if (this.closed) throw new Error("Local functions closed");
    const manifest = this.catalog.plugins.find((entry) => entry.plugin.id === id);
    const artifact = manifest && this.artifact(manifest);
    if (!artifact) {
      // The caller may know about this plugin before this catalog does: an
      // install or reload answers its request before the "plugins changed"
      // notice reaches this connection. Read the catalog once more before
      // saying the plugin has nothing to run.
      if (this.rechecked.get(id) !== this.generation) {
        if (this.rechecked.size >= RECHECK_CAPACITY) this.rechecked.clear();
        this.rechecked.set(id, ++this.generation);
        return this.invoke(name, args, signal);
      }
      throw new Error(`Plugin ${id} has no local functions`);
    }
    let worker = this.workers.get(id);
    if (worker && !sameArtifact(worker.artifact, artifact)) {
      void worker.close("Local plugin generation retired");
      worker = undefined;
    }
    if (!worker) {
      if (this.workers.size >= WORKER_CAPACITY) throw new Error("Local plugin worker limit reached");
      const current = new LocalWorker(
        this.launch,
        artifact,
        this.workspace,
        () => this.catalog,
        (catalog, caller, operation, payload) => this.serverCall(catalog, caller ?? id, operation, payload),
        (catalog, caller, host, key, load, allow, routed) =>
          this.contractProviders(catalog, caller ?? id, host ?? id, key, load, allow, routed),
        () => {
          if (this.workers.get(id) === current) this.workers.delete(id);
          this.draining.delete(current);
        },
      );
      this.workers.set(id, current);
      worker = current;
    }
    return worker.invoke(name.slice(slash + 1), args, signal);
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
    const { plugins } = (await this.server.plugins()) as unknown as { plugins: Manifest[] };
    const workers = [...this.workers.values()];
    // Learn which runtime each worker uses before applying the new catalog.
    await Promise.allSettled(workers.map((worker) => worker.ready));
    if (this.closed || generation !== this.generation) return;
    const previous = this.catalog;
    this.catalog = { plugins };
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

  private async contractProviders(
    catalog: Catalog,
    caller: string,
    worker: string,
    payload: JsonValue,
    load: (artifact: LocalArtifact) => Promise<string>,
    allow: (owner: string, name: string, registration: string, artifact: LocalArtifact) => void,
    routed: boolean,
  ): Promise<JsonValue> {
    const { name, owner } = payload as { name: string; owner?: string };
    if (owner !== undefined && owner !== caller)
      throw new Error("Only the defining plugin can list contract providers");
    const definingPlugin = catalog.plugins.find(({ plugin }) => plugin.id === caller);
    const declaration = definingPlugin?.contracts?.find((key) => key.name === name && key.place === "local");
    if (!declaration) throw new Error(`Unknown local contract: ${caller}/${name}`);
    if (routed && declaration.dataMethods !== true)
      throw new Error(
        `Local contract ${caller}/${name} is not all plain data; QuickJS requires dataMethods: true. Rebuild or update this plugin.`,
      );
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
      const path = !routed && !own ? await load(artifact) : undefined;
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
        if (routed) allow(caller, name, registration, target);

        providers.push({
          plugin,
          registration,
          ...(path !== undefined && { path }),
          own,
          owner: caller,
          ...(unavailable === undefined ? {} : { unavailable }),
          ...(routed && { build: `${target.entryHash}:${target.codeHash}` }),
        });
      }
    }
    return providers;
  }

  private serverCall(catalog: Catalog, callerId: string, operation: string, payload: JsonValue) {
    if (operation === "auth.current") return this.server.query(authCaller[functionName], {});
    const { name, args } = payload as { name: string; args: JsonValue };
    const slash = typeof name === "string" ? name.indexOf("/") : -1;
    if (slash < 1) throw new Error("Expected a plugin-qualified server function");
    const id = name.slice(0, slash);
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
  private routed = false;
  private readonly calls = new Map<
    number,
    {
      finish(error: Error | string | undefined, value?: JsonValue): void;
      cancelled: boolean;
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
  private readonly loaded = new Map<string, { artifact: LocalArtifact; path: Promise<string> }>();

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
    ) => Promise<JsonValue>,
    private readonly contractProviders: (
      catalog: Catalog,
      caller: string | undefined,
      host: string | undefined,
      key: JsonValue,
      load: (artifact: LocalArtifact) => Promise<string>,
      allow: (owner: string, name: string, registration: string, artifact: LocalArtifact) => void,
      routed: boolean,
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
    ).then((worker) => {
      this.routed = worker.routed === true;
      return worker;
    });
  }

  get ready() {
    return this.endpoint;
  }

  async invoke(name: string, args: JsonValue, signal?: ActionSignal) {
    const catalog = this.catalog();
    this.invoking++;
    try {
      return await this.call(name, args, catalog, signal);
    } finally {
      this.invoking--;
      this.finishDraining();
    }
  }

  private async call(name: string, args: JsonValue, catalog: Catalog, signal?: ActionSignal) {
    let endpoint: Worker;
    try {
      endpoint = await this.endpoint;
    } catch (error) {
      void this.close(String(error));
      throw error;
    }
    if (this.closing) throw new Error("Local worker retired");
    if (this.draining) throw new Error("Local plugin build retired");
    if (signal?.aborted) throw new Error("Local function cancelled");
    if (this.calls.size >= WORKER_CAPACITY) throw new Error("Local worker invocation limit reached");
    const id = ++this.next;
    const invocation = { type: "invoke", id, fn: name, args };
    if (new TextEncoder().encode(JSON.stringify(invocation)).length >= WORKER_FRAME_BYTES)
      throw new Error("Local function arguments exceed 1 MiB");
    return new Promise<JsonValue>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        call.cancelled = true;
        // A handler can ignore abort or block Bun; retire the worker if it
        // cannot finish cooperative cleanup before the deadline.
        timer = setTimeout(() => {
          void this.close("Local function cancellation timed out");
        }, 1000);
        void endpoint.send({ type: "cancel", id }).catch((error) => this.close(String(error)));
      };
      const call = {
        cancelled: false,
        providers: new Set<string>(),
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
      error?: string;
      value: JsonValue;
    };
    if (frame.type === "result") {
      this.calls.get(frame.id)?.finish(frame.error, frame.value);
    } else if (frame.type === "op") {
      const call = this.calls.get(frame.call);
      if (!call || call.cancelled) return;
      let response: JsonValue;
      try {
        if (frame.plugin !== undefined && !call.providers.has(frame.plugin))
          throw new Error("Local provider is not active in this invocation");
        const worker = await this.endpoint;
        if (
          worker.routed &&
          (frame.name === "local.contract.call" || frame.name === "local.contract.describe")
        ) {
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
            await worker.route!(frame.id, route);
          }
          return;
        }
        const catalog = worker.routed ? call.catalog : this.catalog();
        const value =
          frame.name === "local.contracts"
            ? await this.contractProviders(
                catalog,
                frame.plugin,
                worker.routed ? frame.plugin : undefined,
                frame.payload,
                async (artifact) => {
                  const path = await this.loadProvider(artifact);
                  call.providers.add(artifact.id);
                  return path;
                },
                (owner, name, registration, artifact) => {
                  call.routes.set(routeKey(artifact.id, owner, name, registration), artifact);
                },
                worker.routed === true,
              )
            : await this.serverCall(catalog, frame.plugin, frame.name, frame.payload);
        response = {
          type: "opResult",
          id: frame.id,
          value,
        };
        if (new TextEncoder().encode(JSON.stringify(response)).length >= WORKER_FRAME_BYTES)
          throw new Error("Server result exceeds 1 MiB worker limit");
      } catch (error) {
        response = { type: "opResult", id: frame.id, error: String(error).slice(0, 8192) };
      }
      if (this.calls.get(frame.call) === call && !call.cancelled) await (await this.endpoint).send(response);
    } else if (frame.type !== "log") {
      throw new Error("Invalid local worker message");
    }
  }

  catalogChange(artifacts: ReadonlyMap<string, LocalArtifact | undefined>) {
    const matches = (artifact: LocalArtifact) => sameArtifact(artifact, artifacts.get(artifact.id));
    if (!matches(this.artifact)) {
      if (this.routed) return true;
      void this.close("Local plugin generation retired");
    } else if (!this.routed && [...this.loaded.values()].some(({ artifact }) => !matches(artifact))) {
      // Bun caches imported modules. Closing the worker releases the provider and its tasks.
      void this.close("Local plugin generation retired");
    }
    return false;
  }

  drain() {
    this.draining = true;
    if (this.invoking > 0) {
      // Give this build's admitted calls a bounded chance to settle on reload.
      const retired = "Local plugin build retired";
      this.reloadTimer = setTimeout(() => void this.close(new LocalReloadTimeout()), 5_000);
      void this.endpoint.then((worker) => worker.retire?.(this.artifact)).catch(() => this.close(retired));
    }
    this.finishDraining();
  }

  private finishDraining() {
    if (!this.draining || this.invoking !== 0) return;
    void this.close("Local plugin build retired", true);
  }

  async retireArtifact(artifact: LocalArtifact) {
    if (this.draining && artifact.id === this.artifact.id && sameArtifact(artifact, this.artifact)) return;
    await (await this.endpoint).retire?.(artifact);
  }

  private loadProvider(artifact: LocalArtifact): Promise<string> {
    const current = this.loaded.get(artifact.id);
    if (current) {
      if (
        current.artifact.codeHash !== artifact.codeHash ||
        current.artifact.entryHash !== artifact.entryHash
      )
        return Promise.reject(new Error("Local provider generation changed"));
      return current.path;
    }
    const path = this.endpoint.then((worker) => {
      if (!worker.load) throw new Error("Local contract loading is unavailable");
      return worker.load(artifact);
    });
    this.loaded.set(artifact.id, { artifact, path });
    void path.catch(() => {
      if (this.loaded.get(artifact.id)?.path === path) this.loaded.delete(artifact.id);
    });
    return path;
  }

  close(reason: Error | string, retire = false) {
    if (!this.closing) {
      clearTimeout(this.reloadTimer);
      this.closing = this.endpoint
        .then(async (worker) => {
          if (retire) await worker.retire?.(this.artifact).catch(() => {});
          await worker.close();
        })
        .catch(() => {});
      this.retire();
      for (const call of this.calls.values()) call.finish(reason);
    }
    return this.closing;
  }
}
