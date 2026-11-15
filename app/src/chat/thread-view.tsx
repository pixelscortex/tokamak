import { DEFAULT_MODEL } from "../../../plugins/chat/models";
import { For, Show } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id } from "@tokamak/sdk";
import { api, type ChatState } from "./use-chat";
import { Message } from "./message";
import { ComposerStrip } from "./composer-strip";

export function ThreadView(props: { chat: ChatState; threadId: Id<"threads">; hidden: boolean }) {
  const messages = useQuery(props.chat.client, api.messages.list, () => ({ threadId: props.threadId }));
  const turns = () => messages.data()?.filter(message => message.role === "user").length ?? 0;

  return <div class={props.hidden ? "hidden" : "flex min-h-0 flex-1 flex-col gap-5"}>
    {/* Blitz only supports non-negative scroll offsets; keep history in normal flow. */}
    <div id="chat-messages" role="log" aria-label="Conversation" class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain">
      <For each={messages.data() ?? []}>{message => <Message message={message} />}</For>
    </div>
    <Show when={messages.error()}><p role="alert" class="m-0 text-text-2">{messages.error()?.message}</p></Show>
    <Show when={props.chat.thread()}>
      <ComposerStrip title={props.chat.thread()?.title ?? "New thread"} model={props.chat.thread()?.model ?? DEFAULT_MODEL} turns={turns()} onModel={() => void props.chat.cycleModel()} />
    </Show>
  </div>;
}
