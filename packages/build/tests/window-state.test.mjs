import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, source } from "./plugin-fixtures.mjs";

for (const side of ["server", "local"]) {
  test(`the plugin build rejects window state in ${side} code`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "tokamak-state-"));
    try {
      const plugin = await source(scratch, "notes", "export function Screen() { return <p>Notes</p>; }");
      await mkdir(join(plugin, "src", side));
      await writeFile(
        join(plugin, "src", side, "draft.ts"),
        'import { state as makeDraft } from "@tokamak/sdk/client"; export const draft = makeDraft("");',
      );
      const result = build(plugin);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Window state is only available in the window");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

test("the plugin build refuses to publish state through a public alias", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "tokamak-state-private-"));
  try {
    const plugin = await source(
      scratch,
      "notes",
      `import { state } from "@tokamak/sdk/client";
       const draft = state("");
       export { draft as publicDraft };`,
    );
    const result = build(plugin);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Window state is private: do not export publicDraft");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
