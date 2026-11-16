import { For, createSignal } from "solid-js";
import { useClient, useQuery } from "@tokamak/sdk/solid";
import { Button, Input } from "@tokamak/ui/elements";
import { api } from "../backend/_legacyApi";
function Panel(props: { name: string; id: string }) {
  const client = useClient();
  const rows = useQuery(client, api.record.list, () => ({}));
  const [title, setTitle] = createSignal("");
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const write = async (action: () => Promise<unknown>) => {
    if (pending()) return;
    setPending(true);
    try {
      await action();
      setTitle("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  const add = () => {
    if (title().trim()) void write(() => client.mutation(api.record.add, { title: title() }));
  };
  return (
    <section class="panel" id={props.id}>
      <h2>{props.name}</h2>
      <Input
        id={`${props.id}-title`}
        label="New task"
        disabled={pending()}
        value={title()}
        onValueChange={setTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing && !event.repeat) {
            event.preventDefault();
            add();
          }
        }}
      />
      <Button id={`${props.id}-add`} disabled={pending() || !title().trim()} onClick={add}>
        Add task
      </Button>
      <p role="status">{rows.loading() ? "Loading tasks…" : `${rows.data()?.length ?? 0} tasks`}</p>
      <p role="alert">{error() || rows.error()?.message || ""}</p>
      <For each={rows.data()}>
        {(row) => (
          <div class="task" data-record={row._id}>
            <Button
              pressed={row.done}
              aria-label={`${row.done ? "Mark incomplete" : "Complete"}: ${row.title}`}
              onClick={() => void write(() => client.mutation(api.record.toggle, { id: row._id }))}
            >
              {row.done ? "Done · " : "To do · "}
              {row.title}
            </Button>
            <Button
              aria-label={`Remove: ${row.title}`}
              onClick={() => void write(() => client.mutation(api.record.remove, { id: row._id }))}
            >
              Remove
            </Button>
          </div>
        )}
      </For>
    </section>
  );
}
export default function Records() {
  return (
    <main>
      <h1>Record fixture</h1>
      <div class="panels">
        <Panel name="First view" id="first" />
        <Panel name="Second view" id="second" />
      </div>
    </main>
  );
}
