import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { NativeEvent } from "@tokamak/render";
import { Textarea } from "@tokamak/ui/components";
import { CHAT_MODELS, currentModel } from "../../../plugins/chat/models";
import { api, type ChatState, type Thread } from "./use-chat";

export function backendLabel(thread: Thread | undefined) {
  const backend = thread?.backend;
  return backend?.kind === "acp"
    ? `${backend.agent} · ${backend.cwd.split("/").filter(Boolean).at(-1) ?? "/"}`
    : currentModel(thread);
}

// Keep the last successful folder across threads without depending on browser storage.
let lastFolder = "";

export function BackendPicker(props: { chat: ChatState; onClose: () => void; onFolderChange: (editing: boolean) => void; onKeyReady: (handler: (event: NativeEvent) => void) => void }) {
  const [agents, setAgents] = createSignal<{ id: string; title: string }[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  const [index, setIndex] = createSignal(0);
  const [agent, setAgent] = createSignal<string>();
  const backend = props.chat.thread()?.backend;
  const previous = props.chat.threads.data()?.find(thread => thread.backend?.kind === "acp")?.backend;
  const [folder, setFolder] = createSignal(backend?.kind === "acp" ? backend.cwd : lastFolder || (previous?.kind === "acp" ? previous.cwd : ""));
  let alive = true;
  onCleanup(() => { alive = false; });
  const [saving, setSaving] = createSignal(false);
  const choices = createMemo(() => [
    ...CHAT_MODELS.map(model => ({ title: model, backend: { kind: "model" as const, model } })),
    ...agents().map(agent => ({ title: agent.title, backend: { kind: "acp" as const, agent: agent.id } })),
  ]);
  void props.chat.client.action(api.agents.list, {}).then(value => { if (alive) setAgents(value); })
    .catch(cause => { if (alive) setError(String(cause)); }).finally(() => { if (alive) setLoading(false); });

  async function save(backend: { kind: "model"; model: string } | { kind: "acp"; agent: string; cwd: string }) {
    const thread = props.chat.thread();
    if (!thread || saving()) return;
    setSaving(true);
    setError(undefined);
    try {
      await props.chat.client.mutation(api.threads.setBackend, { threadId: thread._id, backend });
      if (backend.kind === "acp") lastFolder = backend.cwd;
      if (alive) props.onClose();
    } catch (cause) { if (alive) setError(String(cause)); }
    finally { if (alive) setSaving(false); }
  }
  function choose(i: number) {
    if (saving()) return;
    const choice = choices()[i];
    if (!choice) return;
    setError(undefined);
    if (choice.backend.kind === "acp") setAgent(choice.backend.agent);
    else void save(choice.backend);
  }
  function submitFolder() {
    if (!folder().startsWith("/")) { setError("Folder must be an absolute path"); return; }
    const selected = agent();
    if (selected) void save({ kind: "acp", agent: selected, cwd: folder() });
  }
  function keydown(event: NativeEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key;
    if (key === "Escape" || key === "Tab") {
      event.preventDefault();
      if (!saving()) props.onClose();
    } else if (!agent() && (key === "ArrowDown" || key === "ArrowUp" || key === "Enter")) {
      event.preventDefault();
      if (key === "Enter") { if (!event.repeat) choose(index()); }
      else setIndex(i => (i + (key === "ArrowDown" ? 1 : -1) + choices().length) % choices().length);
    }
  }
  createEffect(() => props.onKeyReady(keydown));
  createEffect(() => props.onFolderChange(Boolean(agent())));

  return <div id="backend-picker" class="flex shrink-0 flex-col gap-2 border border-hairline bg-ground p-3 font-label text-[11px] leading-5 text-text-2" onKeyDown={keydown}>
    <Show when={!agent()} fallback={<>
      <span>FOLDER · {agent()}</span>
      <Textarea id="backend-folder" aria-label="Absolute folder path" autofocus appearance="inherit" size="xs" maxRows={1}
        value={folder()} onValueChange={setFolder} onSubmit={submitFolder} disabled={saving()} placeholder="/absolute/path" />
      <span class="text-text-3">ENTER SAVE · ESC CLOSE</span>
    </>}>
      <div role="listbox" aria-label="Chat backend" aria-activedescendant={`backend-choice-${index()}`}>
        <For each={choices()}>{(choice, i) => <button id={`backend-choice-${i()}`} role="option" aria-selected={index() === i()}
          disabled={saving()} onClick={() => choose(i())}
          class={`m-0 block box-border w-full cursor-pointer border-0 px-2 py-1 text-left font-label text-[11px] ${index() === i() ? "bg-text text-ground" : "bg-transparent text-text-2"}`}>{choice.title}</button>}</For>
      </div>
      <Show when={loading()}><span class="text-text-3">Loading agents…</span></Show>
      <Show when={!loading() && !agents().length}><span class="text-text-3">No agents — add them to agents.toml and restart the app (server)<br />$TOKAMAK_SERVER_DIR/agents.toml<br />Default: ~/Library/Application Support/com.pixelscortex.Tokamak/agents.toml</span></Show>
      <span class="text-text-3">↑↓ MOVE · ENTER SELECT · ESC CLOSE</span>
    </Show>
    <Show when={error()}><span role="alert">{error()}</span></Show>
    <p class="m-0 text-text-3">An agent can do anything its CLI can in this folder.</p>
  </div>;
}
