import { waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { expect, test, vi } from "vitest";
import { createPluginLoader, type PluginModuleHost } from "../../../runtime/js/plugins";
import { ExtensionProvider } from "../../client";
import { Composer } from "./fixtures/parts/owner/src/client/api";
import { loadActions, manifest, RenamedComposer } from "virtual:built-component-addon";

test.each([
  {
    title: "a built add-on renders after a plain JSX element with the owner's props",
    Screen: Composer,
    matches: true,
  },
  {
    title: "an installed add-on keeps its other placement after a part is renamed",
    Screen: RenamedComposer,
    matches: false,
  },
])("$title", async ({ Screen, matches }) => {
  const catalogEntry = structuredClone(manifest);
  // Model a stale catalog that names a missing export without changing the actual bundle.
  const contributions = catalogEntry.plugin.contributes["component-action"];
  contributions.push({ ...contributions[0]!, id: "MissingBadge" });
  const host: PluginModuleHost = {
    importModule: (name, entry) => {
      expect(name).toBe("@plugins/addon/ui");
      expect(entry.entries.ui?.code).toBe(manifest.entries.ui.code);
      return loadActions();
    },
    affected: (names) => new Set(names),
    remove() {},
    evaluate() {
      throw new Error("Expected the ESM loader");
    },
    dependencies: () => [],
    has: () => false,
    require() {
      throw new Error("Expected the ESM loader");
    },
    setLoader() {},
    notifyError() {},
    onError: () => () => {},
  };
  const loader = createPluginLoader(host, {
    plugins: async () => ({ revision: "built", plugins: [catalogEntry] }),
    pluginAsset: async () => {
      throw new Error("Expected the ESM loader");
    },
    onPluginsChanged: () => () => {},
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = document.createElement("div");
  await loader.connect();
  const dispose = render(
    () => (
      <ExtensionProvider host={loader}>
        <Screen label="Send" lifecycle={() => {}} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(root.querySelector("section + p")?.textContent).toBe("Notes for Send"));
    expect(root.querySelector("button + small")?.textContent).toBe(matches ? "Built for Send" : undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/addon.*MissingBadge.*manifest/));
  } finally {
    dispose();
    loader.dispose();
    warn.mockRestore();
  }
});
