/** Solid's universal host: a small owned tree, not a DOM polyfill. Rust consumes
 * ordered mutations only after a synchronous JS turn, before native paint. */
import { createRoot, getOwner, onCleanup } from "solid-js";
import { owned, flushRejections, promiseHooks, clearRejections } from "./async-ownership";
import { createRenderer } from "solid-js/universal";
import type { JSX, NativeEvent, EventHandler } from "./jsx-runtime";

export type { JSX, NativeEvent, EventHandler } from "./jsx-runtime";

export class NativeNode {
  readonly children: NativeNode[] = [];
  readonly handlers = new Map<string, EventHandler>();
  parent: NativeNode | undefined;

  /** Queue a vertical scroll in CSS px. Call after observeLayout for current bounds. */
  scrollTo(top: number): void {
    if (!Number.isFinite(top)) throw new TypeError("Scroll offset must be finite");
    pending.push({ op: "scroll", id: this.id, top });
  }

  constructor(
    readonly id: number,
    readonly text: boolean,
  ) {}
}

type Mutation =
  | { op: "element"; id: number; tag: string }
  | { op: "text"; id: number; value: string }
  | { op: "textValue"; id: number; value: string }
  | { op: "attribute"; id: number; name: string; value: string | null }
  | { op: "insert"; id: number; parent: number; before: number | null }
  | { op: "detach"; id: number }
  | { op: "scroll"; id: number; top: number };

declare const __tokamakClipboard: (id: number, text: string) => void;
declare const __tokamakAfter: (id: number, ms: number) => void;

const clipboardWrites = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
let nextClipboardWrite = 1;

export const clipboard = {
  writeText(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = nextClipboardWrite++;
      clipboardWrites.set(id, { resolve, reject });
      try {
        __tokamakClipboard(id, text);
      } catch (cause) {
        clipboardWrites.delete(id);
        reject(cause);
      }
    });
  },
};

declare global {
  interface Clipboard {
    writeText(text: string): Promise<void>;
  }
  interface Navigator {
    readonly clipboard: Clipboard;
  }
  var navigator: Navigator;
}

Object.defineProperty(globalThis, "navigator", {
  value: Object.freeze({ clipboard }),
});

const delays = new Map<number, () => void>();
let nextDelay = 1;

/** Run once on the UI thread after a short delay; disposal cancels delivery. */
export function afterDelay(ms: number, callback: () => void): () => void {
  const id = nextDelay++;
  __tokamakAfter(id, ms);
  delays.set(id, owned(callback));
  const stop = () => {
    delays.delete(id);
  };
  if (getOwner()) onCleanup(stop);
  return stop;
}

const nodes = new Map<number, NativeNode>();
const root = new NativeNode(0, false);
nodes.set(0, root);

let next = 1;
let pending: Mutation[] = [];
let dispose: (() => void) | undefined;
let disposed = false;

const subscriptions = new Map<string, Set<(value: unknown) => void>>();

function allocate(text: boolean): NativeNode {
  const node = new NativeNode(next++, text);
  nodes.set(node.id, node);
  return node;
}

function detach(node: NativeNode) {
  if (node.parent) {
    const siblings = node.parent.children;
    siblings.splice(siblings.indexOf(node), 1);
    node.parent = undefined;
  }
}

