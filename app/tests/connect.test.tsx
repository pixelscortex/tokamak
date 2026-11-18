import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/solid-router";
import { Region, RegionProvider } from "@tokamak/sdk/client";
import { createServers, type Servers } from "../src/host/servers";
import type { PluginShell, PluginView } from "../src/plugins/views";
import { Connect } from "../src/shell/connect/flow";
import { ShellContext } from "../src/shell/context";
import { Frame } from "../src/shell/frame";
import type { Connection, Session } from "../src/shell/session";
import { createShellState } from "../src/shell/shell";
import { shortcutName } from "../src/shell/shortcuts";

const notes: PluginView = {
  id: "Notes",
  plugin: "fixture",
  route: "/p/fixture",
  title: "Notes",
  generation: 1,
};
const good = "g".repeat(32);
const local = () => ({ http: "http://127.0.0.1:43123", ws: "ws://127.0.0.1:43123/ws", token: null });
const connected: Connection = {
  state: "connected",
  client: {} as never,
  plugins: { views: () => [notes] } as unknown as PluginShell,
  endpoint: local(),
};

/** The real frame over a memory router, with a session the test drives by hand. */
function mount(
  options: { start?: string; connection?: Connection; sidebar?: boolean; origin?: string } = {},
) {
  const [connection, setConnection] = createSignal<Connection>(options.connection ?? connected, {
    ownedWrite: true,
  });
  const session: Session & { retries: number } = {
    connection,
    retries: 0,
    retry() {
      session.retries++;
    },
  };
  let servers!: Servers;
  const root = createRootRoute({
    component: () => (
      <RegionProvider>
        <Harness />
      </RegionProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> }),
      createRoute({ getParentRoute: () => root, path: "/connect", component: Connect }),
      createRoute({
        getParentRoute: () => root,
        path: "/p/fixture",
        component: () => (
          <>
            {options.sidebar !== false && (
              <Region.Sidebar>
                <p>Sidebar rows</p>
              </Region.Sidebar>
            )}
            <p>Notes page</p>
          </>
        ),
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [options.start ?? "/p/fixture"] }),
  });
  function Harness() {
    servers = createServers(options.origin ? { origin: options.origin } : { local });
    const shell = createShellState(router, session, servers);
    return (
      <ShellContext value={shell}>
        <Frame />
      </ShellContext>
    );
  }
  const element = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <RouterProvider router={router} />, element);
  return { router, session, setConnection, servers: () => servers, dispose };
}

