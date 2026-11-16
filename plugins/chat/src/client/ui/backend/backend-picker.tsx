import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { NativeEvent } from "@tokamak/render";
import { Textarea } from "@tokamak/ui/components";
import { api, type ChatState, type Thread } from "../../lib/state/use-chat";
import type { JsonValue } from "@tokamak/sdk";

function backendFolder(settings: JsonValue | undefined): string {
  return settings &&
    typeof settings === "object" &&
    !Array.isArray(settings) &&
    typeof settings.cwd === "string"
    ? settings.cwd
    : "";
}

export function backendLabel(
  thread: Thread | undefined,
  options?: { id: string; plugin: string; title: string }[],
) {
  const backend = thread?.backend;
  return backend?.kind === "plugin"
    ? `${options?.find((option) => option.id === backend.backendId && option.plugin === backend.plugin)?.title ?? backend.backendId}${backendFolder(backend.settings) ? ` · ${backendFolder(backend.settings).split("/").filter(Boolean).at(-1) ?? "/"}` : ""}`
    : options?.length === 0
      ? "No agents found. Install `claude-agent-acp` or `codex-acp` (see README)"
      : "Select agent";
}

// Keep the last successful folder across threads without depending on browser storage.
let lastFolder = "";

export function BackendPicker(props: {
  chat: ChatState;
  onClose: () => void;
  onFolderChange: (editing: boolean) => void;
  onKeyReady: (handler: (event: NativeEvent) => void) => void;
}) {
  const { data: options, loading, error: discoveryError, refresh } = props.chat.backendDiscovery;
  const [error, setError] = createSignal<string>();
  const [index, setIndex] = createSignal(0);
  const [selected, setSelected] = createSignal<{ plugin: string; backendId: string }>();
  const backend = props.chat.thread()?.backend;
  const previous = props.chat.threads.data()?.find((thread) => thread.backend?.kind === "plugin")?.backend;
  const [folder, setFolder] = createSignal(
    backendFolder(backend?.settings) || lastFolder || backendFolder(previous?.settings),
  );
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const [saving, setSaving] = createSignal(false);
  const choices = createMemo(() => [
    ...(options() ?? []).map((agent) => ({
      title: agent.title,
      folder: agent.folder,
      backend: { kind: "plugin" as const, plugin: agent.plugin, backendId: agent.id },
    })),
  ]);
  void refresh();

  async function save(backend: {
    kind: "plugin";
    plugin: string;
    backendId: string;
    settings?: import("@tokamak/sdk").JsonValue;
  }) {
    const thread = props.chat.thread();
    if (!thread || saving()) return;
    setSaving(true);
    setError(undefined);
    try {
      if (backend.kind === "plugin") {
        const settings = await props.chat.client.action(api.backends.configure, {
          plugin: backend.plugin,
          backendId: backend.backendId,
          settings: backend.settings ?? {},
        });
        backend = { ...backend, settings };
      }
      await props.chat.client.mutation(api.threads.setBackend, { threadId: thread._id, backend });
      if (backend.kind === "plugin" && backendFolder(backend.settings))
        lastFolder = backendFolder(backend.settings);
      if (alive) props.onClose();
    } catch (cause) {
      if (alive) setError(String(cause));
    } finally {
      if (alive) setSaving(false);
    }
  }

  function choose(i: number) {
    if (saving()) return;
    const choice = choices()[i];
    if (!choice) return;
    setError(undefined);
    if (choice.backend.kind === "plugin" && "folder" in choice && choice.folder) setSelected(choice.backend);
    else void save(choice.backend);
  }

  function submitFolder() {
    // Empty means the home folder; the server resolves `~` and checks the path.
    const path = folder().trim();
    if (path && !path.startsWith("/") && !path.startsWith("~")) {
      setError("Use an absolute path, ~/…, or leave empty for your home folder");
      return;
    }
    const backend = selected();
    if (backend) void save({ kind: "plugin", ...backend, settings: { cwd: path } });
  }

  function keydown(event: NativeEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key;
    if (key === "Escape" || key === "Tab") {
      event.preventDefault();
      if (!saving()) props.onClose();
    } else if (!selected() && (key === "ArrowDown" || key === "ArrowUp" || key === "Enter")) {
      event.preventDefault();
      if (!choices().length) return;
      if (key === "Enter") {
        if (!event.repeat) choose(index());
      } else setIndex((i) => (i + (key === "ArrowDown" ? 1 : -1) + choices().length) % choices().length);
    }
  }

  createEffect(() => props.onKeyReady(keydown));
  createEffect(() => props.onFolderChange(Boolean(selected())));

  return (
    <div
      id="backend-picker"
      class="flex shrink-0 flex-col gap-2 border border-hairline bg-ground p-3 font-label text-[12px] leading-5 text-text-2"
      onKeyDown={keydown}
    >
      <Show
        when={!selected()}
        fallback={
          <>
            <span>FOLDER · {selected()?.backendId}</span>
            <Textarea
              id="backend-folder"
              aria-label="Agent folder"
              autofocus
              appearance="inherit"
              size="xs"
              maxRows={1}
              value={folder()}
              onValueChange={setFolder}
              onSubmit={submitFolder}
              disabled={saving()}
              placeholder="~ (home folder)"
            />
            <span class="text-text-3">ENTER SAVE · ESC CLOSE</span>
          </>
        }
      >
        <div role="listbox" aria-label="Chat backend" aria-activedescendant={`backend-choice-${index()}`}>
          <For each={choices()}>
            {(choice, i) => (
              <button
                id={`backend-choice-${i()}`}
                role="option"
                aria-selected={index() === i()}
                disabled={saving()}
                onClick={() => choose(i())}
                class={`m-0 block box-border w-full cursor-pointer border-0 px-2 py-1 text-left font-label text-[12px] ${index() === i() ? "bg-text text-ground" : "bg-transparent text-text-2"}`}
              >
                {choice.title}
              </button>
            )}
          </For>
        </div>
        <Show when={loading()}>
          <span class="text-text-3">Loading backends…</span>
        </Show>
        <Show when={!loading() && props.chat.noAgents()}>
          <span class="text-text-3">
            No agents found. Install `claude-agent-acp` or `codex-acp` (see README)
          </span>
        </Show>
        <span class="text-text-3">↑↓ MOVE · ENTER SELECT · ESC CLOSE</span>
      </Show>
      <Show when={options()?.some((option) => option.folder)}>
        <p class="m-0 text-text-3">An agent can do anything its CLI can in this folder.</p>
      </Show>
      <Show when={error() ?? discoveryError()}>
        <span role="alert">{error() ?? discoveryError()}</span>
        <Show when={discoveryError()}>
          <button onClick={() => void refresh()}>Retry discovery</button>
        </Show>
      </Show>
    </div>
  );
}
