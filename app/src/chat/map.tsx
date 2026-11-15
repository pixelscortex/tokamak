import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Textarea } from "@tokamak/ui/components";
import { api } from "./use-chat";
import { Icon } from "@tokamak/ui";
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
  const [editing, setEditing] = createSignal<"rename" | "delete">();
  const [target, setTarget] = createSignal<string>();
  const [title, setTitle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [selected, setSelected] = createSignal<string>();
  const rows = createMemo(() => {
    const matches = (chat.threads.data() ?? []).filter(thread => thread.title.toLowerCase().includes(query().trim().toLowerCase()));
    const recent = matches.sort((a, b) => b.updatedAt - a.updatedAt);
    return [...recent.filter(thread => chat.runs()[thread._id]), ...recent.filter(thread => !chat.runs()[thread._id])];
  });
  const index = () => Math.max(0, rows().findIndex(thread => thread._id === selected()));

  createEffect(() => {
    if (editing() && !rows().some(thread => thread._id === target())) setEditing(undefined);
  });

  function open(thread: Thread | undefined) {
    if (!thread) return;
    chat.open(thread._id);
    close();
  }

  async function save() {
    const current = rows().find(thread => thread._id === target());
    if (!current) {
      setEditing(undefined);
      return;
    }
    if (!editing() || busy() || (editing() === "rename" && !title().trim())) return;
    setBusy(true);
    try {
      if (editing() === "rename") await chat.client.mutation(api.threads.rename, { threadId: current._id, title: title() });
      else await chat.client.mutation(api.threads.remove, { threadId: current._id });
      setEditing(undefined);
    } catch (cause) {
      chat.setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  function keydown(event: NativeEvent) {
    const key = event.key ?? "";
    if (editing()) {
      if (key === "Escape" || key === "Enter" || key === "Tab") {
        event.preventDefault();
        if (event.repeat || busy()) return;
        if (key === "Enter") void save();
        else setEditing(undefined);
      }
      return;
    }

    const current = rows()[index()];
    const rename = !query() && key.toLowerCase() === "r" && !event.metaKey && !event.ctrlKey && !event.altKey;
    const remove = event.metaKey && key === "Backspace";

    if (current && (rename || remove)) {
      event.preventDefault();
      if (event.repeat) return;
      setSelected(current._id);
      setTarget(current._id);
      setTitle(current.title);
      setEditing(rename ? "rename" : "delete");
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const list = rows();
      setSelected(list[(index() + (key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?._id);
    } else if (key === "Enter") {
      event.preventDefault();
      if (!event.repeat) open(rows()[index()]);
    } else if (!query() && /^[1-9]$/.test(key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) open(rows()[Number(key) - 1]);
    }
  }

  function search(text: string) {
    if (editing()) return;
    setQuery(text);
    setSelected(undefined);
  }

  function reset() {
    setEditing(undefined);
    setQuery("");
    setSelected(chat.threadId());
  }

  return { editing, title, setTitle, query, search, rows, index, open, keydown, reset };
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
          onClick={() => { if (!props.map.editing()) props.map.open(thread); }}
          class={`flex cursor-pointer items-center gap-4 px-3 py-3 ${props.map.index() === index() ? "bg-text text-ground" : "text-text-2"}`}>
          <span class="w-4 shrink-0 font-label text-[10px]">{index() + 1}</span>
          <Show when={props.map.index() === index() && props.map.editing()} fallback={<span class="min-w-0 flex-1 truncate">{thread.title}</span>}>
            <Show when={props.map.editing() === "rename"} fallback={<span class="min-w-0 flex-1">Delete? Enter / Esc</span>}>
              <Textarea autofocus id="chat-rename" aria-label="Rename thread" appearance="inherit" maxRows={1}
                class="min-w-0 flex-1" value={props.map.title()} onValueChange={props.map.setTitle} />
            </Show>
          </Show>
          <span class="shrink-0 font-label text-[10px]">{relativeTime(thread.updatedAt)}</span>
        </div>
      </>}</For>
      <Show when={!props.map.rows().length}><p class="text-text-3">{props.chat.threads.loading() ? "Loading threads…" : "No threads found"}</p></Show>
    </div>
    <footer aria-label="↑↓ MOVE  ↵ OPEN  1-9 JUMP  ⌘↵ NEW THREAD  R RENAME  ⌘⌫ DELETE" class="order-3 flex shrink-0 flex-wrap items-center gap-5 border-t border-hairline pt-4 font-label text-[9px] leading-4 text-text-3">
      <span class="flex items-center gap-1"><Icon d="M7 20V4 M3 8l4-4 4 4 M17 4v16 M13 16l4 4 4-4" class="size-3" />MOVE</span>
      <span class="flex items-center gap-1"><Icon d="M20 4v10H4 M9 9l-5 5 5 5" class="size-3" />OPEN</span>
      <span>1-9 JUMP</span>
      <span>R RENAME</span>
      <span>⌘⌫ DELETE</span>
      <span class="flex items-center gap-1"><Icon d="M9 7V4a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v16a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z" class="size-3" /><Icon d="M20 4v10H4 M9 9l-5 5 5 5" class="size-3" />NEW THREAD</span>
    </footer>
  </>;
}
