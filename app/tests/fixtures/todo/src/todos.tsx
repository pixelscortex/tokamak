/** Core Todo screen: two independent live subscriptions, one SDK connection.
 * Only backend/ is discovered as feature code; this page never registers handlers. */
import { For, createSignal, onCleanup } from "solid-js";
import { createMessageConnection } from "@tokamak/render/connection";
import { InProcessTransport, TokamakClient } from "@tokamak/sdk";
import type { Event, Request } from "@tokamak/sdk";
import { useQuery } from "@tokamak/sdk/solid";
import { Button, Input } from "@tokamak/ui/elements";
import { api } from "../backend/_generated/api";
import { MAX_TITLE_UNITS } from "../backend/_limits";

function TodoPanel(props: { client: TokamakClient; name: string; id: string }) {
  const todos = useQuery(props.client, api.todo.list, () => ({}));
  const [title, setTitle] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  async function write(action: () => Promise<unknown>, added = false) {
    if (pending()) return;
    setPending(true);
    setError(undefined);
    try {
      await action();
      if (alive && added) setTitle("");
    } catch (cause) {
      if (alive) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive) setPending(false);
    }
  }

  function add() {
    const text = title();
    if (text.trim()) {
      void write(() => props.client.mutation(api.todo.add, { title: text }), true);
    }
  }

  return (
    <section class="panel" id={props.id}>
      <h2>{props.name}</h2>
      <Input
        id={`${props.id}-title`}
        label="New task"
        description={`Up to ${MAX_TITLE_UNITS} UTF-16 code units per title; saved lists have a 48 KiB budget.`}
        value={title()}
        disabled={pending()}
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
      <p role="status">
        {todos.loading() ? "Loading tasks…" : `${todos.data()?.length ?? 0} tasks`}
      </p>
      <p role="alert">{error() ?? todos.error()?.message ?? ""}</p>
      <div class="tasks">
        <For each={todos.data()}>
          {(todo) => (
            <div class="task" data-todo={todo._id}>
              <Button
                class="toggle"
                pressed={todo.done}
                disabled={pending()}
                aria-label={`${todo.done ? "Mark incomplete" : "Complete"}: ${todo.title}`}
                onClick={() =>
                  void write(() => props.client.mutation(api.todo.toggle, { id: todo._id }))
                }
              >
                {todo.done ? "Done · " : "To do · "}
                {todo.title}
              </Button>
              <Button
                disabled={pending()}
                aria-label={`Remove: ${todo.title}`}
                onClick={() =>
                  void write(() => props.client.mutation(api.todo.remove, { id: todo._id }))
                }
              >
                Remove
              </Button>
            </div>
          )}
        </For>
      </div>
    </section>
  );
}

export default function Todos() {
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  const client = new TokamakClient(transport);
  onCleanup(() => transport.close());
  return (
    <main>
      <h1>Tokamak · Todo</h1>
      <p>Two live views of the same saved tasks. Edit in either panel.</p>
      <div class="panels">
        <TodoPanel client={client} name="First view" id="first" />
        <TodoPanel client={client} name="Second view" id="second" />
      </div>
    </main>
  );
}
