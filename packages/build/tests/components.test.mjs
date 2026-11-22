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

const ownerSource = `import { component } from "@tokamak/sdk/client";
  const SendButton = () => <button>Send</button>;
  const Composer = component("composer", {}, () =>
    <section part="toolbar"><SendButton /><span part="badge" locked /></section>);
  export { Composer };`;
async function owner(root, code = ownerSource) {
  const path = await source(root, "owner", "");
  await mkdir(resolve(path, "src/client"));
  await writeFile(resolve(path, "src/client/api.tsx"), code);
  return path;
}

test("a plugin publishes stable element paths and another plugin builds all seven actions", async () => {
  await scratch(async (root) => {
    const path = await owner(root);
    built(path);
    const types = () => readFile(resolve(path, "src/client/_generated/components.d.ts"), "utf8");
    const first = await types();
    expect(first).toContain('"owner.composer.sendButton"');
    expect(first).toContain('"owner.composer.toolbar"');
    expect(first).toContain('"owner.composer.badge"');
    built(path);
    expect(await types()).toBe(first);

    const addon = await source(
      root,
      "addon",
      `import { after, append, before, hide, prepend, replace, wrap } from "@tokamak/sdk/client";
      import * as owner from "plugin:owner/client";
      export { Composer as Reexported } from "plugin:owner/client";
      const when = () => true;
      export const Cost = before(owner.Composer.sendButton, () => <small>Cost</small>, { when, order: -1 });
      export const Help = after(owner.Composer.sendButton, () => "Help");
      export const Start = prepend(owner.Composer.toolbar, () => "Start");
      export const End = append(owner.Composer.toolbar, () => "End");
      export const Tip = wrap(owner.Composer.sendButton, ({ children }) => <aside>{children}</aside>);
      export const Send = replace(owner.Composer.sendButton, () => <button>Post</button>);
      export const Compact = hide(owner.Composer.toolbar, { when });`,
    );
    built(addon);
    const manifest = JSON.parse(await readFile(resolve(addon, "dist/manifest.json"), "utf8"));
    expect(manifest.plugin.contributes["component-action"]).toEqual([
      { id: "Cost", target: "owner.composer.sendButton", action: "before", order: -1 },
      { id: "Help", target: "owner.composer.sendButton", action: "after" },
      { id: "Start", target: "owner.composer.toolbar", action: "prepend" },
      { id: "End", target: "owner.composer.toolbar", action: "append" },
      { id: "Tip", target: "owner.composer.sendButton", action: "wrap" },
      { id: "Send", target: "owner.composer.sendButton", action: "replace" },
      { id: "Compact", target: "owner.composer.toolbar", action: "hide" },
    ]);
  });
}, 30_000);

test("actions on locked, unknown, or stale paths fail the plugin build", async () => {
  await scratch(async (root) => {
    const path = await owner(root);
    built(path);
    const addon = await source(root, "addon", "");
    const authored = resolve(addon, "src/main.tsx");
    const code = (element) => `import { replace } from "@tokamak/sdk/client";
      import { Composer } from "plugin:owner/client";
      export const Change = replace(Composer.${element}, () => <small>Change</small>);`;
    for (const [element, message] of [
      ["badge", "Cannot change locked element owner.composer.badge"],
      ["missing", "Component element does not exist"],
    ]) {
      await writeFile(authored, code(element));
      const failure = build(addon);
      expect(failure.status).not.toBe(0);
      expect(failure.stderr).toContain(message);
    }
    await writeFile(resolve(path, "src/client/api.tsx"), ownerSource.replace("<SendButton />", ""));
    await writeFile(authored, code("sendButton"));
    const stale = build(addon);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("Component element does not exist");
    const rebuild = build(path);
    expect(rebuild.status).toBe(0);
    expect(rebuild.stderr).toContain(
      "Published component element no longer exists: owner.composer.sendButton",
    );
  });
}, 30_000);

test("an owner must resolve name clashes and one plugin cannot declare two replacements for one path", async () => {
  await scratch(async (root) => {
    const path = await owner(root, ownerSource.replace("<SendButton />", "<SendButton /><SendButton />"));
    const collision = build(path);
    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toContain('Element "sendButton" is named twice');
    await writeFile(
      resolve(path, "src/client/api.tsx"),
      ownerSource.replace("<SendButton />", '<SendButton /><SendButton part="sendAnother" />'),
    );
    built(path);
    const addon = await source(
      root,
      "addon",
      `import { replace } from "@tokamak/sdk/client";
      import { Composer } from "plugin:owner/client";
      export const First = replace(Composer.sendAnother, () => "first");
      export const Second = replace(Composer.sendAnother, () => "second");`,
    );
    const conflict = build(addon);
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("First and Second both replace owner.composer.sendAnother");
  });
}, 30_000);

test("only explicit Solid built-in parts are published, and the owner declaration fixture stays current", async () => {
  await scratch(async (root) => {
    const fixture = resolve(workspace, "packages/sdk/tests/web/fixtures/parts/owner/src/client");
    const authored = await readFile(resolve(fixture, "api.tsx"), "utf8");
    const path = await owner(root, authored);
    built(path);
    const types = () => readFile(resolve(path, "src/client/_generated/components.d.ts"), "utf8");
    const committed = await readFile(resolve(fixture, "_generated/components.d.ts"), "utf8");
    expect(await types()).toBe(committed);

    await writeFile(
      resolve(path, "src/client/api.tsx"),
      `
      import { component } from "@tokamak/sdk/client";
      import { Show as Visible } from "solid-js";
      import * as Solid from "@solidjs/web";
      const Show = () => <small>Plugin component</small>;
      export const Composer = component("composer", {}, () =>
        <section>
          <Visible when={true}>One</Visible>
          <Visible when={true}>Two</Visible>
          <Solid.Show when={true}>Three</Solid.Show>
          <Solid.Show part="fourth" when={true}>Four</Solid.Show>
          <Show />
        </section>);`,
    );
    built(path);
    expect(await types()).not.toContain('"owner.composer.visible"');
    expect(await types()).toContain('"owner.composer.fourth"');
    expect(await types()).toContain('"owner.composer.show"');
  });
}, 30_000);

test("placement callbacks on component tags direct the owner to a native part", async () => {
  await scratch(async (root) => {
    const path = await owner(
      root,
      `
      import { component } from "@tokamak/sdk/client";
      const Panel = (props: { children: (value: any) => string }) => <section />;
      export const Layout = component("layout", {}, () =>
        <Panel>{(added) => added.append}</Panel>);`,
    );
    const failure = build(path);
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain("PartAdditions placement callbacks require a named native element");
  });
}, 30_000);
