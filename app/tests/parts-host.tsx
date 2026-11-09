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

export function PartsHost(props: { modules: ModuleRegistry }) {
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  const subscriptions = retainSubscriptions(transport);
  const client = new TokamakClient(subscriptions);
  const router = createMemoryRouter("/chat");
  const loader = createPluginLoader(props.modules, transport);
  const [connected, setConnected] = createSignal(false);
  void loader.connect().then(() => setConnected(true));
  onCleanup(() => { loader.dispose(); subscriptions.dispose(); transport.close(); });
  return <ClientContext.Provider value={client}><RouterContext.Provider value={router}>
    <p id="route">{router.location().pathname}</p>
    <For each={connected() ? loader.contributions("view").filter(c => c.id === "Consumer" || c.id === "Broken") : []}>
      {contribution => <Contribution loader={loader} contribution={contribution} />}
    </For>
  </RouterContext.Provider></ClientContext.Provider>;
}
