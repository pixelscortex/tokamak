import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Show } from "solid-js";
import { authCaller } from "@tokamak/sdk";
import { Menu } from "@tokamak/ui";
import { useShell } from "./context";
import { shellIcons } from "./icons";
import { shellPages } from "./pages";
import type { ThemeChoice } from "./theme";

export function SettingsMenu(props: { side: "right" | "bottom" }): JSX.Element {
  const shell = useShell();
  const [manager, setManager] = createSignal(false);
  createEffect(shell.session.connection, (connection) => {
    setManager(false);
    if (connection.state === "connected" && shell.servers.current().kind !== "local") {
      return connection.client.subscribe(authCaller, {}, (event) => {
        setManager(
          "value" in event && (event.value.user.role === "owner" || event.value.user.role === "admin"),
        );
      });
    }
  });
  return (
    <Menu.Root
      onAction={(value) => {
        if (value === "kit") shell.navigation.go("/kit");
        if (value === "members") shell.navigation.openView(shellPages.members);
        if (value === "devices") shell.navigation.openView(shellPages.devices);
      }}
    >
      <Menu.Trigger variant="ghost" icon={shellIcons.settings} label="Settings" />
      <Menu.Content side={props.side} align="end">
        <Menu.RadioGroup
          value={shell.theme.choice()}
          onValueChange={(value: string) => shell.theme.choose(value as ThemeChoice)}
        >
          <Menu.GroupLabel>Theme</Menu.GroupLabel>
          <Menu.RadioItem value="system">System</Menu.RadioItem>
          <Menu.RadioItem value="dark">Dark</Menu.RadioItem>
          <Menu.RadioItem value="light">Light</Menu.RadioItem>
        </Menu.RadioGroup>
        <Menu.Separator />
        <Show when={shell.servers.current().kind !== "local"}>
          <Show when={manager()}>
            <Menu.Item value="members">Members</Menu.Item>
          </Show>
          <Menu.Item value="devices">Devices</Menu.Item>
        </Show>
        <Menu.Item value="kit">UI kit</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
