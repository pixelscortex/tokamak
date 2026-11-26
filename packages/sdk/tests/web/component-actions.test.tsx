import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { render, type JSX } from "@solidjs/web";
import { waitFor } from "@testing-library/dom";
import {
  after,
  append,
  before,
  ExtensionProvider,
  hide,
  prepend,
  layer,
  type ComponentPart,
} from "../../client";
import { BenchmarkRow, Composer, Labels, RealisticRow } from "./fixtures/parts/owner/src/client/api";
import { find } from "./fixtures/parts/owner/src/client/_generated/components";

import { host, layer as contribution, type Layer } from "./fixtures/parts/extension-host";

test("a plugin can add live UI before another plugin's button", async () => {
  const [visible, setVisible] = createSignal(false);
  const target = find("SendButton");
  const Cost = before(target, (props) => <small>Cost of {props.label}</small>, { when: visible });
  const root = document.createElement("div");
  const lifecycle: string[] = [];
  const dispose = render(
    () => (
      <ExtensionProvider host={host([contribution("Cost", Cost, "before", target)])}>
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
  const button = find("SendButton");
  const toolbar = find("section", { in: "Composer" });
  const layers = [
    contribution(
      "Before",
      before(button, () => <i>before</i>),
      "before",
      button,
    ),
    contribution(
      "After",
      after(button, () => <i>after</i>),
      "after",
      button,
    ),
    contribution(
      "Last",
      append(toolbar, () => <em>last</em>),
      "append",
      toolbar,
    ),
    contribution(
      "Second",
      prepend(toolbar, () => <em>second</em>),
      "prepend",
      toolbar,
    ),
    contribution(
      "First",
      prepend(toolbar, () => <em>first</em>),
      "prepend",
      toolbar,
      -1,
    ),
    contribution(
      "Tooltip",
      layer(
        button,
        (props, Original) => (
          <aside aria-label={props.label}>
            <Original />
          </aside>
        ),
        { when: wrapping },
      ),
      "layer",
      button,
      -1,
    ),
    contribution(
      "Replace",
      layer(button, (props) => <b>new {props.label}</b>, { when: replacing }),
      "layer",
      button,
    ),
    contribution("Hide", hide(button, { when: hiding }), "hide", button),
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
    expect(root.querySelector("section")?.textContent).toBe("firstsecondbeforenew Postafterlast");
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

test("layers pass through independently and the first installed layer is outermost", async () => {
  const [first, setFirst] = createSignal(false);
  const [second, setSecond] = createSignal(false);
  const target = find("SendButton");
  const layers = [
    contribution(
      "Second",
      layer(target, () => <b>second</b>, { when: second }),
      "layer",
      target,
      -100,
      "a-later",
      2,
    ),
    contribution(
      "First",
      layer(target, () => <b>first</b>, { when: first }),
      "layer",
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
    setSecond(true);
    await waitFor(() => expect(root.textContent).toBe("second"));
    setFirst(true);
    flush();
    expect(root.textContent).toBe("first");
    setSecond(false);
    flush();
    expect(root.textContent).toBe("first");
    setFirst(false);
    flush();
    expect(root.textContent).toBe("Send");
    expect(alerts).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/refused/));
  } finally {
    dispose();
    warn.mockRestore();
  }
});

test("render props, forwarded and explicit children, and void elements keep their behavior", async () => {
  const list = find("span", { in: "Labels", nth: 1 });
  const search = find("input");
  const body = find("span", { in: "Region" });
  const button = find("button", { in: "Labels" });
  const layers = [
    contribution(
      "Result",
      append(list, () => <em>!</em>),
      "append",
      list,
    ),
    contribution(
      "Label",
      before(search, () => <b>Filter</b>),
      "before",
      search,
    ),
    contribution(
      "Body",
      append(body, () => "!"),
      "append",
      body,
    ),
    contribution(
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
    await waitFor(() =>
      expect(root.textContent).toBe("1: one!2: two!" + "0:0:ONE1:0:TWOFilterBody!Forwarded?"),
    );
    expect(root.querySelector("b + input")?.getAttribute("aria-label")).toBe("Search");
  } finally {
    dispose();
  }
});

test("each action's `when` reads the props of the instance it would change", async () => {
  const button = find("SendButton");
  const toolbar = find("section", { in: "Composer" });
  // Only the composer labelled "Post" is changed; the "Send" one stays as it was.
  const onPost = (props: { label: string }) => props.label === "Post";
  const cases: [Layer[], string][] = [
    [
      [
        contribution(
          "Before",
          before(button, (p) => <i>b-{p.label}</i>, { when: onPost }),
          "before",
          button,
        ),
        contribution(
          "After",
          after(button, (p) => <i>a-{p.label}</i>, { when: onPost }),
          "after",
          button,
        ),
        contribution(
          "First",
          prepend(toolbar, () => <em>p</em>, { when: onPost }),
          "prepend",
          toolbar,
        ),
        contribution(
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
        contribution(
          "Wrap",
          layer(
            button,
            (_p, Original) => (
              <aside>
                [<Original />]
              </aside>
            ),
            { when: onPost },
          ),
          "layer",
          button,
        ),
      ],
      "[Post]",
    ],
    [
      [
        contribution(
          "Replace",
          layer(button, (p) => <b>new {p.label}</b>, { when: onPost }),
          "layer",
          button,
        ),
      ],
      "new Post",
    ],
    [[contribution("Hide", hide(button, { when: onPost }), "hide", button)], ""],
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
  const header = find("header", { in: "BenchmarkRow" });
  const bold = find("b", { in: "BenchmarkRow" });
  const additions = [
    contribution(
      "Before",
      before(header, () => <i>before</i>),
      "before",
      header,
    ),
    contribution(
      "After",
      after(header, () => <i>after</i>),
      "after",
      header,
    ),
    contribution(
      "Prepend",
      prepend(header, () => <i>prepend</i>),
      "prepend",
      header,
    ),
    contribution(
      "Append",
      append(header, () => <i>append</i>),
      "append",
      header,
    ),
    contribution(
      "Wrap",
      layer(header, (_p, Original) => (
        <aside>
          <Original />
        </aside>
      )),
      "layer",
      header,
    ),
    contribution(
      "Replace",
      layer(header, () => <strong>replacement</strong>, { when: replaced }),
      "layer",
      header,
    ),
    contribution("Hide", hide(header, { when: hidden }), "hide", header),
    contribution(
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

test("a child component is a hole in the native template and unloads when its containing part hides", async () => {
  const [hidden, setHidden] = createSignal(false);
  const unloaded = vi.fn();
  const header = find("header", { in: "RealisticRow" });
  const person = find("b", { in: "RealisticRow" });
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider
        host={host([
          contribution(
            "Label",
            after(person, () => <i>Added</i>),
            "after",
            person,
          ),
          contribution("Hide", hide(header, { when: hidden }), "hide", header),
        ])}
      >
        <RealisticRow text="test" unloaded={unloaded} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(root.querySelector("b + i")?.textContent).toBe("Added"));
    const headerNode = root.querySelector("header");
    expect(root.querySelector("header small")?.textContent).toBe("Ready");
    setHidden(true);
    flush();
    expect(root.querySelector("header")).toBeNull();
    expect(unloaded).toHaveBeenCalledTimes(1);
    setHidden(false);
    flush();
    expect(root.querySelector("header")).toBe(headerNode);
    expect(root.querySelector("b + i")?.textContent).toBe("Added");
    expect(root.querySelector("header small")?.textContent).toBe("Ready");
  } finally {
    dispose();
  }
});

test("a native layer changes contents without changing the element, and can project the owner's contents", async () => {
  const [project, setProject] = createSignal(false);
  const [styled, setStyled] = createSignal(true);
  const [label, setLabel] = createSignal("Send");
  const toolbar = find("section", { in: "Composer" });
  const root = document.createElement("div");
  const lifecycle = vi.fn();
  const body = find("div", { in: "Composer", nth: 1 });
  const [showSibling, setShowSibling] = createSignal(true);
  const actions = [
    contribution(
      "BodySibling",
      after(body, () => <i>included</i>, { when: showSibling }),
      "after",
      body,
      0,
      "companion",
    ),
    contribution(
      "Lead",
      prepend(toolbar, () => <em>lead</em>),
      "prepend",
      toolbar,
      0,
      "companion",
    ),
    contribution(
      "Tail",
      append(toolbar, () => <em>tail</em>),
      "append",
      toolbar,
      0,
      "companion",
    ),
    contribution(
      "Content",
      layer(
        toolbar,
        (_, Original) => (
          <Original>
            <b>new</b>
            {project() && (
              <div data-projection>
                <Original.Children />
              </div>
            )}
          </Original>
        ),
        { when: styled },
      ),
      "layer",
      toolbar,
    ),
  ];
  onTestFinished(
    render(
      () => (
        <ExtensionProvider host={host(actions)}>
          <Composer label={label()} lifecycle={lifecycle} />
        </ExtensionProvider>
      ),
      root,
    ),
  );
  await waitFor(() => expect(root.textContent).toBe("new"));
  const owner = root.querySelector("section");
  expect(owner?.getAttribute("aria-label")).toBe("toolbar");

  setProject(true);
  flush();
  expect(root.querySelector("[data-projection]")?.textContent).toBe("leadSendincludedtail");
  expect(root.querySelector("section")).toBe(owner);
  setShowSibling(false);
  flush();
  setLabel("Post");
  flush();
  expect(root.textContent).toBe("newleadPosttail");

  setProject(false);
  flush();
  expect(root.textContent).toBe("new");
  expect(root.querySelector("section")).toBe(owner);

  setStyled(false);
  flush();
  expect(root.textContent).toBe("leadPosttail");
  expect(root.querySelector("section")).toBe(owner);
});

test("a layer works in list rows and on a void element", async () => {
  const list = find("span", { in: "Labels", nth: 1 });
  const search = find("input");
  const forwarded = find("button", { in: "Labels" });
  const region = find("Region");
  const actions = [
    contribution(
      "Row",
      layer(list, (props, Original) => (
        <Original>
          Row {props.$row.index() + 1}: <Original.Children />
        </Original>
      )),
      "layer",
      list,
    ),
    contribution(
      "Search",
      layer(search, (_, Original) => (
        <label>
          Filter
          <Original />
        </label>
      )),
      "layer",
      search,
    ),
    contribution(
      "Forwarded",
      layer(forwarded, (_, Original) => (
        <Original>
          [<Original.Children />]
        </Original>
      )),
      "layer",
      forwarded,
    ),
    contribution(
      "Explicit",
      layer(region, (_, Original) => (
        <Original>
          New <Original.Children />
        </Original>
      )),
      "layer",
      region,
    ),
  ];
  const root = document.createElement("div");
  onTestFinished(
    render(
      () => (
        <ExtensionProvider host={host(actions)}>
          <Labels labels={["one", "two"]} />
        </ExtensionProvider>
      ),
      root,
    ),
  );
  await waitFor(() => expect(root.querySelector("label > input")?.getAttribute("aria-label")).toBe("Search"));
  expect(root.textContent).toContain("Row 1: 1: oneRow 2: 2: two");
  expect(root.querySelector("input")?.childNodes).toHaveLength(0);
  expect(root.querySelector("button")?.textContent).toBe("[Forwarded]");
  expect(root.querySelector("main")?.textContent).toBe("New Body");
});

test("a duplicate Original draws nothing and warns once across instances", async () => {
  const target = find("SendButton");
  const root = document.createElement("div");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  const actions = [
    contribution(
      "Duplicate",
      layer(target, (_, Original) => (
        <aside>
          <Original />
          <Original />
        </aside>
      )),
      "layer",
      target,
      0,
      "duplicate",
    ),
  ];
  onTestFinished(
    render(
      () => (
        <ExtensionProvider host={host(actions)}>
          <Composer label="Send" lifecycle={vi.fn()} />
          <Composer label="Post" lifecycle={vi.fn()} />
        </ExtensionProvider>
      ),
      root,
    ),
  );
  await waitFor(() => expect(root.querySelectorAll("aside")).toHaveLength(2));
  expect([...root.querySelectorAll("aside")].map((node) => node.textContent)).toEqual(["Send", "Post"]);
  expect(
    warn.mock.calls.flat().filter((message) => /duplicate\/Duplicate.*Original twice/.test(message)),
  ).toHaveLength(1);
});

test("a throwing layer passes through to the next layer and warns once", async () => {
  const target = find("SendButton");
  const [broken, setBroken] = createSignal(false);
  const root = document.createElement("div");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  const actions = [
    contribution(
      "Broken",
      layer(target, (_, Original) => {
        if (broken()) throw new Error("broken layer");
        return (
          <aside>
            <Original />
          </aside>
        );
      }),
      "layer",
      target,
      -1,
      "broken",
    ),
    contribution(
      "Lower",
      layer(target, (_, Original) => (
        <strong>
          <Original />
        </strong>
      )),
      "layer",
      target,
    ),
  ];
  onTestFinished(
    render(
      () => (
        <ExtensionProvider host={host(actions)}>
          <Composer label="Send" lifecycle={vi.fn()} />
          <Composer label="Post" lifecycle={vi.fn()} />
        </ExtensionProvider>
      ),
      root,
    ),
  );
  await waitFor(() => expect(root.querySelectorAll("aside > strong > button")).toHaveLength(2));
  const button = root.querySelector("button");
  setBroken(true);
  flush();
  expect(root.querySelector("aside")).toBeNull();
  expect(root.querySelector("strong > button")).toBe(button);
  expect(
    warn.mock.calls.flat().filter((message) => /broken\/Broken.*broken layer/.test(message)),
  ).toHaveLength(1);
});

test("an error in children supplied by a layer falls back to the original", async () => {
  const [broken, setBroken] = createSignal(false);
  const target = find("Region");
  const root = document.createElement("div");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  function Custom() {
    if (broken()) throw new Error("broken projection");
    return "custom";
  }
  const actions = [
    contribution(
      "Custom",
      layer(target, (_, Original) => <Original>{broken() ? <Custom /> : "custom"}</Original>),
      "layer",
      target,
      0,
      "projector",
    ),
  ];
  onTestFinished(
    render(
      () => (
        <ExtensionProvider host={host(actions)}>
          <Labels labels={[]} />
        </ExtensionProvider>
      ),
      root,
    ),
  );
  await waitFor(() => expect(root.querySelector("main")?.textContent).toBe("custom"));
  setBroken(true);
  flush();
  expect(root.querySelector("main")?.textContent).toBe("Body");
  expect(
    warn.mock.calls.flat().filter((message) => /projector\/Custom.*broken projection/.test(message)),
  ).toHaveLength(1);
});

test("a native text binding stays out of an override and resumes with the latest value", async () => {
  const [text, setText] = createSignal("original");
  const [changed, setChanged] = createSignal(true);
  const [project, setProject] = createSignal(false);
  const target = find("p", { in: "BenchmarkRow" });
  const root = document.createElement("div");
  const actions = [
    contribution(
      "Text",
      layer(
        target,
        (_, Original) => (
          <Original>
            <mark>custom{project() && <Original.Children />}</mark>
          </Original>
        ),
        { when: changed },
      ),
      "layer",
      target,
    ),
  ];
  onTestFinished(
    render(
      () => (
        <ExtensionProvider host={host(actions)}>
          <BenchmarkRow text={text()} />
        </ExtensionProvider>
      ),
      root,
    ),
  );
  await waitFor(() => expect(root.querySelector("p")?.textContent).toBe("custom"));
  const node = root.querySelector("p");
  setText("live");
  flush();
  expect(node?.textContent).toBe("custom");
  setProject(true);
  flush();
  expect(node?.textContent).toBe("customlive");
  setText("live again");
  flush();
  expect(node?.textContent).toBe("customlive again");
  setChanged(false);
  flush();
  expect(root.querySelector("p")).toBe(node);
  expect(node?.textContent).toBe("live again");
});

function restoresPlacement<Props extends object>({
  parent,
  child,
  selector,
  sibling,
  screen,
}: {
  parent: ComponentPart<string, Props>;
  child: ComponentPart<string, Props>;
  selector: string;
  sibling: string;
  screen: () => JSX.Element;
}) {
  test(`restores descendant placements after overriding ${selector}`, async () => {
    const [on, setOn] = createSignal(false);
    const root = document.createElement("div");
    onTestFinished(
      render(
        () => (
          <ExtensionProvider
            host={host([
              contribution(
                "Added",
                after(child, () => <i>Added</i>),
                "after",
                child,
                0,
                "companion",
              ),
              contribution(
                "Content",
                layer(parent, (_, Original) => <Original>custom</Original>, { when: on }),
                "layer",
                parent,
              ),
            ])}
          >
            {screen()}
          </ExtensionProvider>
        ),
        root,
      ),
    );
    await waitFor(() => expect(root.querySelector(sibling)?.textContent).toBe("Added"));
    const element = root.querySelector(selector);
    setOn(true);
    flush();
    expect(element?.textContent).toBe("custom");
    setOn(false);
    flush();
    expect(root.querySelector(selector)).toBe(element);
    expect(root.querySelector(sibling)?.textContent).toBe("Added");
  });
}

restoresPlacement({
  parent: find("header", { in: "RealisticRow" }),
  child: find("b", { in: "RealisticRow" }),
  selector: "header",
  sibling: "b + i",
  screen: () => <RealisticRow text="test" />,
});
restoresPlacement({
  parent: find("section", { in: "Composer" }),
  child: find("div", { in: "Composer", nth: 1 }),
  selector: "section",
  sibling: '[aria-label="body"] + i',
  screen: () => <Composer label="Send" lifecycle={vi.fn()} />,
});

function testsForOriginalChildren<Props extends object>({
  path,
  target,
  screen,
  selector,
  owner,
}: {
  path: string;
  target: ComponentPart<string, Props>;
  screen: () => JSX.Element;
  selector: string;
  owner: string;
}) {
  describe(`Original.Children on a ${path} element`, () => {
    function mount(actions: Layer[]) {
      const root = document.createElement("div");
      onTestFinished(
        render(() => <ExtensionProvider host={host(actions)}>{screen()}</ExtensionProvider>, root),
      );
      return root;
    }

    test("projects the children passed by the previous layer", async () => {
      const Outer = layer(target, (_, Original) => <Original>X</Original>);
      const Inner = layer(target, (_, Original) => (
        <Original>
          Y<Original.Children />
        </Original>
      ));
      const root = mount([
        contribution("Outer", Outer, "layer", target, 0, "outer", 1),
        contribution("Inner", Inner, "layer", target, 0, "inner", 2),
      ]);
      await waitFor(() => expect(root.querySelector(selector)?.textContent).toBe("YX"));
    });

    test("draws nothing outside Original", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warn.mockRestore());
      const Outside = layer(target, (_, Original) => (
        <aside>
          <Original.Children />
          <Original />
        </aside>
      ));
      const root = mount([contribution("Outside", Outside, "layer", target)]);
      await waitFor(() => expect(root.querySelector("aside")?.textContent).toBe(owner));
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes("Original.Children")),
      ).toHaveLength(1);
    });

    test("draws the contents only once, with both inside placements", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      onTestFinished(() => warn.mockRestore());
      const Twice = layer(target, (_, Original) => (
        <Original>
          <Original.Children />
          <Original.Children />
        </Original>
      ));
      const root = mount([
        contribution(
          "Lead",
          prepend(target, () => "lead/"),
          "prepend",
          target,
        ),
        contribution(
          "Tail",
          append(target, () => "/tail"),
          "append",
          target,
        ),
        contribution("Twice", Twice, "layer", target),
      ]);
      await waitFor(() => expect(root.querySelector(selector)?.textContent).toBe(`lead/${owner}/tail`));
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes("Original.Children")),
      ).toHaveLength(1);
    });
  });
}

testsForOriginalChildren({
  path: "native",
  target: find("header", { in: "RealisticRow" }),
  screen: () => <RealisticRow text="test" />,
  selector: "header",
  owner: "Person10:00Ready",
});
testsForOriginalChildren({
  path: "component",
  target: find("Region"),
  screen: () => <Labels labels={[]} />,
  selector: "main",
  owner: "Body",
});

test("reloading a plugin allows its layer warnings to be reported again", async () => {
  const target = find("SendButton");
  const [version, setVersion] = createSignal(0);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  const Broken = layer(target, () => {
    throw new Error("again");
  });
  const root = document.createElement("div");
  onTestFinished(
    render(
      () => (
        <ExtensionProvider
          host={{
            ...host([contribution("Broken", Broken, "layer", target, 0, "reloaded")]),
            version: (id) => (id === "reloaded" ? version() : 0),
          }}
        >
          <Composer label="Send" lifecycle={vi.fn()} />
        </ExtensionProvider>
      ),
      root,
    ),
  );
  const warnings = () => warn.mock.calls.filter(([message]) => /reloaded\/Broken.*again/.test(message));
  await waitFor(() => expect(warnings()).toHaveLength(1));
  setVersion(1);
  flush();
  await waitFor(() => expect(warnings()).toHaveLength(2));
  expect(root.textContent).toBe("Send");
});
