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
  import { after, append, attach, before, hide, prepend, layer } from "@tokamak/sdk/client";
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
      export const Frame = layer(owner.find("Price", { nth: 1 }), (_, Original) => <aside><Original /></aside>);
      export const Substitute = layer(owner.find("Price", { nth: 1 }), () => "Replaced");
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
      "layer",
      "layer",
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

test("attach searches render functions, including nested names, separately from elements", async () => {
  await scratch(async (root) => {
    built(
      await source(
        root,
        "owner",
        screen +
          `
      export function Left() {
        const Item = ({ left }: { left: string }) => <div>{left}</div>;
        return <Item left="left" />;
      }
      export function Right() {
        const Item = (props: { right: number }) => <div>{props.right}</div>;
        return <Item right={2} />;
      }
    `,
      ),
    );
    const addon = await source(
      root,
      "addon",
      imports +
        `
      const target = owner.find("Price", { nth: 1 });
      export const Placed = after(target, ({ amount }) => amount.toFixed());
      export const Attached = attach(target, ({ currency }) => currency?.toLowerCase());
      export const Left = attach(owner.find("Item", { in: "Left" }), ({ left }) => left.toUpperCase());
      export const Right = attach(owner.find("Item", { nth: 2 }), ({ right }) => right.toFixed(), {
        when: ({ right }) => right > 0, order: 2,
      });
    `,
    );
    built(addon);
    expect((await manifest(addon)).plugin.contributes["component-action"]).toMatchObject([
      { id: "Placed", action: "after", target: "owner.Picker.section.Price" },
      { id: "Attached", action: "attach", name: "Price", nth: 1, target: "owner.Price" },
      { id: "Left", action: "attach", name: "Item", in: "Left", target: "owner.Left.Item" },
      { id: "Right", action: "attach", name: "Item", nth: 2, order: 2, target: "owner.Right.Item" },
    ]);
    const entry = resolve(addon, "src/main.tsx");
    const wrong = [
      ['attach(owner.find("strong"), () => null)', "attach requires a render function"],
      ['after(owner.find("Header"), () => null)', "after requires an element"],
      ['attach(owner.find("Item"), () => null)', "matches several render functions"],
    ];
    for (const [call, reason] of wrong) {
      await writeFile(entry, imports + `export const Bad = ${call};`);
      const result = build(addon);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(reason);
      if (call.includes('"Item"')) expect(result.stderr).toContain("Left › Item, Right › Item");
    }
    await writeFile(
      entry,
      imports +
        `
      // @ts-expect-error: an element is not a render function
      ${wrong[0][0]};
      // @ts-expect-error: a render function is not an element
      ${wrong[1][0]};
      // @ts-expect-error: a render function does not have the element's props
      attach(owner.find("Price"), ({ row }) => row);
      // @ts-expect-error: scope is checked against render function candidates
      attach(owner.find("Item", { in: "Missing" }), () => null);
    `,
    );
    const program = ts.createProgram(
      [entry],
      pluginCompilerOptions(addon, {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        jsxImportSource: "@solidjs/web",
      }),
    );
    expect(program.getSemanticDiagnostics(program.getSourceFile(entry))).toEqual([]);
  });
}, 30_000);

