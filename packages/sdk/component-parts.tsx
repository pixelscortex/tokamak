import {
  createComponent,
  createContext,
  createEffect,
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  flatten,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
  Errored,
  For,
  merge,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { insert, type JSX } from "@solidjs/web";
import { screenElementName } from "./screen-search";
import {
  componentActionKind,
  type ComponentAction,
  type ComponentActionKind,
  type OriginalElement,
} from "./component-actions";

import {
  attributeValues,
  bindNativeAttributes,
  installationOrder,
  noAttributeLayers,
  warnAttribute,
  type AttributeLayers,
  type AttributeWarning,
} from "./component-attributes";

export interface LoadedPartAction {
  id: string;
  fingerprint?: string;
  plugin: string;
  order: number;
  installOrder?: number;
  callableAttributes?: ReadonlySet<string>;
  action: ComponentAction;
  /** Reads the action's `when` with the props of the component that owns the element. */
  enabled(props: object): boolean;
}
type ChildOverride = () => JSX.Element;
type LayerContents = {
  draw: ChildOverride;
  fail(cause: unknown): void;
};
type ReadOverride = () => LayerContents | undefined;

function drawContents(contents: LayerContents): JSX.Element {
  return (
    <Errored
      fallback={(cause) => {
        contents.fail(cause());
        return undefined;
      }}
    >
      {contents.draw()}
    </Errored>
  );
}
type Contents = {
  native?: { read: ReadOverride; capture(children: ChildOverride): void };
  (override?: () => JSX.Element): JSX.Element;
  prepend?: () => JSX.Element;
  append?: () => JSX.Element;
  c: typeof createComponent;
  spread(props: { readonly children?: JSX.Element }): object;
};

export interface PartObserver {
  update(actions: readonly LoadedPartAction[]): void;
}

export interface PartRegistry {
  mismatch(plugin: string, target: string): void;
  warn(
    key: readonly [kind: string, plugin: string, target: string],
    message: string,
    detail?: AttributeWarning,
  ): void;
  failure(item: LoadedPartAction, cause: unknown, consoleMessage: string): void;
  interference(
    kind: string,
    cause: LoadedPartAction,
    affected: LoadedPartAction,
    message: string,
  ): () => void;
  inside(target: string): readonly LoadedPartAction[];
  read(target: string): () => readonly LoadedPartAction[];
  observe(target: string, observer: PartObserver): void;
  unobserve(target: string, observer: PartObserver): void;
}

export const PartActions = createContext<PartRegistry | null>(null);

export { installationOrder as compareInstallOrder } from "./component-attributes";

const noProps = {};

/** Compiler entry point, owned by the render function rather than any of its parts. */
export function attachRenderFunction(target: string, props?: object) {
  // A component function can also be called as a plain helper, outside any
  // owner (from a click handler, say). There is no instance to attach to.
  if (!getOwner()) return;
  const registry = useContext(PartActions);
  if (!registry) return;
  const observer = new RenderAttachment(registry, target, props ?? noProps);
  onCleanup(() => observer.stop());
  registry.observe(target, observer);
}

class RenderAttachment implements PartObserver {
  private dispose?: () => void;
  private write?: (actions: readonly LoadedPartAction[]) => void;
  private owner = getOwner();

  constructor(
    private registry: PartRegistry,
    private target: string,
    private props: object,
  ) {}

  stop() {
    this.registry.unobserve(this.target, this);
    this.dispose?.();
  }

  update(actions: readonly LoadedPartAction[]) {
    if (!actions.length) {
      this.dispose?.();
      this.dispose = this.write = undefined;
    } else if (this.write) this.write(actions);
    else
      runWithOwner(this.owner, () =>
        createRoot((dispose) => {
          this.dispose = dispose;
          const [read, write] = createSignal(actions, { ownedWrite: true });
          this.write = write;
          const tree = <For each={read()}>{(item) => attached(item, this.props, this.registry)}</For>;
          // Evaluate lazy children (including portals) without inserting the
          // returned nodes. A Portal can render directly into its outlet.
          createRenderEffect(
            () => flatten(tree),
            () => {},
          );
        }),
      );
  }
}

function attached(item: LoadedPartAction, props: object, registry: PartRegistry) {
  const [failed, setFailed] = createSignal(false, { ownedWrite: true });
  const owner = getOwner();
  return (
    <Show when={!failed()}>
      <Errored
        fallback={(cause) => {
          registry.failure(
            item,
            cause(),
            `Component attachment ${item.plugin}/${item.id} failed: ${String(cause())}`,
          );
          // Solid's error boundary retains the failed scope for a possible
          // reset. Dropping the boundary disposes it and runs its cleanups.
          runWithOwner(owner, () =>
            onSettled(() => {
              setFailed(true);
            }),
          );
          return undefined;
        }}
      >
        <Show when={item.enabled(props)}>
          {createComponent((item.action as ComponentAction<"attach">).layer!, props)}
        </Show>
      </Errored>
    </Show>
  );
}

type NativeSite = readonly [
  target: string,
  fingerprint: string | null | undefined,
  children: readonly NativeSite[],
  ref?: number | null,
  hole?: number | null,
];
type HoleValue = JSX.Element | (() => JSX.Element);
type RenderHole = (id: number, render: () => HoleValue) => () => HoleValue;
type ParkedHoles = Map<Text, () => HoleValue>;
type HoleState = boolean | ParkedHoles;

function matches(
  registry: PartRegistry,
  target: string,
  fingerprint: string | null | undefined,
  item: LoadedPartAction,
) {
  if (!item.fingerprint || !fingerprint || item.fingerprint === fingerprint) return true;
  registry.mismatch(item.plugin, target);
  return false;
}

const plainHole: RenderHole = (_id, render) => render;
const plainSpread = (props: object) => props;
const isAttributes = (item: LoadedPartAction) => componentActionKind(item.action) === "attrs";
const orderedAttributes = (actions: readonly LoadedPartAction[]) =>
  actions.filter(isAttributes).sort(installationOrder);
const asElement = (value: JSX.Element) =>
  value && typeof value === "object" && "nodeType" in value && value.nodeType === 1
    ? (value as Element)
    : undefined;

// Native templates own their DOM nodes. Additions get their own insertion
// ranges, so changing one path leaves the other nodes and observers alone.
function nativeRange(parent: ParentNode, before: Node | null, original?: Element) {
  const start = parent.ownerDocument!.createTextNode("");
  const end = parent.ownerDocument!.createTextNode("");
  parent.insertBefore(start, original ?? before);
  parent.insertBefore(end, before);
  onCleanup(() => {
    if (original) parent.insertBefore(original, end);
    while (start.nextSibling && start.nextSibling !== end && start.nextSibling !== original)
      parent.removeChild(start.nextSibling);
    start.remove();
    end.remove();
  });
  return end;
}

type NativeContents = {
  resume(): void;
  suspend(park?: ParkedHoles): void;
  project(parent: ParentNode, nodes: Node[]): void;
};

function nativeContents(element: Element, contents: Contents, children?: NativeContents) {
  const { prepend, append, native } = contents;
  if (!native) return nativeAdditions(element, prepend, append);
  if (
    element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(element.localName)
  )
    return;

  const changed = createMemo(() => !!native.read());
  createEffect(
    () => {
      const owner = getOwner();
      if (!changed()) {
        onSettled(() =>
          runWithOwner(owner, () => {
            children?.resume();
            nativeAdditions(element, prepend, append);
          }),
        );
        return;
      }
      // Component holes unload before moving children. Leave an anchor for each
      // direct hole so projection can mount it in its new parent on demand.
      const holes: ParkedHoles = new Map();
      children?.suspend(holes);
      let restore: (() => void) | undefined;
      onCleanup(() => restore?.());
      onSettled(() => {
        const parked = Array.from(element.childNodes);
        let projection: (() => void) | undefined;
        native.capture(() => {
          const anchor = element.ownerDocument.createTextNode("");
          const owner = getOwner();
          let live = true;
          const stop = () => {
            live = false;
            projection?.();
            projection = undefined;
          };
          onCleanup(stop);
          onSettled(() => {
            if (!live || !anchor.parentNode) return;
            const parent = anchor.parentNode;
            runWithOwner(owner, () =>
              createRoot((dispose) => {
                projection = dispose;
                children?.project(parent, parked);
                for (const [marker, draw] of holes) {
                  if (marker.parentNode === parent)
                    insert(parent, () => untrack(draw), nativeRange(parent, marker));
                }
              }),
            );
          });
          return [...parked, anchor];
        });
        element.replaceChildren();
        restore = () => {
          projection?.();
          // Observers must see the restored DOM the next time they register.
          element.replaceChildren(...parked);
          native.capture(() => undefined);
        };
        runWithOwner(owner, () =>
          insert(element, () => {
            const override = native.read();
            return override && drawContents(override);
          }),
        );
      });
    },
    () => {},
  );
}

const textEffect = { sync: true, transparent: true };

export function renderNativeText(parent: Element, read: () => string | number, before: Node | null = null) {
  let node: Text | undefined;
  createRenderEffect(
    read,
    (value) => {
      const text = String(value ?? "");
      if (node) node.data = text;
      else node = parent.insertBefore(parent.ownerDocument.createTextNode(text), before);
    },
    textEffect,
  );
}

function nativeAdditions(element: Element, prepend?: ChildOverride, append?: ChildOverride) {
  if (prepend) insert(element, prepend(), nativeRange(element, element.firstChild));
  if (append) insert(element, append(), nativeRange(element, null));
}

export function renderNativePart(
  target: string,
  fingerprint: string | null | undefined,
  props: object,
  row: (() => object) | undefined,
  create: (refs: Element[], hole: RenderHole) => JSX.Element,
  children: readonly NativeSite[],
  rootHole?: number,
) {
  const registry = useContext(PartActions);
  if (!registry) return create([], plainHole);
  if (!children.length)
    return renderPart(
      target,
      fingerprint,
      props,
      row,
      (contents) => {
        const element = create([], plainHole) as Element;
        nativeContents(element, contents);
        return element;
      },
      undefined,
      false,
    );

  return renderPart(
    target,
    fingerprint,
    props,
    row,
    (contents) => {
      const refs: Element[] = [];
      const active: ReturnType<typeof createSignal<HoleState>>[] = [];
      const hole: RenderHole = (id, render) => {
        let state = active[id];
        if (!state) active[id] = state = createSignal<HoleState>(true, { ownedWrite: true });
        const [shown] = state;
        return createMemo(() => {
          const value = shown();
          if (value === true) return untrack(render);
          if (value === false) return undefined;
          const marker = element.ownerDocument.createTextNode("");
          value.set(marker, render);
          return marker;
        });
      };

      function setHoles(id: number | null | undefined, sites: readonly NativeSite[], enabled: HoleState) {
        if (typeof id === "number") {
          const state = active[id];
          if (!state) active[id] = createSignal(enabled, { ownedWrite: true });
          else state[1](enabled);
        }
        for (const [, , descendants, , hole] of sites) setHoles(hole, descendants, enabled === true);
      }

      const element = create(refs, hole) as Element;
      const scope = { registry, refs, owner: getOwner(), props, row, setHoles };
      let bindings: NativeBinding[] | undefined = registerNative(element, children, scope);
      onCleanup(() => stopNative(bindings));
      if (contents.native)
        nativeContents(element, contents, {
          resume() {
            if (bindings) return;
            setHoles(rootHole, children, true);
            bindings = registerNative(element, children, scope);
          },
          suspend(park) {
            stopNative(bindings);
            bindings = undefined;
            setHoles(rootHole, children, park ?? false);
          },
          project: (parent, nodes) => projectNative(parent, nodes, children, scope),
        });
      else nativeContents(element, contents);
      return element;
    },
    undefined,
    false,
  );
}

type NativeScope = {
  registry: PartRegistry;
  refs: Element[];
  owner: ReturnType<typeof getOwner>;
  props: object;
  row: (() => object) | undefined;
  setHoles(id: number | null | undefined, sites: readonly NativeSite[], enabled: HoleState): void;
};

function registerNative(
  node: ParentNode,
  sites: readonly NativeSite[],
  scope: NativeScope,
  projected?: Node[],
) {
  let child = projected
    ? (projected.find((candidate): candidate is Element => candidate.nodeType === 1) ?? null)
    : node.firstElementChild;
  const bindings: NativeBinding[] = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]!;
    const ref = site[3];
    const element = typeof ref === "number" ? scope.refs[ref] : child;
    if (!element || (typeof ref === "number" && element.parentNode !== node)) continue;
    if (i + 1 < sites.length && typeof sites[i + 1]![3] !== "number") child = element.nextElementSibling;
    const binding = new NativeBinding(scope, element, site);
    bindings.push(binding);
    binding.start();
  }
  return bindings;
}

