import { beforeEach, expect, test } from "vitest";
import { createRoot, flush } from "solid-js";
import { hostedTokenKey } from "../src/host/endpoint";
import { createServers, type Servers } from "../src/host/servers";
import { loadServers } from "../src/host/saved-servers";

const local = () => ({ http: "http://127.0.0.1:43123", ws: "ws://127.0.0.1:43123/ws", token: "local" });
const make = (options: Parameters<typeof createServers>[0] = { local }) =>
  createRoot((dispose) => ({ servers: createServers(options), dispose }));
const join = (servers: Servers, address: string, token = "t".repeat(32)) =>
  servers.save({ address, token, name: new URL(address).hostname, displayName: "Noor" });

beforeEach(() => localStorage.clear());

test("This Mac comes first, joined servers follow, and the choice survives a restart", async () => {
  const first = make();
  expect(first.servers.list().map((server) => server.name)).toEqual(["This Mac"]);
  const studio = join(first.servers, "https://noor-studio.up.railway.app");
  expect(first.servers.select(studio.id)).toBe(true);
  expect(first.servers.select("missing")).toBe(false);
  first.dispose();

  const second = make();
  expect(second.servers.current()).toMatchObject({
    kind: "remote",
    address: "https://noor-studio.up.railway.app",
  });
  expect(second.servers.displayName()).toBe("Noor");
  expect(await second.servers.endpointOf(second.servers.current())).toEqual({
    http: "https://noor-studio.up.railway.app",
    ws: "wss://noor-studio.up.railway.app/ws",
    token: "t".repeat(32),
  });
  expect(await second.servers.endpointOf(second.servers.list()[0]!)).toEqual(local());
  second.dispose();
});

test("joining a saved address again replaces its token and keeps its name", () => {
  const { servers, dispose } = make();
  const first = join(servers, "http://127.0.0.1:43124", "old");
  servers.rename(first.id, "Kira's server");
  const again = join(servers, "http://127.0.0.1:43124", "new");
  expect(again).toMatchObject({ id: first.id, name: "Kira's server", token: "new" });
  flush();
  expect(servers.list()).toHaveLength(2);
  dispose();
});

test("removing the selected server falls back to This Mac and forgets its token", () => {
  const { servers, dispose } = make();
  const studio = join(servers, "https://noor-studio.up.railway.app", "secret-token");
  servers.select(studio.id);
  servers.remove(studio.id);
  flush();
  expect(servers.current().id).toBe("local");
  expect(JSON.stringify(loadServers())).not.toContain("secret-token");
  dispose();
});

test("a page served by a hosted server has only that server, with the token it saved before", async () => {
  localStorage.setItem(hostedTokenKey, "saved-before");
  const { servers, dispose } = make({ origin: "https://tokamak.example.app" });
  expect(servers.canAdd).toBe(false);
  expect(servers.list()).toEqual([
    expect.objectContaining({ id: "origin", kind: "origin", name: "tokamak", token: "saved-before" }),
  ]);
  join(servers, "https://tokamak.example.app", "replaced");
  flush();
  expect(await servers.endpointOf(servers.current())).toMatchObject({ token: "replaced" });
  expect(localStorage.getItem(hostedTokenKey)).toBe("replaced");
  servers.remove("origin");
  expect(servers.list()).toHaveLength(1);
  dispose();
});
