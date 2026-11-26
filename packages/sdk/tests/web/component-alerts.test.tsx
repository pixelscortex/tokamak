import { waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { createSignal, flush, untrack } from "solid-js";
import { expect, onTestFinished, test, vi } from "vitest";
import { after, append, attach, attrs, ExtensionProvider, hide, layer } from "../../client";
import { host, layer as contribution, type Layer } from "./fixtures/parts/extension-host";
import { Composer, Labels } from "./fixtures/parts/owner/src/client/api";
import { find } from "./fixtures/parts/owner/src/client/_generated/components";

const button = find("SendButton");
const section = find("section", { in: "Composer" });
const select = find("select");
const composer = find("Composer");
const wrap = layer(button, (_, Original) => <Original />);
const coveredLayer = "focus's layer covers voice's layer on owner Composer › section › SendButton";
const sectionName = "owner Composer › section";
const selectName = sectionName + " › select";

function mount(initial: Layer[], rows?: string[]) {
  const [catalog, setCatalog] = createSignal(initial);
  const [versions, setVersions] = createSignal<Record<string, number>>({});
  const [blocked, block] = createSignal<string>();
  const [label, setLabel] = createSignal("Send");
  const onAlerts = vi.fn<(messages: readonly string[]) => void>();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = document.createElement("div");
  const lifecycle = () => {};
  const dispose = render(
    () => (
      <ExtensionProvider
        host={{
          ...host([]),
          contributions: (kind) => host(catalog()).contributions(kind),
          partOwner: async () => ({ find }),
          version: (id) => versions()[id] ?? 0,
          load: (id) => (id === untrack(blocked) ? Promise.resolve({}) : host(untrack(catalog)).load(id)),
        }}
        onAlerts={onAlerts}
      >
        <Composer label={label()} lifecycle={lifecycle} />
        {rows && <Labels labels={rows} />}
      </ExtensionProvider>
    ),
    root,
  );
  onTestFinished(() => {
    dispose();
    warn.mockRestore();
  });
  function bump(id: string) {
    setVersions((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    flush();
  }
  const reported = () => onAlerts.mock.lastCall?.[0] ?? [];
  const expectAlerts = (...messages: string[]) => waitFor(() => expect(reported()).toEqual(messages.sort()));
  return {
    root,
    onAlerts,
    warn,
    setCatalog,
    setLabel,
    expectAlerts,
    bump,
    reload(id: string) {
      block(id);
      bump(id);
    },
  };
}

test("a cover warns only while a layer omits Original, alongside sorted skipped searches", async () => {
  const [mode, setMode] = createSignal<"pass" | "cover" | "off">("cover");
  const covering = layer(button, (_, Original) => (mode() === "cover" ? <i>Hold</i> : <Original />), {
    when: () => mode() !== "off",
  });
  const stale = contribution(
    "Moved",
    after(select, () => null),
    "after",
    select,
    0,
    "old",
  );
  stale.metadata.options = { ...stale.metadata.options, name: "Missing" };
  const { root, expectAlerts, onAlerts, setLabel, warn } = mount([
    contribution("Cover", covering, "layer", button, 0, "focus", 1),
    contribution("Wrap", wrap, "layer", button, 0, "voice", 2),
    stale,
  ]);
  const skipped =
    'Plugin "old": find("Missing") matches no elements; candidates: none. Narrow the search with in or nth; skipping this addition';
  await expectAlerts(skipped, coveredLayer);
  expect(root.querySelector("button")).toBeNull();
  const calls = onAlerts.mock.calls.length;
  setLabel("Send again");
  flush();
  await Promise.resolve();
  expect(onAlerts).toHaveBeenCalledTimes(calls);

  setMode("pass");
  flush();
  await expectAlerts(skipped);
  expect(root.querySelector("button")?.textContent).toBe("Send again");

  setMode("cover");
  flush();
  await expectAlerts(skipped, coveredLayer);
  expect(warn.mock.calls.filter(([message]) => message === coveredLayer)).toHaveLength(1);
  setMode("off");
  flush();
  await expectAlerts(skipped);
});

test("cover loses inside actions on the element and its descendants; Original.Children keeps them", async () => {
  const [project, setProject] = createSignal(false);
  const cover = layer(section, (_, Original) =>
    project() ? (
      <Original>
        <Original.Children />
      </Original>
    ) : (
      <aside>Covered</aside>
    ),
  );
  const { root, expectAlerts } = mount([
    contribution("Cover", cover, "layer", section, 0, "focus"),
    contribution(
      "Own",
      after(select, () => "own"),
      "after",
      select,
      0,
      "focus",
    ),
    contribution(
      "Inside",
      append(section, () => "inside"),
      "append",
      section,
      0,
      "voice",
    ),
    contribution(
      "Nested",
      after(select, () => "nested"),
      "after",
      select,
      0,
      "voice",
    ),
    contribution(
      "Title",
      attrs(section, () => ({ title: "extended" })),
      "attrs",
      section,
      0,
      "voice",
    ),
    contribution(
      "Outside",
      after(section, () => "outside"),
      "after",
      section,
      0,
      "outside",
    ),
  ]);
  await expectAlerts(
    `focus's layer hides voice's inside addition on ${sectionName}`,
    `focus's layer on ${sectionName} hides voice's addition on ${selectName}`,
    `Plugin "voice" cannot change attributes on ${sectionName}: plugin "focus" covers the element`,
  );
  expect(root.textContent).toBe("Coveredoutside");

  setProject(true);
  flush();
  await expectAlerts();
  expect(root.textContent).toContain("nested");
  expect(root.textContent).toContain("inside");
  expect(root.querySelector("section")?.title).toBe("extended");
});

test("a conditional hide reports same-target and descendant losses once per plugin", async () => {
  const [hidden, setHidden] = createSignal(true);
  const { root, expectAlerts } = mount([
    contribution("Hide", hide(section, { when: hidden }), "hide", section, 0, "focus"),
    contribution(
      "Sibling",
      after(section, () => "outside"),
      "after",
      section,
      0,
      "voice",
    ),
    contribution(
      "Child",
      append(section, () => "inside"),
      "append",
      section,
      0,
      "voice",
    ),
    contribution(
      "Select",
      after(select, () => "nested"),
      "after",
      select,
      0,
      "voice",
    ),
    contribution(
      "Own",
      after(select, () => "own"),
      "after",
      select,
      0,
      "focus",
    ),
  ]);
  await expectAlerts(
    `focus hides voice's addition on ${sectionName}`,
    `focus hides voice's addition on ${selectName}`,
  );
  expect(root.textContent).toBe("");
  setHidden(false);
  flush();
  await expectAlerts();
  expect(root.textContent).toContain("nested");
  expect(root.textContent).toContain("outside");
});

test("one plugin can cover its own layer and additions without an alert", async () => {
  const { root, onAlerts } = mount([
    contribution(
      "Cover",
      layer(button, () => <i>Hold</i>),
      "layer",
      button,
      0,
      "voice",
    ),
    contribution("Wrap", wrap, "layer", button, 1, "voice"),
    contribution(
      "Inside",
      append(button, () => "inside"),
      "append",
      button,
      0,
      "voice",
    ),
  ]);
  await waitFor(() => expect(root.textContent).toBe("Hold"));
  expect(onAlerts).not.toHaveBeenCalled();
});

test("twenty covered list rows share one alert until the last row stops covering", async () => {
  const row = find("span", { in: "Labels", nth: 1 });
  const [limit, setLimit] = createSignal(20);
  const a = layer(row, (props) => <i>{props.$row.item}</i>, {
    when: (props) => props.$row.index() < limit(),
  });
  const b = layer(row, (_, Original) => <Original />);
  const { root, expectAlerts, onAlerts, warn } = mount(
    [
      contribution("Rows", a, "layer", row, 0, "focus", 1),
      contribution("Rows", b, "layer", row, 0, "voice", 2),
    ],
    Array.from({ length: 20 }, (_, i) => String(i)),
  );
  const message = "focus's layer covers voice's layer on owner Labels › section › span";
  await expectAlerts(message);
  expect(root.querySelectorAll("i")).toHaveLength(20);
  expect(onAlerts).toHaveBeenCalledExactlyOnceWith([message]);
  setLimit(1);
  flush();
  await Promise.resolve();
  expect(root.querySelectorAll("i")).toHaveLength(1);
  expect(onAlerts).toHaveBeenCalledExactlyOnceWith([message]);
  expect(warn.mock.calls.filter(([logged]) => logged === message)).toHaveLength(1);
  setLimit(0);
  flush();
  await expectAlerts();
});

test.each(["focus", "voice"])("removed and reloaded %s generations clear the live alert", async (plugin) => {
  const initial = [
    contribution(
      "Cover",
      layer(section, () => <i>Hold</i>),
      "layer",
      section,
      0,
      "focus",
    ),
    contribution(
      "Nested",
      after(select, () => "nested"),
      "after",
      select,
      0,
      "voice",
    ),
  ];
  const { expectAlerts, setCatalog, reload } = mount(initial);
  const message = `focus's layer on ${sectionName} hides voice's addition on ${selectName}`;
  await expectAlerts(message);

  setCatalog(initial.filter(({ metadata }) => metadata.plugin !== plugin));
  flush();
  await expectAlerts();
  setCatalog(initial);
  flush();
  await expectAlerts(message);

  reload(plugin);
  await expectAlerts();
});

test("throwing actions raise one alert per export and leave the owner drawn", async () => {
  const fail = (reason: string) => () => {
    throw new Error(reason);
  };
  const attachTarget = attach(composer, fail("attachment broke"));
  const { root, expectAlerts, setLabel, bump, reload, warn } = mount([
    contribution("Note", after(button, fail("addition broke")), "after", button, 0, "voice"),
    contribution("Wrap", layer(button, fail("layer broke")), "layer", button, 0, "voice"),
    contribution("Color", attrs(button, fail("attrs broke")), "attrs", button, 0, "voice"),
    contribution("Track", attachTarget, "attach", attachTarget, 0, "voice"),
    contribution("Hide", hide(button, { when: fail("condition broke") }), "hide", button, 0, "voice"),
    contribution(
      "Healthy",
      after(select, () => "healthy"),
      "after",
      select,
      0,
      "other",
    ),
  ]);
  const target = "owner Composer › section › SendButton";
  const messages = [
    `voice (Note) failed on ${target}: addition broke`,
    `voice (Wrap) failed on ${target}: layer broke`,
    `Attribute action voice/Color failed on ${target}: Error: attrs broke`,
    "voice (Track) failed on owner Composer: attachment broke",
    `voice (Hide) failed on ${target}: condition broke`,
  ];
  await expectAlerts(...messages);
  expect(root.querySelector("button")?.textContent).toBe("Send");
  expect(root.textContent).toContain("healthy");

  setLabel("Still here");
  flush();
  expect(root.querySelector("button")?.textContent).toBe("Still here");
  bump("owner");
  await waitFor(() => expect(root.textContent).toContain("healthy"));
  await expectAlerts(...messages);
  expect(warn.mock.calls.filter(([message]) => String(message).includes("broke"))).toHaveLength(5);
  reload("voice");
  await expectAlerts();
});