const adapter = createRenderer<NativeNode>({
  createElement(tag) {
    const node = allocate(false);
    pending.push({ op: "element", id: node.id, tag });
    return node;
  },
  createTextNode(value) {
    const node = allocate(true);
    pending.push({ op: "text", id: node.id, value });
    return node;
  },
  replaceText(node, value) {
    pending.push({ op: "textValue", id: node.id, value });
  },
  isTextNode: (node) => node.text,
  getParentNode: (node) => node.parent,
  getFirstChild: (node) => node.children[0],
  getNextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
  insertNode(parent, node, before) {
    if (node === before) return;
    detach(node);
    parent.children.splice(before ? parent.children.indexOf(before) : parent.children.length, 0, node);
    node.parent = parent;
    pending.push({ op: "insert", id: node.id, parent: parent.id, before: before?.id ?? null });
  },
  removeNode(_parent, node) {
    detach(node);
    pending.push({ op: "detach", id: node.id });
  },
  setProperty(node, name, value) {
    if (/^on[A-Z]/.test(name)) {
      if (value !== null && value !== undefined && typeof value !== "function")
        throw new TypeError(`${name} must be a handler`);
      const event = name.slice(2).toLowerCase();
      if (typeof value === "function") node.handlers.set(event, owned(value as EventHandler));
      else node.handlers.delete(event);
      return;
    }
    // ARIA and data booleans are strings. Only HTML boolean attributes use
    // presence/absence; aria-disabled is deliberately not native disabled.
    const boolean = name === "disabled" || name === "readonly" || name === "hidden" || name === "autofocus";
    if (value !== null && value !== undefined && !["string", "number", "boolean"].includes(typeof value)) {
      throw new TypeError(`${name} must be a scalar attribute`);
    }
    const attribute =
      value === null || value === undefined || (boolean && value === false)
        ? null
        : boolean && value === true
          ? ""
          : String(value);
    pending.push({ op: "attribute", id: node.id, name, value: attribute });
  },
});

export const {
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  effect,
  memo,
  createComponent,
  mergeProps,
  use,
} = adapter;

/** One Solid ownership root per native document. Dropping the document disposes it. */
export function mount(component: () => JSX.Element): void {
  if (dispose) throw new Error("Document already mounted");
  dispose = createRoot((cleanup) => {
    insert(root, component());
    return cleanup;
  });
}

/** The caller declares its payload type; native only transports owned JSON.
 * Subscription lifetime follows the current Solid owner, including on unmount. */
export function onHostEvent<T>(topic: string, handler: (payload: T) => void): void {
  let handlers = subscriptions.get(topic);
  if (!handlers) subscriptions.set(topic, (handlers = new Set()));
  const listener = owned(handler as (payload: unknown) => void);
  handlers.add(listener);
  onCleanup(() => {
    handlers.delete(listener);
    if (!handlers.size) subscriptions.delete(topic);
  });
}

/** Where an observed element is, as the host reports it after layout
 * (render/src/layout.rs). CSS px, window coordinates. */
export interface Layout {
  /** The element's border box (scrolling included, transforms not). */
  rect: Rect;
  /** The part of the window it can show in: the window cut by every
   * ancestor that clips its overflow (a scroller, a clipped panel). */
  clip: Rect;
  /** Resolved vertical scroll geometry in CSS px, including content growth. */
  scroll: { top: number; height: number; clientHeight: number };
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const observers = new Map<number, Set<(layout: Layout) => void>>();

/** Call `callback` with `node`'s layout after the layout that first places
 * it, and again after every layout that moves or resizes it or its visible
 * area (scrolling, a window resize, content changing around it). Nothing is
 * reported while it does not change. The host lays out again when a
 * callback changes the document, before painting, so a placement computed
 * here is in the first frame that shows it. Stops when the calling owner
 * is disposed, or when the returned function is called. */
export function observeLayout(node: NativeNode, callback: (layout: Layout) => void): () => void {
  let set = observers.get(node.id);
  if (!set) {
    observers.set(node.id, (set = new Set()));
    pending.push({ op: "attribute", id: node.id, name: "tk-observe", value: "" });
  }
  const listener = owned(callback);
  set.add(listener);
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    set.delete(listener);
    if (!set.size && observers.get(node.id) === set) {
      observers.delete(node.id);
      if (!disposed && nodes.get(node.id) === node) {
        pending.push({ op: "attribute", id: node.id, name: "tk-observe", value: null });
      }
    }
  };
  if (getOwner()) onCleanup(stop);
  return stop;
}

