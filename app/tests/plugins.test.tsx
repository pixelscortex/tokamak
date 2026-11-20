import { expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { createRoot, createSignal, flush, onCleanup } from "solid-js";
import { getByRole, waitFor } from "@testing-library/dom";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/solid-router";
import { useShortcuts, view } from "@tokamak/sdk/client";
import { useClient, useQuery } from "@tokamak/sdk/solid";
import type { JsonValue, TokamakClient } from "@tokamak/sdk";
import {
  createPluginLoader,
  type PluginAssets,
  type PluginManifest,
  type PluginModuleHost,
} from "../../packages/runtime/js/plugins";
import { appVersion } from "../src/host/compatibility";
import { adaptCatalog, assetURL } from "../src/plugins/adapter";
import { createPluginShell } from "../src/plugins/views";
import { WebPluginHost } from "../src/plugins/web-host";
import { createMemoryRouter, matchRoute } from "../src/plugins/router";

export function catalog(revision = "one") {
  return {
    revision,
    plugins: [
      {
        plugin: {
          id: "fixture",
          version: revision,
          api: `tokamak@${appVersion}`,
          contributes: { view: [{ id: "View", route: "/", title: "Fixture" }] },
        },
        logRevision: revision,
        entries: {
          ui: {
            code: `/plugins/fixture/${revision}/assets/ui.js`,
            css: `/plugins/fixture/${revision}/assets/ui.css`,
          },
        },
        hashes: {},
      },
    ],
  };
}
test("adapter pins URL and token, preserves metadata, refuses another origin", () => {
  const endpoint = { http: "http://127.0.0.1:4000", ws: "ws://127.0.0.1:4000/ws", token: "a&b" };
  expect(assetURL(endpoint, "/plugins/fixture/one/assets/ui.js")).toBe(
    "http://127.0.0.1:4000/plugins/fixture/one/assets/ui.js?token=a%26b",
  );
  expect(() => assetURL(endpoint, "http://example.com/ui.js")).toThrow("server origin");
  expect(adaptCatalog(catalog()).plugins[0]?.plugin.contributes?.view?.[0]?.title).toBe("Fixture");
  const raw = catalog();
  const real = {
    ...raw,
    plugins: raw.plugins.map((plugin) => ({
      ...plugin,
      revision: "server-revision",
      uiUrl: "/plugins/fixture/server-revision/assets/module.js",
      stylesheetUrl: "/plugins/fixture/server-revision/assets/styles.css",
    })),
  };
  const entry = adaptCatalog(real).plugins[0]!.entries.ui!;
  expect(entry.code).toBe(real.plugins[0]!.uiUrl);
  expect(assetURL(endpoint, entry.css)).toBe(
    "http://127.0.0.1:4000/plugins/fixture/server-revision/assets/styles.css?token=a%26b",
  );
});

test("ESM lifecycle rejects a load retired while import is pending", async () => {
  let finish!: (value: Record<string, unknown>) => void;
  let notify!: Parameters<PluginAssets["onPluginsChanged"]>[0];
  const host: PluginModuleHost = {
    affected: (names) => new Set(names),
    remove: vi.fn(),
    evaluate: vi.fn(),
    dependencies: () => [],
    has: () => true,
    require: () => ({}),
    setLoader: vi.fn(),
    notifyError: vi.fn(),
    onError: () => () => {},
    importModule: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const assets: PluginAssets = {
    plugins: async () => catalog(),
    pluginAsset: vi.fn(),
    onPluginsChanged: (listener) => {
      notify = listener;
      return () => {};
    },
  };
  const loader = createRoot(() => createPluginLoader(host, assets));
  await loader.connect();
  const pending = loader.load("fixture");
  notify({ plugins: ["fixture"], catalog: catalog("two") });
  finish({ stale: true });
  await expect(pending).rejects.toThrow("Retired plugin generation");
  expect(assets.pluginAsset).not.toHaveBeenCalled();
  loader.dispose();
});

test("web host rewrites literal imports, owns CSS and disposers, and invalidates actual importers", async () => {
  const manifests = catalog().plugins;
  manifests.push({
    ...manifests[0]!,
    plugin: { ...manifests[0]!.plugin, id: "other" },
    entries: { ui: { code: "/plugins/other/one/assets/ui.js", css: "" } },
  });
  const blobs = new Map<string, Blob>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      text: async () =>
        url.includes("/other/")
          ? "export const value = 1"
          : `import { value } from '@plugins/other/ui'; export const lazy = () => import('@plugins/other/ui'); export const url = import.meta.url;`,
    })),
  );
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:test-${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const host = new WebPluginHost(
    { http: "http://localhost", ws: "ws://localhost", token: null },
    () => manifests,
  );
  try {
    // jsdom cannot execute native blob modules; the browser harness executes the same graph.
    await expect(host.importModule("@plugins/fixture/ui", manifests[0]!)).rejects.toThrow();
    expect(blobs.size).toBe(2);
    expect(host.errorOwner("blob:test-0", undefined)).toBe("other");
    const unhandled = Object.assign(new Error("Rejected view callback"), {
      stack: "callback@blob:test-1:4:12",
    });
    expect(host.errorOwner("", unhandled)).toBe("fixture");
    const dependency = Object.assign(new Error("Dependency failure"), {
      stack: "dependency@blob:test-0:1:2\nonClick@blob:test-1:4:12",
    });
    expect(host.errorOwner("blob:test-0", dependency)).toBe("fixture");
    expect(host.errorOwner("", new Error("Unattributed"))).toBeUndefined();
    expect(host.dependencies("@plugins/fixture/ui")).toEqual(["@plugins/other/ui"]);
    expect(host.affected(["@plugins/other/ui"])).toEqual(
      new Set(["@plugins/other/ui", "@plugins/fixture/ui"]),
    );
    expect(document.querySelector('link[data-plugin="fixture"]')).toBeTruthy();
    const dispose = vi.fn();
    host.own("fixture", dispose);
    host.remove(host.affected(["@plugins/other/ui"]));
    expect(dispose).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(document.querySelector('link[data-plugin="fixture"]')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

test("runtime routes mount, retire query owners, swap revision, contain throws, and remove routes", async () => {
  let current = catalog();
  let notify!: (event: { plugins: string[]; catalog: JsonValue }) => void;
  const stopQuery = vi.fn();
  const client = {
    subscribe: vi.fn((_ref, _args, next) => {
      next({ value: "query" });
      return stopQuery;
    }),
  } as unknown as TokamakClient;
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Host survived</p> });
  const router: AnyRouter = createRouter({
    routeTree: root.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const source = {
    plugins: async () => current,
    onPluginsChanged(listener: typeof notify) {
      notify = listener;
      return () => {};
    },
  };
  const fixtureCleanup = vi.fn();
  vi.spyOn(WebPluginHost.prototype, "importModule").mockImplementation(
    async (_name, manifest: PluginManifest) => {
      const revision = manifest.plugin.version;
      return {
        sharedSignal: createSignal,
        View: view({ route: "/" }, () => {
          if (revision === "throws") throw new Error("fixture exploded");
          onCleanup(
            useShortcuts().registerShortcut("k", async () => {
              throw "primitive callback rejection";
            }),
          );
          const query = useQuery(useClient(), "fixture:read" as never, () => ({}));
          onCleanup(fixtureCleanup);
          return (
            <p>
              {revision}: {query.data() as string}
            </p>
          );
        }),
      };
    },
  );
  // The mock import still establishes a generation so host retirement can own it.
  vi.spyOn(WebPluginHost.prototype, "own").mockImplementation(() => () => {});
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const report = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  const shell = createPluginShell(
    client,
    { http: "http://localhost", ws: "ws://localhost", token: "fixture-token" },
    source,
    { router, root, base: [home] },
  );
  const target = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <RouterProvider router={router} />, target);
  const publish = (revision: string) => {
    current = catalog(revision);
    notify({ plugins: ["fixture"], catalog: current });
    flush();
  };
  try {
    await shell.connect();
    flush();
    await waitFor(() => expect(router.routesByPath["/p/fixture"]).toBeTruthy());
    expect(shell.views()[0]).toMatchObject({
      id: "View",
      plugin: "fixture",
      route: "/p/fixture",
      title: "Fixture",
    });
    await router.navigate({ href: "/p/fixture" });
    await waitFor(() => expect(target.textContent).toContain("one: query"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    await waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        "http://localhost/plugins/fixture/window-error?token=fixture-token&revision=one",
        { method: "POST", body: "primitive callback rejection" },
      ),
    );
    publish("two");
    await waitFor(() => expect(target.textContent).toContain("two: query"));
    expect(stopQuery).toHaveBeenCalledOnce();
    expect(fixtureCleanup).toHaveBeenCalledOnce();
    publish("throws");
    await waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toContain("fixture exploded"),
    );
    expect(target.querySelector("button")?.textContent).toBe("Reload");
    const alert = getByRole(target, "alert", { name: "Plugin view error" });
    expect(alert.textContent).toContain("tokamak plugin logs fixture");
    getByRole(alert, "button", { name: "Copy plugin log command" }).click();
    expect(writeText).toHaveBeenCalledWith("tokamak plugin logs fixture");
    await waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        "http://localhost/plugins/fixture/window-error?token=fixture-token&revision=throws",
        {
          method: "POST",
          body: "Error: fixture exploded",
        },
      ),
    );
    await router.navigate({ to: "/" });
    await waitFor(() => expect(target.textContent).toContain("Host survived"));
    notify({ plugins: ["fixture"], catalog: { revision: "removed", plugins: [] } });
    flush();
    await waitFor(() => expect(router.routesByPath["/p/fixture"]).toBeUndefined());
    expect(shell.views()).toEqual([]);
  } finally {
    dispose();
    shell.dispose();
    Reflect.deleteProperty(navigator, "clipboard");
    vi.restoreAllMocks();
  }
});

