import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, StatusIcon } from "@tokamak/ui";
import { glyphs } from "../../lib/icons";
import type { Plan } from "../../lib/turns";

/** The agent's todo list for this turn: a small "what changed" card under the work row. */
export function PlanList(props: { plan: Plan }): JSX.Element {
  const done = () => props.plan.entries.filter((entry) => entry.status === "completed").length;
  return (
    <section aria-label="Plan" class="flex max-w-read flex-col rounded-md bg-hover py-2">
      <div class="flex h-8 items-center gap-3 px-4 text-ink-3">
        <Icon path={glyphs.list} />
        <span class="text-data">
          {done()} / {props.plan.entries.length}
        </span>
      </div>
      <ul class="flex flex-col">
        <For each={props.plan.entries}>
          {(entry) => (
            <li class="flex min-h-8 items-start gap-3 px-4 py-1 text-row">
              <span class="flex h-6 w-4 shrink-0 items-center justify-center text-ink-3">
                <Show
                  when={entry.status === "in_progress"}
                  fallback={
                    <Icon
                      path={entry.status === "completed" ? glyphs.todoDone : glyphs.todo}
                      label={entry.status === "completed" ? "done" : "to do"}
                    />
                  }
                >
                  <StatusIcon status="running" />
                </Show>
              </span>
              <span class={entry.status === "completed" ? "py-1 text-ink-2" : "py-1 text-ink"}>
                {entry.content}
              </span>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
