import { render } from "@solidjs/web";
import { waitFor } from "@testing-library/dom";
import { createComponent, createSignal, flush, isStatic, untrack } from "solid-js";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  __renderComponentPart,
  __renderPart,
  attrs,
  ExtensionProvider,
  layer,
  type AttributeWarning,
} from "../../client";
import { host, layer as contribution, type Layer } from "./fixtures/parts/extension-host";
import { AttributeScreen } from "./fixtures/parts/attrs-owner/src/client/api";
import { find } from "./fixtures/parts/attrs-owner/src/client/_generated/components";

const article = find("attr-root");
const nested = find("attr-nested");
const button = find("AttrButton");
const input = find("attr-input");
const row = find("attr-row");

function mount(initial: Layer[]) {
  const [loaded, setLoaded] = createSignal(initial);
  const [label, setLabel] = createSignal("owner title");
  const [busy, setBusy] = createSignal(false);
  const [enabled, setEnabled] = createSignal(true);
  const [disabled, setDisabled] = createSignal(false);
  const [labels, setLabels] = createSignal(["row one"]);
  const warnings = vi.fn<(warning: AttributeWarning) => void>();
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = document.createElement("div");
  const mounts = vi.fn();
  const dispose = render(
    () => (
      <ExtensionProvider
        host={{
          ...host([]),
          contributions: (kind) => host(loaded()).contributions(kind),
          load: (id) => host(untrack(loaded)).load(id),
        }}
        onAttributeWarning={warnings}
      >
        <AttributeScreen
          label={label()}
          busy={busy()}
          enabled={enabled()}
          ownerDisabled={disabled()}
          labels={labels()}
          mount={mounts}
        />
      </ExtensionProvider>
    ),
    root,
  );
  onTestFinished(() => {
    dispose();
    consoleWarn.mockRestore();
  });
  return {
    root,
    setLoaded,
    setLabel,
    setBusy,
    setEnabled,
    setDisabled,
    setLabels,
    warnings,
    consoleWarn,
    mounts,
  };
}

test("native overlays stay live on template roots, descendants, a void input and list rows", async () => {
  const first = contribution(
    "Style",
    attrs(
      article,
      (props) => ({
        class: "first",
        title: `plugin: ${props.label}`,
        "aria-busy": props.busy,
      }),
      { when: (props) => props.enabled },
    ),
    "attrs",
    article,
    0,
    "first",
  );
  const second = contribution(
    "Style",
    attrs(article, () => ({ class: "second" })),
    "attrs",
    article,
    0,
    "second",
  );
  const inside = contribution(
    "Nested",
    attrs(nested, () => ({ class: "inside", title: "heading" })),
    "attrs",
    nested,
  );
  const voidInput = contribution(
    "Input",
    attrs(input, (props) => ({ value: `override: ${props.label}` }), {
      when: (props) => props.enabled,
    }),
    "attrs",
    input,
  );
  const list = contribution(
    "Row",
    attrs(row, (props) => ({ title: `${props.$row.index()}: ${props.$row.item}` })),
    "attrs",
    row,
  );
  const { root, setLoaded, setBusy, setLabel, setEnabled, setLabels, warnings } = mount([
    second,
    first,
    inside,
    voidInput,
    list,
  ]);

  const element = root.querySelector("article")!;
  const heading = root.querySelector("header")!;
  const field = root.querySelector("input")!;
  await waitFor(() => {
    expect([...element.classList]).toEqual(["flex", "first", "second"]);
    expect(heading.className).toBe("block inside");
    expect(heading.title).toBe("heading");
    expect(field.value).toBe("override: owner title");
    expect(root.querySelector("em")?.title).toBe("0: row one");
  });
  setLabel("new owner");
  setBusy(true);
  setLabels(["row two", "row one"]);
  flush();
  expect(element.title).toBe("plugin: new owner");
  expect(element.getAttribute("aria-busy")).toBe("true");
  expect([...element.classList]).toEqual(["flex", "hidden", "first", "second"]);
  expect([...heading.classList]).toEqual(["block", "hidden", "inside"]);
  expect(field.value).toBe("override: new owner");
  expect(Array.from(root.querySelectorAll("em"), (node) => node.title)).toEqual(["0: row two", "1: row one"]);

  setEnabled(false);
  flush();
  expect(element.title).toBe("new owner");
  expect(field.value).toBe("new owner");
  expect(element.hasAttribute("aria-busy")).toBe(false);
  expect([...element.classList]).toEqual(["flex", "hidden", "second"]);

  setEnabled(true);
  flush();
  setLoaded([first, voidInput, list]);
  flush();
  expect(element.classList.contains("second")).toBe(false);
  expect(element.classList.contains("first")).toBe(true);
  expect(heading.title).toBe("new owner");
  setLoaded([]);
  flush();
  expect(element.title).toBe("new owner");
  expect(field.value).toBe("new owner");
  expect(root.querySelector("article")).toBe(element);
  expect(root.querySelector("header")).toBe(heading);
  expect(root.querySelector("input")).toBe(field);
  expect(warnings).not.toHaveBeenCalled();
});

