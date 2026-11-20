import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  createComponent,
  Errored,
  Show,
  onCleanup,
  type Accessor,
  type Component,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { createRoute, type AnyRoute, type AnyRouter } from "@tanstack/solid-router";
import type { TokamakClient } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import {
  ChatMachineContext,
  ExtensionProvider,
  ShortcutContext,
  contributionBrand,
  type RemoteChat,
} from "@tokamak/sdk/client";
import {
  createPluginLoader,
  type PluginLoader,
  type ModuleExports,
} from "../../../packages/runtime/js/plugins";
import { Button, StatusIcon } from "@tokamak/ui";
import { serverAssets, type CatalogSource, type ServerEndpoint } from "./adapter";
import { WebPluginHost } from "./web-host";
import { RouterContext, routerFacade, type MemoryRouter } from "./router";

export interface PluginView {
  id: string;
  plugin: string;
  route: string;
  title: string;
  /** A single-colour 24 × 24 SVG path from the view's options, if it named one. */
  icon?: string;
  generation: number;
}
export interface PluginRouting {
  router: AnyRouter;
  root: AnyRoute;
  base: readonly AnyRoute[];
}
export interface PluginShell {
  views: Accessor<readonly PluginView[]>;
  loader: ReturnType<typeof createPluginLoader>;
  host: WebPluginHost;
  navigation: MemoryRouter;
  client: TokamakClient;
  remoteChat?: RemoteChat;
  connect(): Promise<void>;
  dispose(): void;
}
export function createPluginShell(
  client: TokamakClient,
  endpoint: ServerEndpoint,
  source: CatalogSource | undefined,
  routing: PluginRouting,
  remoteChat?: RemoteChat,
): PluginShell {
  let stop!: () => void;
  return createRoot((dispose) => {
    stop = dispose;
    const host: WebPluginHost = new WebPluginHost(endpoint, () => loader.metadata().plugins);
    watchUnhandledPluginErrors(host);
    const loader: PluginLoader = createPluginLoader(host, serverAssets(endpoint, source));
    const navigation = routerFacade(routing.router);
    const views = createMemo(() =>
      loader.contributions("view").map((c): PluginView => ({
        id: c.id,
        plugin: c.plugin,
        route: `/p/${c.plugin}${c.options.route === "/" ? "" : c.options.route}`,
        title: String(c.options.title ?? c.options.label ?? c.id),
        ...(typeof c.options.icon === "string" ? { icon: c.options.icon } : {}),
        generation: loader.version(c.plugin),
      })),
    );
    const shell: PluginShell = {
      views,
      loader,
      host,
      client,
      remoteChat,
      navigation,
      connect: () => loader.connect(),
      dispose: () => stop(),
    };
    const routeCache = new Map<string, AnyRoute>();
    createEffect(views, (current) => {
      const paths = new Set<string>();
      const routes = current.flatMap((view) => {
        if (paths.has(view.route)) return [];
        paths.add(view.route);
        const identity = `${view.plugin}:${view.id}:${view.route}`;
        let route = routeCache.get(identity);
        if (!route) {
          route = createRoute({
            getParentRoute: () => routing.root,
            path: view.route
              .replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "$$$1")
              .replace(/\*[A-Za-z][A-Za-z0-9_]*/g, "$"),
            component: () => <PluginViews shell={shell} view={view} />,
          });
          routeCache.set(identity, route);
        }
        return [route];
      });
      const identities = new Set(current.map((view) => `${view.plugin}:${view.id}:${view.route}`));
      for (const id of routeCache.keys()) if (!identities.has(id)) routeCache.delete(id);
      routing.root.addChildren([...routing.base, ...routes]);
      // The pinned Router RC only rebuilds on root identity changes.
      routing.router.setRoutes(routing.router.buildRouteTree());
      void routing.router.invalidate();
    });
    onCleanup(() => {
      loader.dispose();
      routing.root.addChildren([...routing.base]);
      // The pinned Router RC only rebuilds on root identity changes.
      routing.router.setRoutes(routing.router.buildRouteTree());
      void routing.router.invalidate();
    });
    return shell;
  });
}

function watchUnhandledPluginErrors(host: WebPluginHost) {
  const unhandled = (event: ErrorEvent | PromiseRejectionEvent) => {
    const cause = "reason" in event ? event.reason : event.error;
    const plugin = host.errorOwner("filename" in event ? event.filename : "", cause);
    if (plugin)
      host.reportError(
        plugin,
        host.logRevision(plugin),
        describe(cause ?? ("message" in event ? event.message : "Unhandled rejection")),
      );
  };
  window.addEventListener("error", unhandled);
  window.addEventListener("unhandledrejection", unhandled);
  onCleanup(() => {
    window.removeEventListener("error", unhandled);
    window.removeEventListener("unhandledrejection", unhandled);
  });
}

