import { expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { JSX } from "@solidjs/web";
import {
  Button,
  Dialog,
  Menu,
  Row,
  RowList,
  Select,
  StatusIcon,
  Tabs,
  Textarea,
  FileName,
  icons,
} from "../src/index.ts";

function mount(view: () => JSX.Element) {
  const root = document.body.appendChild(document.createElement("div"));
  return render(view, root);
}

test("menu opens from the keyboard, moves, runs an item and returns focus", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  mount(() => (
    <Menu.Root onAction={run}>
      <Menu.Trigger variant="ghost" icon={icons.more} label="Thread actions" />
      <Menu.Content>
        <Menu.Item value="rename">Rename</Menu.Item>
        <Menu.Item value="archive">Archive</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  ));
  const trigger = screen.getByRole("button", { name: "Thread actions" });
  expect(trigger.className).toContain("hover:bg-edge");
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement?.textContent).toBe("Archive");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(run).toHaveBeenCalledWith("archive", expect.anything()));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("select picks with the keyboard and Escape returns focus", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  mount(() => (
    <Select.Root defaultValue="normal" onValueChange={change}>
      <Select.Label>Density</Select.Label>
      <Select.Trigger>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="roomy">Roomy</Select.Item>
        <Select.Item value="normal">Normal</Select.Item>
        <Select.Item value="dense">Dense</Select.Item>
      </Select.Content>
    </Select.Root>
  ));
  const trigger = screen.getByRole("combobox", { name: "Density" });
  trigger.focus();
  await user.keyboard("{Enter}{ArrowDown}{Enter}");
  await waitFor(() => expect(trigger.textContent).toContain("Dense"));
  expect(change.mock.calls.at(-1)?.[0]).toBe("dense");
  await user.keyboard("{Enter}");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("dialog traps a named dialog and gives focus back on Escape and Close", async () => {
  const user = userEvent.setup();
  mount(() => (
    <Dialog.Root>
      <Dialog.Trigger variant="outline">Rename thread</Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Content>
        <Dialog.Title>Rename thread</Dialog.Title>
        <Dialog.Close>Cancel</Dialog.Close>
        <Dialog.Close variant="brand">Save</Dialog.Close>
      </Dialog.Content>
    </Dialog.Root>
  ));
  const trigger = screen.getByRole("button", { name: "Rename thread" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Rename thread" })).toBeTruthy());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}");
  expect((await screen.findByRole("button", { name: "Save" })).className).toContain("from-brand");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("tabs move with arrows and show the matching panel", async () => {
  const user = userEvent.setup();
  mount(() => (
    <Tabs.Root defaultValue="files">
      <Tabs.List aria-label="Review">
        <Tabs.Tab value="files">Files</Tabs.Tab>
        <Tabs.Tab value="changes">Changes</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="files">Four files</Tabs.Panel>
      <Tabs.Panel value="changes">Two changes</Tabs.Panel>
    </Tabs.Root>
  ));
  const files = screen.getByRole("tab", { name: "Files" });
  files.focus();
  await user.keyboard("{ArrowRight}");
  const changes = screen.getByRole("tab", { name: "Changes" });
  expect(document.activeElement).toBe(changes);
  await waitFor(() => expect(changes.getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel").textContent).toBe("Two changes");
});

test("row list has one tab stop, moves with arrows, selects with Enter and skips disabled rows", async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  mount(() => (
    <>
      <Button>Before</Button>
      <RowList.Root aria-label="Threads" defaultValue="a" onValueChange={pick}>
        <RowList.Option value="a" lead={<StatusIcon status="running" label="Add CSV export" />} trail="0:12">
          Add CSV export
        </RowList.Option>
        <RowList.Option value="b" disabled>
          PDF dark mode
        </RowList.Option>
        <RowList.Option value="c" kind="double" detail="sonnet 4.5">
          Fix total rounding
        </RowList.Option>
      </RowList.Root>
    </>
  ));
  const options = screen.getAllByRole("option");
  expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1);
  screen.getByRole("button", { name: "Before" }).focus();
  await user.keyboard("{Tab}");
  expect(document.activeElement).toBe(options[0]);
  expect(options[0]!.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(options[2]);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(options[2]!.getAttribute("aria-selected")).toBe("true"));
  expect(pick.mock.calls.at(-1)?.[0]).toBe("c");
  expect(options[2]!.querySelector('[data-slot="row-box"]')?.className).toContain("h-12");
});

test("a row button activates from the keyboard without submitting its form", async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
  mount(() => (
    <form onSubmit={submit}>
      <Row as="button" role="radio" aria-checked="true" title="Use no folder" selected onClick={pick}>
        No folder
      </Row>
    </form>
  ));
  const row = screen.getByRole("radio", { name: "No folder", checked: true });
  expect(row.getAttribute("title")).toBe("Use no folder");
  row.focus();
  await user.keyboard("{Enter}");
  expect(pick).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

test("a status icon carries its word in the name, never on screen", () => {
  mount(() => (
    <Row lead={<StatusIcon status="needs-you" label="Fix total rounding" />}>Fix total rounding</Row>
  ));
  expect(screen.getByRole("img", { name: "Fix total rounding, needs you" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("needs you");
});

test("a file name keeps its extension and is named in full", () => {
  mount(() => <FileName path="src/invoices/InvoiceTable.tsx" />);
  const name = document.querySelector('[data-slot="file-name"]')!;
  expect(name.getAttribute("aria-label")).toBe("src/invoices/InvoiceTable.tsx");
  expect(name.lastElementChild!.textContent).toBe(".tsx");
});

test("icon-only buttons are named by their label and default to outline", () => {
  mount(() => (
    <>
      <Button icon={icons.add} label="New thread" />
      <Button>Cancel</Button>
    </>
  ));
  const add = screen.getByRole("button", { name: "New thread" });
  expect(add.className).toContain("w-8");
  expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("inset-ring-edge-strong");
  expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("aria-label")).toBe(false);
});

test.each(["brand", "primary", "outline", "destructive", "ghost", "quiet", "bare"] as const)(
  "%s buttons support all content at the compact size",
  (variant) => {
    mount(() => (
      <>
        <Button variant={variant} size="sm" icon={icons.add} label="Add" />
        <Button variant={variant} size="sm" icon={icons.add}>
          Continue
        </Button>
        <Button variant={variant} size="sm" disabled>
          Sign in
        </Button>
        <Button variant={variant}>Default</Button>
      </>
    ));
    const icon = screen.getByRole("button", { name: "Add" });
    const mixed = screen.getByRole("button", { name: "Continue" });
    const text = screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
    const layout = /^(?:h-|w-|px-|gap-|text-(?:row|label)$)/;
    const state = /^(?:focus-ring$|(?:\S*disabled|active):)/;
    const defaultStates = [...screen.getByRole("button", { name: "Default" }).classList].filter((name) =>
      state.test(name),
    );
    for (const button of [icon, mixed, text]) {
      const classes = [...button.classList];
      expect(classes.filter((name) => layout.test(name)).sort()).toEqual(
        (button === icon
          ? ["h-6", "w-6", "px-0", "gap-1", "text-label"]
          : ["h-6", "px-2", "gap-1", "text-label"]
        ).sort(),
      );
      expect(classes.filter((name) => state.test(name))).toEqual(defaultStates);
    }
    for (const button of [icon, mixed]) {
      expect(
        button.querySelector("svg")?.classList.contains(variant === "bare" ? "size-3" : "size-mark"),
      ).toBe(true);
    }
    expect(text.querySelector("svg")).toBeNull();
    expect(text.disabled).toBe(true);
  },
);

test.each([
  ["md", "h-8", "px-3", "w-8"],
  ["lg", "h-12", "px-4", "w-12"],
] as const)("%s buttons retain their existing size classes", (size, height, padding, width) => {
  mount(() => (
    <>
      <Button size={size} icon={icons.add} label="Add" />
      <Button size={size} icon={icons.add}>
        Continue
      </Button>
    </>
  ));
  const sizing = /^(?:h-|w-|px-|gap-|text-(?:row|label)$)/;
  const icon = screen.getByRole("button", { name: "Add" });
  const mixed = screen.getByRole("button", { name: "Continue" });
  expect([...icon.classList].filter((name) => sizing.test(name))).toEqual([
    "gap-2",
    "text-row",
    height,
    "px-0",
    width,
  ]);
  expect([...mixed.classList].filter((name) => sizing.test(name))).toEqual([
    "gap-2",
    "text-row",
    height,
    padding,
  ]);
  expect(icon.querySelector("svg")?.classList.contains("size-4")).toBe(true);
  expect(mixed.querySelector("svg")?.classList.contains("size-4")).toBe(true);
});

test("textarea starts one line high and grows with its text", () => {
  mount(() => <Textarea aria-label="Note" />);
  const note = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
  expect(note.rows).toBe(1);
  expect(note.dataset.slot).toBe("textarea");
});
