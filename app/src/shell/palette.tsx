import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import { DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/solid/dialog";
import { Command, Dialog, Icon, Kbd } from "@tokamak/ui";
import { keys, useShell } from "./context";
import type { ThemeChoice } from "./theme";

const themes: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Use the system theme" },
  { value: "dark", label: "Use the dark theme" },
  { value: "light", label: "Use the light theme" },
];

/** Search over what the shell knows today: the installed views and its own commands. */
export function Palette(): JSX.Element {
  const shell = useShell();
  const views = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? connection.plugins.views() : [];
  };
  const run = (value: string) => {
    shell.setPaletteOpen(false);
    const [kind, ...rest] = value.split(":");
    const target = rest.join(":");
    if (kind === "view") {
      const view = views().find((candidate) => `${candidate.plugin}/${candidate.id}` === target);
      if (view) shell.navigation.openView(view);
    } else if (kind === "theme") shell.theme.choose(target as ThemeChoice);
    else if (value === "sidebar") shell.sidebar.toggle();
    else if (value === "kit") shell.navigation.go("/kit");
  };
  return (
    <Dialog.Root open={shell.paletteOpen()} onOpenChange={(open: boolean) => shell.setPaletteOpen(open)}>
      <DialogBackdrop class="fixed inset-0 bg-window/70 transition duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0" />
      <DialogContent class="fixed inset-x-0 top-16 bottom-auto mx-auto flex max-h-3/4 w-full max-w-dialog flex-col overflow-hidden rounded-md border-0 surface-card p-1 inset-ring inset-ring-edge backdrop:bg-transparent transition duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0">
        <DialogTitle class="sr-only">Search</DialogTitle>
        <Command.Root onAction={run}>
          <Command.Search label="Search views and commands" placeholder="Search views and commands" />
          <Command.Empty>Nothing matches.</Command.Empty>
          <Command.List>
            <Command.Group>
              <Command.GroupLabel>Views</Command.GroupLabel>
              <For each={views()}>
                {(view) => (
                  <Command.Item value={`view:${view.plugin}/${view.id}`}>
                    {view.icon && <Icon path={view.icon} class="text-ink-3" />}
                    {view.title}
                  </Command.Item>
                )}
              </For>
            </Command.Group>
            <Command.Separator />
            <Command.Group>
              <Command.GroupLabel>Window</Command.GroupLabel>
              <Command.Item value="sidebar">
                {shell.sidebar.shown() ? "Hide sidebar" : "Show sidebar"}
                <Kbd keys={keys.sidebar} />
              </Command.Item>
              <For each={themes}>
                {(theme) => <Command.Item value={`theme:${theme.value}`}>{theme.label}</Command.Item>}
              </For>
              <Command.Item value="kit">Open the UI kit</Command.Item>
            </Command.Group>
          </Command.List>
        </Command.Root>
      </DialogContent>
    </Dialog.Root>
  );
}