test("legacy route names and parameter matching remain available", async () => {
  expect(matchRoute("/p/:id/*tail", "/p/a/b%20c/d")?.params).toEqual({ id: "a", tail: "b c/d" });
  expect(matchRoute("/p/:id", "/p/%ZZ")).toBeUndefined();
  const router = createMemoryRouter("/");
  router.navigate("/p/a");
  await waitFor(() => expect(router.location().pathname).toBe("/p/a"));
  router.navigate("/p/b", { replace: true });
  await waitFor(() => expect(router.match("/p/:id")?.params.id).toBe("b"));
  router.dispose();
  expect(() => router.navigate("/")).toThrow("disposed");
});

test("concurrent cross-plugin UI cycles reject instead of waiting on each other", async () => {
  const manifests = catalog().plugins;
  manifests.push({
    ...manifests[0]!,
    plugin: { ...manifests[0]!.plugin, id: "other" },
    entries: { ui: { code: "/plugins/other/one/assets/ui.js", css: "" } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      text: async () => `import '@plugins/${url.includes("/other/") ? "fixture" : "other"}/ui';`,
    })),
  );
  const host = new WebPluginHost(
    { http: "http://localhost", ws: "ws://localhost", token: null },
    () => manifests,
  );
  try {
    await expect(
      Promise.all([
        host.importModule("@plugins/fixture/ui", manifests[0]!),
        host.importModule("@plugins/other/ui", manifests[1]!),
      ]),
    ).rejects.toThrow("UI module dependency cycle");
  } finally {
    host.remove(["@plugins/fixture/ui", "@plugins/other/ui"]);
    vi.unstubAllGlobals();
  }
});

