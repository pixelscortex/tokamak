import type { PluginLoader } from "@tokamak/runtime/plugins";
import { Show, createSignal, type Accessor } from "solid-js";
import { ComposerInput } from "./composer-input";
import type { Id } from "@tokamak/sdk";
import type { NativeEvent } from "@tokamak/render";
import type { ChatState } from "./use-chat";
import { Mark } from "./message";
import { ThreadView } from "./thread-view";
import { Map, MapHeader } from "./map";
import { useMap } from "./use-map";
import { useDrafts } from "./use-drafts";

export function Chat(props: { loader: PluginLoader; pathname: string; chat: ChatState }) {
  const [mapOpen, setMapOpen] = createSignal(false);
  const map = useMap(props.chat, closeMap);
  let pickPermission: ((index: number) => boolean) | undefined;
  let copyReply: (() => Promise<void>) | undefined;
  const composer = useDrafts(props.chat);
  const busy = () => Boolean(props.chat.active() || composer.sending());
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
    if (shortcut(event, key)) return;
    if (mapOpen() && map.editing()) {
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
    } else if (!composer.draft() && /^[1-4]$/.test(key) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat && pickPermission?.(Number(key) - 1)) {
      event.preventDefault();
    } else stopRun(event);
  }

  function stopRun(event: NativeEvent) {
    if (event.key !== "Escape" || !props.chat.active()) return;
    event.preventDefault();
    if (!event.repeat) void props.chat.cancel();
  }

  function shortcut(event: NativeEvent, key: string) {
    if (event.metaKey && (key.toLowerCase() === "n" || key === "Enter")) {
      event.preventDefault();
      if (!event.repeat) void newThread();
    } else if (!mapOpen() && event.metaKey && event.shiftKey && key.toLowerCase() === "c") {
      event.preventDefault();
      if (!event.repeat) void copyReply?.();
    } else if (!mapOpen() && event.metaKey && key.toLowerCase() === "m") {
      event.preventDefault();
      if (!event.repeat) void props.chat.cycleModel();
    } else return false;
    return true;
  }

  return <section id="chat-screen" data-thread-id={props.chat.threadId()} aria-label={mapOpen() ? "Map" : "Chat"} data-chat-route={props.pathname} onKeyDown={keydown}
    class="flex min-h-0 min-w-0 flex-1 justify-center px-6 pb-6">
    <div class={`flex min-h-0 w-[560px] max-w-full flex-col gap-4 ${mapOpen() ? "pt-6" : ""}`}>
      <Show when={mapOpen()}><MapHeader /></Show>
      <Show keyed when={props.chat.threadId()}>{(threadId: Id<"threads">) => <ThreadView loader={props.loader} chat={props.chat} threadId={threadId} hidden={mapOpen()} onPermissionReady={pick => { pickPermission = pick; }} onCopyReady={copy => { copyReply = copy; }} />}</Show>
      <Show when={props.chat.error() ?? props.chat.threads.error()?.message}>{(error: Accessor<string>) => <p role="alert" class="m-0 text-text-2">{error()}</p>}</Show>
      {/* Retire the focused native editor only while the row editor owns focus. */}
      <Show when={map.editing() !== "rename"}>
        <div class={`flex shrink-0 items-start gap-3 ${editorClass()}`}>
          <Show when={!mapOpen()}><Mark user /></Show>
          <ComposerInput mapOpen={mapOpen()} autofocus id="chat-input" aria-label={mapOpen() ? "Search threads" : "Message"} size="md" appearance="inherit" caret="block"
            class={`chat-input min-w-0 flex-1 ${!mapOpen() && busy() ? "chat-input-busy" : ""}`} maxRows={mapOpen() ? 1 : 8}
            placeholder={mapOpen() ? "Search threads" : "Ask anything, or tell Tokamak what to do"}
            value={mapOpen() ? map.query() : composer.draft()}
            onValueChange={text => mapOpen() ? map.search(text) : composer.edit(text)}
            onKeyDown={keydown} onSubmit={text => { if (!mapOpen()) void composer.send(text); }} />
        </div>
      </Show>
      <Show when={mapOpen()}><Map chat={props.chat} map={map} /></Show>
    </div>
  </section>;
}
