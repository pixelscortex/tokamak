import { waitFor, within } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { createSignal, flush, onCleanup, Show } from "solid-js";
import { expect, onTestFinished, test, vi } from "vitest";
import { ExtensionProvider, layer, type ComponentPart } from "../../client";
import { host, layer as contribution, type Layer } from "./fixtures/parts/extension-host";
import { Composer, RealisticRow } from "./fixtures/parts/owner/src/client/api";
import { find } from "./fixtures/parts/owner/src/client/_generated/components";

const button = find("SendButton");

function mount(layers: Layer[], label = () => "Send", lifecycle = (_event: string) => {}) {
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider host={host(layers)}>
        <Composer label={label()} lifecycle={lifecycle} />
      </ExtensionProvider>
    ),
    root,
  );
  onTestFinished(dispose);
  return { root, scope: within(root) };
}

function details(name: string, unmounted: () => void) {
  return layer(button, (props, Original) => {
    const [open, setOpen] = createSignal(false, { ownedWrite: true });
    onCleanup(unmounted);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          {name}
        </button>
        {open() && (
          <p>
            {name} for {props.label}
          </p>
        )}
        <Original />
      </div>
    );
  });
}

test("a wrapper keeps its open state when another wrapper's condition flips", async () => {
  const [label, setLabel] = createSignal("Send");
  const frameUnmounted = vi.fn();
  const detailsUnmounted = vi.fn();
  const frame = layer(
    button,
    (_props, Original) => {
      onCleanup(frameUnmounted);
      return (
        <aside>
          <Original />
        </aside>
      );
    },
    { when: (props) => props.label === "Send" },
  );
  const { root, scope } = mount(
    [
      contribution("Frame", frame, "layer", button, 1),
      contribution("Details", details("Details", detailsUnmounted), "layer", button, 0, "details"),
    ],
    label,
  );
  const trigger = await scope.findByRole("button", { name: "Details" });
  const original = scope.getByRole("button", { name: "Send" });
  expect(root.querySelector("aside")?.contains(original)).toBe(true);
  trigger.click();
  flush();
  expect(scope.getByText("Details for Send")).toBeTruthy();

  setLabel("Post");
  flush();
  expect(root.querySelector("aside")).toBeNull();
  expect(scope.getByRole("button", { name: "Post" })).toBe(original);
  expect(scope.getByText("Details for Post")).toBeTruthy();
  expect(frameUnmounted).toHaveBeenCalledTimes(1);
  expect(detailsUnmounted).not.toHaveBeenCalled();

  setLabel("Send");
  flush();
  expect(root.querySelector("aside button")?.textContent).toBe("Send");
  expect(scope.getByText("Details for Send")).toBeTruthy();
  expect(frameUnmounted).toHaveBeenCalledTimes(1);
  expect(detailsUnmounted).not.toHaveBeenCalled();
});

test("an open wrapper survives replacing and restoring the element inside it", async () => {
  const [replacing, setReplacing] = createSignal(false);
  const unmounted = vi.fn();
  const lifecycle = vi.fn();
  const replacement = layer(button, () => <button type="button">Replacement</button>, { when: replacing });
  const { scope } = mount(
    [
      contribution("Details", details("Details", unmounted), "layer", button),
      contribution("Replacement", replacement, "layer", button),
    ],
    undefined,
    lifecycle,
  );
  (await scope.findByRole("button", { name: "Details" })).click();
  flush();
  const open = scope.getByText("Details for Send");
  const wrapper = open.parentElement!;
  expect(within(wrapper).getByRole("button", { name: "Send" })).toBeTruthy();
  lifecycle.mockClear();

  setReplacing(true);
  flush();
  expect(within(wrapper).getByRole("button", { name: "Replacement" })).toBeTruthy();
  expect(scope.queryByRole("button", { name: "Send" })).toBeNull();
  expect(scope.getByText("Details for Send")).toBe(open);
  expect(lifecycle.mock.calls).toEqual([["send unloaded"]]);

  setReplacing(false);
  flush();
  expect(within(wrapper).getByRole("button", { name: "Send" })).toBeTruthy();
  expect(scope.queryByRole("button", { name: "Replacement" })).toBeNull();
  expect(scope.getByText("Details for Send")).toBe(open);
  expect(lifecycle.mock.calls).toEqual([["send unloaded"], ["send mounted"]]);
  expect(unmounted).not.toHaveBeenCalled();
});

