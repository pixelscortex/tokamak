import { Show, createSignal, onCleanup, type Accessor } from "solid-js";
import type { Id, ResultOf } from "@tokamak/sdk";
import { useClient, useQuery } from "@tokamak/sdk/solid";
import { api } from "../backend/_generated/api";

type Todo = NonNullable<ResultOf<typeof api.todo.get>>;

export default function TodoCard(props: { part: { result?: unknown }; threadId: string }) {
  const client = useClient();
  const todo = useQuery(client, api.todo.get, () => ({ id: (props.part.result as { id: Id<"todos"> }).id }));
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  async function toggle(id: Id<"todos">) {
    if (pending()) return;
    setPending(true);
    setError(undefined);
    try {
      await client.mutation(api.todo.toggle, { id });
    } catch (cause) {
      if (alive) setError(String(cause));
    } finally {
      if (alive) setPending(false);
    }
  }

  return (
    <section
      data-todo-card
      class="box-border flex w-full flex-col gap-4 border border-hairline bg-ground p-4"
    >
      <Show
        when={todo.data()}
        fallback={<p class="m-0 text-text-3">{todo.data() === null ? "Task deleted" : "Loading task…"}</p>}
      >
        {(task: Accessor<Todo>) => (
          <div class="flex items-start gap-2 text-text">
            <button
              role="checkbox"
              aria-checked={task().done}
              disabled={pending()}
              aria-label={`Complete: ${task().title}`}
              class="m-0 mt-1 box-border flex size-4 shrink-0 items-center justify-center border border-text-3 bg-ground p-0 text-[10px] text-text"
              onClick={() => void toggle(task()._id)}
            >
              {task().done ? "✓" : ""}
            </button>
            <span class={task().done ? "text-text-3 line-through" : ""}>{task().title}</span>
          </div>
        )}
      </Show>
      <Show when={error() ?? todo.error()?.message}>
        {(message: Accessor<string>) => (
          <p role="alert" class="m-0 text-text-2">
            {message()}
          </p>
        )}
      </Show>
    </section>
  );
}
