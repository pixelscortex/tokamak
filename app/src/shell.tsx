import { For, Show, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { createMessageConnection } from "@tokamak/render/connection";
import { functionName, InProcessTransport, TokamakClient, type Event, type Request } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import { RouterContext, createMemoryRouter, matchRoute } from "@tokamak/runtime/router";
import { createPluginLoader, type SlotContribution } from "@tokamak/runtime/plugins";
import { retainSubscriptions } from "@tokamak/runtime/subscriptions";
import { IsolatedModuleRegistry } from "@tokamak/runtime/realms";
import type { ModuleRegistry } from "@tokamak/runtime/modules";
import { Contribution } from "./contribution";
import { ShellFrame } from "./shell-frame";
import { ExtensionProvider, ShortcutContext } from "@tokamak/sdk/client";

export function Shell(props: { modules: ModuleRegistry }) {
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  const subscriptions = retainSubscriptions(transport);
  const client = new TokamakClient(subscriptions);
  const router = createMemoryRouter("/chat");
  const loader = createPluginLoader(props.modules, transport);
  const shortcuts = new Map<string, Set<() => void>>();
  const shortcutAPI = {
    registerShortcut(key: string, handler: () => void) {
      const handlers = shortcuts.get(key) ?? new Set<() => void>();
      shortcuts.set(key, handlers);
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (!handlers.size) shortcuts.delete(key);
      };
    },
  };
  if (props.modules instanceof IsolatedModuleRegistry)
    props.modules.setServices((plugin) => {
      const allowed = (reference: { [functionName]: string }) => {
        if (!reference[functionName].startsWith(`${plugin}/`)) throw new Error("Foreign server API");
      };
      return {
        client: {
          query(reference: any, args: any) {
            allowed(reference);
            return client.query(reference, args);
          },
          mutation(reference: any, args: any) {
            allowed(reference);
            return client.mutation(reference, args);
          },
          action(reference: any, args: any) {
            allowed(reference);
            return client.action(reference, args);
          },
          subscribe(reference: any, args: any, callback: any) {
            allowed(reference);
            return client.subscribe(reference, args, callback);
          },
        },
        router: {
          location: router.location,
          navigate: router.navigate,
          back: router.back,
          forward: router.forward,
          match: router.match,
        },
        shortcuts: shortcutAPI,
        extensions: {
          contributions: loader.contributions,
          version: loader.version,
          load: loader.load,
          onError: loader.onError,
        },
      };
    });
  const [error, setError] = createSignal<string>();
  void loader.connect().catch((cause) => setError(String(cause)));
  onCleanup(() => {
    loader.dispose();
    subscriptions.dispose();
    transport.close();
  });

  const href = (view: SlotContribution) =>
    `/p/${view.plugin}${view.options.route === "/" ? "" : view.options.route}`;
  // Every switcher button reads active state. Cache these projections so a large
  // catalog does not allocate/search its entire view list once per button.
  const views = createMemo(() => loader.contributions("view"));
  const active = createMemo(() => {
    const pathname = router.location().pathname;
    return views().find(
      (view) =>
        matchRoute(href(view), pathname) ||
        (view.options.route === "/" &&
          (pathname === `/${view.plugin}` || pathname.startsWith(`/${view.plugin}/`))),
    );
  });
  // Catalog refreshes allocate new descriptors. Only identity/generation may
  // retire the view owner, otherwise reloading an unrelated plugin loses state.
  const activeKey = () => {
    const view = active();
    return view && JSON.stringify([view.plugin, view.id, loader.version(view.plugin)]);
  };
  return (
    <ClientContext.Provider value={client}>
      <RouterContext.Provider value={router}>
        <For each={Object.entries(loader.styles())}>
          {([id, css]) => <style data-plugin={id}>{css}</style>}
        </For>
        <ShortcutContext.Provider value={shortcutAPI}>
          <ExtensionProvider host={loader}>
            <ShellFrame
              onKeyDown={(event) => {
                if (event.defaultPrevented || event.isComposing) return;
                const key = [
                  event.metaKey && "Meta",
                  event.ctrlKey && "Control",
                  event.altKey && "Alt",
                  event.shiftKey && "Shift",
                  event.key?.toLowerCase(),
                ]
                  .filter(Boolean)
                  .join("+");
                const handlers = shortcuts.get(key);
                if (!handlers?.size) return;
                event.preventDefault();
                if (!event.repeat) for (const handler of [...handlers]) handler();
              }}
              switcher={
                <>
                  <For each={views()}>
                    {(view) => (
                      <button
                        data-plugin-view={`${view.plugin}/${view.id}`}
                        aria-current={
                          active()?.id === view.id && active()?.plugin === view.plugin ? "page" : undefined
                        }
                        onClick={() => router.navigate(href(view))}
                      >
                        {view.id}
                      </button>
                    )}
                  </For>
                </>
              }
              navigation={
                <>
                  <button aria-label="Go back" onClick={() => router.back()}>
                    Back
                  </button>
                  <button aria-label="Go forward" onClick={() => router.forward()}>
                    Forward
                  </button>
                </>
              }
              stage={
                <>
                  <Show when={error()}>{(message: Accessor<string>) => <p role="alert">{message()}</p>}</Show>
                  <Show keyed when={activeKey()} fallback={<p>View not found</p>}>
                    {(_key: string) => (
                      <div
                        class={
                          active()?.options.route === "/" ? "shell-plugin shell-plugin-root" : "shell-plugin"
                        }
                      >
                        <Contribution loader={loader} contribution={active()!} componentProps={{ router }} />
                      </div>
                    )}
                  </Show>
                </>
              }
            />
          </ExtensionProvider>
        </ShortcutContext.Provider>
      </RouterContext.Provider>
    </ClientContext.Provider>
  );
}
