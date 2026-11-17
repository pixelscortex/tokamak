import { expect, test, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { waitFor } from "@testing-library/dom";
import {
  ExtensionProvider,
  Slot,
  defineSlot,
  fill,
  wrap,
  replace,
  publicComponent,
  contributionBrand,
  type ExtensionContribution,
  type ExtensionHost,
} from "../../client";

function host(initial: ExtensionContribution[], exports: Record<string, Record<string, unknown>>) {
  const [contributions, setContributions] = createSignal(initial);
  const stop = vi.fn();
  return {
    setContributions,
    stop,
    host: {
      contributions: (kind) => contributions().filter((c) => c.kind === kind),
      version: () => 0,
      load: async (id) => exports[id]!,
      onError: () => stop,
    } satisfies ExtensionHost,
  };
}

test("slot fills order by rank, plugin and fill identity, keep reactive props and retire cleanly", async () => {
  const slot = defineSlot<{ text: string }>("chat.actions");
  const item = (plugin: string, id: string, order: number, fillId = id): ExtensionContribution => ({
    plugin,
    id,
    kind: "fill",
    options: { target: slot.name, order, fillId },
  });
  const entries = [
    item("z", "Late", 1),
    item("b", "Second", 0),
    item("a", "Last", 0, "z"),
    item("a", "First", 0, "a"),
    item("a", "Early", -1),
  ];
  const component = (name: string) => (props: { text: string }) => (
    <span>
      {name}:{props.text};
    </span>
  );
  const fixture = host(entries, {
    a: { First: component("first"), Last: component("last"), Early: component("early") },
    b: { Second: component("second") },
    z: { Late: component("late") },
  });
  const [text, setText] = createSignal("one");
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider host={fixture.host}>
        <Slot of={slot} props={{ text: text() }} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(root.textContent).toBe("early:one;first:one;last:one;second:one;late:one;"));
    setText("two");
    flush();
    expect(root.textContent).toContain("first:two;");
    fixture.setContributions(entries.filter((c) => c.plugin !== "a"));
    flush();
    expect(root.textContent).toBe("second:two;late:two;");
    expect(fixture.stop).toHaveBeenCalledOnce();
  } finally {
    dispose();
  }
  expect(fixture.stop).toHaveBeenCalledTimes(3);
});

test("a failing fill leaves siblings visible", async () => {
  const slot = defineSlot<{}>("test.actions");
  const fixture = host(
    ["Broken", "Healthy"].map((id) => ({ plugin: "test", id, kind: "fill", options: { target: slot.name } })),
    {
      test: {
        Broken: () => {
          throw new Error("failed fill");
        },
        Healthy: () => <span>healthy</span>,
      },
    },
  );
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider host={fixture.host}>
        <Slot of={slot} props={{}} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(root.textContent).toBe("healthy"));
  } finally {
    dispose();
  }
});

test("contribution brands and wrapper/replacement fallback keep public identities", async () => {
  const Original = (props: { text: string }) => <span>{props.text}</span>;
  const slot = defineSlot<{ text: string }>("test.actions");
  expect(fill(slot, {}, Original)[contributionBrand]).toBe("fill");
  expect(wrap(Original, (Inner) => Inner)[contributionBrand]).toBe("wrap");
  expect(replace(Original, (props) => <b>{props.text}</b>)[contributionBrand]).toBe("replace");
  const Public = publicComponent("test.Original", Original);
  const fixture = host(
    [
      { plugin: "replacement", id: "Replacement", kind: "replace", options: { target: "test.Original" } },
      { plugin: "wrapper", id: "Wrapper", kind: "wrap", options: { target: "test.Original" } },
    ],
    {
      replacement: { Replacement: (props: { text: string }) => <b>replacement:{props.text}</b> },
      wrapper: {
        Wrapper: () => () => {
          throw new Error("failed wrapper");
        },
      },
    },
  );
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider host={fixture.host}>
        <Public text="value" />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await waitFor(() => expect(root.textContent).toBe("replacement:value"));
  } finally {
    dispose();
  }
});