function projectNative(parent: ParentNode, nodes: Node[], sites: readonly NativeSite[], scope: NativeScope) {
  // Only direct holes need their insertions rebuilt. Inside a moved element,
  // existing insertion ranges still point to their original parent.
  function showHoles(shown: boolean) {
    for (const [, , descendants, , hole] of sites) scope.setHoles(hole, descendants, shown);
  }
  showHoles(true);
  const bindings = registerNative(parent, sites, scope, nodes);
  onCleanup(() => {
    stopNative(bindings);
    showHoles(false);
  });
}

function stopNative(bindings: NativeBinding[] | undefined) {
  if (bindings) for (const binding of bindings) binding.stop();
}

class NativeBinding implements PartObserver {
  private dispose?: () => void;
  private inner?: NativeBinding[];

  constructor(
    private scope: NativeScope,
    private element: Element,
    private site: NativeSite,
  ) {}

  start() {
    this.scope.registry.observe(this.site[0], this);
    if (!this.dispose) this.registerChildren();
  }

  stop() {
    this.scope.registry.unobserve(this.site[0], this);
    this.dispose?.();
    stopNative(this.inner);
  }

  private registerChildren() {
    if (this.site[2].length) this.inner ??= registerNative(this.element, this.site[2], this.scope);
  }