export function PluginViews(props: { shell: PluginShell; view: PluginView }) {
  const key = () => `${props.view.plugin}:${props.view.id}:${props.shell.loader.version(props.view.plugin)}`;
  return (
    <Show keyed when={key()}>
      {(_key) => {
        const revision = props.shell.host.logRevision(props.view.plugin);
        return (
          <Errored
            fallback={(cause) => (
              <ViewFailure
                view={props.view}
                cause={cause()}
                report={(text) => props.shell.host.reportError(props.view.plugin, revision, text)}
                reload={() => props.shell.loader.reload(props.view.plugin)}
              />
            )}
          >
            <LoadedView {...props} revision={revision} />
          </Errored>
        );
      }}
    </Show>
  );
}
function ViewFailure(props: {
  view: PluginView;
  cause: unknown;
  reload(): void;
  report(text: string): void;
}) {
  const command = () => `tokamak plugin logs ${props.view.plugin}`;
  createEffect(
    () => describe(props.cause),
    (text) => props.report(text),
  );
  const [copyStatus, setCopyStatus] = createSignal("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command());
      setCopyStatus("Copied plugin log command.");
    } catch {
      setCopyStatus("Could not copy plugin log command.");
    }
  };
  return (
    <div
      role="alert"
      aria-label="Plugin view error"
      class="m-auto flex max-w-read flex-col items-center gap-6 px-8 py-16 text-center"
    >
      <div class="flex flex-col items-center gap-2">
        <StatusIcon class="mb-2" status="failed" label={props.view.title} />
        <h2 class="text-read font-semibold text-ink">{props.view.title} stopped</h2>
        <p class="text-read text-pretty text-ink-2">
          Its plugin, <span class="font-mono">{props.view.plugin}</span>, failed. The rest of the window still
          works.
        </p>
      </div>
      <p class="max-w-full text-data break-words text-ink-3">{describe(props.cause)}</p>
      <Button variant="primary" onClick={() => props.reload()}>
        Reload
      </Button>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <code class="text-data break-all">{command()}</code>
        <Button onClick={() => void copy()}>Copy plugin log command</Button>
        <span role="status">{copyStatus()}</span>
      </div>
    </div>
  );
}
function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
function LoadedView(props: { shell: PluginShell; view: PluginView; revision?: string }) {
  const [module, setModule] = createSignal<ModuleExports>();
  const [failure, setFailure] = createSignal<{ cause: unknown }>();
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  onCleanup(props.shell.loader.onError(props.view.plugin, (cause) => setFailure({ cause })));
  void props.shell.loader.load(props.view.plugin).then(
    (exports) => {
      if (alive) setModule(exports);
    },
    (cause) => {
      if (alive) setFailure({ cause });
    },
  );
  const loaded = () => {
    if (failure()) throw failure()!.cause;
    return module();
  };
  return (
    <Show
      when={loaded()}
      fallback={
        <span class="m-auto text-ink-3">
          <StatusIcon status="running" label={`Loading ${props.view.title}`} />
        </span>
      }
    >
      {(exports) => {
        const component = exports()[props.view.id];
        if (
          typeof component !== "function" ||
          (component as { [contributionBrand]?: string })[contributionBrand] !== "view"
        )
          throw new Error(`Missing branded view: ${props.view.id}`);
        return (
          <OwnedView
            shell={props.shell}
            plugin={props.view.plugin}
            revision={props.revision}
            component={component as Component<Record<string, unknown>>}
          />
        );
      }}
    </Show>
  );
}
function OwnedView(props: {
  shell: PluginShell;
  plugin: string;
  revision?: string;
  component: Component<Record<string, unknown>>;
}) {
  let dispose = () => {};
  onCleanup(() => dispose());
  return createRoot((stop): JSX.Element => {
    dispose = stop;
    onCleanup(props.shell.host.own(props.plugin, stop));
    const revision = props.revision;
    const reportCallbackError = (cause: unknown) =>
      props.shell.host.reportError(props.plugin, revision, describe(cause));
    const shortcuts = new Map<string, Set<() => void>>();
    const registerShortcut = (key: string, handler: () => void) => {
      const handlers = shortcuts.get(key) ?? new Set();
      handlers.add(handler);
      shortcuts.set(key, handlers);
      return () => {
        handlers.delete(handler);
        if (!handlers.size) shortcuts.delete(key);
      };
    };
    const dispatch = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const key = [
        event.metaKey && "Meta",
        event.ctrlKey && "Control",
        event.altKey && "Alt",
        event.shiftKey && "Shift",
        event.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join("+");
      const handlers = shortcuts.get(key);
      if (!handlers?.size) return;
      event.preventDefault();
      for (const handler of handlers) {
        try {
          void Promise.resolve(handler()).catch(reportCallbackError);
        } catch (cause) {
          reportCallbackError(cause);
        }
      }
    };
    document.addEventListener("keydown", dispatch);
    onCleanup(() => {
      document.removeEventListener("keydown", dispatch);
      shortcuts.clear();
    });
    return (
      <ClientContext value={props.shell.client}>
        <RouterContext value={props.shell.navigation}>
          <ShortcutContext value={{ registerShortcut }}>
            <ExtensionProvider host={props.shell.loader}>
              <ChatMachineContext value={props.plugin === "chat" ? (props.shell.remoteChat ?? null) : null}>
                {createComponent(props.component, { router: props.shell.navigation })}
              </ChatMachineContext>
            </ExtensionProvider>
          </ShortcutContext>
        </RouterContext>
      </ClientContext>
    );
  });
}
