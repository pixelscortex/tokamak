import { expect, test, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { waitFor } from "@testing-library/dom";
import { after, append, before, ExtensionProvider, hide, prepend, replace, wrap } from "../../client";
import { BenchmarkRow, Composer, Labels } from "./fixtures/parts/owner/src/client/api";
import { parts } from "./fixtures/parts/owner/src/client/_generated/components";

import { host, layer, type Layer } from "./fixtures/parts/extension-host";

test("a plugin can add live UI before another plugin's button", async () => {
  const [visible, setVisible] = createSignal(false);
  const target = parts.Composer.section.SendButton;
  const Cost = before(target, (props) => <small>Cost of {props.label}</small>, { when: visible });
  const root = document.createElement("div");
  const lifecycle: string[] = [];
  const dispose = render(
    () => (
      <ExtensionProvider host={host([layer("Cost", Cost, "before", target)])}>
        <Composer label="Send" lifecycle={(event) => lifecycle.push(event)} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    expect(root.textContent).toBe("Send");
    setVisible(true);
    await waitFor(() => expect(root.textContent).toBe("Cost of SendSend"));
    setVisible(false);
    flush();
    expect(root.textContent).toBe("Send");
    expect(lifecycle).toEqual(["send mounted"]);
  } finally {
    dispose();
  }
});

test("two plugins compose around and inside elements, and hiding or replacing unloads the original", async () => {
  const [replacing, setReplacing] = createSignal(false);
  const [hiding, setHiding] = createSignal(false);
  const [wrapping, setWrapping] = createSignal(true);
  const [label, setLabel] = createSignal("Send");
  const button = parts.Composer.section.SendButton;
  const toolbar = parts.Composer.section;
  const layers = [
    layer(
      "Before",
      before(button, () => <i>before</i>),
      "before",
      button,
    ),
    layer(
      "After",
      after(button, () => <i>after</i>),
      "after",
      button,
    ),
    layer(
      "Last",
      append(toolbar, () => <em>last</em>),
      "append",
      toolbar,
    ),
    layer(
      "Second",
      prepend(toolbar, () => <em>second</em>),
      "prepend",
      toolbar,
    ),
    layer(
      "First",
      prepend(toolbar, () => <em>first</em>),
      "prepend",
      toolbar,
      -1,
    ),
    layer(
      "Tooltip",
      wrap(button, (props) => <aside aria-label={props.label}>{props.children}</aside>, { when: wrapping }),
      "wrap",
      button,
    ),
    layer(
      "Replace",
      replace(button, (props) => <b>new {props.label}</b>, { when: replacing }),
      "replace",
      button,
    ),
    layer("Hide", hide(button, { when: hiding }), "hide", button),
  ];
  const root = document.createElement("div");
  const lifecycle: string[] = [];
  const dispose = render(
    () => (
      <ExtensionProvider host={host(layers)}>
        <Composer label={label()} lifecycle={(event) => lifecycle.push(event)} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() =>
      expect(root.querySelector("section")?.textContent).toBe("firstsecondbeforeSendafterlast"),
    );
    expect(root.querySelector("aside > button")?.textContent).toBe("Send");
    setLabel("Post");
    flush();
    expect(root.querySelector("aside")?.getAttribute("aria-label")).toBe("Post");
    expect(root.querySelector("button")?.textContent).toBe("Post");

    lifecycle.length = 0;
    setReplacing(true);
    flush();
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("aside > b")?.textContent).toBe("new Post");
    expect(lifecycle).toEqual(["send unloaded"]);

    setReplacing(false);
    flush();
    expect(root.querySelector("aside > button")?.textContent).toBe("Post");
    expect(lifecycle).toEqual(["send unloaded", "send mounted"]);
    const original = root.querySelector("button");
    lifecycle.length = 0;
    setWrapping(false);
    flush();
    expect(root.querySelector("aside")).toBeNull();
    expect(root.querySelector("section > button")).toBe(original);
    setWrapping(true);
    flush();
    expect(root.querySelector("aside > button")).toBe(original);
    expect(lifecycle).toEqual([]);

    setHiding(true);
    flush();
    expect(root.querySelector("section")?.textContent).toBe("firstsecondlast");
    expect(lifecycle).toEqual(["send unloaded"]);

    setHiding(false);
    flush();
    expect(root.querySelector("aside > button")?.textContent).toBe("Post");
    expect(lifecycle).toEqual(["send unloaded", "send mounted"]);
  } finally {
    dispose();
  }
});

test("a later replacement is refused even while the first installed replacement is inactive", async () => {
  const [active, setActive] = createSignal(false);
  const target = parts.Composer.section.SendButton;
  const layers = [
    layer(
      "Second",
      replace(target, () => <b>second</b>),
      "replace",
      target,
      -100,
      "a-later",
      2,
    ),
    layer(
      "First",
      replace(target, () => <b>first</b>, { when: active }),
      "replace",
      target,
      0,
      "z-first",
      1,
    ),
  ];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const alerts = vi.fn();
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider host={host(layers)} onAlerts={alerts}>
        <Composer label="Send" lifecycle={() => {}} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    expect(root.textContent).toBe("Send");
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/a-later.*refused.*z-first.*installed first/)),
    );
    expect(alerts).toHaveBeenCalledWith([
      expect.stringMatching(/a-later.*refused.*z-first.*installed first/),
    ]);
    setActive(true);
    await waitFor(() => expect(root.textContent).toBe("first"));
    setActive(false);
    flush();
    expect(root.textContent).toBe("Send");
  } finally {
    dispose();
    warn.mockRestore();
  }
});