test("a dynamic import of an absent plugin is left to fail when called, and a failed fetch is retried", async () => {
  const manifests = catalog().plugins;
  manifests.push({
    ...manifests[0]!,
    plugin: { ...manifests[0]!.plugin, id: "other" },
    entries: { ui: { code: "/plugins/other/one/assets/ui.js", css: "" } },
  });
  const blobs = new Map<string, Blob>();
  let otherFetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/other/") && ++otherFetches === 1) throw new Error("offline");
      return {
        ok: true,
        text: async () =>
          url.includes("/other/")
            ? "export const value = 1"
            : `import '@plugins/other/ui'; export const lazy = () => import('@plugins/absent/ui').catch(() => null);`,
      };
    }),
  );
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:retry-${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const host = new WebPluginHost(
    { http: "http://localhost", ws: "ws://localhost", token: null },
    () => manifests,
  );
  try {
    await expect(host.importModule("@plugins/fixture/ui", manifests[0]!)).rejects.toThrow("offline");
    // Reloading the importer fetches the dependency again instead of replaying the failure.
    host.remove(["@plugins/fixture/ui"]);
    await expect(host.importModule("@plugins/fixture/ui", manifests[0]!)).rejects.not.toThrow(
      /offline|missing UI dependency/,
    );
    expect(otherFetches).toBe(2);
    const fixture = await [...blobs.values()].at(-1)!.text();
    expect(fixture).toContain("import('@plugins/absent/ui')");
  } finally {
    host.remove(["@plugins/fixture/ui", "@plugins/other/ui"]);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

test("a dependency reload recovers an importer whose old dependency fetch got 404", async () => {
  const p = (id: string, rev: string, depends: Record<string, string> = {}) => ({
    revision: rev,
    plugin: { id, version: "1.0.0", depends },
    entries: { ui: { code: `/plugins/${id}/${rev}/assets/ui.js`, css: "" } },
    hashes: {},
  });
  const a = p("a", "a1", { b: "*" });
  const serverOnly = p("server-only", "s1", { b: "*" });
  const old = { revision: "catalog1", plugins: [a, p("b", "b1"), serverOnly] };
  const next = { revision: "catalog2", plugins: [a, p("b", "b2"), serverOnly] };
  let changed!: Parameters<PluginAssets["onPluginsChanged"]>[0];
  const fetchAsset = vi.fn(async (url: string) =>
    url.includes("/a/")
      ? new Response("import '@plugins/b/ui';")
      : url.includes("/b/b1/")
        ? new Response("", { status: 404 })
        : new Response("export const value = 2;"),
  );
  vi.stubGlobal("fetch", fetchAsset);
  const loader: ReturnType<typeof createPluginLoader> = createRoot(() => {
    const host = new WebPluginHost(
      { http: "http://localhost", ws: "ws://localhost", token: null },
      () => loader.metadata().plugins,
    );
    return createPluginLoader(host, {
      plugins: async () => old,
      pluginAsset: vi.fn(),
      onPluginsChanged(listener) {
        changed = listener;
        return () => {};
      },
    });
  });
  try {
    await loader.connect();
    await expect(loader.load("a")).rejects.toThrow("HTTP 404");
    changed({ plugins: ["b"], catalog: next });
    flush();
    expect(loader.version("a")).toBe(1);
    expect(loader.version("server-only")).toBe(0);
    // jsdom cannot evaluate blob modules, but the remount can now fetch B's new build.
    await expect(loader.load("a")).rejects.not.toThrow("HTTP 404");
    expect(fetchAsset).toHaveBeenCalledWith("http://localhost/plugins/b/b2/assets/ui.js");
  } finally {
    loader.dispose();
    vi.unstubAllGlobals();
  }
});

const [major, minor, patch] = appVersion.split(".").map(Number);

test.each([
  ["tokamak@999.0.0", "The owner needs to rebuild this plugin"],
  [`tokamak@${major}.${minor}.${patch! + 1}`, "Update the app to use this plugin"],
  [null, "The owner needs to rebuild this plugin"],
])("a blocked plugin (%s) keeps a route without loading its view", async (api, message) => {
  const root = createRootRoute({ component: Outlet });
  const router: AnyRouter = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const active = catalog();
  active.plugins[0]!.plugin.api = api ?? "";
  const metadata = api ? active : { ...active, plugins: [], skipped: { fixture: "needs rebuild" } };
  const imported = vi.spyOn(WebPluginHost.prototype, "importModule");
  const shell = createPluginShell(
    {} as TokamakClient,
    { http: "http://localhost", ws: "ws://localhost", token: null },
    { plugins: async () => metadata, onPluginsChanged: () => () => {} },
    { router, root, base: [] },
  );
  const target = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <RouterProvider router={router} />, target);
  try {
    await shell.connect();
    flush();
    await router.navigate({ href: "/p/fixture" });
    await waitFor(() => expect(getByRole(target, "alert").textContent).toContain(message));
    expect(imported).not.toHaveBeenCalled();
  } finally {
    dispose();
    shell.dispose();
    imported.mockRestore();
  }
});
