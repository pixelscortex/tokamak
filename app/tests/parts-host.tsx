// Two real contribution slots in one native document prove a failed slot cannot
// strand a healthy sibling. The production entry supplies all host namespaces.
import { For, createSignal, onCleanup } from "solid-js";
import { createMessageConnection } from "@tokamak/render/connection";
import { InProcessTransport, TokamakClient, type Event, type Request } from "@tokamak/sdk";
import { ClientContext } from "@tokamak/sdk/solid";
import { createPluginLoader } from "@tokamak/runtime/plugins";
import { RouterContext, createMemoryRouter } from "@tokamak/runtime/router";
import type { ModuleRegistry } from "@tokamak/runtime/modules";
import { Contribution } from "../src/contribution";

export function PartsHost(props: { modules: ModuleRegistry }) {
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  // Direct SDK subscriptions let the payload regression detect leaked wire
  // capacity instead of replaying a cached terminal error 130 times.
  const client = new TokamakClient(transport);
  const router = createMemoryRouter("/chat");
  const loader = createPluginLoader(props.modules, transport);
  const [connected, setConnected] = createSignal(false);
  void loader.connect().then(() => setConnected(true));
  onCleanup(() => { loader.dispose(); transport.close(); });
  return <ClientContext.Provider value={client}><RouterContext.Provider value={router}>
    <p id="route">{router.location().pathname}</p>
    <For each={connected() ? loader.contributions("view").filter(c => ["Consumer", "Broken", "Healthy", "Failure", "Payload"].includes(c.id)) : []}>
      {contribution => <Contribution loader={loader} contribution={contribution} />}
    </For>
  </RouterContext.Provider></ClientContext.Provider>;
}
