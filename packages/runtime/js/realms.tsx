/** Experimental multi-context adapter. The native broker copies tagged JSON
 * and grants call capabilities; no JavaScript object enters another realm. */
import {
  ErrorBoundary,
  createRoot,
  createEffect,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  type Owner,
} from "solid-js";
import {
  createElement,
  createComponent,
  installComponentPortal,
  mountRealm,
  NativeNode,
  setProp,
  warn,
} from "@tokamak/render";
import { functionName } from "@tokamak/sdk";
import { ModuleRegistry, type ModuleExports } from "./modules";

// These globals are installed independently by Rust in each QuickJS context.
declare const __tokamakRealmName: string;
declare const __tokamakRealm: (op: string, input: string) => string;
type Wire = any[];
type Endpoint = { fn: Function; owner: Owner | null };
const endpoints = new Map<number, Endpoint>();
const proxies = new WeakMap<Function, { token: number; component: boolean }>();
let next = 1;
const native = (op: string, data: unknown) => JSON.parse(__tokamakRealm(op, JSON.stringify(data)));

function encode(value: any, component = false, ancestors = new Set<object>()): Wire {
  if (value === undefined) return ["undefined"];
  if (typeof value === "function") {
    const remote = proxies.get(value);
    if (remote) return ["ref", remote.token, remote.component];
    const id = next++;
    endpoints.set(id, { fn: value, owner: getOwner() });
    return ["fn", id, component];
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return ["value", value];
  if (value instanceof Error) return ["error", value.message];
  try {
    const reference = value[functionName];
    if (typeof reference === "string") return ["reference", reference];
  } catch {
    /* API namespace proxies are not individual references. */
  }
  if (value instanceof NativeNode) throw new Error("Native nodes cannot cross realms");
  if (value && typeof value.then === "function")
    return [
      "promise",
      encode((resolve: Function, reject: Function) => {
        void value.then(resolve, reject);
      }),
    ];
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("Realm values must be acyclic JSON or capabilities");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return ["array", value.map((v) => encode(v, false, ancestors))];
    return [
      "object",
      Object.fromEntries(Object.keys(value).map((key) => [key, encode(value[key], false, ancestors)])),
    ];
  } finally {
    ancestors.delete(value);
  }
}
function decode(value: Wire): any {
  switch (value[0]) {
    case "undefined":
      return undefined;
    case "value":
      return value[1];
    case "error":
      return new Error(value[1]);
    case "reference":
      return { [functionName]: value[1] };
    case "array":
      return value[1].map(decode);
    case "object":
      return Object.fromEntries(Object.entries(value[1]).map(([key, item]) => [key, decode(item as Wire)]));
    case "fn": {
      const endpoint = endpoints.get(value[1]);
      if (!endpoint) throw new Error("Retired local function");
      return endpoint.fn;
    }
    case "ref": {
      const fn = (...args: unknown[]) => decode(native("call", { token: value[1], args: encode(args) }));
      proxies.set(fn, { token: value[1], component: value[2] });
      return fn;
    }
    case "promise":
      return new Promise(decode(value[1]));
    default:
      throw new Error("Invalid realm value");
  }
}
function exportsWire(exports: ModuleExports): Wire {
  return [
    "object",
    Object.fromEntries(
      Object.entries(exports).map(([key, value]) => [key, encode(value, /^[A-Z]/.test(key))]),
    ),
  ];
}
function enter(target: string, method: string, value?: unknown): any {
  return decode(native("enter", { target, method, payload: encode(value) }));
}

/** Slice supports views, fills and JSON props with callable capabilities.
 * Wrappers/public component context inheritance need the design's next stage. */
