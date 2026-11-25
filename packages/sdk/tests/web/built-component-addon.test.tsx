import { waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { expect, test, vi } from "vitest";
import { createPluginLoader, type PluginModuleHost } from "../../../runtime/js/plugins";
import { ExtensionProvider } from "../../client";
import { Composer, Labels } from "./fixtures/parts/owner/src/client/api";
import { loadActions, manifest, RenamedComposer } from "virtual:built-component-addon";

test.each([
  {
    title: "a built add-on renders after a plain JSX element with the owner's props",
    Screen: Composer,
    matches: true,
  },
  {
    title: "an installed add-on skips renamed and shifted parts while its other placements render",
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
        <Labels labels={["work", "quick"]} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(root.querySelector("section + p")?.textContent).toBe("Notes for Send"));
    expect(root.querySelector("button + small")?.textContent).toBe(matches ? "Built for Send" : undefined);
    expect(root.querySelector('[aria-label="replacement"]') !== null).toBe(matches);
    expect(root.querySelector('[aria-label="body"]') !== null).toBe(!matches);
    expect(root.querySelector('[aria-label="notice"]') !== null).toBe(!matches);
    expect([...root.querySelectorAll("span + small")].map((row) => row.textContent)).toEqual([
      "Profile 1: work of 2",
      "Profile 2: quick of 2",
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/addon.*MissingBadge.*manifest/));
  } finally {
    dispose();
    loader.dispose();
    warn.mockRestore();
  }
});