test("render props, forwarded and explicit children, and void elements keep their behavior", async () => {
  const list = parts.Labels.section.span;
  const search = parts.Labels.section.input;
  const body = parts.Labels.section.Region.span;
  const button = parts.Labels.section.button;
  const layers = [
    layer(
      "Result",
      append(list, () => <em>!</em>),
      "append",
      list,
    ),
    layer(
      "Label",
      before(search, () => <b>Filter</b>),
      "before",
      search,
    ),
    layer(
      "Body",
      append(body, () => "!"),
      "append",
      body,
    ),
    layer(
      "Forwarded",
      append(button, () => "?"),
      "append",
      button,
    ),
  ];
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider host={host(layers)}>
        <Labels labels={["one", "two"]} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(root.textContent).toBe("1: one!2: two!FilterBody!Forwarded?"));
    expect(root.querySelector("b + input")?.getAttribute("aria-label")).toBe("Search");
  } finally {
    dispose();
  }
});

test("each action's `when` reads the props of the instance it would change", async () => {
  const button = parts.Composer.section.SendButton;
  const toolbar = parts.Composer.section;
  // Only the composer labelled "Post" is changed; the "Send" one stays as it was.
  const onPost = (props: { label: string }) => props.label === "Post";
  const cases: [Layer[], string][] = [
    [
      [
        layer(
          "Before",
          before(button, (p) => <i>b-{p.label}</i>, { when: onPost }),
          "before",
          button,
        ),
        layer(
          "After",
          after(button, (p) => <i>a-{p.label}</i>, { when: onPost }),
          "after",
          button,
        ),
        layer(
          "First",
          prepend(toolbar, () => <em>p</em>, { when: onPost }),
          "prepend",
          toolbar,
        ),
        layer(
          "Last",
          append(toolbar, () => <em>q</em>, { when: onPost }),
          "append",
          toolbar,
        ),
      ],
      "pb-PostPosta-Postq",
    ],
    [
      [
        layer(
          "Wrap",
          wrap(button, (p) => <aside>[{p.children}]</aside>, { when: onPost }),
          "wrap",
          button,
        ),
      ],
      "[Post]",
    ],
    [
      [
        layer(
          "Replace",
          replace(button, (p) => <b>new {p.label}</b>, { when: onPost }),
          "replace",
          button,
        ),
      ],
      "new Post",
    ],
    [[layer("Hide", hide(button, { when: onPost }), "hide", button)], ""],
  ];
  for (const [layers, changed] of cases) {
    const root = document.createElement("div");
    const dispose = render(
      () => (
        <ExtensionProvider host={host(layers)}>
          <Composer label="Send" lifecycle={() => {}} />
          <Composer label="Post" lifecycle={() => {}} />
        </ExtensionProvider>
      ),
      root,
    );
    try {
      await waitFor(() =>
        expect(Array.from(root.querySelectorAll("section"), (s) => s.textContent)).toEqual(["Send", changed]),
      );
    } finally {
      dispose();
    }
  }
});

test("a cloned native subtree supports live placements and restores its original nodes", async () => {
  const [layers, setLayers] = createSignal<Layer[]>([]);
  const [hidden, setHidden] = createSignal(false);
  const [replaced, setReplaced] = createSignal(false);
  const header = parts.BenchmarkRow.article.header;
  const bold = header.b;
  const additions = [
    layer(
      "Before",
      before(header, () => <i>before</i>),
      "before",
      header,
    ),
    layer(
      "After",
      after(header, () => <i>after</i>),
      "after",
      header,
    ),
    layer(
      "Prepend",
      prepend(header, () => <i>prepend</i>),
      "prepend",
      header,
    ),
    layer(
      "Append",
      append(header, () => <i>append</i>),
      "append",
      header,
    ),
    layer(
      "Wrap",
      wrap(header, (p) => <aside>{p.children}</aside>),
      "wrap",
      header,
    ),
    layer(
      "Replace",
      replace(header, () => <strong>replacement</strong>, { when: replaced }),
      "replace",
      header,
    ),
    layer("Hide", hide(header, { when: hidden }), "hide", header),
    layer(
      "Nested",
      after(bold, () => <i>nested</i>),
      "after",
      bold,
    ),
  ];
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider
        host={{
          ...host([]),
          contributions: (kind) => host(layers()).contributions(kind),
          load: (id) => host(layers()).load(id),
        }}
      >
        <BenchmarkRow text="message" />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    const original = root.querySelector("header");
    expect(root.textContent).toBe("Person10:00messageSent");
    setLayers(additions);
    await waitFor(() =>
      expect(root.textContent).toBe("beforeprependPersonnested10:00appendaftermessageSent"),
    );
    expect(root.querySelector("aside > header")).toBe(original);
    setHidden(true);
    flush();
    expect(root.textContent).toBe("messageSent");
    setHidden(false);
    setReplaced(true);
    flush();
    expect(root.textContent).toBe("beforereplacementaftermessageSent");
    setReplaced(false);
    flush();
    expect(root.textContent).toBe("beforeprependPersonnested10:00appendaftermessageSent");
    setLayers([]);
    flush();
    expect(root.textContent).toBe("Person10:00messageSent");
    expect(root.querySelector("header")).toBe(original);
  } finally {
    dispose();
  }
});
