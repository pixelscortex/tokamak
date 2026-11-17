import { expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { JSX } from "@solidjs/web";
import {
  Button,
  Density,
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Row,
  RowList,
  RowOption,
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  StatusIcon,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Textarea,
  icons,
  useDensity,
} from "../src/index.ts";

function mount(view: () => JSX.Element) {
  const root = document.body.appendChild(document.createElement("div"));
  return render(view, root);
}

test("menu opens from the keyboard, moves, runs an item and returns focus", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  mount(() => (
    <Menu onAction={run}>
      <MenuTrigger variant="ghost" icon={icons.more} label="Thread actions" />
      <MenuContent>
        <MenuItem value="rename">Rename</MenuItem>
        <MenuItem value="archive">Archive</MenuItem>
      </MenuContent>
    </Menu>
  ));
  const trigger = screen.getByRole("button", { name: "Thread actions" });
  expect(trigger.dataset.button).toBe("ghost");
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
    <Select defaultValue="normal" onValueChange={change}>
      <SelectLabel>Density</SelectLabel>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="roomy">Roomy</SelectItem>
        <SelectItem value="normal">Normal</SelectItem>
        <SelectItem value="dense">Dense</SelectItem>
      </SelectContent>
    </Select>
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
    <Dialog>
      <DialogTrigger variant="outline">Rename thread</DialogTrigger>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>Rename thread</DialogTitle>
        <DialogClose>Cancel</DialogClose>
        <DialogClose variant="brand">Save</DialogClose>
      </DialogContent>
    </Dialog>
  ));
  const trigger = screen.getByRole("button", { name: "Rename thread" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Rename thread" })).toBeTruthy());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}");
  expect((await screen.findByRole("button", { name: "Save" })).dataset.button).toBe("brand");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("tabs move with arrows and show the matching panel", async () => {
  const user = userEvent.setup();
  mount(() => (
    <Tabs defaultValue="files">
      <TabsList aria-label="Review">
        <TabsTab value="files">Files</TabsTab>
        <TabsTab value="changes">Changes</TabsTab>
      </TabsList>
      <TabsPanel value="files">Four files</TabsPanel>
      <TabsPanel value="changes">Two changes</TabsPanel>
    </Tabs>
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
      <button type="button">Before</button>
      <RowList aria-label="Threads" defaultValue="a" onValueChange={pick}>
        <RowOption value="a" lead={<StatusIcon status="running" label="Add CSV export" />} trail="0:12">
          Add CSV export
        </RowOption>
        <RowOption value="b" disabled>
          PDF dark mode
        </RowOption>
        <RowOption value="c" kind="double" detail="sonnet 4.5">
          Fix total rounding
        </RowOption>
      </RowList>
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
  expect(options[2]!.querySelector('[data-slot="row-box"]')?.getAttribute("data-kind")).toBe("double");
});

test("a status icon carries its word in the name, never on screen", () => {
  mount(() => (
    <Row lead={<StatusIcon status="needs-you" label="Fix total rounding" />}>Fix total rounding</Row>
  ));
  expect(screen.getByRole("img", { name: "Fix total rounding, needs you" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("needs you");
});

test("density only gets tighter inward", () => {
  const seen: string[] = [];
  const Probe = () => {
    const density = useDensity();
    seen.push(density());
    return null;
  };
  mount(() => (
    <>
      <Probe />
      <Density value="dense">
        <Density value="roomy">
          <Probe />
        </Density>
      </Density>
      <Density value="roomy">
        <Density value="normal">
          <Probe />
        </Density>
      </Density>
    </>
  ));
  expect(seen).toEqual(["normal", "dense", "normal"]);
  expect(
    [...document.querySelectorAll("[data-density]")].map((node) => node.getAttribute("data-density")),
  ).toEqual(["dense", "dense", "roomy", "normal"]);
});

test("icon-only buttons are named by their label and default to outline", () => {
  mount(() => (
    <>
      <Button icon={icons.add} label="New thread" />
      <Button>Cancel</Button>
    </>
  ));
  const add = screen.getByRole("button", { name: "New thread" });
  expect(add.hasAttribute("data-icon-only")).toBe(true);
  expect(screen.getByRole("button", { name: "Cancel" }).dataset.button).toBe("outline");
  expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("aria-label")).toBe(false);
});

test("textarea starts one line high and grows with its text", () => {
  mount(() => <Textarea aria-label="Note" />);
  const note = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
  expect(note.rows).toBe(1);
  expect(note.dataset.slot).toBe("textarea");
});
