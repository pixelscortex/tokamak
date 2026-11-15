import type { PluginLoader } from "@tokamak/runtime/plugins";
import { Show, createSignal, onCleanup, type Accessor } from "solid-js";
import { Textarea } from "@tokamak/ui/components";
import type { Id } from "@tokamak/sdk";
import type { NativeEvent } from "@tokamak/render";
import { api, type ChatState } from "./chat/use-chat";
import { Mark } from "./chat/message";
import { ThreadView } from "./chat/thread-view";
import { Map, MapHeader, useMap } from "./chat/map";

export function Chat(props: { loader: PluginLoader; pathname: string; chat: ChatState }) {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [mapOpen, setMapOpen] = createSignal(false);
  const [sending, setSending] = createSignal<Record<string, boolean>>({});
  const map = useMap(props.chat, () => setMapOpen(false));
  let alive = true;
  onCleanup(() => { alive = false; });
  const draft = () => drafts()[props.chat.threadId() ?? ""] ?? "";

  async function newThread() {
    if (await props.chat.createThread()) setMapOpen(false);
  }

  function keydown(event: NativeEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key ?? "";
    if (event.metaKey && (key.toLowerCase() === "n" || key === "Enter")) {
      event.preventDefault();
      if (!event.repeat) void newThread();
    } else if (key === "Tab" || (key === "Escape" && mapOpen())) {
      event.preventDefault();
      if (event.repeat) return;
      if (!mapOpen()) map.reset();
      setMapOpen(!mapOpen());
    } else if (mapOpen()) {
      map.keydown(event);
    } else if (key === "Escape" && props.chat.active()) {
      event.preventDefault();
      if (!event.repeat) void props.chat.cancel();
    }
  }

  async function send(text: string) {
    const threadId = props.chat.threadId();
    if (!threadId || !text.trim() || props.chat.active() || sending()[threadId]) return;
    props.chat.setError(undefined);
    setSending(previous => ({ ...previous, [threadId]: true }));
    setDrafts(previous => ({ ...previous, [threadId]: "" }));
    try {
      await props.chat.client.action(api.chat.send, { threadId, text });
    } catch (cause) {
      if (alive) {
        setDrafts(previous => ({ ...previous, [threadId]: previous[threadId] || text }));
        props.chat.setError(String(cause));
      }
    } finally {
      if (alive) setSending(previous => ({ ...previous, [threadId]: false }));
    }
  }

  return <section id="chat-screen" data-thread-id={props.chat.threadId()} aria-label={mapOpen() ? "Map" : "Chat"} data-chat-route={props.pathname} onKeyDown={keydown}
    class="flex min-h-0 min-w-0 flex-1 justify-center px-6 pb-6">
    <div class={`flex min-h-0 w-[560px] max-w-full flex-col gap-4 ${mapOpen() ? "pt-6" : ""}`}>
      <Show when={mapOpen()}><MapHeader /></Show>
      <Show keyed when={props.chat.threadId()}>{(threadId: Id<"threads">) => <ThreadView loader={props.loader} chat={props.chat} threadId={threadId} hidden={mapOpen()} />}</Show>
      <Show when={props.chat.error() ?? props.chat.threads.error()?.message}>{(error: Accessor<string>) => <p role="alert" class="m-0 text-text-2">{error()}</p>}</Show>
      {/* Keep one native editor mounted so Tab preserves focus in both views. */}
      <div class={`flex shrink-0 items-start gap-3 ${mapOpen() ? "order-1 border-b border-hairline py-3" : ""}`}>
        <Show when={!mapOpen()}><Mark user /></Show>
        <Textarea autofocus id="chat-input" aria-label={mapOpen() ? "Search threads" : "Message"} size="md" appearance="inherit" caret="block"
          class="chat-input min-w-0 flex-1" maxRows={mapOpen() ? 1 : 8}
          placeholder={mapOpen() ? "Search threads" : "Ask anything, or tell Tokamak what to do"}
          value={mapOpen() ? map.query() : draft()}
          onValueChange={text => mapOpen() ? map.search(text) : setDrafts(previous => ({ ...previous, [props.chat.threadId() ?? ""]: text }))}
          onKeyDown={keydown} onSubmit={text => { if (!mapOpen()) void send(text); }} />
      </div>
      <Show when={mapOpen()}><Map chat={props.chat} map={map} /></Show>
    </div>
  </section>;
}
