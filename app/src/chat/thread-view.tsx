import { afterDelay, observeLayout, type Layout, type NativeNode } from "@tokamak/render";
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
    const text = reply?.parts.map(part => part.type === "text" ? part.text : "").join("");
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      if (!alive) return;
      clearCopied?.();
      setCopied(true);
      clearCopied = afterDelay(1500, () => setCopied(false));
    } catch (cause) {
      if (alive) props.chat.setError(`Copy failed: ${String(cause)}`);
    }
  }

  function follow(node: NativeNode) {
    let previousBottom: number | undefined;
    let following = true;

    observeLayout(node, ({ scroll, rect }: Layout) => {
      if (props.hidden || rect.height <= 0) return;

      const bottom = Math.max(0, scroll.height - scroll.clientHeight);
      // Layout growth keeps the current follow mode; every scroll report
      // evaluates its distance directly, including fractional offsets.
      if (bottom === previousBottom) following = bottom - scroll.top <= 8;
      else if (following) node.scrollTo(bottom);
      previousBottom = bottom;
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
