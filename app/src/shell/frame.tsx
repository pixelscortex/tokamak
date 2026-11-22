import { Match, Show, Switch, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Outlet } from "@tanstack/solid-router";
import { RegionOutlet, usePageTitleValue, useRegionFilled } from "@tokamak/sdk/client";
import { Icon, Resizable, ScrollArea, StatusIcon, icons } from "@tokamak/ui";
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
 * stage (with an optional panel) floating beside them. The sidebar and the
 * panel are resized by dragging the gap beside them (or with the arrow keys on
 * it); their widths are kept on this device.
 */
export function Frame(): JSX.Element {
  const shell = useShell();
  const sidebarShown = shell.sidebar.shown;
  const panelFilled = shell.panelFilled;
  // Made once and moved between the resizable group and a hidden holder, so the
  // regions' outlets (and what plugins render into them) stay mounted while hidden.
  const sidebar = (
    <aside
      aria-label="Sidebar"
      hidden={!sidebarShown()}
      class="flex min-w-0 flex-1 flex-col pt-1 pe-3 pb-3 ps-2 density-dense"
    >
      <ScrollArea class="min-h-0 flex-1">
        <div class="flex flex-col gap-1">
          <Show when={sidebarShown()}>
            <ServerSwitcher />
          </Show>
          <RegionOutlet name="sidebar" />
        </div>
      </ScrollArea>
    </aside>
  );
  const panel = (
    <section
      aria-label="Panel"
      hidden={!panelFilled()}
      class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md surface-stage"
    >
      <RegionOutlet name="panel" />
    </section>
  );
  return (
    <div class="flex h-dvh flex-col overflow-hidden surface-window">
      <TopStrip />
      <div class="flex min-h-0 flex-1">
        <Show when={showRail}>
          <Rail />
        </Show>
        {/* Two groups, so opening or closing the panel never changes the sidebar's width. */}
        <Resizable.Root autoSaveId="tokamak-frame" class="flex-1">
          <Show when={sidebarShown()}>
            <Resizable.Panel id="sidebar" defaultSize="244px" minSize="200px" maxSize="420px">
              {sidebar}
            </Resizable.Panel>
            <Resizable.Handle aria-label="Resize sidebar" class="mb-2" />
          </Show>
          <Resizable.Panel id="main" minSize="360px">
            <Resizable.Root autoSaveId="tokamak-panel" class="flex-1">
              <Resizable.Panel id="stage" minSize="360px" ref={followStageEdge()}>
                <div class={panelFilled() ? "flex min-w-0 flex-1 pb-1" : "flex min-w-0 flex-1 pe-2 pb-2"}>
                  <Stage />
                </div>
              </Resizable.Panel>
              <Show when={panelFilled()}>
                <Resizable.Handle aria-label="Resize panel" class="mb-1" />
                <Resizable.Panel id="panel" defaultSize="600px" minSize="320px">
                  <div class="flex min-w-0 flex-1 pe-1 pb-1">{panel}</div>
                </Resizable.Panel>
              </Show>
            </Resizable.Root>
          </Resizable.Panel>
        </Resizable.Root>
        <div hidden>
          <Show when={!sidebarShown()}>{sidebar}</Show>
          <Show when={!panelFilled()}>{panel}</Show>
        </div>
      </div>
      <Palette />
    </div>
  );
}

/**
 * Keeps --tk-nav at the stage's left edge, so the top strip's tabs start where
 * the stage does (styles.css: w-nav) whatever width the sidebar is dragged to.
 */
function followStageEdge(): (stage: HTMLElement) => void {
  const root = document.documentElement;
  let stage: HTMLElement | undefined;
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          if (stage)
            root.style.setProperty("--tk-nav", `${Math.round(stage.getBoundingClientRect().left)}px`);
        });
  onCleanup(() => {
    observer?.disconnect();
    root.style.removeProperty("--tk-nav");
  });
  return (element) => {
    stage = element;
    observer?.observe(element);
  };
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
  const unsaved = () => {
    const connection = shell.session.connection();
    return connection.state === "connected" && connection.plugins.host.hasUnsavedWindowState();
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
      <p role="status" aria-label="Save status" class="text-ink-2">
        <Show when={unsaved()}>Your changes haven’t been saved yet.</Show>
      </p>
    </footer>
  );
}
