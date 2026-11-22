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

test("textarea starts one line high and grows with its text", () => {
  mount(() => <Textarea aria-label="Note" />);
  const note = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
  expect(note.rows).toBe(1);
  expect(note.dataset.slot).toBe("textarea");
});
