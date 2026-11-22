import { waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { expect, test, vi } from "vitest";
import { createPluginLoader, type PluginModuleHost } from "../../../runtime/js/plugins";
import { ExtensionProvider } from "../../client";
import { Composer } from "./fixtures/parts/owner/src/client/_generated/components";
import { loadActions, manifest } from "virtual:built-component-addon";

test("loads built actions through the catalog and warns about a mismatched export", async () => {
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
        <Composer label="Send" lifecycle={() => {}} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(root.querySelector("small + button")?.textContent).toBe("Send"));
    expect(root.querySelector("small")?.textContent).toBe("Built for Send");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/addon.*MissingBadge.*manifest/));
  } finally {
    dispose();
    loader.dispose();
    warn.mockRestore();
  }
});