/** A pretend network: which origins answer /health, and which token their catalog takes. */
function network(answering: Record<string, string>) {
  const fetch = vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    const token = answering[url.origin];
    if (token === undefined) throw new TypeError("Failed to fetch");
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/plugins")
      return url.searchParams.get("token") === token
        ? Response.json({ revision: "1", plugins: [] })
        : new Response(null, { status: 401 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const step = () => screen.getByRole("region", { name: "Add a server" });
const mod = shortcutName("mod+1").startsWith("Meta") ? "Meta" : "Control";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

test("adding a server: address, connecting, a rejected then accepted token, your name", async () => {
  network({ "http://127.0.0.1:43124": good });
  const user = userEvent.setup();
  const { router, servers, dispose } = mount({ start: "/connect" });
  try {
    await user.type(await screen.findByRole("textbox", { name: "Server address" }), "127.0.0.1:43124");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(within(step()).getByText("Step 2 of 4:", { exact: false })).toBeTruthy();
    await waitFor(() => expect(within(step()).getByText("Found the server")).toBeTruthy());
    // A loopback server has no TLS, so the secure-connection line is not claimed.
    expect(within(step()).queryByText("Made a secure connection")).toBeNull();
    await user.click(within(step()).getByRole("button", { name: "Continue" }));

    await screen.findByRole("heading", { name: "Is this the right place?" });
    expect(within(step()).getAllByText("127.0.0.1:43124")).toHaveLength(2);
    const token = screen.getByRole("textbox", { name: "Invite token" });
    await user.type(token, "wrong-token");
    await user.click(screen.getByRole("button", { name: "Join" }));
    const refused = await screen.findByRole("alert");
    expect(refused.textContent).toContain("This invite wasn't accepted");
    expect(token.getAttribute("aria-invalid")).toBe("true");

    await user.clear(token);
    await user.type(token, good);
    await user.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByRole("heading", { name: "You're in. How should people see you?" });
    await user.type(screen.getByRole("textbox", { name: "Your name" }), "Noor");
    expect(within(screen.getByRole("group", { name: "Message preview" })).getByText("Noor")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open 127.0.0.1:43124" }));

    await waitFor(() => expect(router.history.location.pathname).toBe("/"));
    flush();
    expect(servers().current()).toMatchObject({
      kind: "remote",
      name: "127.0.0.1:43124",
      address: "http://127.0.0.1:43124",
      token: good,
      displayName: "Noor",
    });
    expect(screen.queryByRole("button", { name: "Add a server" })).toBeNull();
  } finally {
    dispose();
  }
});

test("a pasted invite carries its token: the chip shows and Verify asks for nothing", async () => {
  network({ "https://tokamak-kira.up.railway.app": good });
  localStorage.setItem("tokamak.servers", JSON.stringify({ servers: [], displayName: "Noor" }));
  const user = userEvent.setup();
  const { servers, dispose } = mount({ start: "/connect" });
  try {
    const field = await screen.findByRole("textbox", { name: "Server address" });
    await user.click(field);
    await user.paste(`https://tokamak-kira.up.railway.app/join#${good}`);
    expect((field as HTMLInputElement).value).toBe("tokamak-kira.up.railway.app");
    expect(screen.getByRole("img", { name: "Invite token included" })).toBeTruthy();
    expect(screen.getByText("Your invite came with it, so you won't need to type it")).toBeTruthy();
    // The token belongs to the address it came with.
    await user.type(field, "x");
    expect(screen.queryByRole("img", { name: "Invite token included" })).toBeNull();
    await user.clear(field);
    await user.paste(`https://tokamak-kira.up.railway.app/join#${good}`);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(within(step()).getByText("Made a secure connection")).toBeTruthy());
    await user.click(within(step()).getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Is this the right place?" });
    expect(within(step()).getByText("tokamak-kira")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Invite token" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Join" }));

    const name = await screen.findByRole("textbox", { name: "Your name" });
    expect((name as HTMLInputElement).value).toBe("Noor");
    expect(screen.getByText("The name you used before")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open tokamak-kira" }));
    flush();
    await waitFor(() => expect(servers().current()).toMatchObject({ token: good, displayName: "Noor" }));
  } finally {
    dispose();
  }
});

test("an address that does not answer gets its own state, and the address can be changed", async () => {
  const fetch = network({});
  const user = userEvent.setup();
  const { dispose } = mount({ start: "/connect" });
  try {
    const field = await screen.findByRole("textbox", { name: "Server address" });
    await user.type(field, "http://example.app");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("alert").textContent).toContain("Use an https:// address");
    expect(fetch).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, "asleep.example.app");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("heading", { name: "Couldn't reach the server" });
    expect(within(step()).getByText("No answer from the server")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetch.mock.calls.length).toBe(4));
    await screen.findByRole("heading", { name: "Couldn't reach the server" });
    await user.click(screen.getByRole("button", { name: "Change address" }));
    expect((screen.getByRole("textbox", { name: "Server address" }) as HTMLInputElement).value).toBe(
      "asleep.example.app",
    );
  } finally {
    dispose();
  }
});

