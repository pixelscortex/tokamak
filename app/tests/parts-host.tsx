// Two real contribution slots in one native document prove a failed slot cannot
// strand a healthy sibling. The production entry supplies all host namespaces.
import { For, createSignal, onCleanup } from "solid-js";
import { createMessageConnection } from "@tokamak/render/connection";
import { InProcessTransport, TokamakClient, type Event, type Request } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import { createPluginLoader } from "@tokamak/runtime/plugins";
import { retainSubscriptions } from "@tokamak/runtime/subscriptions";
import { RouterContext, createMemoryRouter } from "@tokamak/runtime/router";
import type { ModuleRegistry } from "@tokamak/runtime/modules";
import { Contribution } from "../src/contribution";

// Every installed view is mounted at once except routes that need navigation.
const HIDDEN = ["Nested"];

export function PartsHost(props: { modules: ModuleRegistry }) {
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  // Like the production Shell, views get the window-owned query cache, so a
  // terminal subscription failure followed by Reload exercises real resubscription.
  const subscriptions = retainSubscriptions(transport);
  const client = new TokamakClient(subscriptions);
  // Direct SDK subscriptions let the payload regression detect leaked wire
  // capacity instead of replaying a cached terminal error 130 times.
  (globalThis as any).__tokamakTestWireClient = new TokamakClient(transport);
  const router = createMemoryRouter("/chat");
  const loader = createPluginLoader(props.modules, transport);
  // Lets a fixture download any declared UI asset through the shell's own
  // transport without compiling it (see the bulk-asset fixture).
  (globalThis as any).__tokamakTestAsset = (plugin: string, name: string) =>
    transport.pluginAsset(plugin, name, loader.metadata().revision);
  const [connected, setConnected] = createSignal(false);
  void loader.connect().then(() => setConnected(true));
  onCleanup(() => {
    loader.dispose();
    subscriptions.dispose();
    transport.close();
  });
  return (
    <ClientContext.Provider value={client}>
      <RouterContext.Provider value={router}>
        <p id="route">{router.location().pathname}</p>
        <For each={connected() ? loader.contributions("view").filter((c) => !HIDDEN.includes(c.id)) : []}>
          {(contribution) => <Contribution loader={loader} contribution={contribution} />}
        </For>
      </RouterContext.Provider>
    </ClientContext.Provider>
  );
}
