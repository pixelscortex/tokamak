import { waitFor } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { createEffect, createSignal, flush, onCleanup, Show } from "solid-js";
import { expect, test, vi } from "vitest";
import { attach, ExtensionProvider, hide, layer, Region, RegionOutlet, RegionProvider } from "../../client";
import { Composer } from "./fixtures/parts/owner/src/client/api";
import { find } from "./fixtures/parts/owner/src/client/_generated/components";
import { host, layer as contribution } from "./fixtures/parts/extension-host";

test("attachments own live props and region content for each mounted instance, independent of its elements", async () => {
  const composer = find("Composer");
  const button = find("SendButton");
  const body = find("div", { in: "Composer", aria: { label: "body" } });
  const [label, setLabel] = createSignal("first");
  const [second, setSecond] = createSignal(true);
  const [covered, setCovered] = createSignal(false);
  const [enabled, setEnabled] = createSignal(true);
  const [installed, setInstalled] = createSignal(false);
  const starts: string[] = [];
  const stops: string[] = [];
  const seen: string[] = [];
  const clicked = vi.fn();
  const watch = attach(
    composer,
    (props) => {
      const label = props.label;
      starts.push(label);
      onCleanup(() => stops.push(label));
      createEffect(
        () => props.label,
        (value) => {
          seen.push(value);
        },
      );
      return (
        <>
          <b>Do not draw here</b>
          <Show when={props.label !== "closed"}>
            <Region.Panel>
              <button onClick={() => clicked(props.label)}>{props.label}</button>
            </Region.Panel>
          </Show>
        </>
      );
    },
    { when: (props) => enabled() && props.label !== "off" },
  );
  const catalog = host([
    contribution("Watch", watch, "attach", watch),
    contribution("Hide", hide(button, { when: covered }), "hide", button, 0, "hiding"),
    contribution(
      "Layer",
      layer(body, () => <aside>Layered</aside>, { when: covered }),
      "layer",
      body,
      0,
      "layering",
    ),
  ]);
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <RegionProvider>
        <ExtensionProvider
          host={{
            ...catalog,
            contributions: (kind) =>
              catalog.contributions(kind).filter((c) => installed() || c.id !== "Watch"),
          }}
        >
          <div id="screen">
            <Composer label={label()} lifecycle={() => {}} />
            <Show when={second()}>
              <Composer label="second" lifecycle={() => {}} />
            </Show>
          </div>
        </ExtensionProvider>
        <RegionOutlet name="panel" />
      </RegionProvider>
    ),
    root,
  );
  const panel = () => root.querySelector('[data-region="panel"]')!;
  try {
    expect(panel().textContent).toBe("");
    setInstalled(true);
    flush();
    await waitFor(() => expect(panel().textContent).toBe("firstsecond"));
    expect(starts).toEqual(["first", "second"]);
    expect(root.querySelector("#screen b")).toBeNull();
    expect(root.querySelector("#screen")!.textContent).not.toContain("Do not draw here");

    setLabel("updated");
    setCovered(true);
    flush();
    expect(seen).toContain("updated");
    expect(panel().textContent).toBe("updatedsecond");
    expect(root.querySelector("#screen button")).toBeNull();
    expect(root.querySelectorAll("#screen aside")).toHaveLength(2);
    expect(starts).toEqual(["first", "second"]);
    expect(stops).toEqual([]);
    panel().querySelector("button")!.click();
    expect(clicked).toHaveBeenCalledExactlyOnceWith("updated");

    setSecond(false);
    flush();
    expect(panel().textContent).toBe("updated");
    expect(stops).toEqual(["second"]);

    setLabel("closed");
    flush();
    expect(panel().textContent).toBe("");
    expect(stops).toEqual(["second"]);
    setLabel("updated");
    flush();
    expect(panel().textContent).toBe("updated");

    setEnabled(false);
    flush();
    expect(panel().textContent).toBe("");
    expect(stops).toEqual(["second", "first"]);
    setEnabled(true);
    flush();
    expect(panel().textContent).toBe("updated");
    expect(starts).toEqual(["first", "second", "updated"]);
  } finally {
    dispose();
  }
  expect(stops).toEqual(["second", "first", "updated"]);
});

test.each(["mount", "effect"])(
  "a throwing attachment stops at %s and warns once across instances",
  async (phase) => {
    const target = find("Composer");
    const [fail, setFail] = createSignal(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cleaned = vi.fn();
    const good = vi.fn();
    const broken = attach(target, (props) => {
      onCleanup(() => cleaned(props.label));
      if (phase === "mount") throw new Error("broken attachment");
      createEffect(fail, (failed) => {
        if (failed) throw new Error("broken attachment");
      });
      return null;
    });
    const healthy = attach(target, ({ label }) => {
      good(label);
      return null;
    });
    const root = document.createElement("div");
    const dispose = render(
      () => (
        <ExtensionProvider
          host={host([
            contribution("Broken", broken, "attach", broken),
            contribution("Healthy", healthy, "attach", healthy),
          ])}
        >
          <Composer label="first" lifecycle={() => {}} />
          <Composer label="second" lifecycle={() => {}} />
        </ExtensionProvider>
      ),
      root,
    );
    try {
      await waitFor(() => expect(good.mock.calls).toEqual([["first"], ["second"]]));
      setFail(true);
      flush();
      expect(root.querySelectorAll("section")).toHaveLength(2);
      expect(cleaned.mock.calls).toEqual([["first"], ["second"]]);
      expect(
        warn.mock.calls.filter(([message]) => String(message).startsWith("Component attachment")),
      ).toEqual([["Component attachment addon/Broken failed: Error: broken attachment"]]);
    } finally {
      dispose();
      warn.mockRestore();
    }
  },
);

test("attachments start in install, action, plugin and export order even when imports complete out of order", async () => {
  const target = find("Composer");
  const started: string[] = [];
  const addons = [
    ["late", 2, -10, "First"],
    ["b", 1, 0, "A"],
    ["a", 1, 0, "B"],
    ["a", 1, 0, "A"],
    ["c", 1, -1, "Z"],
  ] as const;
  const catalog = host(
    addons.map(([plugin, installed, order, id]) => {
      const action = attach(target, () => {
        started.push(`${plugin}/${id}`);
      });
      return contribution(id, action, "attach", action, order, plugin, installed);
    }),
  );
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider
        host={{
          ...catalog,
          async load(id) {
            if (id === "c") await delayed;
            return catalog.load(id);
          },
        }}
      >
        <Composer label="first" lifecycle={() => {}} />
      </ExtensionProvider>
    ),
    root,
  );
  try {
    await Promise.resolve();
    flush();
    expect(started).toEqual([]);
    release();
    await waitFor(() => expect(started).toEqual(["c/Z", "a/A", "a/B", "b/A", "late/First"]));
  } finally {
    dispose();
  }
});