  update(installed: readonly LoadedPartAction[]) {
    this.dispose?.();
    this.dispose = undefined;
    const { registry, owner, props, row, setHoles } = this.scope;
    const [target, fingerprint, children, , hole] = this.site;
    const actions = installed.filter((item) => matches(registry, target, fingerprint, item));
    if (!actions.length) {
      if (typeof hole === "number" || children.length) setHoles(hole, children, true);
      this.registerChildren();
      return;
    }
    const destructive = actions.some(({ action }) => {
      const kind = componentActionKind(action);
      return kind === "hide" || kind === "layer";
    });
    const deactivate = (park?: ParkedHoles) => {
      stopNative(this.inner);
      this.inner = undefined;
      setHoles(hole, children, park ?? false);
    };
    if (destructive) deactivate();

    const element = this.element;
    const parent = element.parentNode! as ParentNode;
    const placementProps = row ? merge(props, { $row: row() }) : props;
    if (actions.every(isAttributes)) {
      setHoles(hole, children, true);
      this.registerChildren();
      const ordered = actions.sort(installationOrder);
      this.dispose = runWithOwner(owner, () =>
        createRoot((cleanup) => {
          bindNativeAttributes(element, (owner, native) =>
            attributeValues(registry, placementProps, owner, ordered, undefined, native),
          );
          return cleanup;
        }),
      );
      return;
    }
    const next = element.nextSibling;
    runWithOwner(owner, () =>
      createRoot((cleanup) => {
        this.dispose = cleanup;
        const end = nativeRange(parent, next, element);
        const decorated = renderActions(
          registry,
          actions,
          placementProps,
          (contents) => {
            const activate = () => {
              // Always: a layer removed just before this rebuild left the child
              // components off, and the actions that remain may all be additions.
              setHoles(hole, children, true);
              this.registerChildren();
            };
            if (destructive) onCleanup(() => deactivate());
            if (contents.native) {
              nativeContents(element, contents, {
                resume: activate,
                suspend: deactivate,
                project: (parent, nodes) => projectNative(parent, nodes, children, this.scope),
              });
            } else {
              activate();
              nativeContents(element, contents);
            }
            return element;
          },
          undefined,
          false,
        );
        insert(parent, decorated, end, [element]);
      }),
    );
  }
}

