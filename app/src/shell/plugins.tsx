import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Button, Icon, icons } from "@tokamak/ui";
import { bearerHeaders } from "../host/auth";
import type { Endpoint } from "../host/endpoint";
import { assetURL } from "../plugins/adapter";
import type { PluginShell } from "../plugins/views";
import { useShell } from "./context";
import { shellIcons } from "./icons";
import { Unreachable } from "./states";

/** One row of Settings → Plugins: a loaded plugin or a folder the server skipped. */
export type InstalledPlugin =
  | { state: "loaded"; key: string; name: string; id: string; version: string; folder: string }
  | { state: "failed"; key: string; reason: string; folder: string };

export interface InstalledPlugins {
  /** Absolute path of the folder the server scans for plugin builds. */
  folder: string;
  plugins: InstalledPlugin[];
}

/**
 * Reads what this page needs from `GET /plugins` (packages/server/PLUGINS.md):
 * `pluginsFolder`, each plugin's `folder`, and the `skipped` reasons with their
 * `skippedFolders`. Loaded plugins come first in catalog order, then skipped ones by key.
 */
export function readInstalled(value: unknown): InstalledPlugins {
  const catalog = (value ?? {}) as {
    pluginsFolder?: unknown;
    plugins?: unknown;
    skipped?: unknown;
    skippedFolders?: unknown;
  };
  const text = (item: unknown) => (typeof item === "string" ? item : "");
  const record = (item: unknown) =>
    item && typeof item === "object" ? (item as Record<string, unknown>) : ({} as Record<string, unknown>);
  const loaded = (Array.isArray(catalog.plugins) ? catalog.plugins : []).flatMap(
    (item): InstalledPlugin[] => {
      const entry = record(item);
      const plugin = record(entry.plugin);
      const id = text(plugin.id) || text(entry.id);
      if (!id) return [];
      return [
        {
          state: "loaded",
          key: id,
          id,
          name: text(plugin.name) || id,
          version: text(plugin.version),
          folder: text(entry.folder),
        },
      ];
    },
  );
  const folders = record(catalog.skippedFolders);
  const failed = Object.entries(record(catalog.skipped))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, reason]): InstalledPlugin => ({
      state: "failed",
      key,
      reason: text(reason),
      folder: text(folders[key]),
    }));
  return { folder: text(catalog.pluginsFolder), plugins: [...loaded, ...failed] };
}

export function Plugins(): JSX.Element {
  const shell = useShell();
  const connected = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? connection : undefined;
  };
  const failure = () => {
    const connection = shell.session.connection();
    return connection.state === "failed" ? connection : undefined;
  };
  return (
    <Show
      when={connected()}
      keyed
      fallback={
        <Show when={failure()} fallback={<p class="px-6 py-8 text-row text-ink-2">Connecting…</p>}>
          {(failed) => <Unreachable reason={failed().reason} needs={failed().needs} />}
        </Show>
      }
    >
      {(connection) => <PluginsList endpoint={connection.endpoint} plugins={connection.plugins} />}
    </Show>
  );
}

/**
 * The list itself. It reads the catalog on open and again whenever the window's plugin
 * catalog changes (the server's plugin-changed event after a reload), so an install
 * shows up without a restart. Read-only: nothing here installs, removes or switches off.
 */