function reportLayout(changes: { id: number; rect: number[]; clip: number[]; scroll: number[] }[]) {
  const box = (r: number[]): Rect => ({ x: r[0], y: r[1], width: r[2], height: r[3] });
  for (const change of changes) {
    for (const listener of [...(observers.get(change.id) ?? [])]) {
      listener({
        rect: box(change.rect),
        clip: box(change.clip),
        scroll: { top: change.scroll[0]!, height: change.scroll[1]!, clientHeight: change.scroll[2]! },
      });
    }
  }
}

function drain() {
  flushRejections();
  const mutations = pending;
  pending = [];
  return JSON.stringify(mutations);
}

interface Dispatch {
  type: string;
  chain: number[];
  target: number;
  bubbles: boolean;
  cancelable: boolean;
  value?: string;
  key?: string;
  code?: string;
  command?: string;
  repeat?: boolean;
  isComposing: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

function dispatch(data: Dispatch) {
  let prevented = false,
    stopped = false,
    error: string | null = null;
  const event: NativeEvent = {
    ...data,
    currentTarget: data.target,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      if (data.cancelable) prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  };
  for (const id of data.chain) {
    event.currentTarget = id;
    try {
      nodes.get(id)?.handlers.get(data.type)?.(event);
    } catch (cause) {
      error = String(cause);
      stopped = true;
    }
    if (stopped || !data.bubbles) break;
  }
  return { prevented, stopped, error };
}

/** Dispatch a bubbling, cancelable click through the final rendered handlers.
 * Nonnative button keyboard behavior uses this instead of calling its internal
 * onClick directly. Native buttons already receive clicks from the Rust host.
 * Throws for foreign, disposed or detached nodes; no event crosses a document
 * lifetime. Listener failures propagate to the enclosing native turn, which
 * still flushes preceding valid mutations before reporting the error.
 */
export function dispatchClick(node: NativeNode): void {
  if (disposed) throw new Error("Cannot dispatch click after native document disposal");
  const chain: number[] = [];
  let current: NativeNode | undefined = node;
  while (current) {
    if (nodes.get(current.id) !== current || chain.length >= nodes.size) {
      throw new Error("Cannot dispatch click through a stale or invalid native tree");
    }
    chain.push(current.id);
    if (current === root) break;
    current = current.parent;
  }
  if (current !== root) throw new Error("Cannot dispatch click to a detached native node");
  const result = dispatch({
    type: "click",
    target: node.id,
    chain,
    bubbles: true,
    cancelable: true,
    isComposing: false,
  });
  if (result.error !== null) throw new Error(result.error);
}

// Native calls these functions with JSON, never generated JavaScript source.
// Catching here preserves cancellation and already-queued mutations when a user
// handler throws. Rust reports the error after applying the valid mutation batch.
Object.defineProperty(globalThis, "__tokamak", {
  value: Object.freeze({
    drain,
    ...promiseHooks,
    dispatch(json: string): string {
      return JSON.stringify(dispatch(JSON.parse(json) as Dispatch));
    },
    host(json: string): void {
      const { topic, payload } = JSON.parse(json) as { topic: string; payload: unknown };
      if (topic === "tk:clipboard") {
        const { id, error } = payload as { id: number; error: string | null };
        const write = clipboardWrites.get(id);
        clipboardWrites.delete(id);
        if (error !== null) write?.reject(new Error(error));
        else write?.resolve();
        return;
      }
      if (topic === "tk:delay") {
        const id = payload as number;
        const callback = delays.get(id);
        delays.delete(id);
        callback?.();
        return;
      }
      if (topic === "tk:layout") return reportLayout(payload as Parameters<typeof reportLayout>[0]);
      for (const handler of [...(subscriptions.get(topic) ?? [])]) handler(payload);
    },
    dispose(): void {
      // Cleanup callbacks must not reactivate the document being retired.
      disposed = true;
      try {
        dispose?.();
      } finally {
        dispose = undefined;
        subscriptions.clear();
        observers.clear();
        delays.clear();
        clipboardWrites.clear();
        clearRejections();
        nodes.clear();
        pending = [];
      }
    },
  }),
});