/** Compiler entry point. Keep the original element and contents lazy so hiding
 * or replacing the element disposes its entire Solid owner. */
export function renderPart(
  target: string,
  fingerprint: string | null | undefined,
  props: object,
  row: (() => object) | undefined,
  render: (contents: Contents) => JSX.Element,
  original?: () => JSX.Element,
  component?: boolean,
): JSX.Element | (() => JSX.Element) {
  const registry = useContext(PartActions);
  const read = registry?.read(target);
  const plain = ((override = original) => override?.()) as Contents;
  plain.spread = plainSpread;
  plain.c = createComponent;
  if (!read) return render(plain);

  // The insert can move between wrapper owners. Keep the original in a
  // separate owner so a sibling placement never remounts the element.
  const owner = getOwner();
  let disposeOriginal: (() => void) | undefined;
  let disposeActions: (() => void) | undefined;
  let element: JSX.Element;
  let decorated: JSX.Element;
  let previous: readonly LoadedPartAction[] | undefined;
  onCleanup(() => {
    disposeActions?.();
    disposeOriginal?.();
  });

  let originalAttributes: readonly LoadedPartAction[] = [];
  function renderOriginal(contents = plain) {
    if (!disposeOriginal) {
      element = runWithOwner(owner, () =>
        createRoot((dispose) => {
          disposeOriginal = dispose;
          return render(contents);
        }),
      );
    }
    return element;
  }

  return () => {
    const installed = read();
    if (installed === previous) return decorated;
    previous = installed;
    return untrack(() => {
      disposeActions?.();
      disposeActions = undefined;
      let legacy: LoadedPartAction[] | undefined;
      const actions = installed.filter((item) => {
        if (!matches(registry!, target, fingerprint, item)) return false;
        if (component !== undefined || !isAttributes(item)) return true;
        (legacy ??= []).push(item);
        return false;
      });
      const outside = actions.every(({ action }) => {
        const kind = componentActionKind(action);
        return kind === "before" || kind === "after" || kind === "attrs";
      });
      const attributes = component && outside ? orderedAttributes(actions) : [];
      if (
        !outside ||
        attributes.length !== originalAttributes.length ||
        attributes.some((item, index) => item !== originalAttributes[index])
      ) {
        disposeOriginal?.();
        disposeOriginal = undefined;
      }
      originalAttributes = attributes;
      if (!actions.length && !legacy) return (decorated = renderOriginal());
      const legacyActions = legacy;
      const placementProps = row ? merge(props, { $row: row() }) : props;
      return (decorated = runWithOwner(owner, () =>
        createRoot((dispose) => {
          disposeActions = dispose;
          if (legacyActions)
            createEffect(
              () => {
                for (const item of legacyActions)
                  if (item.enabled(placementProps)) warnLegacyAttributes(registry!, item);
              },
              () => {},
            );
          if (!actions.length) return renderOriginal();
          return renderActions(
            registry!,
            actions,
            placementProps,
            outside
              ? (contents) => renderOriginal(component && attributes.length ? contents : plain)
              : render,
            original,
            component,
          );
        }),
      ));
    });
  };
}

