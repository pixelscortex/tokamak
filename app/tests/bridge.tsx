/** Native transport fixture, NOT the app workflow: observe ordered SDK stream
 * delivery across a real session and surface close events from each observer. */
import { createSignal, onCleanup } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";
import { createMessageConnection } from "@tokamak/render/connection";
import { InProcessTransport, TokamakClient } from "@tokamak/sdk";
import type { Event, Request } from "@tokamak/sdk";
import { api } from "../_generated/api";

function Trace() {
  const [trace, setTrace] = createSignal<string[]>([]);
  const record = (event: string) => setTrace(before => [...before, event]);
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  const client = new TokamakClient(transport);
  onCleanup(() => transport.close());
  for (const panel of ["first", "second"]) {
    const stop = client.subscribe(api.todo.list, {}, event => {
      record("value" in event ? panel : `error:${panel}`);
    });
    onCleanup(stop);
  }
  onHostEvent<null>("write", () => {
    void client.mutation(api.todo.add, { title: "Ordered native write" })
      .then(() => record("reply"), () => record("write:error"));
  });
  onHostEvent<string>("write:title", title => {
    void client.mutation(api.todo.add, { title })
      .then(() => record("title:accepted"), error => record(`title:rejected:${String(error)}`));
  });
  return <p id="trace">{JSON.stringify(trace())}</p>;
}
mount(Trace);
