import type { JsonValue } from "@tokamak/sdk";
import type { Endpoint as ServerEndpoint } from "../host/endpoint";
export type { Endpoint as ServerEndpoint } from "../host/endpoint";
import type { PluginAssets, PluginCatalog, PluginManifest } from "../../../packages/runtime/js/plugins";

export interface CatalogSource {
  plugins(): Promise<JsonValue>;
  onPluginsChanged(listener: (event: { plugins: string[]; catalog: JsonValue }) => void): () => void;
}
export function assetURL(endpoint: ServerEndpoint, path: string): string {
  const url = new URL(path, endpoint.http);
  if (url.origin !== new URL(endpoint.http).origin)
    throw new Error("Plugin assets must use the server origin");
  if (endpoint.token) url.searchParams.set("token", endpoint.token);
  return url.href;
}

// Only this adapter understands the server's catalog and asset URL spelling.
export function adaptCatalog(value: JsonValue): PluginCatalog {
  const raw = value as unknown as PluginCatalog;
  if (!raw || typeof raw.revision !== "string" || !Array.isArray(raw.plugins))
    throw new Error("Invalid plugin catalog");
  return {
    revision: raw.revision,
    skipped: raw.skipped,
    plugins: raw.plugins.map((item) => {
      const p = item as PluginManifest & {
        id?: string;
        revision?: string;
        uiUrl?: string | null;
        stylesheetUrl?: string | null;
        ui?: string;
        stylesheet?: string;
        contributes?: PluginManifest["plugin"]["contributes"];
      };
      const plugin = p.plugin ?? { id: p.id!, version: p.revision!, contributes: p.contributes };
      if (typeof plugin.id !== "string") throw new Error("Invalid plugin id");
      const entry = p.uiUrl
        ? { code: p.uiUrl, css: p.stylesheetUrl ?? "" }
        : (p.entries?.ui ?? (p.ui ? { code: p.ui, css: p.stylesheet ?? "" } : undefined));
      const path = (name: string) =>
        !name || /^(\/|https?:)/.test(name)
          ? name
          : `/plugins/${encodeURIComponent(plugin.id)}/${encodeURIComponent(p.revision ?? raw.revision)}/assets/${name}`;
      return {
        ...p,
        plugin,
        entries: { ui: entry ? { code: path(entry.code), css: path(entry.css) } : undefined },
        hashes: p.hashes ?? {},
      };
    }),
  };
}
export function serverAssets(endpoint: ServerEndpoint, source?: CatalogSource): PluginAssets {
  const normalize = (value: JsonValue) => adaptCatalog(value) as unknown as JsonValue;
  return {
    async plugins() {
      if (source) return normalize(await source.plugins());
      const response = await fetch(assetURL(endpoint, "/plugins"));
      if (!response.ok) throw new Error(`Plugin catalog: HTTP ${response.status}`);
      return normalize(await response.json());
    },
    onPluginsChanged(listener) {
      return (
        source?.onPluginsChanged((event) =>
          listener({
            ...event,
            catalog: (event.catalog as { paged?: boolean }).paged ? event.catalog : normalize(event.catalog),
          }),
        ) ?? (() => {})
      );
    },
    async pluginAsset(_plugin, path) {
      if (!path) return "";
      const response = await fetch(assetURL(endpoint, path));
      if (!response.ok) throw new Error(`Plugin asset ${path}: HTTP ${response.status}`);
      return response.text();
    },
  };
}
