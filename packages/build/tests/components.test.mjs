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
      { id: "Note", action: "after", target: "owner.Picker.section.aside" },
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
