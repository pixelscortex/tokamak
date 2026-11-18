import { afterEach, beforeEach, expect, test } from "vitest";
import { render } from "@solidjs/web";
import { createRoot } from "solid-js";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/solid-router";
import { Region, RegionProvider, usePageTitle } from "@tokamak/sdk/client";
import type { PluginShell, PluginView } from "../src/plugins/views";
import { ShellContext } from "../src/shell/context";
import { Frame } from "../src/shell/frame";
import { createNavigation } from "../src/shell/navigation";
import type { Connection, Session } from "../src/shell/session";
import { createShellState } from "../src/shell/shell";
import { shortcutName } from "../src/shell/shortcuts";
import { NoPlugins } from "../src/shell/states";
import { createTheme } from "../src/shell/theme";

const view = (id: string, route: string, title = id): PluginView => ({
  id,
  plugin: "fixture",
  route: `/p/fixture${route === "/" ? "" : route}`,
  title,
  generation: 1,
});
const notes = view("Notes", "/", "Notes");
const thread = view("Thread", "/t/:id", "Thread");
const board = view("Board", "/board", "Board");
const admin = { ...view("Admin", "/admin", "Admin"), icon: "M4 4H20V20H4Z" };

function connected(views: () => readonly PluginView[]): Session {
  const connection: Connection = {
    state: "connected",
    client: {} as never,
    plugins: { views } as unknown as PluginShell,
    endpoint: { http: "http://127.0.0.1:43123", ws: "ws://127.0.0.1:43123/ws", token: null },
  };
  return { connection: () => connection, retry() {} };
}

function Titled(props: { title: string }) {
  usePageTitle(() => props.title);
  return null;
}

/** The real frame and keys over a memory router, a fake session and fixture routes. */
function mount(views: readonly PluginView[] = [notes, board], start = "/p/fixture") {
  const root = createRootRoute({
    component: () => (
      <RegionProvider>
        <Harness />
      </RegionProvider>
    ),
  });
  const page = (path: string, text: string, sidebar = false, title?: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => (
        <>
          {title && <Titled title={title} />}
          {sidebar && (
            <Region.Sidebar>
              <p>Sidebar rows</p>
            </Region.Sidebar>
          )}
          <p>{text}</p>
        </>
      ),
    });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/", "Home"),
      page("/p/fixture", "Notes page", true),
      page("/p/fixture/board", "Board page"),
      page("/p/fixture/admin", "Admin page", false, "Weekly admin"),
      page("/p/fixture/t/$id", "Thread page", true),
      createRoute({ getParentRoute: () => root, path: "/empty", component: NoPlugins }),
    ]),
    history: createMemoryHistory({ initialEntries: [start] }),
  });
  function Harness() {
    const shell = createShellState(
      router,
      connected(() => views),
    );
    return (
      <ShellContext value={shell}>
        <Frame />
      </ShellContext>
    );
  }
  const element = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <RouterProvider router={router} />, element);
  return { router, dispose };
}

beforeEach(() => localStorage.clear());
afterEach(() => document.documentElement.removeAttribute("data-theme"));

test("shortcut names follow the facade's modifier order", () => {
  expect(shortcutName("ctrl+shift+Tab")).toBe("Control+Shift+tab");
  expect(shortcutName("mod+k")).toMatch(/^(Meta|Control)\+k$/);
});