test("component props stay live until removal restores the owner on a fresh mount", async () => {
  const [left, setLeft] = createSignal(false);
  const [right, setRight] = createSignal(false);
  const first = contribution(
    "Left",
    attrs(button, (_, current) => ({ disabled: current.disabled || left(), once: true })),
    "attrs",
    button,
    10,
    "z-first",
    1,
  );
  const second = contribution(
    "Right",
    attrs(button, (_, current) => ({ disabled: current.disabled || right() })),
    "attrs",
    button,
    -10,
    "a-second",
    2,
  );
  const { root, setDisabled, setLoaded, warnings, mounts } = mount([second, first]);
  await waitFor(() => expect(root.querySelector("button")?.dataset.once).toBe("true"));
  const send = root.querySelector("button")!;
  expect(send.disabled).toBe(false);
  setLeft(true);
  flush();
  await waitFor(() => expect(send.disabled).toBe(true));
  setRight(true);
  setLeft(false);
  flush();
  expect(send.disabled).toBe(true);
  setRight(false);
  flush();
  expect(send.disabled).toBe(false);
  setDisabled(true);
  flush();
  expect(send.disabled).toBe(true);
  expect(root.querySelector("button")).toBe(send);
  const beforeRemoval = mounts.mock.calls.length;
  setLoaded([]);
  flush();
  const restored = root.querySelector("button")!;
  expect(restored.disabled).toBe(true);
  expect(mounts).toHaveBeenCalledTimes(beforeRemoval + 1);
  setDisabled(false);
  flush();
  expect(root.querySelector("button")).toBe(restored);
  expect(restored.disabled).toBe(false);
  expect(restored.dataset.once).toBe("false");
  expect(restored).not.toBe(send);
  expect(warnings).not.toHaveBeenCalled();
});

test("an untargeted component receives the exact Solid props object without setup warnings", () => {
  const authored = { label: "owner" };
  const draw = vi.fn((props: typeof authored) => {
    expect(isStatic(props, "label")).toBe(true);
    return <button>{props.label}</button>;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const container = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider host={host([])}>
        {
          __renderComponentPart("owner.Screen.Button", null, {}, undefined, (contents) =>
            contents.c(draw, authored),
          ) as ReturnType<typeof draw>
        }
      </ExtensionProvider>
    ),
    container,
  );
  onTestFinished(() => {
    dispose();
    warn.mockRestore();
  });
  expect(draw.mock.calls).toHaveLength(1);
  expect(draw.mock.calls[0]?.[0]).toBe(authored);
  expect(container.textContent).toBe("owner");
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("STRICT_READ_UNTRACKED"));
});

