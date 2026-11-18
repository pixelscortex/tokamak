import { expect, test, vi } from "vitest";
import { createRoot, flush } from "solid-js";
import { waitFor } from "@testing-library/dom";

const shell = vi.hoisted(() => ({ loaded: () => {}, dispose: vi.fn() }));
vi.mock("../src/plugins/views", () => ({
  createPluginShell: () => ({
    connect: () => new Promise<void>((resolve) => (shell.loaded = resolve)),
    dispose: shell.dispose,
  }),
}));

import { createSession } from "../src/shell/session";

class FakeSocket extends EventTarget {
  static last: FakeSocket;
  readyState = 1;
  bufferedAmount = 0;
  constructor(public url: URL) {
    super();
    FakeSocket.last = this;
  }
  send() {}
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

test("a socket that closes while the catalog loads stays failed", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  try {
    await createRoot(async (dispose) => {
      const session = createSession({
        routing: {} as never,
        getEndpoint: () => ({
          http: "http://localhost:1",
          ws: "ws://localhost:1/ws",
          token: null,
        }),
      });
      await waitFor(() => expect(FakeSocket.last).toBeDefined());
      FakeSocket.last.dispatchEvent(new Event("open"));
      // Let the session reach the catalog load, then lose the socket before it finishes.
      await new Promise((resolve) => setTimeout(resolve));
      FakeSocket.last.close();
      flush();
      expect(session.connection()).toEqual({
        state: "failed",
        reason: "The server closed the connection.",
      });
      shell.loaded();
      await new Promise((resolve) => setTimeout(resolve));
      flush();
      expect(session.connection().state).toBe("failed");
      dispose();
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("connect sends the saved display name before loading plugins", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ id: "alice", name: "Alice", role: "member" }),
  );
  vi.stubGlobal("fetch", request);
  try {
    await createRoot(async (dispose) => {
      const session = createSession({
        routing: {} as never,
        displayName: () => "Alicia",
        getEndpoint: () => ({ http: "https://example.test", ws: "wss://example.test/ws", token: "invite" }),
      });
      await waitFor(() => expect(String(FakeSocket.last.url)).toContain("example.test"));
      FakeSocket.last.dispatchEvent(new Event("open"));
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]![1]).toMatchObject({
        method: "POST",
        body: JSON.stringify({ name: "Alicia" }),
      });
      shell.loaded();
      await waitFor(() => {
        flush();
        expect(session.connection().state).toBe("connected");
      });
      dispose();
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
