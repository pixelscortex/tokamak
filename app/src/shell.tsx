import { For, Show, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { createMessageConnection } from "@tokamak/render/connection";
import { InProcessTransport, TokamakClient, type Event, type Request } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import { RouterContext, createMemoryRouter, matchRoute } from "@tokamak/runtime/router";
import { createPluginLoader, type SlotContribution } from "@tokamak/runtime/plugins";
import { retainSubscriptions } from "@tokamak/runtime/subscriptions";
import type { ModuleRegistry } from "@tokamak/runtime/modules";
import { Contribution } from "./contribution";
import { ShellFrame } from "./shell-frame";
import { Chat } from "./chat";

export function Shell(props: { modules: ModuleRegistry }) {
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  const subscriptions = retainSubscriptions(transport);
  const client = new TokamakClient(subscriptions);
  const router = createMemoryRouter("/chat");
  const loader = createPluginLoader(props.modules, transport);
  const [error, setError] = createSignal<string>();
  void loader.connect().catch(cause => setError(String(cause)));
  onCleanup(() => { loader.dispose(); subscriptions.dispose(); transport.close(); });

  const href = (view: SlotContribution) => `/p/${view.plugin}${view.options.route === "/" ? "" : view.options.route}`;
  // Every switcher button reads active state. Cache these projections so a large
  // catalog does not allocate/search its entire view list once per button.
  const views = createMemo(() => loader.contributions("view"));
  const active = createMemo(() => {
    const pathname = router.location().pathname;
    return views().find(view => matchRoute(href(view), pathname));
  });
  // Catalog refreshes allocate new descriptors. Only identity/generation may
  // retire the view owner, otherwise reloading an unrelated plugin loses state.
  const activeKey = () => {
    const view = active();
    return view && JSON.stringify([view.plugin, view.id, loader.version(view.plugin)]);
  };
  return <ClientContext.Provider value={client}><RouterContext.Provider value={router}>
    <For each={Object.entries(loader.styles())}>{([id, css]) => <style data-plugin={id}>{css}</style>}</For>
    <ShellFrame
      switcher={<>
        <button aria-current={router.match("/chat") || router.match("/chat/:thread") ? "page" : undefined} onClick={() => router.navigate("/chat")}>Chat</button>
        <For each={views()}>{view => <button
          data-plugin-view={`${view.plugin}/${view.id}`}
          aria-current={active()?.id === view.id && active()?.plugin === view.plugin ? "page" : undefined}
          onClick={() => router.navigate(href(view))}>{view.id}</button>}</For>
      </>}
      navigation={<>
        <button aria-label="Go back" onClick={() => router.back()}>Back</button>
        <button aria-label="Go forward" onClick={() => router.forward()}>Forward</button>
      </>}
      stage={<>
        <Show when={error()}>{(message: Accessor<string>) => <p role="alert">{message()}</p>}</Show>
        <Show keyed when={activeKey()} fallback={
          <Show when={router.match("/chat") || router.match("/chat/:thread")} fallback={<p>View not found</p>}>
            <Chat pathname={router.location().pathname} />
          </Show>
        }>
          {(_key: string) => <div class="shell-plugin"><Contribution loader={loader} contribution={active()!} componentProps={{ router }} /></div>}
        </Show>
      </>}
    />
  </RouterContext.Provider></ClientContext.Provider>;
}