export function installRealmEntry(modules: ModuleRegistry): void {
  const mounts = new Map<number, { stop(): void; update(props: any): void }>();
  Object.defineProperty(globalThis, "__tokamakRealmEntry", {
    value(method: string, json: string): string {
      const data = JSON.parse(json);
      if (method === "invoke") {
        const endpoint = endpoints.get(data.id);
        if (!endpoint) throw new Error("Retired realm function");
        const args = decode(data.args);
        const result = runWithOwner(endpoint.owner, () => endpoint.fn(...args));
        return JSON.stringify(encode(result));
      }
      if (method === "mount") {
        const endpoint = endpoints.get(data.id);
        if (!endpoint) throw new Error("Retired realm component");
        const [props, setProps] = createSignal(decode(data.props));
        const liveProps = new Proxy(
          {},
          {
            get: (_target, key) => props()[key],
            ownKeys: () => Reflect.ownKeys(props()),
            getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
            has: (_target, key) => key in props(),
          },
        );
        const stop = runWithOwner(endpoint.owner, () =>
          mountRealm(data.mount, () => (
            <ErrorBoundary
              fallback={(cause: unknown) => {
                warn(`Realm component failed: ${String(cause)}`);
                return null;
              }}
            >
              {createComponent(endpoint.fn as (props: object) => any, liveProps)}
            </ErrorBoundary>
          )),
        );
        if (stop) mounts.set(data.mount, { stop, update: (value) => setProps(() => value) });
        return JSON.stringify(encode(undefined));
      }
      if (method === "update") {
        mounts.get(data.mount)?.update(decode(data.props));
        return JSON.stringify(encode(undefined));
      }
      if (method === "unmount") {
        mounts.get(data.mount)?.stop();
        mounts.delete(data.mount);
        return JSON.stringify(encode(undefined));
      }
      const payload = decode(data);
      switch (method) {
        case "evaluate":
          modules.evaluate(payload.name, payload.code);
          return JSON.stringify(encode(modules.dependencies(payload.name)));
        case "provide":
          modules.provide(payload.name, payload.exports);
          break;
        case "exports":
          return JSON.stringify(exportsWire(modules.require(payload)));
        case "dispose":
          for (const mount of mounts.values()) mount.stop();
          mounts.clear();
          modules.remove([payload]);
          break;
        default:
          throw new Error(`Unknown realm entry ${method}`);
      }
      return JSON.stringify(encode(undefined));
    },
  });
  installComponentPortal((component, props) => {
    const remote = proxies.get(component);
    if (!remote?.component) return;
    const point = createElement("div");
    setProp(point, "style", "display:contents");
    let mount: number | undefined;
    createEffect(() => {
      const value = encode(props);
      if (mount === undefined)
        mount = native("portal", { token: remote.token, parent: point.id, props: value });
      else native("update", { mount, props: value });
    });
    onCleanup(() => {
      if (mount !== undefined) native("unmount", { mount });
    });
    return point;
  });
}

/** Opt-in slice only: production retains ModuleRegistry until the remaining
 * extension semantics and lifecycle are implemented and tested. */
export class IsolatedModuleRegistry extends ModuleRegistry {
  private readonly realmDependencies = new Map<string, string[]>();
  private readonly realmExports = new Map<string, ModuleExports>();
  private services: ((plugin: string) => Record<string, unknown>) | undefined;
  setServices(services: (plugin: string) => Record<string, unknown>): void {
    this.services = services;
  }
  override evaluate(name: string, code: string): void {
    native("create", { name });
    this.realmDependencies.set(name, enter(name, "evaluate", { name, code }));
  }
  override dependencies(name: string): readonly string[] {
    return this.realmDependencies.get(name) ?? [];
  }
  override has(name: string): boolean {
    return this.realmDependencies.has(name) || super.has(name);
  }
  override require(name: string): ModuleExports {
    if (!name.startsWith("@plugins/")) return super.require(name);
    const cached = this.realmExports.get(name);
    if (cached) return cached;
    for (const dependency of this.dependencies(name)) {
      if (dependency.startsWith("@plugins/"))
        enter(name, "provide", { name: dependency, exports: this.require(dependency) });
    }
    const services = this.services?.(name.slice(9, -3));
    if (services) enter(name, "provide", { name: "@tokamak/realm-services", exports: services });
    const exports = enter(name, "exports", name);
    this.realmExports.set(name, exports);
    return exports;
  }
  override remove(names: Iterable<string>): void {
    for (const name of names) {
      if (this.realmDependencies.has(name)) enter(name, "dispose", name);
      this.realmExports.delete(name);
      this.realmDependencies.delete(name);
    }
  }
}

/** Each plugin has local Solid provider objects. Shell services are copied
 * functions with native grants, wrapped in these local providers at mount. */
export function realmProviders(
  modules: ModuleRegistry,
  providers: (services: any, children: () => any) => any,
): void {
  // The per-realm registry only exposes this plugin's own module. Its factory
  // and all contribution mounts inherit a local provider root.
  const original = modules.require.bind(modules);
  modules.require = (name) => {
    if (!name.startsWith("@plugins/")) return original(name);
    const services = original("@tokamak/realm-services");
    let exports!: ModuleExports;
    createRoot(() =>
      providers(services, () => {
        exports = original(name);
        return null;
      }),
    );
    return Object.fromEntries(
      Object.entries(exports).map(([key, value]) => [
        key,
        typeof value === "function" && /^[A-Z]/.test(key)
          ? (props: object) =>
              providers(services, () => createComponent(value as (props: object) => any, props))
          : value,
      ]),
    );
  };
}
