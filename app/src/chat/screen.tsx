import type { PluginLoader } from "@tokamak/runtime/plugins";
import { Show, createSignal, onCleanup, type Accessor } from "solid-js";
import { ComposerInput } from "./composer-input";
import type { Id } from "@tokamak/sdk";
import type { NativeEvent } from "@tokamak/render";
import { api, type ChatState } from "./use-chat";
import { Mark } from "./message";
import { ThreadView } from "./thread-view";
import { Map, MapHeader, useMap } from "./map";

export function Chat(props: { loader: PluginLoader; pathname: string; chat: ChatState }) {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [mapOpen, setMapOpen] = createSignal(false);
  const [sending, setSending] = createSignal<Record<string, boolean>>({});
  const map = useMap(props.chat, closeMap);
  let copyReply: (() => Promise<void>) | undefined;
  let alive = true;
  onCleanup(() => { alive = false; });
  const draft = () => drafts()[props.chat.threadId() ?? ""] ?? "";

  const busy = () => Boolean(props.chat.active() || sending()[props.chat.threadId() ?? ""]);
  const editorClass = () => mapOpen() ? "order-1 border-b border-hairline py-3" : "";

  function closeMap() {
    map.reset();
    setMapOpen(false);
  }

  async function newThread() {
    if (await props.chat.createThread()) closeMap();
  }

  function keydown(event: NativeEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key ?? "";
    if (event.metaKey && (key.toLowerCase() === "n" || key === "Enter")) {
      event.preventDefault();
      if (!event.repeat) void newThread();
    } else if (!mapOpen() && event.metaKey && event.shiftKey && key.toLowerCase() === "c") {
      event.preventDefault();
      if (!event.repeat) void copyReply?.();
    } else if (!mapOpen() && event.metaKey && key.toLowerCase() === "m") {
      event.preventDefault();
      if (!event.repeat) void props.chat.cycleModel();
    } else if (mapOpen() && map.editing()) {
      map.keydown(event);
    } else if (key === "Tab" || (key === "Escape" && mapOpen())) {
      event.preventDefault();
      if (event.repeat) return;
      if (mapOpen()) closeMap();
      else {
        map.reset();
        setMapOpen(true);
      }
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
      <Show keyed when={props.chat.threadId()}>{(threadId: Id<"threads">) => <ThreadView loader={props.loader} chat={props.chat} threadId={threadId} hidden={mapOpen()} onCopyReady={copy => { copyReply = copy; }} />}</Show>
      <Show when={props.chat.error() ?? props.chat.threads.error()?.message}>{(error: Accessor<string>) => <p role="alert" class="m-0 text-text-2">{error()}</p>}</Show>
      {/* Retire the focused native editor only while the row editor owns focus. */}
      <Show when={map.editing() !== "rename"}>
        <div class={`flex shrink-0 items-start gap-3 ${editorClass()}`}>
        <Show when={!mapOpen()}><Mark user /></Show>
        <ComposerInput mapOpen={mapOpen()} autofocus id="chat-input" aria-label={mapOpen() ? "Search threads" : "Message"} size="md" appearance="inherit" caret="block"
          class={`chat-input min-w-0 flex-1 ${!mapOpen() && busy() ? "chat-input-busy" : ""}`} maxRows={mapOpen() ? 1 : 8}
          placeholder={mapOpen() ? "Search threads" : "Ask anything, or tell Tokamak what to do"}
          value={mapOpen() ? map.query() : draft()}
          onValueChange={text => mapOpen() ? map.search(text) : setDrafts(previous => ({ ...previous, [props.chat.threadId() ?? ""]: text }))}
          onKeyDown={keydown} onSubmit={text => { if (!mapOpen()) void send(text); }} />
        </div>
      </Show>
      <Show when={mapOpen()}><Map chat={props.chat} map={map} /></Show>
    </div>
  </section>;
}
