import { assign, className, DOMWithState } from "@solidjs/web";
import { createRenderEffect, createSignal, onCleanup } from "solid-js";
import { eventNamespace, reservedAttribute } from "./component-actions";
import type { LoadedPartAction, PartRegistry } from "./component-parts";

type Values = Record<string, unknown>;
type NativeAttributes = { key(key: string): string; event(key: string): boolean };
export type AttributeLayer = { item: LoadedPartAction; values: Values };
export type AttributeLayers = () => readonly AttributeLayer[];
export const noAttributeLayers: AttributeLayers = () => [];
const empty = Object.freeze(Object.create(null) as Values);
const exposed = { enumerable: true, configurable: true };

export type AttributeWarning = {
  kind: "attr-conflict" | "attr-covered" | "attr-invalid" | "attr-error" | "attr-legacy";
  plugin: string;
  target: string;
  otherPlugin?: string;
  attribute?: string;
};

export function warnAttribute(registry: PartRegistry, warning: AttributeWarning, message: string) {
  const { kind, plugin, target, attribute, otherPlugin } = warning;
  const key = kind === "attr-conflict" ? JSON.stringify([target, attribute, otherPlugin]) : target;
  registry.warn([kind, plugin, key], message, warning);
}

export function installationOrder(a: LoadedPartAction, b: LoadedPartAction) {
  return (
    (a.installOrder ?? Infinity) - (b.installOrder ?? Infinity) ||
    a.order - b.order ||
    a.plugin.localeCompare(b.plugin) ||
    a.id.localeCompare(b.id)
  );
}

/** Return only add-on values. Unchanged properties still read from the author. */
export function attributeValues(
  registry: PartRegistry,
  props: object,
  owner: Values,
  actions: readonly LoadedPartAction[],
  layers?: readonly AttributeLayer[],
  native?: NativeAttributes,
): Values {
  if (!actions.length && !layers?.length) return empty;
  const changes = Object.create(null) as Values;
  const written = new Map<string, string>();

  const forbidden = (item: LoadedPartAction, key: string) =>
    reservedAttribute(key) || native?.event(key) || item.callableAttributes?.has(key);
  const name = (key: string) => native?.key(key) ?? key;

  function apply(item: LoadedPartAction, values: Values, reads?: Set<string>) {
    // Children are drawn by the layer stage. Reading that getter here would
    // render a second copy of the children in the attribute effect.
    const keys = Object.keys(values).filter((key) => reads || key !== "children");
    const entries = keys.map((raw) => {
      const blocked = forbidden(item, raw);
      return { raw, key: name(raw), blocked, value: blocked ? undefined : values[raw] };
    });
    for (const { raw, key, blocked, value } of entries) {
      if (blocked || typeof value === "function" || (key !== "class" && typeof owner[key] === "function")) {
        warnAttribute(
          registry,
          { kind: "attr-invalid", plugin: item.plugin, target: item.action.target, attribute: raw },
          `Plugin "${item.plugin}" cannot change attribute "${raw}" on ${item.action.target}`,
        );
        continue;
      }
      if (value === undefined) continue;
      const previous = written.get(key);
      if (key === "class") {
        if (typeof value === "string" && value) {
          const base = changes.class ?? owner.class;
          // Solid accepts nested arrays of classes, including object forms.
          changes.class =
            typeof base === "string" && base ? `${base} ${value}` : base ? [base, value] : value;
        }
        continue;
      }
      if (reads && previous && previous !== item.plugin && !reads.has(key)) {
        warnAttribute(
          registry,
          {
            kind: "attr-conflict",
            plugin: item.plugin,
            target: item.action.target,
            otherPlugin: previous,
            attribute: key,
          },
          `Plugin "${item.plugin}" overwrote "${key}" from plugin "${previous}" on ${item.action.target} without reading current.${key}`,
        );
      }
      written.set(key, item.plugin);
      changes[key] = value;
    }
  }

  function safely(item: LoadedPartAction, run: () => void) {
    try {
      run();
    } catch (cause) {
      warnAttribute(
        registry,
        { kind: "attr-error", plugin: item.plugin, target: item.action.target },
        `Attribute action ${item.plugin}/${item.id} failed on ${item.action.target}: ${String(cause)}`,
      );
    }
  }

  for (const item of actions) {
    if (!item.enabled(props)) continue;
    const reads = new Set<string>();
    const current = new Proxy(Object.create(null) as Values, {
      get(_, key) {
        if (typeof key !== "string" || forbidden(item, key)) return;
        key = name(key);
        reads.add(key);
        return Object.hasOwn(changes, key) ? changes[key] : owner[key];
      },
      has(_, key) {
        if (typeof key !== "string" || forbidden(item, key)) return false;
        key = name(key);
        reads.add(key);
        return key in changes || key in owner;
      },
      ownKeys: () =>
        [...new Set([...Object.keys(owner), ...Object.keys(changes)])].filter((key) => !forbidden(item, key)),
      getOwnPropertyDescriptor(_, key) {
        if (typeof key !== "string" || forbidden(item, key)) return;
        key = name(key);
        reads.add(key);
        if (Object.hasOwn(changes, key) || Object.hasOwn(owner, key)) return exposed;
      },
    });
    safely(item, () => apply(item, item.action.attributes!(props, current), reads));
  }
  for (const { item, values } of layers ?? []) safely(item, () => apply(item, values));
  return changes;
}

