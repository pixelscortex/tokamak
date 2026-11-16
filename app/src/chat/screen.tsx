import type { PluginLoader } from "@tokamak/runtime/plugins";
import { Show, createEffect, createSignal, on, type Accessor } from "solid-js";
import { BackendPicker } from "./backend-picker";
import { ComposerInput } from "./composer-input";
import type { Id } from "@tokamak/sdk";
import type { NativeEvent } from "@tokamak/render";
import type { ChatState } from "./use-chat";
import { Mark } from "./message";
import { ThreadView } from "./thread-view";
import { Map, MapHeader } from "./map";
import { useMap } from "./use-map";
import { useDrafts } from "./use-drafts";
import { SharePicker } from "./share-picker";
import { authorInitial } from "./use-identity";

export function Chat(props: { loader: PluginLoader; pathname: string; chat: ChatState }) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [pickerFolder, setPickerFolder] = createSignal(false);
  let pickerKey: ((event: NativeEvent) => void) | undefined;
  const [shareOpen, setShareOpen] = createSignal(false);
  let shareKey: ((event: NativeEvent) => void) | undefined;
  const [mapOpen, setMapOpen] = createSignal(false);
  const map = useMap(props.chat, closeMap);
  let pickPermission: ((index: number) => boolean) | undefined;
  let copyReply: (() => Promise<void>) | undefined;
  const composer = useDrafts(props.chat);
  const busy = () => Boolean(props.chat.active() || composer.sending());
  const editorClass = () => mapOpen() ? "order-1 border-b border-hairline py-3" : "";

  function closePicker() {
    setPickerOpen(false);
    setPickerFolder(false);
    pickerKey = undefined;
  }

  function closeShare() {
    setShareOpen(false);
    shareKey = undefined;
  }

  createEffect(on(() => props.chat.threadId(), () => { closePicker(); closeShare(); }));

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
    if (pickerOpen()) { pickerKey?.(event); return; }
    if (shareOpen()) { shareKey?.(event); return; }
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
    } else if (props.chat.isOwner() && !composer.draft() && /^[1-4]$/.test(key) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat && pickPermission?.(Number(key) - 1)) {
      event.preventDefault();
    } else stopRun(event);
  }

  // Escape stops a run only for its starter or the owner.
  function stopRun(event: NativeEvent) {
    if (event.key !== "Escape" || !props.chat.canStop()) return;
    event.preventDefault();
    if (!event.repeat) void props.chat.cancel();
  }

  function shortcut(event: NativeEvent, key: string) {
    const owner = props.chat.isOwner();
    const letter = key.toLowerCase();

    if (owner && event.metaKey && (letter === "n" || key === "Enter")) {
      event.preventDefault();
      if (!event.repeat) void newThread();
    } else if (!mapOpen() && event.metaKey && event.shiftKey && letter === "c") {
      event.preventDefault();
      if (!event.repeat) void copyReply?.();
    } else if (owner && !mapOpen() && event.metaKey && event.shiftKey && letter === "s") {
      event.preventDefault();
      if (event.repeat) return true;
      closePicker();
      setShareOpen(open => !open);
    } else if (owner && !mapOpen() && event.metaKey && letter === "m") {
      event.preventDefault();
      if (event.repeat) return true;
      closeShare();
      setPickerOpen(open => !open);
    } else return false;
    return true;
  }

  return <section id="chat-screen" data-thread-id={props.chat.threadId()} aria-label={mapOpen() ? "Map" : "Chat"} data-chat-route={props.pathname} onKeyDown={keydown}
    class="flex min-h-0 min-w-0 flex-1 justify-center px-6 pb-6">
    <div class={`flex min-h-0 w-[560px] max-w-full flex-col gap-4 ${mapOpen() ? "pt-6" : ""}`}>
      <Show when={mapOpen()}><MapHeader /></Show>
      <Show keyed when={props.chat.threadId()}>{(threadId: Id<"threads">) => <ThreadView loader={props.loader} chat={props.chat} threadId={threadId} hidden={mapOpen()} raced={composer.raced()}
        onBackend={props.chat.isOwner() ? () => { closeShare(); setPickerOpen(open => !open); } : undefined} onPermissionReady={pick => { pickPermission = pick; }} onCopyReady={copy => { copyReply = copy; }} />}</Show>
      <Show when={props.chat.error() ?? props.chat.threads.error()?.message}>{(error: Accessor<string>) => <p role="alert" class="m-0 text-text-2">{error()}</p>}</Show>
      <Show when={!mapOpen() && props.chat.isGuest() && props.chat.threads.data()?.length === 0}>
        <p id="chat-nothing-shared" class="m-0 flex-1 font-label text-[10px] uppercase tracking-[0.08em] text-text-3">Nothing has been shared with you yet</p>
      </Show>
      <Show when={shareOpen() && !mapOpen() && props.chat.sharing()}>{(sharing: Accessor<NonNullable<ReturnType<ChatState["sharing"]>>>) =>
        <Show when={props.chat.threadId()}>{(threadId: Accessor<Id<"threads">>) =>
          <SharePicker sharing={sharing()} threadId={threadId()} onClose={closeShare} onKeyReady={handler => { shareKey = handler; }} />}</Show>}
      </Show>
      <Show when={pickerOpen() && !mapOpen() && props.chat.isOwner()}><BackendPicker chat={props.chat} onClose={closePicker} onFolderChange={setPickerFolder} onKeyReady={handler => { pickerKey = handler; }} /></Show>
      {/* Retire the focused native editor only while the row editor owns focus. */}
      <Show when={map.editing() !== "rename" && !(pickerOpen() && pickerFolder())}>
        <div class={`flex shrink-0 items-start gap-3 ${editorClass()}`}>
          <Show when={!mapOpen()}><Mark user initial={authorInitial(props.chat.identity() ?? {})} /></Show>
          <ComposerInput mapOpen={mapOpen()} autofocus id="chat-input" aria-label={mapOpen() ? "Search threads" : "Message"} size="md" appearance="inherit" caret="block"
            class={`chat-input min-w-0 flex-1 ${!mapOpen() && busy() ? "chat-input-busy" : ""}`} maxRows={mapOpen() ? 1 : 8}
            placeholder={mapOpen() ? "Search threads" : "Ask anything, or tell Tokamak what to do"}
            value={mapOpen() ? map.query() : composer.draft()}
            onValueChange={text => {
              if (mapOpen()) map.search(text);
              else { composer.edit(text); composer.clearRace(); }
            }}
            onKeyDown={keydown} onSubmit={text => { if (!mapOpen()) void composer.send(text); }} />
        </div>
      </Show>
      <Show when={mapOpen()}><Map chat={props.chat} map={map} /></Show>
    </div>
  </section>;
}