function warnLegacyAttributes(registry: PartRegistry, item: LoadedPartAction) {
  const target = item.action.target;
  const owner = target.split(".")[0];
  warnAttribute(
    registry,
    { kind: "attr-legacy", plugin: item.plugin, target, otherPlugin: owner },
    `Plugin "${item.plugin}" cannot change attributes on ${target}: owner plugin "${owner}" must be rebuilt`,
  );
}

export function renderComponentPart(
  target: string,
  fingerprint: string | null | undefined,
  props: object,
  row: (() => object) | undefined,
  render: (contents: Contents) => JSX.Element,
  original?: () => JSX.Element,
) {
  return renderPart(target, fingerprint, props, row, render, original, true);
}

export function renderPlainPart(
  target: string,
  fingerprint: string | null | undefined,
  props: object,
  row: (() => object) | undefined,
  render: (contents: Contents) => JSX.Element,
  original?: () => JSX.Element,
) {
  return renderPart(target, fingerprint, props, row, render, original, false);
}

function renderActions(
  registry: PartRegistry,
  actions: readonly LoadedPartAction[],
  props: object,
  render: (contents: Contents) => JSX.Element,
  original?: () => JSX.Element,
  component?: boolean,
): JSX.Element {
  const at = (kind: ComponentActionKind) =>
    actions.filter((item) => componentActionKind(item.action) === kind);
  const enabled = (item: LoadedPartAction) => item.enabled(props);
  const hides = at("hide");
  const layers = at("layer").sort(installationOrder);
  const attributes = orderedAttributes(actions);

  function additions(items: LoadedPartAction[]) {
    return (
      <For each={items}>
        {(item) => (
          <Show when={enabled(item)}>
            <Errored
              fallback={(cause) => {
                registry.failure(
                  item,
                  cause(),
                  `Component addition ${item.plugin}/${item.id} failed: ${String(cause())}`,
                );
                return null;
              }}
            >
              {untrack(() => createComponent((item.action as ComponentAction<"before">).layer!, props))}
            </Errored>
          </Show>
        )}
      </For>
    );
  }

  const leading = at("prepend");
  const trailing = at("append");
  const hasInside = leading.length > 0 || trailing.length > 0;
  const ForwardedChildren = layers.length ? createContext<ChildOverride | null>(null) : undefined;
  let nativeChildren: ChildOverride | undefined;
  function authored(children = original ?? nativeChildren) {
    if (!hasInside) return children?.();
    return (
      <>
        {additions(leading)}
        {children?.()}
        {additions(trailing)}
      </>
    );
  }

  function renderElement(read?: ReadOverride, readLayers?: AttributeLayers, forwarded = false) {
    const contents: Contents = (children) => {
      if (!read) return authored(children);
      const current = createMemo(() => {
        const override = read();
        if (!override) return authored(children);
        if (!children || !ForwardedChildren) return drawContents(override);
        return (
          <ForwardedChildren value={() => authored(children)}>{drawContents(override)}</ForwardedChildren>
        );
      });
      return <>{current()}</>;
    };
    if (read)
      contents.native = {
        read,
        capture: (children) => {
          nativeChildren = children;
        },
      };
    if (leading.length) contents.prepend = () => additions(leading);
    if (trailing.length) contents.append = () => additions(trailing);
    contents.spread = (forwarded: { readonly children?: JSX.Element }) =>
      hasInside || read
        ? merge(forwarded, {
            get children() {
              return contents(() => forwarded.children);
            },
          })
        : forwarded;
    contents.c =
      component && (attributes.length || forwarded)
        ? (draw, authored, ...debug) =>
            createComponent(
              draw,
              merge(authored, () =>
                attributeValues(registry, props, authored, attributes, readLayers?.()),
              ) as typeof authored,
              ...debug,
            )
        : createComponent;
    const written = render(contents);
    if (component === false && (attributes.length || readLayers)) {
      const element = asElement(written);
      if (element)
        bindNativeAttributes(element, (owner, native) =>
          attributeValues(registry, props, owner, attributes, readLayers?.(), native),
        );
    }
    return written;
  }

  function report(kind: string, cause: LoadedPartAction, affected: LoadedPartAction, message: string) {
    onCleanup(registry.interference(kind, cause, affected, message));
  }

  function hiddenBy(hide: LoadedPartAction) {
    // Another plugin's hide loses nothing: it wanted the element gone too.
    const loses = (item: LoadedPartAction) =>
      item.plugin !== hide.plugin && componentActionKind(item.action) !== "hide";
    const same = actions.filter((item) => loses(item) && enabled(item));
    const inside = registry.inside(hide.action.target).filter(loses);
    if (!same.length && !inside.length) return;
    return () => {
      for (const item of [...same, ...inside])
        report(
          "hide",
          hide,
          item,
          `${hide.plugin} hides ${item.plugin}'s addition on ${screenElementName(item.action.target)}`,
        );
    };
  }

  // `contentsOnly`: the layer drew Original with its own children and did not
  // put the owner's back. The element and the layers below survive; what other
  // plugins added inside it does not.
  function covered(cover: LoadedPartAction, below: readonly LoadedPartAction[], contentsOnly = false) {
    const other = (item: LoadedPartAction) => item.plugin !== cover.plugin;
    const lower = contentsOnly ? [] : below.filter((item) => other(item) && enabled(item));
    const children = [...leading, ...trailing].filter((item) => other(item) && enabled(item));
    const inside = registry.inside(cover.action.target).filter(other);
    const blocked = contentsOnly ? [] : attributes.filter((item) => other(item) && enabled(item));
    if (!lower.length && !children.length && !inside.length && !blocked.length) return;
    return () => {
      const element = screenElementName(cover.action.target);
      for (const item of lower)
        report(
          "cover-layer",
          cover,
          item,
          `${cover.plugin}'s layer covers ${item.plugin}'s layer on ${element}`,
        );
      for (const item of children)
        report(
          "cover-inside",
          cover,
          item,
          `${cover.plugin}'s layer hides ${item.plugin}'s inside addition on ${element}`,
        );
      for (const item of inside)
        report(
          "cover-inside",
          cover,
          item,
          `${cover.plugin}'s layer on ${element} hides ${item.plugin}'s addition on ${screenElementName(item.action.target)}`,
        );
      for (const item of blocked)
        warnAttribute(
          registry,
          {
            kind: "attr-covered",
            plugin: item.plugin,
            target: item.action.target,
            otherPlugin: cover.plugin,
          },
          `Plugin "${item.plugin}" cannot change attributes on ${item.action.target}: plugin "${cover.plugin}" covers the element`,
        );
    };
  }

  function shown() {
    return (
      <>
        {additions(at("before"))}
        {layers.length
          ? renderLayers(
              registry,
              layers,
              props,
              renderElement,
              () => (useContext(ForwardedChildren!) ?? authored)(),
              component,
              attributes.length > 0,
              covered,
            )
          : renderElement()}
        {additions(at("after"))}
      </>
    );
  }
  if (!hides.length) return shown();
  const hider = createMemo(() => hides.find(enabled));
  trackInterference(() => {
    const hide = hider();
    return hide && hiddenBy(hide);
  });
  return <Show when={!hider()}>{shown()}</Show>;
}

