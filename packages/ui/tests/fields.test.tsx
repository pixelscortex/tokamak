import { expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Input, Switch, icons } from "../src/index.ts";

function mount(view: () => JSX.Element) {
  const root = document.body.appendChild(document.createElement("div"));
  return render(view, root);
}

test("an uncontrolled switch toggles with click, Space and Enter without submitting its form", async () => {
  const user = userEvent.setup();
  const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
  mount(() => (
    <form onSubmit={submit}>
      <Switch aria-label="Enabled" />
    </form>
  ));
  const toggle = screen.getByRole("switch", { name: "Enabled" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await user.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await user.keyboard(" ");
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(submit).not.toHaveBeenCalled();
});

test("a controlled switch shows its owner's value, and a disabled one cannot be reached", async () => {
  const user = userEvent.setup();
  const [enabled, setEnabled] = createSignal(true);
  mount(() => (
    <>
      <Switch aria-label="Claude Max" checked={enabled()} onCheckedChange={setEnabled} />
      <Switch aria-label="ChatGPT Pro" disabled />
    </>
  ));
  const toggle = screen.getByRole("switch", { name: "Claude Max" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  toggle.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(enabled()).toBe(false));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  setEnabled(true);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  const off = screen.getByRole("switch", { name: "ChatGPT Pro" });
  await user.click(off);
  expect(off.getAttribute("aria-checked")).toBe("false");
  await user.keyboard("{Tab}");
  expect(document.activeElement).not.toBe(off);
});

test("an input keeps one line, marks itself invalid, and holds an icon and an action", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const clear = vi.fn();
  mount(() => (
    <Input
      aria-label="Callback link"
      mono
      invalid
      icon={icons.search}
      placeholder="http://localhost:1455/callback?code=…"
      onValueChange={change}
      trail={<Button variant="ghost" icon={icons.close} label="Clear" onClick={clear} />}
    />
  ));
  const field = screen.getByRole("textbox", { name: "Callback link" }) as HTMLInputElement;
  expect(field.tagName).toBe("INPUT");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.className).toContain("text-data");
  const well = field.closest('[data-slot="input-group"]')!;
  expect(well.querySelector('[data-slot="icon"]')).toBeTruthy();
  expect(well.className).toContain("pe-1");
  await user.type(field, "abc{Enter}");
  expect(field.value).toBe("abc");
  expect(change.mock.calls.at(-1)?.[0]).toBe("abc");
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(clear).toHaveBeenCalledTimes(1);
});

test("Enter toggles a switch once, and an empty trail takes no room", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  mount(() => (
    <>
      <Switch aria-label="Once" onCheckedChange={change} />
      <Input aria-label="No action" trail={false} />
    </>
  ));
  screen.getByRole("switch", { name: "Once" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
  const well = screen.getByRole("textbox", { name: "No action" }).closest('[data-slot="input-group"]')!;
  expect(well.className).not.toContain("pe-1");
});

test("a disabled input marks its well and takes no text", async () => {
  const user = userEvent.setup();
  mount(() => <Input aria-label="Label" size="lg" disabled defaultValue="Personal" />);
  const field = screen.getByRole("textbox", { name: "Label" }) as HTMLInputElement;
  const well = field.closest('[data-slot="input-group"]')!;
  expect(well.className).toContain("h-12");
  await waitFor(() => expect(well.hasAttribute("data-disabled")).toBe(true));
  await user.type(field, "x");
  expect(field.value).toBe("Personal");
});

test("the corner rule knows the input's 12 px radius", async () => {
  const { primitiveShapes } = await import("../lint/plugin.js");
  const { inputVariants } = await import("../src/index.ts");
  expect(primitiveShapes.Input).toEqual([12, null]);
  expect(inputVariants().root()).toContain("rounded-md");
});
