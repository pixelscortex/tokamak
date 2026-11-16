import { createMemo, createSignal } from "solid-js";
import { useThreadEditor } from "./use-thread-editor";
import type { NativeEvent } from "@tokamak/render";
import type { ChatState, Thread } from "./use-chat";

export function useMap(chat: ChatState, close: () => void) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string>();
  const rows = createMemo(() => {
    const matches = (chat.threads.data() ?? []).filter((thread) =>
      thread.title.toLowerCase().includes(query().trim().toLowerCase()),
    );
    const recent = matches.sort((a, b) => b.updatedAt - a.updatedAt);
    return recent.sort((a, b) => mapGroup(chat, a._id) - mapGroup(chat, b._id));
  });
  const index = () =>
    Math.max(
      0,
      rows().findIndex((thread) => thread._id === selected()),
    );

  const editor = useThreadEditor(chat, rows, setSelected);

  function open(thread: Thread | undefined) {
    if (!thread) return;
    chat.open(thread._id);
    close();
  }

  function keydown(event: NativeEvent) {
    const key = event.key ?? "";
    if (editor.editing()) {
      editor.keydown(event);
      return;
    }

    const current = rows()[index()];
    // Rename and delete are owner controls; the server refuses them for guests too.
    const mode = chat.isOwner() ? editMode(event, query()) : undefined;
    const direction = arrowDirection(key);
    if (current && mode) {
      event.preventDefault();
      if (event.repeat) return;
      editor.begin(current, mode);
    } else if (direction) {
      event.preventDefault();
      const list = rows();
      setSelected(list[(index() + direction + list.length) % list.length]?._id);
    } else if (key === "Enter") {
      event.preventDefault();
      if (!event.repeat) open(rows()[index()]);
    } else if (!query() && /^[1-9]$/.test(key) && plainKey(event)) {
      event.preventDefault();
      if (!event.repeat) open(rows()[Number(key) - 1]);
    }
  }

  function search(text: string) {
    if (editor.editing()) return;
    setQuery(text);
    setSelected(undefined);
  }

  function reset() {
    editor.reset();
    setQuery("");
    setSelected(chat.threadId());
  }

  return {
    editing: editor.editing,
    title: editor.title,
    setTitle: editor.setTitle,
    query,
    search,
    rows,
    index,
    open,
    keydown,
    reset,
  };
}

export type MapState = ReturnType<typeof useMap>;

function plainKey(event: NativeEvent) {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

function editMode(event: NativeEvent, query: string) {
  const key = event.key ?? "";
  if (!query && key.toLowerCase() === "r" && plainKey(event)) return "rename";
  if (event.metaKey && key === "Backspace") return "delete";
}

function arrowDirection(key: string) {
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return -1;
  return 0;
}

export function mapGroup(chat: ChatState, threadId: string) {
  const run = chat.runs()[threadId];
  return run?.waiting ? 0 : run ? 1 : 2;
}
