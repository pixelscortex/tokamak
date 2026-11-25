import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, built, source, workspace } from "./plugin-fixtures.mjs";

async function scratch(run) {
  const parent = resolve(workspace, "packages/build/dist");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "components-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const screen = `
  interface PriceProps { amount: number; currency?: string }
  const Price = (props: PriceProps) => <strong>{props.amount}</strong>;
  export const Picker = (props: { amount: number }) =>
    <section><Price amount={props.amount} /><Price amount={0} /><aside><span /></aside></section>;
`;
const manifest = async (path) => JSON.parse(await readFile(resolve(path, "dist/manifest.json"), "utf8"));
const addonSource = `
  import { after } from "@tokamak/sdk/client";
  import * as owner from "plugin:owner/client";
  export const Badge = after(owner.parts.Picker.section.Price, ({ amount }) => <small>{amount.toFixed(2)}</small>);
  export const Note = after(owner.parts.Picker.section.aside, ({ amount }) => <p>{amount}</p>);
`;

test("plain JSX publishes typed paths for every tag and numbers only same-named siblings", async () => {
  await scratch(async (root) => {
    const owner = await source(root, "owner", screen);
    built(owner);
    const types = () => readFile(resolve(owner, "src/_generated/components.d.ts"), "utf8");
    const paths = (text) => [...text.matchAll(/ComponentPart<"(.*?)"/g)].map((m) => m[1]);
    const first = paths(await types());
    expect(first).toEqual([
      "owner.Price.strong",
      "owner.Picker.section",
      "owner.Picker.section.Price",
      "owner.Picker.section.Price$2",
      "owner.Picker.section.aside",
      "owner.Picker.section.aside.span",
    ]);

    await writeFile(
      resolve(owner, "src/main.tsx"),
      screen.replace("<aside><span />", "<aside><i /><span />"),
    );
    built(owner);
    expect(paths(await types())).toEqual([
      ...first.slice(0, -1),
      "owner.Picker.section.aside.i",
      first.at(-1),
    ]);

    const addon = await source(
      root,
      "addon",
      `
      import { after, append, before, hide, prepend, replace, wrap } from "@tokamak/sdk/client";
      import { parts } from "plugin:owner/client";
      export const Before = before(parts.Picker.section.Price, ({ amount }) => amount.toFixed(2));
      export const After = after(parts.Picker.section.Price, ({ amount }) => amount.toFixed(2));
      export const Prepend = prepend(parts.Price.strong, ({ amount }) => amount.toFixed(2));
      export const Append = append(parts.Price.strong, ({ amount }) => amount.toFixed(2));
      export const Wrap = wrap(parts.Picker.section.Price, ({ children }) => <aside>{children}</aside>);
      export const Replace = replace(parts.Picker.section.Price, () => "Replaced");
      export const Hide = hide(parts.Picker.section.Price$2);
    `,
    );
    built(addon);
    expect(
      (await manifest(addon)).plugin.contributes["component-action"].map(({ action }) => action),
    ).toEqual(["before", "after", "prepend", "append", "wrap", "replace", "hide"]);
  });
}, 30_000);

test("a renamed part warns about the installed addon and only its stale action is skipped", async () => {
  await scratch(async (root) => {
    const owner = await source(root, "owner", screen);
    built(owner);
    const addon = await source(root, "addon", addonSource);
    built(addon);

    await writeFile(resolve(owner, "src/main.tsx"), screen.replaceAll("Price", "NewPrice"));
    const rebuiltOwner = build(owner);
    expect(rebuiltOwner.status, rebuiltOwner.stderr).toBe(0);
    expect(rebuiltOwner.stderr).toContain(
      'Plugin "addon" targets missing screen part owner.Picker.section.Price',
    );

    const rebuiltAddon = build(addon);
    expect(rebuiltAddon.status, rebuiltAddon.stderr).toBe(0);
    expect(rebuiltAddon.stderr).toContain(
      'Plugin "addon" targets missing screen part owner.Picker.section.Price',
    );
    expect((await manifest(addon)).plugin.contributes["component-action"]).toEqual([
      expect.objectContaining({ id: "Note", action: "after", target: "owner.Picker.section.aside" }),
    ]);
  });
}, 30_000);

test("two replacements of the same compiler named element fail the build", async () => {
  await scratch(async (root) => {
    const owner = await source(root, "owner", screen);
    built(owner);
    const addon = await source(
      root,
      "addon",
      `
      import { replace } from "@tokamak/sdk/client";
      import { parts } from "plugin:owner/client";
      export const First = replace(parts.Picker.section.Price, () => "first");
      export const Second = replace(parts.Picker.section.Price, () => "second");`,
    );
    const failure = build(addon);
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain("First and Second both replace owner.Picker.section.Price");
  });
}, 30_000);

test("same-tag insertions keep named parts and warn when a positional part changes identity", async () => {
  await scratch(async (root) => {
    const owner = await source(
      root,
      "owner",
      `
      import { Show } from "solid-js";
      export function Message(props: { text: string }) {
        const helper = () => <i>{props.text}</i>;
        const items = [props.text].map(text => <li>{text}</li>);
        return <article><div class="body" aria-label="body"/><div aria-label="detail"/><div data-part="footer" id="bar"/><footer/><div id="123"/><li/><li/>{helper()}{items}</article>;
      }
    `,
    );
    built(owner);
    const addon = await source(
      root,
      "addon",
      `
      import { replace, append } from "@tokamak/sdk/client";
      import { parts } from "plugin:owner/client";
      export const Body = replace(parts.Message.article.div, () => "body");
      export const Footer = append(parts.Message.article.footer, () => "footer");
      export const Title = append(parts.Message.article["123"], () => "title");
      export const Helper = append(parts.Message.helper.i, ({ text }) => text);
      export const Row = append(parts.Message.li, ({ text }) => text);
      export const Ambiguous = append(parts.Message.article.li, () => "row");
      export const Tag = append(parts.Message.article.footer$2, () => "plain footer");
    `,
    );
    const compiled = build(addon);
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(compiled.stderr).toContain(
      "owner.Message.article.li: ambiguous positional target; ask the owner for a data-part or id",
    );

    const entry = resolve(owner, "src/main.tsx");
    const original = await readFile(entry, "utf8");
    await writeFile(
      entry,
      original.replace(
        '<div class="body" aria-label="body"/>',
        '<div aria-label="notice"/><Show when={true}><div class="body" aria-label="body"/></Show>',
      ),
    );
    const result = build(owner);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'Plugin "addon" targets a changed screen part: path owner.Message.article.div now names a different element',
    );
    expect(result.stderr).not.toMatch(/targets .*owner\.Message\.article\.(footer|123)/);
    expect(await readFile(resolve(owner, "src/_generated/components.d.ts"), "utf8")).toContain(
      "owner.Message.article.div$2",
    );
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

test("style and prop expression edits keep composer placements valid", async () => {
  await scratch(async (root) => {
    const composer = `
      const SendButton = (props: { disabled: boolean }) => <button disabled={props.disabled} />;
      export const Composer = (props: { draft: string }) =>
        <div class="flex gap-1"><div data-part="top"/><div data-part="box"><SendButton disabled={!props.draft}/></div></div>;
    `;
    const owner = await source(root, "owner", composer);
    built(owner);
    const addon = await source(
      root,
      "addon",
      `
      import { after, prepend, replace } from "@tokamak/sdk/client";
      import { parts } from "plugin:owner/client";
      export const Agent = after(parts.Composer.div.box, () => "Agent");
      export const Permission = prepend(parts.Composer.div.top, () => "Permission");
      export const Cleanup = prepend(parts.Composer.div.top, () => "Cleanup");
      export const Stop = replace(parts.Composer.div.box.SendButton, () => "Stop");
    `,
    );
    built(addon);
    const actions = (await manifest(addon)).plugin.contributes["component-action"];
    expect(actions).toHaveLength(4);
    expect(actions.every((action) => !("fingerprint" in action))).toBe(true);

    await writeFile(
      resolve(owner, "src/main.tsx"),
      composer.replace("gap-1", "gap-2").replace("!props.draft", "props.draft.length === 0"),
    );
    const rebuilt = build(owner);
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(rebuilt.stderr).not.toContain("skipping this addition");
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
    const types = await readFile(resolve(owner, "src/_generated/components.d.ts"), "utf8");
    expect(types).toContain("owner.Labels.span");
    expect(types).toContain("readonly item: () => string; readonly index: number");
  });
}, 30_000);