test("find filters by static type, href, role and ARIA before counting positions", async () => {
  await scratch(async (root) => {
    const owner = await source(
      root,
      "owner",
      `
      const computed = () => "email";
      const Menu = () => <nav />;
      export const Header = (props: { title: string }) =>
        <section><button aria-label="Start" /><button aria-label="Stop" aria-live="polite" /></section>;
      export const Footer = (props: { count: number }) =>
        <section><button aria-label="Save" /><button aria-label="Stop" aria-live="off" /></section>;
      export const Other = () => <div role="row" />;
      export const Panel = (props: { title: string }) => (
        <main>
          <input type="text" /><input type="file" /><input type={computed()} />
          <a href="/home" /><a href="/settings" />
          <div role="row" /><div role="status" /><div role="row" />
          <span data-part="named" role="note" /><span id="identified" /><Menu />
        </main>
      );
    `,
    );
    built(owner);
    const addon = await source(
      root,
      "addon",
      imports +
        `
      export const File = after(owner.find("input", { type: "file" }), ({ title }) => title);
      export const SameFile = after(owner.find("input", { type: "file", nth: 1 }), () => null);
      export const Link = after(owner.find("a", { href: "/settings" }), () => null);
      export const Status = after(owner.find("div", { role: "status" }), () => null);
      export const SecondRow = after(owner.find("div", { in: "Panel", role: "row", nth: 2 }), () => null);
      export const Stop = after(owner.find("button", { aria: { label: "Stop", live: "polite" } }), ({ title }) => title);
      export const LastStop = after(owner.find("button", { aria: { label: "Stop" }, nth: 2 }), ({ count }) => count);
      export const Named = after(owner.find("named", { role: "note" }), () => null);
      export const Identified = after(owner.find("identified"), () => null);
      export const Component = after(owner.find("Menu"), () => null);
    `,
    );
    const first = build(addon);
    expect(first.status, first.stderr).toBe(0);
    const placements = (await manifest(addon)).plugin.contributes["component-action"];
    expect(placements.map(({ target }) => target)).toEqual([
      "owner.Panel.main.input$2",
      "owner.Panel.main.input$2",
      "owner.Panel.main.a$2",
      "owner.Panel.main.div$2",
      "owner.Panel.main.div$3",
      "owner.Header.section.button$2",
      "owner.Footer.section.button$2",
      "owner.Panel.main.named",
      "owner.Panel.main.identified",
      "owner.Panel.main.Menu",
    ]);
    expect(placements[4]).toMatchObject({ name: "div", in: "Panel", role: "row", nth: 2 });
    expect(placements[5]).toMatchObject({ name: "button", "aria-label": "Stop", "aria-live": "polite" });

    built(
      await source(
        root,
        "second",
        imports + 'export const File = after(owner.find("input", { type: "file" }), () => null);',
      ),
    );
    const rebuilt = build(owner);
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    for (const log of [first.stderr, rebuilt.stderr]) {
      expect(
        log.match(/Plugin "addon":.*targets unnamed element owner\.Panel\.main\.input\$2;/g),
      ).toHaveLength(1);
      expect(log).toContain(
        'find("input", { type: "file" }) targets unnamed element owner.Panel.main.input$2; add data-part',
      );
      expect(log).not.toMatch(/targets unnamed element.*(?:named|identified|Menu);/);
    }
    expect(rebuilt.stderr.match(/Plugin "second":.*targets unnamed element/g)).toHaveLength(1);

    const entry = resolve(addon, "src/main.tsx");
    await writeFile(
      entry,
      imports +
        `
      // @ts-expect-error: absent value for an available key
      owner.find("input", { type: "email" });
      // @ts-expect-error: href exists on a different name
      owner.find("input", { type: "file", href: "/settings" });
      // @ts-expect-error: unknown filter even when a valid filter is present
      owner.find("input", { type: "file", class: "file" });
      // @ts-expect-error: only ARIA keys authored on button are allowed
      owner.find("button", { aria: { label: "Stop", hidden: "true" } });
      // @ts-expect-error: only ARIA values authored on button are allowed
      owner.find("button", { aria: { live: "assertive" } });
      // @ts-expect-error: a component with no attributes offers no aria filter
      owner.find("Menu", { aria: {} });
    `,
    );
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
      program.getSemanticDiagnostics(program.getSourceFile(entry)).map(({ messageText }) => messageText),
    ).toEqual([]);

    await writeFile(
      entry,
      imports + 'export const Bad = after(owner.find("input", { type: "email" }), () => null);',
    );
    const failure = build(addon);
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain('find("input", { type: "email" }) matches no elements; candidates:');
    expect(failure.stderr).toContain('input [type="text"]');
    expect(failure.stderr).toContain('input [type="file"]');
    expect(failure.stderr).toContain("input [type={…} (a filter cannot match a computed value)]");

    await writeFile(
      entry,
      imports + 'const type = "file"; export const Bad = after(owner.find("input", { type }), () => null);',
    );
    const nonliteral = build(addon);
    expect(nonliteral.status).not.toBe(0);
    expect(nonliteral.stderr).toContain("Use a literal screen element name");
  });
}, 30_000);