test("both neighboring wrappers stay open when the middle wrapper's condition flips", async () => {
  const [framed, setFramed] = createSignal(true);
  const outerUnmounted = vi.fn();
  const innerUnmounted = vi.fn();
  const frame = layer(
    button,
    (_props, Original) => (
      <aside>
        <Original />
      </aside>
    ),
    { when: framed },
  );
  const { root, scope } = mount([
    contribution("Outer", details("Outer", outerUnmounted), "layer", button, 0),
    contribution("Frame", frame, "layer", button, 1),
    contribution("Inner", details("Inner", innerUnmounted), "layer", button, 2),
  ]);
  const outer = await scope.findByRole("button", { name: "Outer" });
  const inner = scope.getByRole("button", { name: "Inner" });
  expect(root.querySelector("aside")?.contains(inner)).toBe(true);
  expect(root.querySelector("aside")?.contains(outer)).toBe(false);
  outer.click();
  inner.click();
  flush();

  setFramed(false);
  flush();
  expect(root.querySelector("aside")).toBeNull();
  expect(scope.getByText("Outer for Send")).toBeTruthy();
  expect(scope.getByText("Inner for Send")).toBeTruthy();

  setFramed(true);
  flush();
  expect(root.querySelector("aside")?.contains(inner)).toBe(true);
  expect(scope.getByText("Outer for Send")).toBeTruthy();
  expect(scope.getByText("Inner for Send")).toBeTruthy();
  expect(outerUnmounted).not.toHaveBeenCalled();
  expect(innerUnmounted).not.toHaveBeenCalled();
});

test("a reactive branch can unload and remount the original", async () => {
  const [active, setActive] = createSignal(false);
  const lifecycle = vi.fn();
  const stop = layer(button, (_, Original) => (active() ? <b>Stop</b> : <Original />));
  const { scope } = mount([contribution("Stop", stop, "layer", button)], undefined, lifecycle);
  const original = scope.getByRole("button", { name: "Send" });
  setActive(true);
  await scope.findByText("Stop");
  lifecycle.mockClear();

  setActive(false);
  flush();
  const restored = scope.getByRole("button", { name: "Send" });
  expect(restored).not.toBe(original);
  expect(lifecycle.mock.calls).toEqual([["send mounted"]]);

  setActive(true);
  flush();
  expect(scope.getByText("Stop")).toBeTruthy();
  expect(scope.queryByRole("button", { name: "Send" })).toBeNull();
  expect(lifecycle.mock.calls).toEqual([["send mounted"], ["send unloaded"]]);
});

// A layer often has two uses of Original: one branch draws the element as it
// is, the other gives it new contents (a heading that names the picked agent).
test.each([
  { name: "a plain element", target: find("header", { in: "RealisticRow" }), selector: "header" },
  { name: "a component", target: find("RowStatus"), selector: "small" },
])(
  "a layer switches between two uses of Original on $name without remounting it",
  async ({ target, selector }) => {
    const [agent, setAgent] = createSignal<string>();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const unloaded = vi.fn();
    const Heading = layer(target as ComponentPart<string, object>, (_, Original) => (
      <Show when={agent()} fallback={<Original />}>
        {(name) => <Original>For {name()}</Original>}
      </Show>
    ));
    const root = document.createElement("div");
    onTestFinished(
      render(
        () => (
          <ExtensionProvider host={host([contribution("Heading", Heading, "layer", target)])}>
            <RealisticRow text="Hello" unloaded={unloaded} />
          </ExtensionProvider>
        ),
        root,
      ),
    );
    const text = () => root.querySelector(selector)?.textContent;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const plain = text();
    const element = root.querySelector(selector);
    for (const name of ["Claude", undefined, "Codex", undefined]) {
      setAgent(name);
      flush();
      // A component decides what to do with children; a plain element shows them.
      const expected = name && selector === "header" ? `For ${name}` : plain;
      await waitFor(() => expect(text()).toBe(expected));
      expect(root.querySelector(selector)).toBe(element);
    }
    expect(warn.mock.calls.filter(([message]) => /twice/.test(String(message)))).toEqual([]);
    // New contents on the header unload the status component inside it. A
    // component that is itself the target is rebuilt once, when the layer first
    // hands it children, and then stays mounted through every later switch.
    if (selector === "small") expect(unloaded.mock.calls.length).toBeLessThanOrEqual(1);
  },
);
