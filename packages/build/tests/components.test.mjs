import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { pluginCompilerOptions } from "../../sdk/tools/plugin-compiler.mjs";
import { build, built, source, workspace } from "./plugin-fixtures.mjs";

async function scratch(run) {
  const parent = resolve(workspace, "packages/build/dist");
  await mkdir(parent, { recursive: true });
  await run(await mkdtemp(resolve(parent, "components-")));
}

const screen = `
  interface PriceProps { amount: number; currency?: string }
  const Price = (props: PriceProps) => <strong>{props.amount}</strong>;
  export const Picker = (props: { amount: number }) =>
    <section><Price amount={props.amount} /><Price amount={0} /><aside><span /></aside></section>;
  export const Header = (props: { heading: string }) =>
    <header><h2 data-part="title">{props.heading}</h2></header>;
  export const ThreadRow = (props: { row: number }) =>
    <article><span><h3 id="title">{props.row}</h3></span></article>;
`;
const manifest = async (path) => JSON.parse(await readFile(resolve(path, "dist/manifest.json"), "utf8"));
const imports = `
  import { after, append, before, hide, prepend, replace, wrap } from "@tokamak/sdk/client";
  import * as owner from "plugin:owner/client";
`;

test("find resolves the placements and stores the literal search with the found element", async () => {
  await scratch(async (root) => {
    built(await source(root, "owner", screen));
    const addon = await source(
      root,
      "addon",
      imports +
        `
      import { find as findPart } from "plugin:owner/client";
      export const Before = before(owner.find("Price", { nth: 1 }), ({ amount }) => amount.toFixed(2));
      const title = findPart("title", { in: "Header" } as const);
      export const After = after(title, ({ heading }) => heading.toUpperCase());
      export const Prepend = prepend(owner.find("strong"), ({ amount }) => amount.toFixed(2));
      export const Append = append(owner.find("title", { nth: 2 }), ({ row }) => row.toFixed(0));
      export const Wrap = wrap(owner.find("Price", { nth: 1 }), ({ children }) => <aside>{children}</aside>);
      export const Replace = replace(owner.find("Price", { nth: 1 }), () => "Replaced");
      export const Hide = hide(owner.find("Price", { nth: 2 }));
    `,
    );
    built(addon);
    const placements = (await manifest(addon)).plugin.contributes["component-action"];
    expect(placements.map(({ action }) => action)).toEqual([
      "before",
      "after",
      "prepend",
      "append",
      "wrap",
      "replace",
      "hide",
    ]);
    expect(placements).toContainEqual({
      id: "After",
      action: "after",
      name: "title",
      owner: "owner",
      in: "Header",
      target: "owner.Header.header.title",
    });
    expect(placements).toContainEqual({
      id: "Append",
      action: "append",
      name: "title",
      owner: "owner",
      nth: 2,
      target: "owner.ThreadRow.article.span.title",
    });
    expect(placements[0]).toMatchObject({ name: "Price", nth: 1, fingerprint: expect.any(String) });
  });
}, 30_000);

test("wrong names fail both TypeScript and the builder; ambiguous and dynamic searches fail the builder", async () => {
  await scratch(async (root) => {
    built(await source(root, "owner", screen));
    const addon = await source(
      root,
      "addon",
      imports + 'export const Bad = after(owner.find("missing"), () => null);',
    );
    const failure = build(addon);
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain('find("missing") matches no elements; candidates: none');

    const entry = resolve(addon, "src/main.tsx");
    const program = ts.createProgram(
      [entry],
      pluginCompilerOptions(addon, {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        jsxImportSource: "@solidjs/web",
      }),
    );
    expect(
      program
        .getSemanticDiagnostics(program.getSourceFile(entry))
        .some(
          ({ code, messageText }) =>
            code === 2345 && ts.flattenDiagnosticMessageText(messageText, " ").includes('"missing"'),
        ),
    ).toBe(true);

    await writeFile(entry, imports + 'export const Bad = after(owner.find("title"), () => null);');
    const ambiguous = build(addon);
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain("Header › header › title, ThreadRow › article › span › title");
    expect(ambiguous.stderr).toContain("Narrow the search with in or nth");

    await writeFile(entry, imports + 'const name = "title"; export const Bad = () => owner.find(name);');
    const dynamic = build(addon);
    expect(dynamic.status).not.toBe(0);
    expect(dynamic.stderr).toContain("Use a literal screen element name");
  });
}, 30_000);

