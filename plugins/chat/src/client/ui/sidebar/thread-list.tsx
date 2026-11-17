import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Id } from "@tokamak/sdk";
import { Icon, Kbd, Row, RowList, StatusIcon } from "@tokamak/ui";
import { agentOf, folderName } from "../../lib/agents";
import { glyphs } from "../../lib/icons";
import type { ChatState, Thread } from "../../lib/state/use-chat";
import { age } from "../../lib/turns";
import { useNow } from "../thread/work-row";

/**
 * Flat recent history: one row per thread, led by the agent's mark. Running
 * and waiting threads are double rows; the rest are single rows with an age.
 */
export function ThreadList(props: { chat: ChatState; onNew: () => void }): JSX.Element {
  const now = useNow();
  const state = (thread: Thread) => {
    const run = props.chat.runs()[thread._id];
    return run ? (run.waiting ? ("needs-you" as const) : ("running" as const)) : undefined;
  };
  return (
    <nav aria-label="Chat threads" class="flex min-h-0 flex-col gap-3 density-dense">
      <Row
        lead={<Icon path={glyphs.newChat} />}
        trail={<Kbd keys="mod+n" />}
        render={(attrs) => (
          <button {...attrs} type="button" disabled={props.chat.creating()} onClick={() => props.onNew()} />
        )}
      >
        New chat
      </Row>
      <Show
        when={props.chat.threads.data()?.length}
        fallback={
          <p class="px-2 text-row text-ink-3">
            {props.chat.threads.loading() ? "Loading threads…" : "No threads yet"}
          </p>
        }
      >
        <RowList.Root
          aria-label="Threads"
          value={props.chat.threadId()}
          onValueChange={(value: unknown) => value && props.chat.open(value as Id<"threads">)}
          class="min-h-0 overflow-y-auto"
        >
          <RowList.Group>
            <For each={props.chat.threads.data() ?? []} keyed={(thread) => thread._id}>
              {(thread) => {
                const agent = () => agentOf(thread().backend, props.chat.backends());
                return (
                  <RowList.Option
                    value={thread()._id}
                    kind={state(thread()) ? "double" : "single"}
                    lead={<Icon path={agent()?.mark ?? glyphs.chat} />}
                    trail={
                      <Show when={state(thread())} fallback={age(thread().updatedAt, now())}>
                        {(status) => <StatusIcon status={status()} size={12} label={thread().title} />}
                      </Show>
                    }
                    detail={[agent()?.name, agent()?.folder ? folderName(agent()!.folder) : undefined]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {thread().title}
                  </RowList.Option>
                );
              }}
            </For>
          </RowList.Group>
        </RowList.Root>
      </Show>
    </nav>
  );
}
