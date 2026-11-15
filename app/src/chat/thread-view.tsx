import { afterDelay, clipboard, observeLayout, type Layout, type NativeNode } from "@tokamak/render";
import { DEFAULT_MODEL } from "../../../plugins/chat/models";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id } from "@tokamak/sdk";
import { api, type ChatState } from "./use-chat";
import { Message } from "./message";
import { ComposerStrip } from "./composer-strip";

export function ThreadView(props: { chat: ChatState; threadId: Id<"threads">; hidden: boolean; onCopyReady?: (copy: () => Promise<void>) => void }) {
  const messages = useQuery(props.chat.client, api.messages.list, () => ({ threadId: props.threadId }));
  const turns = () => messages.data()?.filter(message => message.role === "user").length ?? 0;

  const [copied, setCopied] = createSignal(false);
  let clearCopied: (() => void) | undefined;
  let alive = true;
  onCleanup(() => { alive = false; clearCopied?.(); });

  async function copyReply() {
    if (!alive) return;
    const reply = [...(messages.data() ?? [])].reverse().find(message => message.role === "assistant");
    const text = reply?.parts.map(part => part.text).join("");
    if (!text) return;

    try {
      await clipboard.writeText(text);
      if (!alive) return;
      clearCopied?.();
      setCopied(true);
      clearCopied = afterDelay(1500, () => setCopied(false));
    } catch (cause) {
      if (alive) props.chat.setError(`Copy failed: ${String(cause)}`);
    }
  }

  function follow(node: NativeNode) {
    let sticking = true;
    let previousTop = 0;

    observeLayout(node, ({ scroll, rect }: Layout) => {
      if (props.hidden || rect.height <= 0) return;

      const bottom = Math.max(0, scroll.height - scroll.clientHeight);
      // Growth changes the bottom, wheel input changes the offset. A scroll
      // we requested below is acknowledged at previousTop on the next layout.
      if (Math.abs(scroll.top - previousTop) > 1) sticking = bottom - scroll.top <= 2;
      previousTop = scroll.top;
      if (sticking && Math.abs(bottom - scroll.top) > 1) {
        node.scrollTo(bottom);
        previousTop = bottom;
      }
    });
  }

  createEffect(() => {
    if (!props.hidden) setCopied(false);
  });

  createEffect(() => { props.onCopyReady?.(copyReply); });

  return <div class={props.hidden ? "hidden" : "flex min-h-0 flex-1 flex-col gap-5"}>
    {/* Blitz only supports non-negative scroll offsets; keep history in normal flow. */}
    <div ref={follow} id="chat-messages" role="log" aria-label="Conversation" class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain">
      <For each={messages.data() ?? []}>{message => <Message message={message} />}</For>
    </div>
    <Show when={messages.error()}><p role="alert" class="m-0 text-text-2">{messages.error()?.message}</p></Show>
    <Show when={props.chat.thread()}>
      <ComposerStrip title={props.chat.thread()?.title ?? "New thread"} model={props.chat.thread()?.model ?? DEFAULT_MODEL} turns={turns()} copied={copied()} onModel={() => void props.chat.cycleModel()} />
    </Show>
  </div>;
}
