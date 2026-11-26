import { waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { expect, test, vi } from "vitest";
import { createPluginLoader, type PluginAssets, type PluginModuleHost } from "../../../runtime/js/plugins";
import { ExtensionProvider } from "../../client";
import { Composer, Labels } from "./fixtures/parts/owner/src/client/api";
import { find } from "./fixtures/parts/owner/src/client/_generated/components";
import {
  attachmentWarnings,
  changed,
  duplicate,
  filteredWarnings,
  loadActions,
  manifest,
  moved,
  noComposer,
  noUploadLabel,
  warnings,
} from "virtual:built-component-addon";

test("an owner rename skips an installed attachment and raises one alert", async () => {
  const track = manifest.plugin.contributes["component-action"].find(({ id }) => id === "Track")!;
  expect(track).toMatchObject({ action: "attach", name: "Composer", target: "owner.Composer" });
  const lifecycle = vi.fn();
  const alerts = vi.fn();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const [generation, setGeneration] = createSignal(0);
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider
        host={{
          contributions: () => [{ id: track.id, plugin: "addon", kind: "component-action", options: track }],
          version: (id) => (id === "owner" ? generation() : 0),
          partOwner: async () => ({ find: generation() ? noComposer.find : find }),
          load: loadActions,
          onError: () => () => {},
        }}
        onAlerts={alerts}
      >
        <Composer label="Send" lifecycle={lifecycle} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(lifecycle).toHaveBeenCalledWith("attached"));
    setGeneration(1);
    flush();
    const missing = /Plugin "addon": find\("Composer"\) matches no render functions/;
    await waitFor(() => expect(alerts).toHaveBeenCalledExactlyOnceWith([expect.stringMatching(missing)]));
    expect(warn.mock.calls.filter(([message]) => missing.test(message))).toHaveLength(1);
    expect(attachmentWarnings).toMatch(missing);
    expect(lifecycle).toHaveBeenCalledWith("detached");
    expect(lifecycle.mock.calls.filter(([event]) => event === "attached")).toHaveLength(1);
  } finally {
    dispose();
    warn.mockRestore();
  }
});

test.each([
  {
    title: "a built add-on renders after a plain JSX element with the owner's props",
    Screen: Composer,
    matches: true,
  },
  {
    title: "a rebuilt owner moves a named target without rebuilding the add-on",
    Screen: moved.Composer,
    findOwner: moved.find,
    matches: true,
  },
  {
    title: "removing a static filter attribute skips the addition and raises one alert",
    Screen: noUploadLabel.Composer,
    findOwner: noUploadLabel.find,
    matches: true,
  },
  {
    title: "a second match in a rebuilt owner leaves an add-on on its original element",
    Screen: duplicate.Composer,
    findOwner: duplicate.find,
    matches: true,
  },
  {
    title: "a rebuilt owner skips a missing name and refuses to repoint an nth match",
    Screen: changed.Composer,
    findOwner: changed.find,
    matches: false,
  },
  {
    title: "a built add-on applies before its owner enters the catalog and is checked when the owner loads",
    Screen: Composer,
    matches: true,
    lateOwner: true,
  },
])("$title", async ({ Screen, findOwner, matches, lateOwner }) => {
  const catalogEntry = structuredClone(manifest);
  // Model a stale catalog that names a missing export without changing the actual bundle.
  const contributions = catalogEntry.plugin.contributes["component-action"];
  contributions.push({ ...contributions.find(({ id }) => id === "Note")!, id: "MissingNote" });
  let ownerLoads = 0;
  let catalogChanged!: Parameters<PluginAssets["onPluginsChanged"]>[0];
  const host: PluginModuleHost = {
    importModule: (name, entry) => {
      if (name === "@plugins/owner/ui") {
        ownerLoads++;
        return Promise.resolve(changed);
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
        host={lateOwner ? loader : { ...loader, partOwner: async () => ({ find: findOwner ?? find }) }}
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
    expect(root.querySelector('[aria-label="detail"]')).not.toBeNull();
    expect(root.querySelector('select[aria-label="Upload"] + small')?.textContent).toBe(
      Screen === noUploadLabel.Composer ? undefined : "Upload for Send",
    );
    if (Screen === moved.Composer) {
      expect(root.querySelector('aside select[aria-label="Upload"] + small')?.textContent).toBe(
        "Upload for Send",
      );
      expect(root.querySelector('[data-part="send-slot"] button + small')?.textContent).toBe(
        "Built for Send",
      );
    }
    if (Screen === noUploadLabel.Composer) {
      expect(root.querySelector("select + small")).toBeNull();
      const missingAttribute =
        /Plugin "addon": find\("select", \{ aria: \{ "label": "Upload" \} \}\) matches no elements/;
      expect(alerts).toHaveBeenCalledExactlyOnceWith([expect.stringMatching(missingAttribute)]);
      expect(filteredWarnings).toMatch(missingAttribute);
    }
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
      const missing = expect.stringMatching(
        /addon.*find\("SendButton"\).*matches no elements.*candidates: none/,
      );
      const shifted = expect.stringMatching(
        /addon.*find\("div".*nth.*different element.*candidates: Composer › section › div/,
      );
      expect(alerts).toHaveBeenLastCalledWith([missing, shifted]);
      expect(
        warn.mock.calls.filter(([message]) => /matches no elements|different element/.test(message)),
      ).toHaveLength(2);
    }
    if (!matches) {
      expect(warnings).toMatch(/Plugin "addon".*find\("SendButton"\).*matches no elements/);
      expect(warnings).toMatch(/Plugin "addon".*find\("div".*different element/);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/addon.*MissingNote.*manifest/));
  } finally {
    dispose();
    loader.dispose();
    warn.mockRestore();
  }
});