// A branch can relinquish and reclaim Original in one render. Report only
// the settled result, and let the tracking scope retire its alerts on change.
function trackInterference(read: () => (() => void) | undefined) {
  const owner = getOwner();
  createEffect(
    () => {
      const report = read();
      if (!report) return;
      let active = true;
      let release: (() => void) | undefined;
      onCleanup(() => {
        active = false;
        release?.();
      });
      return () => {
        if (!active) return;
        release = runWithOwner(owner, () =>
          createRoot((dispose) => {
            report();
            return dispose;
          }),
        );
      };
    },
    (report) => {
      if (report) onSettled(report);
    },
  );
}

const noOverride: ReadOverride = () => undefined;

function renderLayers(
  registry: PartRegistry,
  layers: LoadedPartAction[],
  props: object,
  render: (read: ReadOverride, attributes: AttributeLayers, forwarded?: boolean) => JSX.Element,
  authored: () => JSX.Element,
  component: boolean | undefined,
  hasAttributes: boolean,
  covered: (
    item: LoadedPartAction,
    below: readonly LoadedPartAction[],
    contentsOnly?: boolean,
  ) => (() => void) | undefined,
) {
  const owner = getOwner();
  const pending = new Set<() => void>();
  const [revision, revise] = createSignal(0, { ownedWrite: true });
  let closed = false;
  createEffect(revision, () => {
    for (const release of pending) {
      pending.delete(release);
      release();
    }
  });
  const disposers: (() => void)[] = [];
  onCleanup(() => {
    closed = true;
    for (const dispose of disposers) dispose();
  });

  // A stage's owner lives outside the layer that requests it. Switching
  // between a wrapper and its fallback moves the stage without remounting it.
  function stage(draw: typeof render, mergeProps = false) {
    let users = 0;
    let dispose: (() => void) | undefined;
    let output: JSX.Element;
    let setInput: (read: ReadOverride, attributes: AttributeLayers) => void;
    function release() {
      if (users || !dispose) return;
      dispose();
      dispose = undefined;
      output = undefined;
    }
    disposers.push(() => dispose?.());
    return (input: ReadOverride, attributes: AttributeLayers): JSX.Element => {
      users++;
      onCleanup(() => {
        if (--users || closed) return;
        pending.add(release);
        revise((n) => n + 1);
      });
      if (dispose) setInput(input, attributes);
      else {
        output = runWithOwner(owner, () =>
          createRoot((cleanup) => {
            dispose = cleanup;
            const [readInput, writeInput] = createSignal({ input, attributes }, { ownedWrite: true });
            setInput = (input, attributes) =>
              writeInput((current) =>
                current.input === input && current.attributes === attributes
                  ? current
                  : { input, attributes },
              );
            const children = () => readInput().input();
            const layers = () => readInput().attributes();
            // A component with a layer on it takes merged props for as long as
            // the layer is installed, whether or not Original passes any right
            // now. Switching per flip would remount the owner's component each
            // time a layer's condition changed.
            return draw(createMemo(children), layers, mergeProps);
          }),
        );
      }
      return output;
    };
  }

  const top = layers.reduceRight(
    (next, item, index) => {
      const below = layers.slice(index + 1);
      return stage((read, attributes) =>
        renderLayer(
          registry,
          item,
          props,
          authored,
          next,
          read,
          attributes,
          component !== undefined,
          (contentsOnly) => covered(item, below, contentsOnly),
        ),
      );
    },
    stage(render, component === true && !hasAttributes),
  );
  return top(noOverride, noAttributeLayers);
}