const html = "http://www.w3.org/1999/xhtml";
const booleanAttributes = new Set(
  (
    "allowfullscreen alpha async autofocus autoplay checked compact controls credentialless declare default defer " +
    "disablepictureinpicture disableremoteplayback disabled formnovalidate hidden inert ismap itemscope loop " +
    "multiple muted nohref nomodule noresize noshade novalidate nowrap open playsinline readonly required reversed " +
    "scoped seamless selected shadowrootclonable shadowrootcustomelementregistry shadowrootdelegatesfocus shadowrootserializable " +
    "truespeed typemustmatch webkitdirectory"
  ).split(" "),
);

/** Owner bindings keep writing to the original node. While an overlay is
 * active, save those writes separately so disabling it reveals the latest
 * owner state, including Solid's incremental class and style operations. */
export function bindNativeAttributes(
  element: Element,
  read: (owner: Values, native: NativeAttributes) => Values,
) {
  // Mirror attributes only; cloning a custom element would run its constructor.
  const base = element.ownerDocument.createElementNS(
    element.namespaceURI,
    element.namespaceURI === html ? "div" : "g",
  );
  for (const attr of Array.from(element.attributes))
    base.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
  const stateful = DOMWithState[element.nodeName] ?? {};
  const baseline = new Map<string, unknown>();
  const [revision, revise] = createSignal(0, { ownedWrite: true });
  const restore: (() => void)[] = [];
  let applied: Values = empty;
  let applying = false;
  const normalize = (key: string) => (element.namespaceURI === html ? key.toLowerCase() : key);
  const covered = (key: string) => Object.keys(applied).some((name) => normalize(name) === key);
  const dirty = () => revise((prev) => prev + 1);

  function patch(on: object, key: string, descriptor: PropertyDescriptor) {
    const previous = Object.getOwnPropertyDescriptor(on, key);
    Object.defineProperty(on, key, { ...descriptor, configurable: true });
    restore.push(() => {
      if (previous) Object.defineProperty(on, key, previous);
      else Reflect.deleteProperty(on, key);
    });
  }

  function mutate<T extends object, K extends keyof T & string>(
    target: T,
    mirror: T,
    method: K,
    keyOf: (...args: any[]) => string,
  ) {
    const write = target[method] as (...args: unknown[]) => unknown;
    patch(target, method, {
      value: function (this: T, ...args: unknown[]) {
        if (applying || this !== target) return write.apply(this, args);
        const key = normalize(keyOf(...args));
        const before = base.getAttribute(key);
        const result = write.apply(mirror, args);
        if (!covered(key)) write.apply(this, args);
        if (base.getAttribute(key) !== before) dirty();
        return result;
      },
      writable: true,
    });
  }

  mutate(element, base, "setAttribute", (key: string) => key);
  mutate(element, base, "removeAttribute", (key: string) => key);
  mutate(element, base, "toggleAttribute", (key: string) => key);
  mutate(element, base, "setAttributeNS", (_ns: string, key: string) => key);
  mutate(
    element,
    base,
    "removeAttributeNS",
    (ns: string, local: string) => base.getAttributeNodeNS(ns, local)?.name ?? local,
  );

  for (const method of ["add", "remove", "replace", "toggle"] as const)
    mutate(element.classList, base.classList, method, () => "class");

  function setter(on: object, key: string, write: (value: unknown, set: (value: unknown) => void) => void) {
    let prototype: object | null = on;
    let descriptor: PropertyDescriptor | undefined;
    while (prototype && !(descriptor = Object.getOwnPropertyDescriptor(prototype, key)))
      prototype = Object.getPrototypeOf(prototype) as object | null;
    if (!descriptor?.set || !descriptor.get) return;
    const set = descriptor.set.bind(on);
    patch(on, key, {
      get: descriptor.get.bind(on),
      set: (value) => (applying ? set(value) : write(value, set)),
    });
  }

  if ("style" in element && "style" in base) {
    const style = (element as HTMLElement).style;
    const ownerStyle = (base as HTMLElement).style;
    for (const method of ["setProperty", "removeProperty"] as const)
      mutate(style, ownerStyle, method, () => "style");
    setter(style, "cssText", (value, set) => {
      ownerStyle.cssText = String(value);
      if (!covered("style")) set(value);
      dirty();
    });
  }
  setter(element, "className", (value, set) => {
    base.setAttribute("class", String(value));
    if (!covered("class")) set(value);
    dirty();
  });
  for (const key of Object.keys(stateful)) {
    baseline.set(key, Reflect.get(element, key));
    setter(element, key, (value, set) => {
      if (!covered(normalize(key))) set(value);
      if (!Object.is(baseline.get(key), value)) {
        baseline.set(key, value);
        dirty();
      }
    });
  }

  const native: NativeAttributes = {
    key: (key) => (key === "className" ? "class" : key),
    event: (key) => eventNamespace(key) || (/^on/i.test(key) && key.toLowerCase() in element),
  };
  const owner = new Proxy(Object.create(null) as Values, {
    get(_, key) {
      if (typeof key !== "string") return;
      if (baseline.has(key)) return baseline.get(key);
      const value = base.getAttribute(key);
      return element.namespaceURI === html && booleanAttributes.has(key.toLowerCase())
        ? value !== null
        : (value ?? undefined);
    },
    has: (_, key) => typeof key === "string" && (baseline.has(key) || base.hasAttribute(key)),
    ownKeys: () => [...new Set([...base.getAttributeNames(), ...baseline.keys()])],
    getOwnPropertyDescriptor: (_, key) =>
      typeof key === "string" && (baseline.has(key) || base.hasAttribute(key)) ? exposed : undefined,
  });

  function paint(next: Values) {
    applying = true;
    try {
      for (const key of Object.keys(applied)) {
        if (Object.hasOwn(next, key)) continue;
        if (baseline.has(key)) Reflect.set(element, key, baseline.get(key));
        else {
          const attribute = base.getAttributeNode(key);
          if (attribute?.namespaceURI)
            element.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
          else if (attribute) element.setAttribute(key, attribute.value);
          else element.removeAttribute(key);
        }
      }
      for (const [key, value] of Object.entries(next)) {
        if (key === "class" || key === "style") {
          // Normalize with Solid without sharing its owner binding caches.
          const scratch = element.ownerDocument.createElement("div");
          if (key === "class") className(scratch, value as Parameters<typeof className>[1]);
          else assign(scratch, { style: value }, true);
          const attr = scratch.getAttribute(key);
          if (attr === null) element.removeAttribute(key);
          else element.setAttribute(key, attr);
        } else if (typeof value === "boolean" && key.startsWith("aria-")) {
          element.setAttribute(key, String(value));
        } else if (/^on/i.test(key)) {
          // Solid reserves camel-case on* names even when the DOM has no such event.
          if (value === null || value === undefined || value === false) element.removeAttribute(key);
          else element.setAttribute(key, value === true ? "" : String(value));
        } else assign(element, { [key]: value }, true);
      }
    } finally {
      applying = false;
      applied = next;
    }
  }

  onCleanup(() => {
    paint(empty);
    for (const undo of restore.reverse()) undo();
  });
  createRenderEffect(
    () => {
      revision();
      return read(owner, native);
    },
    paint,
    { sync: true, transparent: true },
  );
}
