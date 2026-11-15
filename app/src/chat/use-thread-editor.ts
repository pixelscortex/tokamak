import { createEffect, createSignal, type Accessor } from "solid-js";
import type { NativeEvent } from "@tokamak/render";
import { api, type ChatState, type Thread } from "./use-chat";

export function useThreadEditor(chat: ChatState, rows: Accessor<Thread[]>, select: (id: string) => void) {
  const [editing, setEditing] = createSignal<"rename" | "delete">();
  const [target, setTarget] = createSignal<string>();
  const [title, setTitle] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    if (editing() && !rows().some(thread => thread._id === target())) setEditing(undefined);
  });

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
    if (key !== "Escape" && key !== "Enter" && key !== "Tab") return;
    event.preventDefault();
    if (event.repeat || busy()) return;
    if (key === "Enter") void save();
    else setEditing(undefined);
  }

  function begin(current: Thread, mode: "rename" | "delete") {
    select(current._id);
    setTarget(current._id);
    setTitle(current.title);
    setEditing(mode);
  }

  return { editing, title, setTitle, keydown, begin, reset: () => setEditing(undefined) };
}
