import { afterEach, expect, test, vi } from "vitest";
import { endpoint, hostedTokenKey } from "../src/host/endpoint";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("hosted HTTPS uses its own secure WebSocket origin and stored token", async () => {
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_TOKAMAK_HTTP", "");
  vi.stubGlobal("location", new URL("https://tokamak.example.app/chat"));
  localStorage.setItem(hostedTokenKey, "saved-token");
  expect(await endpoint()).toEqual({
    http: "https://tokamak.example.app",
    ws: "wss://tokamak.example.app/ws",
    token: "saved-token",
  });
});

test("development retains its configured endpoint and token", async () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_TOKAMAK_HTTP", "http://127.0.0.1:43123");
  vi.stubEnv("VITE_TOKAMAK_TOKEN", "dev-token");
  expect(await endpoint()).toEqual({
    http: "http://127.0.0.1:43123",
    ws: "ws://127.0.0.1:43123/ws",
    token: "dev-token",
  });
});
