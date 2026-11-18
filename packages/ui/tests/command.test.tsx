import { expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { Command, Menu } from "../src/index.ts";

test("command filters as you type and runs the highlighted item on Enter", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  const dispose = render(
    () => (
      <Command.Root onAction={run}>
        <Command.Search label="Search views" />
        <Command.Empty>Nothing matches.</Command.Empty>
        <Command.List>
          <Command.Item value="chat">Chat</Command.Item>
          <Command.Item value="notes">Notes</Command.Item>
        </Command.List>
      </Command.Root>
    ),
    document.body.appendChild(document.createElement("div")),
  );
  try {
    const search = screen.getByRole("combobox", { name: "Search views" });
    await user.click(search);
    await user.keyboard("not");
    await waitFor(() => expect(screen.queryByRole("option", { name: "Chat" })).toBeNull());
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(run).toHaveBeenCalledWith("notes", expect.anything()));
  } finally {
    dispose();
  }
});

test("a radio menu item is checked by its group's value", async () => {
  const user = userEvent.setup();
  const choose = vi.fn();
  const dispose = render(
    () => (
      <Menu.Root>
        <Menu.Trigger>Theme</Menu.Trigger>
        <Menu.Content>
          <Menu.RadioGroup value="dark" onValueChange={choose}>
            <Menu.RadioItem value="dark">Dark</Menu.RadioItem>
            <Menu.RadioItem value="light">Light</Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Root>
    ),
    document.body.appendChild(document.createElement("div")),
  );
  try {
    await user.click(screen.getByRole("button", { name: "Theme" }));
    const dark = await screen.findByRole("menuitemradio", { name: "Dark" });
    expect(dark.getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("menuitemradio", { name: "Light" }));
    await waitFor(() => expect(choose).toHaveBeenCalledWith("light", expect.anything()));
  } finally {
    dispose();
  }
});
