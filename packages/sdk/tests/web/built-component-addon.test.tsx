import { waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { expect, test, vi } from "vitest";
import { createPluginLoader, type PluginAssets, type PluginModuleHost } from "../../../runtime/js/plugins";
import { ExtensionProvider } from "../../client";
import { Composer, Labels } from "./fixtures/parts/owner/src/client/api";
import { parts } from "./fixtures/parts/owner/src/client/_generated/components";
import { loadActions, manifest, RenamedComposer, renamedParts } from "virtual:built-component-addon";

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
  {
    title: "a built add-on applies before its owner enters the catalog and is checked when the owner loads",
    Screen: Composer,
    matches: true,
    lateOwner: true,
  },
])("$title", async ({ Screen, matches, lateOwner }) => {
  const catalogEntry = structuredClone(manifest);
  // Model a stale catalog that names a missing export without changing the actual bundle.
  const contributions = catalogEntry.plugin.contributes["component-action"];
  contributions.push({ ...contributions[0]!, id: "MissingBadge" });
  let ownerLoads = 0;
  let catalogChanged!: Parameters<PluginAssets["onPluginsChanged"]>[0];
  const host: PluginModuleHost = {
    importModule: (name, entry) => {
      if (name === "@plugins/owner/ui") {
        ownerLoads++;
        return Promise.resolve({ parts: renamedParts });
      }
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
    onPluginsChanged(listener) {
      catalogChanged = listener;
      return () => {};
    },
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const alerts = vi.fn();
  const root = document.createElement("div");
  await loader.connect();
  const dispose = render(
    () => (
      <ExtensionProvider
        host={
          lateOwner
            ? loader
            : { ...loader, partOwner: async () => ({ parts: matches ? parts : renamedParts }) }
        }
        onAlerts={alerts}
      >
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
    expect([...root.querySelectorAll("em + small")].map((row) => row.textContent)).toEqual([
      "Group 1: work / 0: WORK",
      "Group 2: quick / 0: QUICK",
    ]);
    if (lateOwner) {
      expect(ownerLoads).toBe(0);
      expect(alerts).not.toHaveBeenCalled();
      catalogChanged({
        plugins: ["owner"],
        catalog: {
          revision: "owner-installed",
          plugins: [catalogEntry, { ...catalogEntry, plugin: { id: "owner", version: "1.0.0" } }],
        },
      });
      await waitFor(() => {
        expect(ownerLoads).toBe(1);
        expect(root.querySelector("button + small")).toBeNull();
        expect(root.querySelector("section + p")?.textContent).toBe("Notes for Send");
      });
    }
    if (!matches || lateOwner) {
      const missing = expect.stringMatching(/addon.*missing screen part owner.Composer.section.SendButton/);
      const shifted = expect.stringMatching(/addon.*different element.*owner.Composer.section.div/);
      expect(alerts).toHaveBeenLastCalledWith(expect.arrayContaining([missing, shifted]));
      expect(
        warn.mock.calls.filter(([message]) => /missing screen part|different element/.test(message)),
      ).toHaveLength(2);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/addon.*MissingBadge.*manifest/));
  } finally {
    dispose();
    loader.dispose();
    warn.mockRestore();
  }
});
