import { mapGroup } from "./use-map";
import { For, Show } from "solid-js";
import { Textarea } from "@tokamak/ui/components";
import { Icon } from "@tokamak/ui";
import type { ChatState } from "./use-chat";
import type { MapState } from "./use-map";

function relativeTime(time: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function MapHeader() {
  return (
    <header class="order-0 flex shrink-0 justify-between gap-4 border-b border-hairline pb-4 font-label text-[12px] leading-4 tracking-[0.08em] text-text-3">
      <span>MAP</span>
      <span>TAB OR ESC TO CLOSE</span>
    </header>
  );
}

export function Map(props: { chat: ChatState; map: MapState }) {
  return (
    <>
      <div
        id="chat-map"
        role="listbox"
        aria-label="Threads"
        class="order-2 min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <For each={props.map.rows()}>
          {(thread, index) => (
            <>
              <Show
                when={
                  index() === 0 ||
                  mapGroup(props.chat, thread._id) !==
                    mapGroup(props.chat, props.map.rows()[index() - 1]!._id)
                }
              >
                <h2 class="m-0 pb-2 pt-5 font-label text-[11px] font-normal leading-4 tracking-[0.08em] text-text-3">
                  {["NEEDS YOU", "RUNNING", "RECENT"][mapGroup(props.chat, thread._id)]}
                </h2>
              </Show>
              <div
                role="option"
                aria-selected={props.map.index() === index()}
                data-thread={thread._id}
                onClick={() => {
                  if (!props.map.editing()) props.map.open(thread);
                }}
                class={`flex cursor-pointer items-center gap-4 px-3 py-3 ${props.map.index() === index() ? "bg-text text-ground" : "text-text-2"}`}
              >
                <span class="w-4 shrink-0 font-label text-[12px]">{index() + 1}</span>
                <Show
                  when={props.map.index() === index() && props.map.editing()}
                  fallback={<span class="min-w-0 flex-1 truncate">{thread.title}</span>}
                >
                  <Show
                    when={props.map.editing() === "rename"}
                    fallback={<span class="min-w-0 flex-1">Delete? Enter / Esc</span>}
                  >
                    <Textarea
                      autofocus
                      id="chat-rename"
                      aria-label="Rename thread"
                      appearance="inherit"
                      maxRows={1}
                      class="min-w-0 flex-1"
                      value={props.map.title()}
                      onValueChange={props.map.setTitle}
                    />
                  </Show>
                </Show>
                <span class="shrink-0 font-label text-[12px]">{relativeTime(thread.updatedAt)}</span>
              </div>
            </>
          )}
        </For>
        <Show when={!props.map.rows().length}>
          <p class="text-text-3">{props.chat.threads.loading() ? "Loading threads…" : "No threads found"}</p>
        </Show>
      </div>

      <footer
        aria-label="↑↓ MOVE  ENTER OPEN  1-9 JUMP  CMD+ENTER NEW THREAD  R RENAME  CMD+BACKSPACE DELETE"
        class="order-3 flex shrink-0 flex-wrap items-center gap-5 border-t border-hairline pt-4 font-label text-[11px] leading-4 text-text-3"
      >
        <span class="flex items-center gap-1">
          <Icon d="M7 20V4 M3 8l4-4 4 4 M17 4v16 M13 16l4 4 4-4" class="size-3" />
          MOVE
        </span>
        <span class="flex items-center gap-1">
          <Icon d="M20 4v10H4 M9 9l-5 5 5 5" class="size-3" />
          OPEN
        </span>
        <span>1-9 JUMP</span>

        <>
          <span>R RENAME</span>
          <span>CMD+BACKSPACE DELETE</span>
          <span class="flex items-center gap-1">
            <Icon
              d="M9 7V4a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v16a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z"
              class="size-3"
            />
            <Icon d="M20 4v10H4 M9 9l-5 5 5 5" class="size-3" />
            NEW THREAD
          </span>
        </>
      </footer>
    </>
  );
}
