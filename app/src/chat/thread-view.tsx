import { For, Show, createMemo } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id } from "@tokamak/sdk";
import { api, type ChatState } from "./use-chat";
import { Message } from "./message";
import { ComposerStrip } from "./composer-strip";

export function ThreadView(props: { chat: ChatState; threadId: Id<"threads">; hidden: boolean }) {
  const messages = useQuery(props.chat.client, api.messages.list, () => ({ threadId: props.threadId }));
  const newestFirst = createMemo(() => [...(messages.data() ?? [])].reverse());
  const turns = () => messages.data()?.filter(message => message.role === "user").length ?? 0;

  return <div class={props.hidden ? "hidden" : "flex min-h-0 flex-1 flex-col gap-5"}>
    {/* Reverse flow keeps streaming text at the scroll origin above the composer. */}
    <div id="chat-messages" role="log" aria-label="Conversation" class="flex min-h-0 flex-1 flex-col-reverse gap-6 overflow-y-auto overscroll-contain">
      <For each={newestFirst()}>{message => <Message message={message} />}</For>
    </div>
    <Show when={messages.error()}><p role="alert" class="m-0 text-text-2">{messages.error()?.message}</p></Show>
    <Show when={turns() > 0}>
      <ComposerStrip title={props.chat.thread()?.title ?? "New thread"} model={props.chat.active()?.model ?? "openrouter/free"} turns={turns()} />
    </Show>
  </div>;
}