test("Esc or the close control cancels without saving anything", async () => {
  network({});
  const user = userEvent.setup();
  const { router, servers, dispose } = mount();
  try {
    await screen.findByText("Notes page");
    await user.click(screen.getByRole("button", { name: "Server: This Mac" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add server…" }));
    await screen.findByRole("heading", { name: "Join a server" });
    const tabs = screen.getByRole("navigation", { name: "Open pages" });
    expect(within(tabs).getByRole("button", { name: "Add a server" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(router.history.location.pathname).toBe("/p/fixture"));
    expect(within(tabs).queryByRole("button", { name: "Add a server" })).toBeNull();

    await router.navigate({ href: "/connect" });
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.history.location.pathname).toBe("/p/fixture"));
    expect(servers().list()).toHaveLength(1);
  } finally {
    dispose();
  }
});

test("the switcher lists servers with their keys, and ⌘2 switches and closes the old server's tabs", async () => {
  localStorage.setItem(
    "tokamak.servers",
    JSON.stringify({
      servers: [{ id: "kira", name: "Kira's server", address: "https://kira.example.app", token: good }],
    }),
  );
  network({});
  const user = userEvent.setup();
  const { router, servers, dispose } = mount();
  try {
    await screen.findByText("Notes page");
    await user.click(screen.getByRole("button", { name: "Server: This Mac" }));
    const mac = await screen.findByRole("menuitem", { name: "This Mac, connected" });
    expect(mac.getAttribute("aria-keyshortcuts")).toBe(shortcutName("mod+1"));
    expect(mac.getAttribute("aria-current")).toBe("true");
    // Other servers are asked whether they answer while the menu is open.
    await screen.findByRole("menuitem", { name: "Kira's server, not answering" });
    expect(screen.queryByRole("menuitem", { name: /^Remove/ })).toBeNull();
    await user.keyboard("{Escape}");

    await user.keyboard(`{${mod}>}2{/${mod}}`);
    await waitFor(() => expect(servers().current().id).toBe("kira"));
    await waitFor(() => expect(router.history.location.pathname).toBe("/"));
    await user.click(screen.getByRole("button", { name: /^Server: Kira's server/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove this server" }));
    await waitFor(() => expect(servers().current().id).toBe("local"));
    flush();
    expect(
      servers()
        .list()
        .map((server) => server.name),
    ).toEqual(["This Mac"]);
  } finally {
    dispose();
  }
});

test("an unreachable server never blocks the window", async () => {
  network({});
  const user = userEvent.setup();
  const { setConnection, session, dispose } = mount();
  try {
    await screen.findByText("Notes page");
    setConnection({ state: "failed", reason: "No answer from 127.0.0.1:43123." });
    flush();
    const band = await screen.findByRole("alert", { name: "Server unreachable" });
    expect(band.textContent).toContain("Can't reach This Mac");
    expect(band.textContent).toContain("No answer from 127.0.0.1:43123.");
    // The tab stays listed and the switcher moves to the top strip with the empty sidebar.
    const tabs = screen.getByRole("navigation", { name: "Open pages" });
    expect(within(tabs).getByRole("button", { name: "Notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Server: This Mac, not connected" })).toBeTruthy();

    await user.click(within(band).getByRole("button", { name: "Retry" }));
    expect(session.retries).toBe(1);
    await user.click(within(band).getByRole("button", { name: "Connect to another server" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add server…" }));
    // Shell pages render whatever the connection is doing.
    await screen.findByRole("heading", { name: "Join a server" });
    expect(within(tabs).getAllByRole("button", { name: /^(Notes|Add a server)$/ })).toHaveLength(2);
  } finally {
    dispose();
  }
});

test("a page served by a hosted server asks for its invite in place of a token form", async () => {
  network({ "https://tokamak.example.app": good });
  const user = userEvent.setup();
  const { session, servers, dispose } = mount({
    origin: "https://tokamak.example.app",
    connection: { state: "failed", reason: "This server needs an access token.", needs: "token" },
  });
  try {
    const band = await screen.findByRole("alert", { name: "Server unreachable" });
    expect(band.textContent).toContain("tokamak needs an invite");
    await user.click(within(band).getByRole("button", { name: "Add invite" }));
    // The address is the page's own; the flow starts reaching it straight away.
    await waitFor(() => expect(within(step()).getByText("Found the server")).toBeTruthy());
    await user.click(within(step()).getByRole("button", { name: "Continue" }));
    await user.type(screen.getByRole("textbox", { name: "Invite token" }), good);
    await user.click(screen.getByRole("button", { name: "Join" }));
    await user.type(await screen.findByRole("textbox", { name: "Your name" }), "Sam");
    await user.click(screen.getByRole("button", { name: "Open tokamak" }));
    expect(session.retries).toBe(1);
    flush();
    expect(servers().list()).toEqual([expect.objectContaining({ id: "origin", token: good })]);
    expect(servers().canAdd).toBe(false);
  } finally {
    dispose();
  }
});
