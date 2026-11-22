import { expect, test } from "vitest";
import { syncDisplayName } from "../src/host/identity";

test("connect synchronizes a saved name only when it differs", async () => {
  const calls: { url: string; method?: string; body?: BodyInit | null; authorization: string | null }[] = [];
  const request = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({ id: "alice", name: "Alice", role: "member" });
  }) as typeof fetch;
  const endpoint = { http: "https://example.test", ws: "wss://example.test/ws", token: "invite" };
  await syncDisplayName(endpoint, undefined, request);
  expect(calls).toHaveLength(0);
  await syncDisplayName(endpoint, "Alice", request);
  expect(calls).toHaveLength(1);
  await syncDisplayName(endpoint, "Alicia", request);
  expect(calls.at(-1)).toEqual({
    url: "https://example.test/account",
    authorization: "Bearer invite",
    method: "POST",
    body: JSON.stringify({ name: "Alicia" }),
  });
  await expect(
    syncDisplayName(endpoint, "Alice", (async () => new Response("", { status: 401 })) as typeof fetch),
  ).rejects.toThrow("identity");
});
