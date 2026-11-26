import { within } from "@testing-library/dom";
import { render } from "@solidjs/web";
import { createSignal, flush, onCleanup } from "solid-js";
import { expect, onTestFinished, test, vi } from "vitest";
import { ExtensionProvider, replace, wrap } from "../../client";
import { host, layer, type Layer } from "./fixtures/parts/extension-host";
import { Composer } from "./fixtures/parts/owner/src/client/api";
import { parts } from "./fixtures/parts/owner/src/client/_generated/components";

const button = parts.Composer.section.SendButton;

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
  return wrap(button, (props) => {
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
        {props.children}
      </div>
    );
  });
}

test("a wrapper keeps its open state when another wrapper's condition flips", async () => {
  const [label, setLabel] = createSignal("Send");
  const frameUnmounted = vi.fn();
  const detailsUnmounted = vi.fn();
  const frame = wrap(
    button,
    (props) => {
      onCleanup(frameUnmounted);
      return <aside>{props.children}</aside>;
    },
    { when: (props) => props.label === "Send" },
  );
  const { root, scope } = mount(
    [
      layer("Frame", frame, "wrap", button, 1),
      layer("Details", details("Details", detailsUnmounted), "wrap", button, 0, "details"),
    ],
    label,
  );
  const trigger = await scope.findByRole("button", { name: "Details" });
  expect(root.querySelector("aside button")?.textContent).toBe("Send");
  trigger.click();
  flush();
  expect(scope.getByText("Details for Send")).toBeTruthy();

  setLabel("Post");
  flush();
  expect(root.querySelector("aside")).toBeNull();
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
  const replacement = replace(button, () => <button type="button">Replacement</button>, { when: replacing });
  const { scope } = mount(
    [
      layer("Details", details("Details", unmounted), "wrap", button),
      layer("Replacement", replacement, "replace", button),
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
  const frame = wrap(button, (props) => <aside>{props.children}</aside>, { when: framed });
  const { root, scope } = mount([
    layer("Outer", details("Outer", outerUnmounted), "wrap", button, 0),
    layer("Frame", frame, "wrap", button, 1),
    layer("Inner", details("Inner", innerUnmounted), "wrap", button, 2),
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
