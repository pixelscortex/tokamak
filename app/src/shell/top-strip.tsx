import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Icon, icons, Row, Tooltip } from "@tokamak/ui";
import { showRail } from "./config";
import { keys, useShell } from "./context";
import { Control, TipText } from "./control";
import { shellIcons } from "./icons";
import { isShellPage } from "./pages";
import { SettingsMenu } from "./settings-menu";
import { ServerSwitcher } from "./switcher";
import { hrefOf } from "./views";

const tauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function TopStrip(): JSX.Element {
  const shell = useShell();
  const nav = shell.navigation;
  return (
    <div data-tauri-drag-region class="flex shrink-0 items-center pt-2 pe-2 pb-1">
      <div
        data-tauri-drag-region
        class={
          shell.sidebar.shown()
            ? "flex w-nav shrink-0 items-center gap-1 px-2"
            : "flex shrink-0 items-center gap-1 px-2"
        }
      >
        <Show when={tauri}>
          {/* Measured in the window: the traffic lights end 79 px in; keep 9 px clear after them. */}
          <div data-tauri-drag-region class="me-3 h-8 w-16 shrink-0" />
        </Show>
        <Control
          icon={shellIcons.sidebar}
          label={shell.sidebar.shown() ? "Hide sidebar" : "Show sidebar"}
          keys={keys.sidebar}
          disabled={!shell.sidebar.filled()}
          expanded={shell.sidebar.shown()}
          onClick={() => shell.sidebar.toggle()}
        />
        <Control
          icon={icons.search}
          label="Search"
          keys={keys.search}
          disabled={shell.session.connection().state !== "connected"}
          onClick={() => shell.setPaletteOpen(true)}
        />
        {/* With the sidebar hidden, the server switcher becomes one icon button here. */}
        <Show when={!shell.sidebar.shown()}>
          <ServerSwitcher compact />
        </Show>
        <div data-tauri-drag-region class="h-8 min-w-2 flex-1" />
        <Control
          icon={shellIcons.back}
          label="Back"
          keys={keys.back}
          disabled={!nav.canBack()}
          onClick={nav.back}
        />
        <Control
          icon={shellIcons.forward}
          label="Forward"
          keys={keys.forward}
          disabled={!nav.canForward()}
          onClick={nav.forward}
        />
      </div>
      <Tabs />
      <Show when={!showRail}>
        <SettingsMenu side="bottom" />
      </Show>
    </div>
  );
}

function Tabs(): JSX.Element {
  const shell = useShell();
  const nav = shell.navigation;
  const first = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? connection.plugins.views()[0] : undefined;
  };
  return (
    <nav
      data-tauri-drag-region
      aria-label="Open pages"
      class="density-dense flex h-8 min-w-0 flex-1 items-center gap-1"
    >
      <For each={nav.tabs()}>
        {(tab) => {
          const current = () => nav.active() === tab.href;
          const title = () => shell.tabTitle(tab.href, tab.view.title);
          return (
            <div
              data-current={current() || undefined}
              class="group flex h-8 w-menu min-w-16 shrink items-center rounded-sm text-ink-2 hover:bg-hover hover:text-ink data-current:surface-stage data-current:font-medium"
            >
              <Row
                as="button"
                aria-current={current() ? "page" : undefined}
                class="flex-1"
                lead={tab.view.icon && <Icon path={tab.view.icon} />}
                onClick={() => nav.go(tab.href)}
              >
                {title()}
              </Row>
              <Show when={nav.tabs().length > 1 || isShellPage(tab.href.split("?")[0]!)}>
                <div class="flex shrink-0 opacity-0 group-hover:opacity-100 group-data-current:opacity-100 focus-within:opacity-100">
                  <Button
                    variant="ghost"
                    icon={icons.close}
                    label={`Close ${title()}`}
                    onClick={() => nav.close(tab.href)}
                  />
                </div>
              </Show>
            </div>
          );
        }}
      </For>
      <Show when={first()}>
        {(view) => (
          <Tooltip.Root>
            <Tooltip.Trigger
              variant="ghost"
              icon={icons.add}
              label="New tab"
              onClick={() => nav.openNew(hrefOf(view()))}
            />
            <Tooltip.Content side="bottom" sideOffset={4}>
              <TipText label={`New tab: ${view().title}`} />
            </Tooltip.Content>
          </Tooltip.Root>
        )}
      </Show>
      <div data-tauri-drag-region class="h-8 flex-1" />
    </nav>
  );
}
