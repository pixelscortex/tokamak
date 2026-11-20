import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from "@tanstack/solid-router";
import { TokamakClient, type ClientTransport, type JsonValue } from "@tokamak/sdk";
import { appVersion } from "../../src/host/compatibility";
import { createPluginShell } from "../../src/plugins/views";

const result = document.getElementById("result")!;
const logs: string[] = [];
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
  logs.push(message);
  result.textContent = logs.join("\n");
}
async function until(test: () => boolean, message: string) {
  const deadline = performance.now() + 5000;
  while (!test()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(true, message);
}
function catalog(revision = "one", dependency = revision): JsonValue {
  return {
    revision: `${revision}-${dependency}`,
    plugins: [
      {
        plugin: {
          id: "fixture",
          version: revision,
          api: `tokamak@${appVersion}`,
          contributes: { view: [{ id: "View", route: "/", title: "Fixture" }] },
        },
        entries: {
          ui: {
            code: `/plugins/fixture/${revision}/assets/ui.js`,
            css: `/plugins/fixture/${revision}/assets/ui.css`,
          },
        },
        hashes: {},
      },
      {
        plugin: { id: "fixture-dependency", version: dependency, api: `tokamak@${appVersion}` },
        entries: { ui: { code: `/plugins/fixture-dependency/${dependency}/assets/ui.js`, css: "" } },
        hashes: {},
      },
    ],
  };
}
async function run() {
  let current = catalog();
  let notify!: (event: { plugins: string[]; catalog: JsonValue }) => void;
  let stopped = 0;
  const client = new TokamakClient({
    subscribe(_name, _args, next) {
      next({ value: "query" });
      return () => {
        stopped++;
      };
    },
    query: async () => null,
    action: async () => null,
    mutation: async () => null,
  } satisfies ClientTransport);
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Host survived</p> });
  const router: AnyRouter = createRouter({
    routeTree: root.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const assetOrigin = new URLSearchParams(location.search).get("assets") ?? location.origin;
  const shell = createPluginShell(
    client,
    { http: assetOrigin, ws: assetOrigin.replace(/^http/, "ws"), token: "fixture-token" },
    {
      plugins: async () => current,
      onPluginsChanged(listener) {
        notify = listener;
        return () => {};
      },
    },
    { router, root, base: [home] },
  );
  const stage = document.getElementById("stage")!;
  const dispose = render(() => <RouterProvider router={router} />, stage);
  try {
    await shell.connect();
    flush();
    const module = await shell.loader.load("fixture");
    assert(module.sharedSignal === createSignal, "PASS shared createSignal identity");
    assert(module.sharedDependencySignal === createSignal, "PASS cross-plugin host identity");
    await until(() => Boolean(router.routesByPath["/p/fixture"]), "PASS route installed");
    await router.navigate({ href: "/p/fixture" });
    await until(
      () => stage.textContent?.includes("query one 0 dependency:one") ?? false,
      "PASS branded view mounts with useQuery",
    );
    const old = stage.querySelector("button")!;
    old.click();
    await until(() => old.textContent?.includes("one 1") ?? false, "PASS plugin signal updates DOM");
    notify({ plugins: [], catalog: { ...(current as object), revision: "metadata-only" } as JsonValue });
    flush();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert(
      stage.querySelector("button") === old && old.textContent?.includes("one 1"),
      "PASS catalog refresh preserves unchanged view owner",
    );
    current = catalog("two");
    notify({ plugins: ["fixture", "fixture-dependency"], catalog: current });
    flush();
    await until(
      () => stage.textContent?.includes("query two 0 dependency:two") ?? false,
      "PASS revision swaps view",
    );
    assert(old.dataset.disposed === "true" && stopped === 1, "PASS old owner and useQuery disposed");
    const second = stage.querySelector("button")!;
    current = catalog("two", "one");
    notify({ plugins: ["fixture-dependency"], catalog: current });
    flush();
    await until(
      () => stage.textContent?.includes("two 0 dependency:one") ?? false,
      "PASS dependency reload invalidates unchanged importer",
    );
    assert(second.dataset.disposed === "true", "PASS importer owner retired");
    assert(
      document.querySelectorAll('link[data-plugin="fixture"]').length === 1,
      "PASS only current generation stylesheet attached",
    );
    const shortcut = new KeyboardEvent("keydown", {
      key: "n",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(shortcut);
    await until(
      () => stage.querySelector("button")?.textContent?.includes("two 1") ?? false,
      "PASS shared shortcut context dispatches",
    );
    assert(
      shortcut.defaultPrevented && stage.querySelector("button")?.dataset.route === "/p/fixture",
      "PASS shared router context and shortcut handling",
    );
    current = catalog("throws");
    notify({ plugins: ["fixture", "fixture-dependency"], catalog: current });
    flush();
    await until(
      () => stage.querySelector('[role="alert"]')?.textContent?.includes("fixture view failed") ?? false,
      "PASS throwing view contained with reload",
    );
    assert(stage.querySelector("button")?.textContent === "Reload", "PASS reload affordance");
    await router.navigate({ to: "/" });
    await until(() => stage.textContent?.includes("Host survived") ?? false, "PASS rest of app survives");
    notify({ plugins: ["fixture", "fixture-dependency"], catalog: { revision: "removed", plugins: [] } });
    flush();
    await until(() => !router.routesByPath["/p/fixture"], "PASS removal retires route");
    assert(!document.querySelector('link[data-plugin="fixture"]'), "PASS removal detaches stylesheet");
    result.dataset.status = "passed";
  } finally {
    dispose();
    shell.dispose();
  }
}
void run().catch((cause) => {
  result.dataset.status = "failed";
  result.textContent = [...logs, `FAIL ${String(cause)}`].join("\n");
});
