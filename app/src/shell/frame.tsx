import { Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Outlet } from "@tanstack/solid-router";
import { RegionOutlet, usePageTitleValue, useRegionFilled } from "@tokamak/sdk/client";
import { Icon, StatusIcon, icons } from "@tokamak/ui";
import { showRail } from "./config";
import { useShell } from "./context";
import { Palette } from "./palette";
import { Rail } from "./rail";
import { isShellPage } from "./pages";
import { Connecting, Unreachable } from "./states";
import { ServerSwitcher } from "./switcher";
import { TopStrip } from "./top-strip";

/**
 * The window: a top strip, the rail and the sidebar on the window tone, and the
 * stage (with an optional panel) floating beside them.
 */
export function Frame(): JSX.Element {
  const shell = useShell();
  const sidebarShown = shell.sidebar.shown;
  const panelFilled = shell.panelFilled;
  return (
    <div class="flex h-dvh flex-col overflow-hidden surface-window">
      <TopStrip />
      <div class="flex min-h-0 flex-1">
        <div class={sidebarShown() ? "flex w-nav shrink-0" : "flex shrink-0"}>
          <Show when={showRail}>
            <Rail />
          </Show>
          <aside
            aria-label="Sidebar"
            hidden={!sidebarShown()}
            class="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto pt-1 pe-4 pb-3 ps-2 density-dense"
          >
            <Show when={sidebarShown()}>
              <ServerSwitcher />
            </Show>
            <RegionOutlet name="sidebar" />
          </aside>
        </div>
        <div
          class={
            panelFilled() ? "flex min-w-0 flex-1 gap-1 pe-1 pb-1" : "flex min-w-0 flex-1 gap-1 pe-2 pb-2"
          }
        >
          <Stage />
          <section
            aria-label="Panel"
            hidden={!panelFilled()}
            class="flex w-1/2 max-w-read shrink-0 flex-col overflow-hidden rounded-md surface-stage"
          >
            <RegionOutlet name="panel" />
          </section>
        </div>
      </div>
      <Palette />
    </div>
  );
}

function Stage(): JSX.Element {
  const shell = useShell();
  const headerFilled = useRegionFilled("header");
  const pageTitle = usePageTitleValue();
  const connection = shell.session.connection;
  return (
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md surface-stage">
      <header aria-label="Page header" class="flex h-12 shrink-0 items-center gap-2 ps-4 pe-2">
        <RegionOutlet name="header" />
        <Show when={!headerFilled() && shell.navigation.current()}>
          {(view) => <h1 class="truncate text-row font-medium text-ink">{pageTitle() ?? view().title}</h1>}
        </Show>
      </header>
      <main class="flex min-h-0 flex-1 flex-col overflow-auto">
        <Switch>
          <Match when={isShellPage(shell.navigation.pathname())}>
            <Outlet />
          </Match>
          <Match when={connection().state === "connecting"}>
            <Connecting />
          </Match>
          <Match when={connection().state === "failed" && connection()}>
            {(failed) => {
              const state = () => failed() as { reason: string; needs?: "token" };
              return <Unreachable reason={state().reason} needs={state().needs} />;
            }}
          </Match>
          <Match when={connection().state === "connected"}>
            <Outlet />
          </Match>
        </Switch>
      </main>
      <Footer />
    </div>
  );
}

function Footer(): JSX.Element {
  const shell = useShell();
  const update = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" && connection.agentsDisabled;
  };
  const host = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" ? new URL(connection.endpoint.http).host : undefined;
  };
  return (
    <footer class="flex h-8 shrink-0 items-center gap-4 px-4 text-label text-ink-3">
      <p role="status" aria-label="Connection status" class="flex items-center gap-2">
        <Switch>
          <Match when={host()}>
            {(address) => (
              <>
                <Icon path={icons.done} size={12} label="Connected" />
                <span class="text-data">{address()}</span>
              </>
            )}
          </Match>
          <Match when={shell.session.connection().state === "connecting"}>
            <StatusIcon status="running" size={12} label="Connecting" />
          </Match>
          <Match when={shell.session.connection().state === "failed"}>
            <Icon path={icons.failed} size={12} label="Not connected" class="text-removed" />
          </Match>
        </Switch>
      </p>
      <Show when={update()}>
        <p role="alert" class="flex items-center gap-2">
          <StatusIcon status="failed" size={12} label="Agents unavailable" />
          <span>Update the app</span>
        </p>
      </Show>
    </footer>
  );
}