test("the sidebar shows a view's region and the keyboard toggles it", async () => {
  const user = userEvent.setup();
  const { dispose } = mount();
  try {
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    await waitFor(() => expect(sidebar.textContent).toContain("Sidebar rows"));
    expect(sidebar.hidden).toBe(false);
    await user.keyboard(
      `{${shortcutName("mod+b").startsWith("Meta") ? "Meta" : "Control"}>}b{/Meta}{/Control}`,
    );
    await waitFor(() => expect(sidebar.hidden).toBe(true));
    expect(screen.getByRole("button", { name: "Show sidebar" }).getAttribute("aria-expanded")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Show sidebar" }));
    await waitFor(() => expect(sidebar.hidden).toBe(false));
  } finally {
    dispose();
  }
});

test("a view without a sidebar region hides the sidebar and disables its toggle", async () => {
  const { dispose } = mount([notes, board], "/p/fixture/board");
  try {
    await screen.findByText("Board page");
    expect(document.querySelector<HTMLElement>('aside[aria-label="Sidebar"]')!.hidden).toBe(true);
    expect(screen.getByRole("button", { name: "Show sidebar" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("heading", { name: "Board" })).toBeTruthy();
  } finally {
    dispose();
  }
});

test("rail entries navigate, mark the current view and open one tab each", async () => {
  const user = userEvent.setup();
  const { router, dispose } = mount();
  try {
    const rail = await screen.findByRole("navigation", { name: "Views" });
    const tabs = screen.getByRole("navigation", { name: "Open pages" });
    await waitFor(() =>
      expect(within(rail).getByRole("link", { name: "Notes" }).getAttribute("aria-current")).toBe("page"),
    );
    await user.click(within(rail).getByRole("link", { name: "Board" }));
    await screen.findByText("Board page");
    expect(router.history.location.pathname).toBe("/p/fixture/board");
    expect(within(rail).getByRole("link", { name: "Board" }).getAttribute("aria-current")).toBe("page");
    expect(
      within(tabs)
        .getAllByRole("button", { name: /^(Notes|Board)$/ })
        .map((tab) => tab.textContent),
    ).toEqual(["Notes", "Board"]);
    await user.click(within(rail).getByRole("link", { name: "Notes" }));
    await screen.findByText("Notes page");
    expect(within(tabs).getAllByRole("button", { name: /^(Notes|Board)$/ })).toHaveLength(2);
  } finally {
    dispose();
  }
});

test("closing the current tab moves to its neighbour; the last tab cannot close", async () => {
  const user = userEvent.setup();
  const { router, dispose } = mount();
  try {
    const rail = await screen.findByRole("navigation", { name: "Views" });
    await user.click(within(rail).getByRole("link", { name: "Board" }));
    await screen.findByText("Board page");
    await user.click(screen.getByRole("button", { name: "Close Board" }));
    await screen.findByText("Notes page");
    expect(router.history.location.pathname).toBe("/p/fixture");
    expect(screen.queryByRole("button", { name: "Close Notes" })).toBeNull();
  } finally {
    dispose();
  }
});

test("tabs follow navigation inside a view and back and forward use the router history", async () => {
  const { router, dispose } = mount([notes, thread, board]);
  try {
    let navigation!: ReturnType<typeof createNavigation>;
    const stop = createRoot((stop) => {
      navigation = createNavigation(router, () => [notes, thread, board]);
      return stop;
    });
    await screen.findByText("Notes page");
    await router.navigate({ href: "/p/fixture/t/a" });
    await router.navigate({ href: "/p/fixture/t/b" });
    await waitFor(() =>
      expect(navigation.tabs().map((tab) => tab.href)).toEqual(["/p/fixture", "/p/fixture/t/b"]),
    );
    expect(navigation.canBack()).toBe(true);
    expect(navigation.canForward()).toBe(false);
    navigation.back();
    await waitFor(() => expect(router.history.location.pathname).toBe("/p/fixture/t/a"));
    expect(navigation.canForward()).toBe(true);
    navigation.openNew("/p/fixture/board");
    await waitFor(() => expect(navigation.tabs()).toHaveLength(3));
    navigation.cycle(1);
    await waitFor(() => expect(router.history.location.pathname).toBe("/p/fixture"));
    stop();
  } finally {
    dispose();
  }
});

test("the footer says what is true: connected, and to which server", async () => {
  const { dispose } = mount();
  try {
    const status = await screen.findByRole("status", { name: "Connection status" });
    expect(status.textContent).toBe("127.0.0.1:43123");
    expect(within(status).getByRole("img", { name: "Connected" })).toBeTruthy();
  } finally {
    dispose();
  }
});

test("with no plugins the stage explains what to do next", async () => {
  const { dispose } = mount([], "/empty");
  try {
    const empty = await screen.findByRole("status", { name: "No plugins" });
    expect(within(empty).getByRole("heading", { name: "No plugins installed" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  } finally {
    dispose();
  }
});

test("the settings menu switches the theme, which follows the system until chosen", async () => {
  const user = userEvent.setup();
  const { dispose } = mount();
  try {
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Light" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(localStorage.getItem("tokamak.theme")).toBe("light");
  } finally {
    dispose();
  }
});

test("a chosen theme survives a restart and System clears it", () => {
  localStorage.setItem("tokamak.theme", "light");
  createRoot((stop) => {
    const theme = createTheme();
    expect(theme.choice()).toBe("light");
    theme.choose("system");
    expect(localStorage.getItem("tokamak.theme")).toBeNull();
    stop();
  });
});

test("a view's icon marks its rail entry and tab, and its page title names the tab and window", async () => {
  const user = userEvent.setup();
  mount([notes, board, admin]);
  const rail = await screen.findByRole("navigation", { name: "Views" });
  const adminLink = within(rail).getByRole("link", { name: "Admin" });
  expect(adminLink.querySelector("svg path")?.getAttribute("d")).toBe("M4 4H20V20H4Z");
  expect(within(rail).getByRole("link", { name: "Notes" }).textContent).toBe("N");

  await user.click(adminLink);
  const tabs = screen.getByRole("navigation", { name: "Open pages" });
  await waitFor(() => expect(within(tabs).getByRole("button", { name: "Weekly admin" })).toBeTruthy());
  expect(within(screen.getByRole("banner", { name: "Page header" })).getByRole("heading").textContent).toBe(
    "Weekly admin",
  );
  expect(document.title).toBe("Weekly admin · Tokamak");

  await user.click(within(rail).getByRole("link", { name: "Notes" }));
  await waitFor(() => expect(document.title).toBe("Notes · Tokamak"));
  expect(
    within(tabs)
      .getAllByRole("button", { name: /^(Notes|Weekly admin)$/ })
      .map((tab) => tab.textContent),
  ).toEqual(["Notes", "Weekly admin"]);
});
