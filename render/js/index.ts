/** Solid's universal host: a small owned tree, not a DOM polyfill. Rust consumes
 * ordered mutations only after a synchronous JS turn, before native paint. */
import { createRoot, onCleanup } from "solid-js";
import { createRenderer } from "solid-js/universal";
import type { JSX, NativeEvent, EventHandler } from "./jsx-runtime";

export type { JSX, NativeEvent, EventHandler } from "./jsx-runtime";

export class NativeNode {
  readonly children: NativeNode[] = [];
  readonly handlers = new Map<string, EventHandler>();
  parent: NativeNode | undefined;
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
  | { op: "detach"; id: number };

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
    parent.children.splice(
      before ? parent.children.indexOf(before) : parent.children.length,
      0,
      node,
    );
    node.parent = parent;
    pending.push({ op: "insert", id: node.id, parent: parent.id, before: before?.id ?? null });
  },
  removeNode(_parent, node) {
    detach(node);
    pending.push({ op: "detach", id: node.id });
  },
  setProperty(node, name, value) {
    if (/^on[A-Z]/.test(name)) {
      if (value != null && typeof value !== "function")
        throw new TypeError(`${name} must be a handler`);
      const event = name.slice(2).toLowerCase();
      if (typeof value === "function") node.handlers.set(event, value as EventHandler);
      else node.handlers.delete(event);
      return;
    }
    // ARIA and data booleans are strings. Only HTML boolean attributes use
    // presence/absence; aria-disabled is deliberately not native disabled.
    const boolean = name === "disabled" || name === "readonly" || name === "hidden";
    if (value != null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new TypeError(`${name} must be a scalar attribute`);
    }
    const attribute =
      value == null || (boolean && value === false)
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
  const listener = handler as (payload: unknown) => void;
  handlers.add(listener);
  onCleanup(() => {
    handlers.delete(listener);
    if (!handlers.size) subscriptions.delete(topic);
  });
}

function drain() {
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
    dispatch(json: string): string {
      return JSON.stringify(dispatch(JSON.parse(json) as Dispatch));
    },
    host(json: string): void {
      const { topic, payload } = JSON.parse(json) as { topic: string; payload: unknown };
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
        nodes.clear();
        pending = [];
      }
    },
  }),
});