export function PluginsList(props: { endpoint: Endpoint; plugins: PluginShell }): JSX.Element {
  const [installed, setInstalled] = createSignal<InstalledPlugins>();
  const [problem, setProblem] = createSignal<string>();
  const closed = new AbortController();
  onCleanup(() => closed.abort());
  let reads = 0;

  async function read() {
    const current = ++reads;
    try {
      const response = await fetch(assetURL(props.endpoint, "/plugins"), {
        headers: bearerHeaders(props.endpoint.token),
        signal: AbortSignal.any([closed.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = readInstalled(await response.json());
      if (current !== reads) return;
      setInstalled(next);
      setProblem(undefined);
    } catch {
      if (!closed.signal.aborted && current === reads) setProblem("Couldn’t read the plugin list.");
    }
  }
  // Every plugin-changed event replaces the loader's catalog, so this runs once per reload.
  createEffect(
    () => props.plugins.loader.metadata(),
    () => void read(),
  );

  const listLabel = createUniqueId();
  return (
    <section aria-label="Plugins" class="mx-auto w-full max-w-read px-6 py-8 sm:px-8">
      <p class="text-row text-ink-2">Every plugin the server found in its plugins folder.</p>
      <Show when={problem()}>
        {(message) => (
          <p role="alert" class="mt-3 text-row text-removed">
            {message()}
          </p>
        )}
      </Show>
      <Show when={installed()} fallback={<p class="mt-4 text-row text-ink-3">Loading plugins…</p>}>
        {(list) => (
          <>
            <FolderSection folder={list().folder} onProblem={setProblem} />
            <section aria-labelledby={listLabel} class="mt-6">
              <h3 id={listLabel} class="flex h-6 items-center text-label text-ink-3">
                Installed
              </h3>
              <Show
                when={list().plugins.length > 0}
                fallback={
                  <p class="py-3 text-row text-ink-2">Plugin builds placed in this folder are loaded.</p>
                }
              >
                <ul class="mt-1" aria-label="Installed plugins">
                  <For each={list().plugins}>{(plugin) => <PluginRow plugin={plugin} />}</For>
                </ul>
              </Show>
            </section>
          </>
        )}
      </Show>
    </section>
  );
}

/** The plugins folder's path, with "Reveal in Finder" for the Runner on this Mac in the desktop app. */
function FolderSection(props: { folder: string; onProblem: (message: string) => void }): JSX.Element {
  const shell = useShell();
  const label = createUniqueId();
  const canReveal = () => isTauri() && shell.servers.current().kind === "local";
  async function reveal() {
    try {
      await invoke("reveal_plugins_folder");
    } catch {
      props.onProblem("Couldn’t open the plugins folder.");
    }
  }
  return (
    <section aria-labelledby={label} class="mt-6">
      <h3 id={label} class="flex h-6 items-center text-label text-ink-3">
        Plugins folder
      </h3>
      <div class="flex flex-wrap items-center gap-3 py-1">
        <p class="min-w-0 flex-1 text-data wrap-anywhere text-ink" aria-label="Plugins folder path">
          {props.folder}
        </p>
        <Show when={canReveal()}>
          <Button variant="ghost" onClick={() => void reveal()}>
            Reveal in Finder
          </Button>
        </Show>
      </div>
    </section>
  );
}

function PluginRow(props: { plugin: InstalledPlugin }): JSX.Element {
  const nameId = createUniqueId();
  const loaded = () => (props.plugin.state === "loaded" ? props.plugin : undefined);
  const failed = () => (props.plugin.state === "failed" ? props.plugin : undefined);
  return (
    <li aria-labelledby={nameId} class="flex items-start gap-3 py-3">
      <Icon
        path={failed() ? icons.failed : shellIcons.plug}
        class={failed() ? "mt-1 shrink-0 text-removed" : "mt-1 shrink-0 text-ink-3"}
      />
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-baseline gap-x-2 text-row">
          <span id={nameId} class="wrap-break-word font-medium text-ink">
            {loaded()?.name ?? props.plugin.key}
          </span>
          <Show when={loaded()}>
            {(plugin) => (
              <span class="text-data text-ink-3">
                {/* The id is the title when the plugin has no name; say it once. */}
                <Show when={plugin().name !== plugin().id}>{plugin().id} </Show>
                {plugin().version}
              </span>
            )}
          </Show>
        </p>
        <Show when={failed()}>
          {(plugin) => <p class="mt-1 text-row wrap-break-word text-ink-2">{plugin().reason}</p>}
        </Show>
        <p class="mt-1 text-data wrap-anywhere text-ink-3">{props.plugin.folder}</p>
      </div>
      <span class={failed() ? "shrink-0 text-label text-removed" : "shrink-0 text-label text-ink-3"}>
        {failed() ? "Failed" : "Loaded"}
      </span>
    </li>
  );
}
