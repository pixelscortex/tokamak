/** Native scheduling regression fixture. The SDK connection exists at mount,
 * but its first feature call waits until prequeued cheap acknowledgments drain.
 * This isolates admission/recv fairness from JS mutation latency or UI stalls. */
import { createSignal, onCleanup } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";
import { createMessageConnection } from "@tokamak/render/connection";
import { InProcessTransport, TokamakClient } from "@tokamak/sdk";
import type { Event, Request } from "@tokamak/sdk";
import { api } from "../dist/tests/record/backend/_legacyApi";

function Fairness() {
  const [trace, setTrace] = createSignal<string[]>([]);
  const [titles, setTitles] = createSignal<string[]>([]);
  const record = (event: string) => setTrace((before) => [...before, event]);
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  const client = new TokamakClient(transport);
  onCleanup(() => transport.close());
  onHostEvent<Event>("connection:event", (event) => {
    if (event.type === "unsubscribed") record(`ack:${event.id}`);
  });
  onHostEvent<string>("connection:close", (reason) => record(`closed:${reason}`));
  onHostEvent<null>("begin", () => {
    void (async () => {
      try {
        await client.mutation(api.record.add, { title: "Healthy after cheap native requests" });
        record("mutation:accepted");
        const rows = await client.query(api.record.list, {});
        setTitles(rows.map((row) => row.title));
        record("query:reply");
      } catch (error) {
        record(`failed:${String(error)}`);
      }
    })();
  });
  return (
    <div>
      <p id="trace">{JSON.stringify(trace())}</p>
      <p id="fairness-data">{JSON.stringify(titles())}</p>
    </div>
  );
}
mount(Fairness);
