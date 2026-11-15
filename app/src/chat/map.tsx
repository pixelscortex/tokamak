import { For, Show, createMemo, createSignal } from "solid-js";
import type { NativeEvent } from "@tokamak/render";
import type { ChatState, Thread } from "./use-chat";

function relativeTime(time: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function useMap(chat: ChatState, close: () => void) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string>();
  const rows = createMemo(() => {
    const matches = (chat.threads.data() ?? []).filter(thread => thread.title.toLowerCase().includes(query().trim().toLowerCase()));
    const recent = matches.sort((a, b) => b.updatedAt - a.updatedAt);
    return [...recent.filter(thread => chat.runs()[thread._id]), ...recent.filter(thread => !chat.runs()[thread._id])];
  });
  const index = () => Math.max(0, rows().findIndex(thread => thread._id === selected()));

  function open(thread: Thread | undefined) {
    if (!thread) return;
    chat.open(thread._id);
    close();
  }

  function keydown(event: NativeEvent) {
    const key = event.key ?? "";
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const list = rows();
      setSelected(list[(index() + (key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?._id);
    } else if (key === "Enter") {
      event.preventDefault();
      if (!event.repeat) open(rows()[index()]);
    } else if (/^[1-9]$/.test(key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) open(rows()[Number(key) - 1]);
    }
  }

  return { query, search: (text: string) => { setQuery(text); setSelected(undefined); }, rows, index, open, keydown,
    reset: () => { setQuery(""); setSelected(chat.threadId()); } };
}

export type MapState = ReturnType<typeof useMap>;

export function MapHeader() {
  return <header class="order-0 flex shrink-0 justify-between gap-4 border-b border-hairline pb-4 font-label text-[10px] leading-4 tracking-[0.08em] text-text-3">
    <span>MAP</span><span>TAB OR ESC TO CLOSE</span>
  </header>;
}

export function Map(props: { chat: ChatState; map: MapState }) {
  return <>
    <div id="chat-map" role="listbox" aria-label="Threads" class="order-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <For each={props.map.rows()}>{(thread, index) => <>
        <Show when={index() === 0 || Boolean(props.chat.runs()[thread._id]) !== Boolean(props.chat.runs()[props.map.rows()[index() - 1]!._id])}>
          <h2 class="m-0 pb-2 pt-5 font-label text-[9px] font-normal leading-4 tracking-[0.08em] text-text-3">{props.chat.runs()[thread._id] ? "RUNNING" : "RECENT"}</h2>
        </Show>
        <div role="option" aria-selected={props.map.index() === index()} data-thread={thread._id}
          onClick={() => props.map.open(thread)}
          class={`flex cursor-pointer items-center gap-4 px-3 py-3 ${props.map.index() === index() ? "bg-text text-ground" : "text-text-2"}`}>
          <span class="w-4 shrink-0 font-label text-[10px]">{index() + 1}</span>
          <span class="min-w-0 flex-1 truncate">{thread.title}</span>
          <span class="shrink-0 font-label text-[10px]">{relativeTime(thread.updatedAt)}</span>
        </div>
      </>}</For>
      <Show when={!props.map.rows().length}><p class="text-text-3">{props.chat.threads.loading() ? "Loading threads…" : "No threads found"}</p></Show>
    </div>
    <footer class="order-3 shrink-0 border-t border-hairline pt-4 font-label text-[9px] leading-4 text-text-3">↑↓ MOVE　 ↵ OPEN　 1-9 JUMP　 ⌘↵ NEW THREAD</footer>
  </>;
}
