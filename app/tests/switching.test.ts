import { afterEach, expect, test, vi } from "vitest";
import { createRoot, createSignal, flush } from "solid-js";
import { waitFor } from "@testing-library/dom";

// Each plugin shell stands for one server's plugin UI: its routes, views and loader.
const shells = vi.hoisted(() => [] as { server: string; disposed: boolean }[]);
vi.mock("../src/plugins/views", () => ({
  createPluginShell: (_client: unknown, endpoint: { http: string }) => {
    const shell = { server: endpoint.http, disposed: false };
    shells.push(shell);
    return { connect: async () => {}, dispose: () => (shell.disposed = true), views: () => [] };
  },
}));

import { createSession } from "../src/shell/session";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  constructor(public url: URL) {
    super();
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve));
const endpointFor = (server: string) => ({
  http: `http://${server}.test`,
  ws: `ws://${server}.test/ws`,
  token: `${server}-token`,
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.all = [];
  shells.length = 0;
});

test("switching servers back and forth keeps one socket and retires the old plugin UI", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async () => Response.json({ version: "0.1.0" }));
  await createRoot(async (dispose) => {
    const [server, setServer] = createSignal("a");
    let current = "a";
    const session = createSession({
      routing: {} as never,
      server,
      getEndpoint: () => endpointFor(current),
    });
    const select = (next: string) => {
      current = next;
      setServer(next);
      flush();
    };
    flush();
    const latest = () => FakeSocket.all.at(-1)!;
    const connectedTo = async (name: string) => {
      await waitFor(() => expect(latest().url.host).toBe(`${name}.test`));
      latest().open();
      await waitFor(() => expect(session.connection().state).toBe("connected"));
      flush();
      const connection = session.connection();
      expect(connection.state === "connected" && connection.endpoint.http).toBe(`http://${name}.test`);
    };

    await connectedTo("a");
    expect(latest().url.searchParams.get("token")).toBe("a-token");
    select("b");
    await connectedTo("b");
    // Back to a while b's replacement is still opening: the half-open socket closes too.
    select("a");
    await waitFor(() => expect(latest().url.host).toBe("a.test"));
    select("b");
    await connectedTo("b");

    const open = FakeSocket.all.filter((socket) => socket.readyState !== 3);
    expect(open.map((socket) => socket.url.host)).toEqual(["b.test"]);
    expect(shells.filter((shell) => !shell.disposed).map((shell) => shell.server)).toEqual(["http://b.test"]);
    expect(shells).toHaveLength(3);

    // A socket from a server left behind cannot report into the current session.
    FakeSocket.all[0]!.dispatchEvent(new Event("close"));
    await tick();
    flush();
    expect(session.connection().state).toBe("connected");

    dispose();
    flush();
    expect(FakeSocket.all.every((socket) => socket.readyState === 3)).toBe(true);
    expect(shells.every((shell) => shell.disposed)).toBe(true);
  });
});

test("a server with no saved token fails at once and asks for one, without a socket", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  await createRoot(async (dispose) => {
    const session = createSession({
      routing: {} as never,
      server: () => "origin",
      getEndpoint: () => ({ ...endpointFor("origin"), token: "" }),
    });
    flush();
    await waitFor(() => expect(session.connection().state).toBe("failed"));
    expect(session.connection()).toMatchObject({ needs: "token" });
    expect(FakeSocket.all).toHaveLength(0);
    dispose();
  });
});
