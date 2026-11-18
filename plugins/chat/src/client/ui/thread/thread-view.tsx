import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "@tokamak/ui";
import { replyAgent, type BackendOption } from "../../lib/agents";
import { createFollow } from "../../lib/follow";
import { glyphs } from "../../lib/icons";
import type { Message } from "../../lib/turns";
import { AgentTurn, UserTurn } from "./turn";

export function ThreadView(props: {
  messages: readonly Message[];
  /** Discovered agents; each reply is labelled from the agent recorded on it. */
  agents: BackendOption[] | undefined;
  run: { messageId: string; startedAt: number } | undefined;
  canRetry: boolean;
  onRetry: (messageId: string) => void;
  empty: JSX.Element;
}): JSX.Element {
  const follow = createFollow();
  let box!: HTMLDivElement;
  const last = () => props.messages.at(-1)?._id;
  return (
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={(element) => (box = element)}
        role="log"
        aria-label="Conversation"
        class="flex min-h-0 flex-1 flex-col overflow-y-auto px-6"
      >
        <div
          ref={(content) => queueMicrotask(() => follow.attach(box, content))}
          class="mx-auto flex w-full max-w-thread flex-1 flex-col justify-end gap-8 pt-12 pb-8"
        >
          <Show when={props.messages.length} fallback={props.empty}>
            <For each={props.messages} keyed={(message) => message._id}>
              {(message) => (
                <Show
                  when={message().role === "user"}
                  fallback={
                    <AgentTurn
                      message={message()}
                      agent={replyAgent(message().agent, props.agents)}
                      startedAt={props.run?.messageId === message()._id ? props.run.startedAt : undefined}
                      onRetry={
                        props.canRetry && message()._id === last()
                          ? () => props.onRetry(message()._id)
                          : undefined
                      }
                    />
                  }
                >
                  <UserTurn message={message()} />
                </Show>
              )}
            </For>
          </Show>
        </div>
      </div>
      <Show when={!follow.following()}>
        <div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <span class="pointer-events-auto rounded-sm bg-stage">
            <Button icon={glyphs.arrowDown} label="Jump to latest" onClick={() => follow.jump()} />
          </span>
        </div>
      </Show>
    </div>
  );
}
