import { render } from "@solidjs/web";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { DevicesList } from "../src/shell/devices";

test("devices update in place and Sign out targets only the selected device", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (controller) => (stream = controller) });
  const request = vi.fn(async (url: URL, options: RequestInit) =>
    url.pathname === "/devices/machines/live"
      ? new Response(null, { status: 403 })
      : options.method === "POST"
        ? new Response()
        : new Response(body),
  );
  const publish = (devices: unknown[]) => {
    const frame = `data: ${JSON.stringify(devices)}\n\n`;
    const encoder = new TextEncoder();
    stream.enqueue(encoder.encode(`: keep alive\n\n${frame.slice(0, 20)}`));
    stream.enqueue(encoder.encode(frame.slice(20)));
  };
  vi.stubGlobal("fetch", request);
  const root = document.body.appendChild(document.createElement("div"));
  const endpoint = { http: "https://example.test", ws: "wss://example.test/ws", token: "saved-key" };
  const dispose = render(() => <DevicesList endpoint={endpoint} />, root);
  try {
    const [liveUrl, liveOptions] = request.mock.calls[0]!;
    expect(liveUrl.href).toBe("https://example.test/devices/live");
    expect(new Headers(liveOptions.headers).get("authorization")).toBe("Bearer saved-key");
    const member = { id: "alice", name: "Alice", role: "member" };
    const laptop = { id: "laptop", name: "Laptop", lastSeen: null, member, current: false, online: false };
    const desktop = { id: "desktop", name: "Desktop", lastSeen: 2000, member, current: true, online: false };
    publish([desktop, laptop]);
    await screen.findByText("This device");
    expect(screen.getByText("Never connected")).toBeTruthy();

    publish([desktop, { ...laptop, lastSeen: 10_000, online: true }]);
    await screen.findByText("Online");
    expect(screen.queryByText("Never connected")).toBeNull();
    expect(root.querySelector('time[datetime="1970-01-01T00:00:10.000Z"]')).toBeTruthy();
    publish([desktop, { ...laptop, lastSeen: 10_000, online: false }]);
    await waitFor(() => expect(screen.queryByText("Online")).toBeNull());
    screen.getByRole("button", { name: "Sign out Laptop" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() =>
      expect(request.mock.calls.some(([, options]) => options.method === "POST")).toBe(true),
    );
    const [signOutUrl, signOutOptions] = request.mock.calls.find(([, options]) => options.method === "POST")!;
    expect(signOutUrl.href).toBe("https://example.test/devices/laptop/revoke");
    expect(signOutOptions.method).toBe("POST");
    expect(new Headers(signOutOptions.headers).get("authorization")).toBe("Bearer saved-key");

    publish([desktop]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out Laptop" })).toBeNull());
    expect(screen.getByRole("button", { name: "Sign out Desktop" })).toBeTruthy();
  } finally {
    const signal = request.mock.calls[0]?.[1].signal;
    dispose();
    stream.close();
    vi.unstubAllGlobals();
    expect(signal?.aborted).toBe(true);
  }
});

function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const publish = (value: unknown) =>
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  return { body, publish, close: () => controller.close() };
}

test("plugin machines show under their own heading with the owning plugin, presence and bound member", async () => {
  const devices = sseStream();
  const machines = sseStream();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: URL) =>
        new Response(url.pathname === "/devices/machines/live" ? machines.body : devices.body),
    ),
  );
  const root = document.body.appendChild(document.createElement("div"));
  const endpoint = { http: "https://example.test", ws: "wss://example.test/ws", token: "saved-key" };
  const dispose = render(() => <DevicesList endpoint={endpoint} />, root);
  try {
    devices.publish([]);
    await screen.findByText("No signed-in devices.");
    machines.publish([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("region", { name: "Plugin machines" })).toBeNull();

    const owner = { kind: "plugin", plugin: "sandbox", name: "Sandbox" };
    machines.publish([
      {
        id: "m1",
        name: "sandbox-7f3a",
        owner,
        online: true,
        lastSeen: 10_000,
        member: { id: "bo", name: "Bo" },
      },
    ]);
    const group = await screen.findByRole("region", { name: "Plugin machines" });
    expect(group.textContent).toContain("sandbox-7f3a");
    expect(group.textContent).toContain("Sandbox plugin");
    expect(group.textContent).toContain("For Bo");
    expect(group.textContent).toContain("Online");
    expect(group.querySelector("button")).toBeNull();

    machines.publish([]);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Plugin machines" })).toBeNull());
  } finally {
    dispose();
    devices.close();
    machines.close();
    vi.unstubAllGlobals();
  }
});

test("a member who may not manage devices sees no plugin machines group and no error", async () => {
  const devices = sseStream();
  const request = vi.fn(async (url: URL) =>
    url.pathname === "/devices/machines/live"
      ? new Response(null, { status: 403 })
      : new Response(devices.body),
  );
  vi.stubGlobal("fetch", request);
  const root = document.body.appendChild(document.createElement("div"));
  const endpoint = { http: "https://example.test", ws: "wss://example.test/ws", token: "saved-key" };
  const dispose = render(() => <DevicesList endpoint={endpoint} />, root);
  try {
    devices.publish([]);
    await screen.findByText("No signed-in devices.");
    await waitFor(() =>
      expect(request.mock.calls.some(([url]) => url.pathname === "/devices/machines/live")).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("region", { name: "Plugin machines" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    dispose();
    devices.close();
    vi.unstubAllGlobals();
  }
});