test("a filter matches a quoted literal in braces, and never a value a later spread can replace", async () => {
  await scratch(async (root) => {
    const owner = await source(
      root,
      "owner",
      `
      export const Form = (props: { rest: object }) => (
        <form><input type={"file"} /><input type="text" {...props.rest} /><input type="text" /></form>
      );
    `,
    );
    built(owner);
    const addon = await source(
      root,
      "addon",
      imports +
        'export const File = after(owner.find("input", { type: "file" }), () => null);' +
        'export const Text = after(owner.find("input", { type: "text" }), () => null);',
    );
    built(addon);
    const targets = (await manifest(addon)).plugin.contributes["component-action"].map(
      (entry) => entry.target,
    );
    expect(targets).toEqual(["owner.Form.form.input", "owner.Form.form.input$3"]);
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
        <section><div data-part-ignore data-part="ignored"><span data-part="secret" /></div><div data-part-ignore=""><span data-part="hidden" /></div><p id="visible" /><p id="$2" /></section>
      );
    `,
    );
    built(owner);
    const types = await readFile(resolve(owner, "src/_generated/components.d.ts"), "utf8");
    const bundle = await readFile(resolve(owner, "dist/ui.js"), "utf8");
    expect(types).toMatch(/["]?visible["]?:/);
    expect(types).not.toMatch(/ignored|secret|hidden|declare const parts/);
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

test("two layers of the same resolved element are published", async () => {
  await scratch(async (root) => {
    built(await source(root, "owner", screen));
    const addon = await source(
      root,
      "addon",
      imports +
        `
      export const First = layer(owner.find("title", { in: "Header" }), () => "first");
      export const Second = layer(owner.find("title", { nth: 1 }), () => "second");`,
    );
    built(addon);
    const placements = (await manifest(addon)).plugin.contributes["component-action"];
    expect(placements.map(({ id, action, target }) => [id, action, target])).toEqual([
      ["First", "layer", "owner.Header.header.title"],
      ["Second", "layer", "owner.Header.header.title"],
    ]);
  });
}, 30_000);

test("a layer can supply children to Original but cannot set attributes", async () => {
  await scratch(async (root) => {
    built(await source(root, "owner", screen));
    const addon = await source(
      root,
      "addon",
      imports +
        `export const Bad = layer(owner.find("strong"), (_, Original) =>
        <Original class="custom">new</Original>);`,
    );
    const failure = build(addon);
    expect(failure.status, failure.stderr).not.toBe(0);
    expect(failure.stderr).toMatch(/Type 'string' is not assignable to type 'never'/);
  });
}, 30_000);

test("a search by a unique name follows the element when the owner edits or moves things around it", async () => {
  await scratch(async (root) => {
    const original = `
      export function Message() {
        return <section><div><p data-part="x">a</p></div><div><p data-part="y">b</p></div></section>;
      }
    `;
    const owner = await source(root, "owner", original);
    built(owner);
    const addon = build(
      await source(root, "addon", imports + 'export const Inside = append(owner.find("y"), () => "y");'),
    );
    expect(addon.status, addon.stderr).toBe(0);
    // A name needs no position, so the add-on is not asked to get one from the owner.
    expect(addon.stderr).not.toContain("ambiguous positional target");

    const entry = resolve(owner, "src/main.tsx");
    const edits = [
      original.replace(">b<", ">b changed<"),
      original.replace('<p data-part="y">b</p>', '<span><p data-part="y">b</p></span>'),
      original.replace("<section><div>", "<section><div /><div>"),
    ];
    for (const edit of edits) {
      await writeFile(entry, edit);
      const edited = build(owner);
      expect(edited.status, edited.stderr).toBe(0);
      expect(edited.stderr).not.toContain('Plugin "addon"');
    }
  });
}, 30_000);

test("a search by position stays on its element, and is skipped when another element takes the position", async () => {
  await scratch(async (root) => {
    const original = `
      export const B = () => <header><h2 data-part="title">B</h2></header>;
      export const C = () => <section><footer><h2 data-part="title">C</h2></footer></section>;
    `;
    const owner = await source(root, "owner", original);
    built(owner);
    built(
      await source(
        root,
        "addon",
        imports + 'export const Note = after(owner.find("title", { nth: 2 }), () => "n");',
      ),
    );

    const entry = resolve(owner, "src/main.tsx");
    // A new sibling makes the footer positional; the title is still the second match at the same place.
    await writeFile(entry, original.replace("</footer>", "</footer><footer />"));
    const kept = build(owner);
    expect(kept.status, kept.stderr).toBe(0);
    expect(kept.stderr).not.toContain('Plugin "addon"');

    // An earlier match pushes another element into second place.
    await writeFile(entry, `export const A = () => <h2 data-part="title">A</h2>;` + original);
    const shifted = build(owner);
    expect(shifted.status, shifted.stderr).toBe(0);
    expect(shifted.stderr).toContain('Plugin "addon": find("title", { nth: 2 }) targets a different element');
  });
}, 30_000);

test("siblings that only a position tells apart ask for a name, and an edit inside one is not a move", async () => {
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
    const first = build(addon);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain("ambiguous positional target; ask the owner for a data-part or id");
    expect((await manifest(addon)).plugin.contributes["component-action"][0]).toMatchObject({
      target: "owner.Panel.section.2",
      fingerprint: expect.any(String),
    });
    await writeFile(resolve(owner, "src/main.tsx"), original.replace("First", "First, edited"));
    const edited = build(owner);
    expect(edited.status, edited.stderr).toBe(0);
    expect(edited.stderr).not.toContain('Plugin "addon"');
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

test("a renamed Original parameter and its Children are private to the layer", async () => {
  await scratch(async (root) => {
    built(await source(root, "owner", screen));
    const addon = await source(
      root,
      "addon",
      imports +
        `
        export const Frame = layer(owner.find("title", { in: "Header" }), (_, Keep) => (
          <Keep><i data-part="badge">New</i><Keep.Children /></Keep>
        ));
      `,
    );
    built(addon);
    const types = await readFile(resolve(addon, "src/_generated/components.d.ts"), "utf8");
    expect(types).toContain('"badge"');
    expect(types).not.toMatch(/"Keep(?:[^"]*)"/);
    const ui = await readFile(resolve(addon, "dist/ui.js"), "utf8");
    expect(ui).not.toContain('"Keep');
  });
}, 30_000);
