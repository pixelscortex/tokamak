import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";
import { cli } from "./cli-fixture.mjs";

test("builds an external plugin and reports its output folder", async () => {
  await withPlugin((plugin, root) => {
    const result = cli(root, ["plugin", "build", plugin, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      id: "outside-fixture",
      outputFolder: join(plugin, "dist"),
    });
  });
}, 120_000);

test("returns structured type errors in both checker formats", async () => {
  await withPlugin(async (plugin, root) => {
    const file = join(plugin, "src/server/broken.ts");
    await writeFile(file, "type Box<T> = { value: T };\nexport const broken: Box<string> = 42;\n");
    for (const mode of ["plain", "tagged", "agent"]) {
      const env = {
        AI_AGENT: mode === "agent" ? "1" : undefined,
        CLAUDECODE: mode === "tagged" ? "1" : undefined,
        CLAUDE_CODE_ENTRYPOINT: mode === "tagged" ? "cli" : undefined,
      };
      if (mode !== "agent") {
        const raw = Bun.spawnSync([process.execPath, "packages/build/src/build.ts", plugin], {
          cwd: workspace,
          env: { ...process.env, ...env, TOKAMAK_SERVER_DIR: join(root, "data") },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 60_000,
        });
        const log = raw.stdout.toString() + raw.stderr.toString();
        expect(log).toMatch(
          mode === "tagged"
            ? /<error file="broken.ts"[^>]*code="TS2322">/
            : /broken\.ts\(2,\d+\): error TS2322/,
        );
      }
      const result = cli(root, ["plugin", "build", plugin, "--json"], env);
      expect(result.code).not.toBe(0);
      const { error } = JSON.parse(result.stdout);
      expect(error.message).toBe("Plugin build failed");
      expect(error.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file,
            line: 2,
            column: expect.any(Number),
            code: "TS2322",
            message: "Type 'number' is not assignable to type 'Box<string>'.",
          }),
        ]),
      );
    }
  });
}, 120_000);

test.each([
  [
    "missing import",
    "src/server/broken.ts",
    "import { x } from './not-there';\nexport { x };",
    /not-there/,
    1,
  ],
  ["syntax error", "src/server/broken.ts", "export const broken = ;\n", /expected/i, 1],
  ["window type error", "src/client/api.tsx", "export const broken: string = 42;\n", /not assignable/, 1],
  [
    "stylesheet error",
    "src/client/styles.css",
    "@import 'tailwindcss';\n.bad { @apply no-such-utility; }\n",
    /no-such-utility/,
    null,
  ],
])(
  "returns a diagnostic for a %s",
  async (_, relative, contents, message, line) => {
    await withPlugin(async (plugin, root) => {
      const file = join(plugin, relative);
      await writeFile(file, contents);
      const result = cli(root, ["plugin", "build", plugin, "--json"]);
      expect(result.code).not.toBe(0);
      const { error } = JSON.parse(result.stdout);
      expect(error.message).toBe("Plugin build failed");
      const diagnostic = error.diagnostics.find((item) => message.test(item.message));
      expect(diagnostic).toBeDefined();
      if (line) expect(diagnostic).toMatchObject({ file, line, column: expect.any(Number) });
      else if (diagnostic.file) expect(diagnostic).toMatchObject({ file, line: expect.any(Number) });
    });
  },
  120_000,
);

test("build and add reject custom artifact output directories", async () => {
  await withPlugin(async (plugin, root) => {
    await writeFile(join(plugin, "vite.config.ts"), "export default { build: { outDir: 'custom-dist' } };\n");
    for (const command of ["build", "add"]) {
      const result = cli(root, ["plugin", command, plugin, "--json"]);
      expect(result.code).not.toBe(0);
      const { error } = JSON.parse(result.stdout);
      expect([error.message, ...error.diagnostics.map((entry) => entry.message)].join("\n")).toContain(
        "must use",
      );
      expect(error.diagnostics[0].message).toContain(join(plugin, "dist"));
    }
    expect(await Bun.file(join(root, "data", "plugin-index.json")).exists()).toBe(false);
  });
}, 120_000);
