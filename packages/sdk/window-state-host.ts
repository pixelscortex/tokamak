import { createSignal, onCleanup, type Signal } from "solid-js";
import { assertJson, jsonSnapshot, type JsonValue } from "./src/values";
import type { ClientTransport } from "./src/client";
import { readWindowState, writeWindowState } from "./src/window-state-protocol";
import { makeState, type StateOptions, type WindowState } from "./window-state";

export { windowStateModule } from "./src/window-state-protocol";
export type WindowStateTransport = Partial<Pick<ClientTransport, "query" | "mutation">>;

type Saved = { value: JsonValue } | null;
export interface WindowStateStorage {
  device: {
    read(key: string): Saved;
    write(key: string, value: JsonValue): void;
  };
  me: {
    read(key: string): Promise<Saved>;
    write(key: string, value: JsonValue): Promise<unknown>;
  };
  report(error: unknown): void;
}

/** The workspace key separates device storage for different server connections. */
export function windowStateStorage(
  plugin: string,
  workspaceKey: string,
  transport?: WindowStateTransport,
): WindowStateStorage {
  const deviceKey = (key: string) => JSON.stringify(["tokamak.window-state", workspaceKey, plugin, key]);

  return {
    device: {
      read(key) {
        const stored = localStorage.getItem(deviceKey(key));
        if (stored === null) return null;
        const value: unknown = JSON.parse(stored);
        assertJson(value, "saved window state");
        return { value };
      },
      write(key, value) {
        localStorage.setItem(deviceKey(key), JSON.stringify(value));
      },
    },
    me: {
      async read(key) {
        if (!transport?.query) throw new Error("No server connection for window state");
        const saved = await transport.query(readWindowState, { plugin, key });
        if (saved === null) return null;
        if (typeof saved === "object" && !Array.isArray(saved) && "value" in saved)
          return { value: saved.value };
        throw new Error("Invalid server window state");
      },
      async write(key, value) {
        if (!transport?.mutation) throw new Error("No server connection for window state");
        await transport.mutation(writeWindowState, { plugin, key, value });
      },
    },
    report(error) {
      // oxlint-disable-next-line no-console -- Report failed saves without unloading the plugin.
      console.warn(`Window state for ${plugin}: ${String(error)}`);
    },
  };
}

/** One scope per plugin in the window. Generated modules receive it as a capability. */
export function createWindowState(storage?: WindowStateStorage) {
  const cells = new Map<string, unknown>();
  const mounted = new Map<string, Set<number>>();
  const controller = new AbortController();
  const unsaved = new Set<string>();
  const [hasUnsavedChanges, setHasUnsavedChanges] = createSignal(false);
  let site: string | undefined;

  return {
    hasUnsavedChanges,
    dispose: () => controller.abort(),
    at<T>(key: string, render: () => T): T {
      const previous = site;
      site = key;
      try {
        return render();
      } finally {
        site = previous;
      }
    },

    instance(component: string, key?: unknown): string {
      const name = JSON.stringify([
        component,
        site ?? null,
        typeof key === "string" || typeof key === "number" ? key : null,
      ]);
      let slots = mounted.get(name);
      if (!slots) mounted.set(name, (slots = new Set()));
      let index = 0;
      while (slots.has(index)) index++;
      slots.add(index);
      onCleanup(() => {
        slots.delete(index);
        if (!slots.size) mounted.delete(name);
      });
      return `${name}:${index}`;
    },

    state<T>(name: string, initial: T, options?: StateOptions): WindowState<T> {
      const key = JSON.stringify(["state", name]);
      const existing = cells.get(key) as WindowState<T> | undefined;
      if (existing) return existing;
      const cell = options?.keep
        ? storedState(key, initial, options.keep, storage, controller.signal, (pending) => {
            if (pending) unsaved.add(key);
            else unsaved.delete(key);
            setHasUnsavedChanges(unsaved.size > 0);
          })
        : makeState(initial).state;
      cells.set(key, cell);
      return cell;
    },

    signal<T>(name: string, create: () => Signal<T>): Signal<T> {
      const key = JSON.stringify(["signal", name]);
      if (!cells.has(key)) cells.set(key, create());
      return cells.get(key) as Signal<T>;
    },
  };
}

function storedState<T>(
  key: string,
  initial: T,
  keep: NonNullable<StateOptions["keep"]>,
  storage: WindowStateStorage | undefined,
  signal: AbortSignal,
  markUnsaved: (pending: boolean) => void,
): WindowState<T> {
  if (!storage) throw new Error("Persistent state requires window storage");
  jsonSnapshot(initial, "state");
  if (keep === "device") {
    let value = initial;
    try {
      const saved = storage.device.read(key);
      if (saved) value = saved.value as T;
    } catch (error) {
      storage.report(error);
    }
    return makeState(value, (next) => {
      const snapshot = jsonSnapshot(next, "state");
      try {
        storage.device.write(key, snapshot);
      } catch (error) {
        storage.report(error);
      }
    }).state;
  }

  let edits: ((previous: T) => T)[] | undefined = [];
  let latestSave = 0;
  const save = (snapshot: JsonValue) => {
    const version = ++latestSave;
    void storage.me.write(key, snapshot).then(() => {
      if (!signal.aborted && version === latestSave) markUnsaved(false);
    }, storage.report);
  };
  const cell = makeState(initial, (next, apply) => {
    const snapshot = jsonSnapshot(next, "state");
    if (signal.aborted) return;
    markUnsaved(true);
    if (edits) edits.push(apply);
    else save(snapshot);
  });
  void readWithRetry(storage, key, signal)
    .then((saved) => {
      if (signal.aborted || !edits) return;
      const queued = edits;
      edits = undefined;
      let value = saved ? (saved.value as T) : initial;
      if (queued.length) {
        try {
          // Replay updater functions so early edits build on the saved state.
          const updated = queued.reduce((previous, apply) => apply(previous), value);
          save(jsonSnapshot(updated, "state"));
          value = updated;
        } catch (error) {
          storage.report(error);
        }
      }
      cell.restore(value);
    })
    .catch(storage.report);
  return cell.state;
}

async function readWithRetry(storage: WindowStateStorage, key: string, signal: AbortSignal) {
  let delay = 250;
  while (!signal.aborted) {
    try {
      return await storage.me.read(key);
    } catch (error) {
      if (signal.aborted) return;
      storage.report(error);
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        signal.addEventListener("abort", finish, { once: true });
      });
      delay = Math.min(delay * 2, 5_000);
    }
  }
}

type WindowStateScope = ReturnType<typeof createWindowState>;
const bindings = new Map<string, WindowStateScope>();

export function offerWindowState(binding: string, scope: WindowStateScope): () => void {
  bindings.set(binding, scope);
  return () => bindings.delete(binding);
}

export function claimWindowState(binding: string): WindowStateScope {
  const scope = bindings.get(binding);
  if (!scope) throw new Error("Window state binding has expired");
  bindings.delete(binding);
  return scope;
}