function renderLayer(
  registry: PartRegistry,
  item: LoadedPartAction,
  props: object,
  authored: ChildOverride,
  next: (read: ReadOverride, attributes: AttributeLayers) => JSX.Element,
  read: ReadOverride,
  attributes: AttributeLayers,
  supportsAttributes: boolean,
  covered: (contentsOnly?: boolean) => (() => void) | undefined,
) {
  const target = item.action.target;
  const draw = (item.action as ComponentAction<"layer">).layer!;
  function warn(cause: unknown) {
    registry.failure(item, cause, `Component layer ${item.plugin}/${item.id} failed: ${String(cause)}`);
  }

  function activeLayer() {
    let claimed = false;
    const [claim, setClaim] = createSignal(false, { ownedWrite: true });
    let childrenClaimed = false;
    const Outlet = createContext(false);
    const [failed, setFailed] = createSignal(false, { ownedWrite: true });
    const owner = getOwner();
    const [supplied, setSupplied] = createSignal(false, { ownedWrite: true });
    const [restored, setRestored] = createSignal(false, { ownedWrite: true });
    trackInterference(() => {
      if (failed()) return;
      if (!claim()) return covered();
      if (supplied() && !restored()) return covered(true);
    });
    const Original: OriginalElement<any> = Object.assign(
      (passed: { readonly children?: JSX.Element }) => {
        if (claimed) {
          registry.warn(
            ["duplicate", item.plugin, target],
            `Component layer ${item.plugin}/${item.id} drew Original twice for ${target}`,
          );
          return undefined;
        }
        claimed = true;
        setClaim(true);
        onCleanup(() => {
          claimed = false;
          setClaim(false);
        });
        const hasAttributes = Object.keys(passed).some((key) => key !== "children");
        if (hasAttributes && !supportsAttributes) warnLegacyAttributes(registry, item);
        const forwarded: AttributeLayers =
          hasAttributes && supportsAttributes
            ? () => [...attributes(), { item, values: passed }]
            : attributes;
        if (!("children" in passed)) return next(read, forwarded);
        setSupplied(true);
        onCleanup(() => setSupplied(false));
        const children: LayerContents = {
          draw: () => <Outlet value={true}>{passed.children}</Outlet>,
          fail(cause) {
            // Children render at the bottom of the stack. Report their
            // failure back to the layer that supplied them.
            warn(cause);
            runWithOwner(owner, () =>
              onSettled(() => {
                setFailed(true);
              }),
            );
          },
        };
        return next(() => children, forwarded);
      },
      {
        Children() {
          const inside = useContext(Outlet);
          if (!inside || childrenClaimed) {
            registry.warn(
              ["children", item.plugin, target],
              `Component layer ${item.plugin}/${item.id} must draw Original.Children once inside Original for ${target}`,
            );
            return undefined;
          }
          childrenClaimed = true;
          setRestored(true);
          onCleanup(() => {
            childrenClaimed = false;
            setRestored(false);
          });
          const previous = () => {
            const inherited = read();
            return inherited ? drawContents(inherited) : authored();
          };
          return <>{previous()}</>;
        },
      },
    );
    return (
      <Show when={!failed()} fallback={next(read, attributes)}>
        <Errored
          fallback={(cause) => {
            warn(cause());
            // The fallback draws the lower stage even though the layer did not.
            setClaim(true);
            onCleanup(() => setClaim(false));
            return next(read, attributes);
          }}
        >
          {draw(props, Original)}
        </Errored>
      </Show>
    );
  }
  return (
    <Show when={item.enabled(props)} fallback={next(read, attributes)}>
      {activeLayer()}
    </Show>
  );
}