test("ignored subtrees stay as JSX and cannot be found", async () => {
  await scratch(async (root) => {
    const owner = await source(
      root,
      "owner",
      `
      export const Panel = () => (
        <section><div data-part-ignore data-part="ignored"><span data-part="secret" /></div><p id="visible" /><p id="$2" /></section>
      );
    `,
    );
    built(owner);
    const types = await readFile(resolve(owner, "src/_generated/components.d.ts"), "utf8");
    const bundle = await readFile(resolve(owner, "dist/ui.js"), "utf8");
    expect(types).toMatch(/["]?visible["]?:/);
    expect(types).not.toMatch(/ignored|secret|declare const parts/);
    expect(bundle).toContain("data-part");
    expect(bundle).not.toMatch(/Panel\.section\.ignored|export\s*\{[^}]*\bas parts\b/);
    const addon = await source(
      root,
      "addon",
      imports + 'export const Note = after(owner.find("$2"), () => null);',
    );
    built(addon);
    await writeFile(
      resolve(addon, "src/main.tsx"),
      imports + 'export const Bad = after(owner.find("secret"), () => null);',
    );
    const failure = build(addon);
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain('find("secret") matches no elements');
  });
}, 30_000);

test("two replacements of the same resolved element fail the build", async () => {
  await scratch(async (root) => {
    built(await source(root, "owner", screen));
    const addon = await source(
      root,
      "addon",
      imports +
        `
      export const First = replace(owner.find("title", { in: "Header" }), () => "first");
      export const Second = replace(owner.find("title", { nth: 1 }), () => "second");`,
    );
    const failure = build(addon);
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain("First and Second both replace owner.Header.header.title");
  });
}, 30_000);

test("a named part inherits position protection without mistaking ordinary edits for a move", async () => {
  await scratch(async (root) => {
    const original = `
      export function Message() {
        return <section><nav role="a"><p data-part="x"/></nav><nav role="b"><p data-part="y"/></nav></section>;
      }
    `;
    const owner = await source(root, "owner", original);
    built(owner);
    built(await source(root, "addon", imports + 'export const Inside = append(owner.find("y"), () => "y");'));

    const entry = resolve(owner, "src/main.tsx");
    await writeFile(entry, original.replace('<nav role="b">', '<nav role="b" title="b" aria-busy={false}>'));
    const edited = build(owner);
    expect(edited.status, edited.stderr).toBe(0);
    expect(edited.stderr).not.toContain('Plugin "addon"');

    await writeFile(entry, original.replace('<nav role="b">', '<nav role="c"/><nav role="b">'));
    const shifted = build(owner);
    expect(shifted.status, shifted.stderr).toBe(0);
    expect(shifted.stderr).toContain('Plugin "addon": find("y") targets a different element');
  });
}, 30_000);

test("same-named siblings preserve source order and detect a reorder even without identifying attributes", async () => {
  await scratch(async (root) => {
    const original =
      'export const Panel = () => <section><p data-part="2">First</p><p data-part="2">Second</p></section>;';
    const owner = await source(root, "owner", original);
    built(owner);
    const addon = await source(
      root,
      "addon",
      imports + 'export const Note = after(owner.find("2", { nth: 1 }), () => "note");',
    );
    built(addon);
    expect((await manifest(addon)).plugin.contributes["component-action"][0]).toMatchObject({
      target: "owner.Panel.section.2",
      fingerprint: expect.any(String),
    });
    await writeFile(
      resolve(owner, "src/main.tsx"),
      original.replace("First", "TEMP").replace("Second", "First").replace("TEMP", "Second"),
    );
    const shifted = build(owner);
    expect(shifted.status, shifted.stderr).toBe(0);
    expect(shifted.stderr).toContain('Plugin "addon": find("2", { nth: 1 }) targets a different element');
  });
}, 30_000);

test("duplicate top-level render names report both files", async () => {
  await scratch(async (root) => {
    const owner = await source(
      root,
      "owner",
      `
      export { Message as Helper } from "./a-helpers";
      export function Message() { return <article/>; }
    `,
    );
    await writeFile(resolve(owner, "src/a-helpers.tsx"), "export function Message() { return <div/>; }");
    const result = build(owner);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/main\.tsx.*Duplicate screen segment "Message".*a-helpers\.tsx/);
  });
}, 30_000);

test("an Index callback exposes its accessor item and numeric index", async () => {
  await scratch(async (root) => {
    const owner = await source(
      root,
      "owner",
      `
      import { Index } from "solid-js";
      export const Labels = (props: { labels: string[] }) =>
        <Index each={props.labels}>{(label: () => string) => <span>{label()}</span>}</Index>;
    `,
    );
    built(owner);
    built(
      await source(
        root,
        "addon",
        imports +
          `
      export const Note = after(owner.find("span"), ({ $row }) => $row.item().repeat($row.index));
    `,
      ),
    );
  });
}, 30_000);