test("an old compiled component skips attrs and Original props but still draws layer children", async () => {
  const OldButton = (props: { children?: string }) => <button>{props.children ?? "owner"}</button>;
  const change = attrs(button, () => ({ label: "plugin", disabled: true }));
  const wrap = layer(button, (_, Original) => <Original disabled>wrapped</Original>);
  const warnings = vi.fn<(warning: AttributeWarning) => void>();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const container = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider
        host={host([
          contribution("Change", change, "attrs", button, 0, "changer"),
          contribution("Wrap", wrap, "layer", button, 0, "wrapper"),
        ])}
        onAttributeWarning={warnings}
      >
        {__renderPart(button.target, null, {}, undefined, () => (
          <button>owner</button>
        ))}
        {__renderPart(button.target, null, {}, undefined, (contents) =>
          createComponent(OldButton, {
            get children() {
              return contents(() => "owner") as string;
            },
          }),
        )}
      </ExtensionProvider>
    ),
    container,
  );
  onTestFinished(() => {
    dispose();
    warn.mockRestore();
  });
  await waitFor(() => expect(container.textContent).toBe("ownerwrapped"));
  expect(container.querySelector("[disabled], [label]")).toBeNull();
  expect(warnings.mock.calls.map(([warning]) => [warning.kind, warning.plugin])).toEqual([
    ["attr-legacy", "changer"],
    ["attr-legacy", "wrapper"],
  ]);
  for (const addon of ["changer", "wrapper"])
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${addon}.*owner plugin "attrs-owner".*must be rebuilt`)),
    );
});

test("native current reads booleans by presence and ignores handler keys", async () => {
  const values = vi.fn(
    (
      _: unknown,
      current: Readonly<{ hidden?: boolean; itemscope?: boolean; inert?: boolean; title?: string }>,
    ) => ({
      className: "alias",
      onclick: "invalid",
      onClick: "invalid",
      "on:customevent": "invalid",
      online: "allowed",
      hidden: current.hidden || false,
      itemscope: current.itemscope || false,
      inert: current.inert || false,
      title: current.title,
    }),
  );
  const { root } = mount([contribution("Native", attrs(nested, values as never), "attrs", nested)]);
  const heading = root.querySelector("header")!;
  await waitFor(() => expect(heading.className).toBe("block alias"));
  const current = values.mock.calls.at(-1)?.[1];
  expect(current?.hidden).toBe(true);
  expect(current?.itemscope).toBe(true);
  expect(current?.inert).toBe(false);
  expect(current?.title).toBe("owner title");
  expect(heading.outerHTML).not.toMatch(/ (?:classname|onclick|on:customevent)=/i);
  expect(heading.getAttribute("online")).toBe("allowed");
  expect(heading.hasAttribute("hidden")).toBe(true);
  expect(heading.hasAttribute("itemscope")).toBe(true);
});

test("an overwrite, invalid computed key and throwing action do not break the owner", async () => {
  const invalid = "data-" + "part";
  function values() {
    return { [invalid]: "different", title: undefined };
  }
  const { root, setLabel, warnings, consoleWarn } = mount([
    contribution(
      "Wins",
      attrs(nested, () => ({ title: "winner" })),
      "attrs",
      nested,
      -10,
      "winner",
      2,
    ),
    contribution(
      "Earlier",
      attrs(nested, () => ({ title: "earlier" })),
      "attrs",
      nested,
      10,
      "earlier",
      1,
    ),
    contribution("Invalid", attrs(nested, values), "attrs", nested, 0, "invalid", 3),
    contribution(
      "Throws",
      attrs(nested, (props) => {
        throw new Error(props.label);
      }),
      "attrs",
      nested,
      0,
      "throws",
      4,
    ),
  ]);
  const heading = root.querySelector("header")!;
  await waitFor(() => expect(heading.title).toBe("winner"));
  expect(heading.getAttribute("data-part")).toBe("attr-nested");
  setLabel("again");
  flush();
  expect(
    warnings.mock.calls
      .flat()
      .map(({ kind }) => kind)
      .sort(),
  ).toEqual(["attr-conflict", "attr-error", "attr-invalid"]);
  expect(warnings).toHaveBeenCalledWith({
    kind: "attr-conflict",
    plugin: "winner",
    otherPlugin: "earlier",
    target: nested.target,
    attribute: "title",
  });
  expect(consoleWarn).toHaveBeenCalledWith(expect.stringMatching(/winner.*title.*earlier.*nested/));
});

test("Original forwards a live prop to the owner's component", async () => {
  const action = layer(button, (props, Original) => <Original disabled={props.busy} />);
  const { root, setBusy } = mount([contribution("Wrap", action, "layer", button)]);
  setBusy(true);
  await waitFor(() => expect(root.querySelector("button")?.disabled).toBe(true));
  const send = root.querySelector("button");
  setBusy(false);
  flush();
  expect(send?.disabled).toBe(false);
  expect(root.querySelector("button")).toBe(send);
});

test("enabling and disabling a layer applies and removes its Original props", async () => {
  const [forward, setForward] = createSignal(false);
  const action = layer(button, (_, Original) => <Original once />, { when: forward });
  const { root } = mount([contribution("Wrap", action, "layer", button)]);
  const plain = root.querySelector("button");
  expect(plain?.dataset.once).toBe("false");
  setForward(true);
  await waitFor(() => expect(root.querySelector("button")?.dataset.once).toBe("true"));
  const decorated = root.querySelector("button");
  expect(decorated).not.toBe(plain);
  setForward(false);
  flush();
  expect(root.querySelector("button")).not.toBe(decorated);
  expect(root.querySelector("button")?.dataset.once).toBe("false");
});

test("Original applies attributes after attrs, and a layer that covers Original drops them", async () => {
  const [cover, setCover] = createSignal<"original" | "cover" | "error">("original");
  const outer = layer(article, (props, Original) => <Original class="opacity-50" title={props.label} />);
  const inner = layer(article, (_, Original) => {
    if (cover() === "error") throw new Error("broken cover");
    return cover() === "cover" ? <b>Covered</b> : <Original />;
  });
  const { root, setLabel, warnings } = mount([
    contribution(
      "Color",
      attrs(article, () => ({ class: "color", title: "underneath" })),
      "attrs",
      article,
      0,
      "color",
    ),
    contribution("Outer", outer, "layer", article, 0, "outer", 1),
    contribution("Cover", inner, "layer", article, 0, "cover", 2),
  ]);
  await waitFor(() => expect(root.querySelector("article")?.className).toBe("flex color opacity-50"));
  expect(root.querySelector("header")?.textContent).toBe("Heading");
  expect(root.querySelector("article")?.title).toBe("owner title");
  setLabel("live title");
  flush();
  expect(root.querySelector("article")?.title).toBe("live title");
  expect(warnings).not.toHaveBeenCalled();

  setCover("error");
  flush();
  expect(root.querySelector("article")?.className).toBe("flex color opacity-50");
  expect(warnings).not.toHaveBeenCalled();

  setCover("cover");
  flush();
  expect(root.querySelector("article")).toBeNull();
  expect(root.querySelector("b")?.textContent).toBe("Covered");
  expect(root.querySelector("b")?.hasAttribute("title")).toBe(false);
  expect(warnings).toHaveBeenCalledExactlyOnceWith({
    kind: "attr-covered",
    plugin: "color",
    otherPlugin: "cover",
    target: article.target,
  });
  setCover("original");
  flush();
  expect(root.querySelector("article")?.className).toBe("flex color opacity-50");
});
