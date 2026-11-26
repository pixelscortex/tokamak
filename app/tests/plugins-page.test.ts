import { expect, test } from "vitest";
import { readInstalled } from "../src/shell/plugins";

// The shape GET /plugins sends (packages/server/src/plugins/catalog.rs), trimmed to what the page reads.
test("loaded plugins come first in catalog order, then every skipped folder with its reason", () => {
  const installed = readInstalled({
    revision: "r1",
    pluginsFolder: "/data/plugins",
    plugins: [
      { plugin: { id: "notes", version: "1.2.0", name: "Notes" }, folder: "/data/plugins/notes" },
      { plugin: { id: "board", version: "0.1.0" }, folder: "/data/plugins/board" },
    ],
    skipped: { zeta: "not built", "broken (duplicate)": "needs chat, which is not installed" },
    skippedFolders: { zeta: "/data/plugins/zeta", "broken (duplicate)": "/data/plugins/broken-2" },
  });
  expect(installed).toEqual({
    folder: "/data/plugins",
    plugins: [
      {
        state: "loaded",
        key: "notes",
        id: "notes",
        name: "Notes",
        version: "1.2.0",
        folder: "/data/plugins/notes",
      },
      {
        state: "loaded",
        key: "board",
        id: "board",
        name: "board",
        version: "0.1.0",
        folder: "/data/plugins/board",
      },
      {
        state: "failed",
        key: "broken (duplicate)",
        reason: "needs chat, which is not installed",
        folder: "/data/plugins/broken-2",
      },
      { state: "failed", key: "zeta", reason: "not built", folder: "/data/plugins/zeta" },
    ],
  });
});

test("a server without the folder fields still gives a list", () => {
  expect(readInstalled({ revision: "r1", plugins: [{ plugin: { id: "old", version: "1.0.0" } }] })).toEqual({
    folder: "",
    plugins: [{ state: "loaded", key: "old", id: "old", name: "old", version: "1.0.0", folder: "" }],
  });
});
