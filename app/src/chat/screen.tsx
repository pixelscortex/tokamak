import { Show, createEffect, createSignal, on, type Accessor } from "solid-js";
import { BackendPicker } from "./backend-picker";
import { ChatComposer } from "./chat-composer";
import type { Id } from "@tokamak/sdk";
import type { NativeEvent } from "@tokamak/render";
import type { ChatState } from "./use-chat";
import { ThreadView } from "./thread-view";
import { Map, MapHeader } from "./map";
import { useMap } from "./use-map";
import { useDrafts } from "./use-drafts";
import { chatKeys } from "./chat-keys";

export function Chat(props: { pathname: string; chat: ChatState }) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [pickerFolder, setPickerFolder] = createSignal(false);
  let pickerKey: ((event: NativeEvent) => void) | undefined;
  const [mapOpen, setMapOpen] = createSignal(false);
  const map = useMap(props.chat, closeMap);
  let pickPermission: ((index: number) => boolean) | undefined;
  let copyReply: (() => Promise<void>) | undefined;
  const composer = useDrafts(props.chat);

  function closePicker() {
    setPickerOpen(false);
    setPickerFolder(false);
    pickerKey = undefined;
  }

  createEffect(
    on(
      () => props.chat.threadId(),
      () => {
        closePicker();
      },
    ),
  );

  function closeMap() {
    map.reset();
    setMapOpen(false);
  }

  async function newThread() {
    if (await props.chat.createThread()) closeMap();
  }

  const keydown = chatKeys({
    chat: props.chat,
    composer,
    map,
    mapOpen,
    setMapOpen,
    closeMap,
    newThread,
    pickerOpen,
    pickerKey: (event) => pickerKey?.(event),
    closePicker,
    setPickerOpen,
    pickPermission: (index) => pickPermission?.(index) ?? false,
    copyReply: () => {
      void copyReply?.();
    },
  });

  return (
    <section
      id="chat-screen"
      data-thread-id={props.chat.threadId()}
      aria-label={mapOpen() ? "Map" : "Chat"}
      data-chat-route={props.pathname}
      onKeyDown={keydown}
      class="flex min-h-0 min-w-0 flex-1 justify-center px-6 pb-6"
    >
      <div class={`flex min-h-0 w-[560px] max-w-full flex-col gap-4 ${mapOpen() ? "pt-6" : ""}`}>
        <Show when={mapOpen()}>
          <MapHeader />
        </Show>
        <Show keyed when={props.chat.threadId()}>
          {(threadId: Id<"threads">) => (
            <ThreadView
              chat={props.chat}
              threadId={threadId}
              hidden={mapOpen()}
              raced={composer.raced()}
              onBackend={() => setPickerOpen((open) => !open)}
              onPermissionReady={(pick) => {
                pickPermission = pick;
              }}
              onCopyReady={(copy) => {
                copyReply = copy;
              }}
            />
          )}
        </Show>
        <Show when={props.chat.error() ?? props.chat.threads.error()?.message}>
          {(error: Accessor<string>) => (
            <p role="alert" class="m-0 text-text-2">
              {error()}
            </p>
          )}
        </Show>
        <Show when={pickerOpen() && !mapOpen()}>
          <BackendPicker
            chat={props.chat}
            onClose={closePicker}
            onFolderChange={setPickerFolder}
            onKeyReady={(handler) => {
              pickerKey = handler;
            }}
          />
        </Show>
        {/* Retire the focused native editor only while the row editor owns focus. */}
        <Show when={map.editing() !== "rename" && !(pickerOpen() && pickerFolder())}>
          <ChatComposer
            chat={props.chat}
            composer={composer}
            map={map}
            mapOpen={mapOpen()}
            onKeyDown={keydown}
          />
        </Show>
        <Show when={mapOpen()}>
          <Map chat={props.chat} map={map} />
        </Show>
      </div>
    </section>
  );
}
