import { expect, test } from "vitest";
import { buildInvite, nameFromHost, parseInvite } from "../src/host/invite";

test("an invite round-trips through its one format", () => {
  const invite = buildInvite("https://tokamak-example.up.railway.app", "s3cret/+=token");
  expect(invite).toBe("https://tokamak-example.up.railway.app/join#s3cret%2F%2B%3Dtoken");
  expect(parseInvite(invite)).toEqual({
    ok: true,
    address: {
      origin: "https://tokamak-example.up.railway.app",
      host: "tokamak-example.up.railway.app",
      secure: true,
    },
    token: "s3cret/+=token",
  });
});

test("a bare host, a URL and address#token all read as the same server", () => {
  const origin = "https://example.up.railway.app";
  for (const text of [
    "example.up.railway.app",
    "  https://example.up.railway.app/  ",
    "https://example.up.railway.app/p/chat?x=1",
  ])
    expect(parseInvite(text)).toMatchObject({ ok: true, address: { origin } });
  expect(parseInvite("example.up.railway.app")).not.toHaveProperty("token");
  expect(parseInvite("example.up.railway.app#abc")).toMatchObject({ address: { origin }, token: "abc" });
  // An empty fragment is no token, not an empty one.
  expect(parseInvite("example.up.railway.app/join#")).not.toHaveProperty("token");
});

test("plain http is only for a server on this computer", () => {
  expect(parseInvite("http://example.app")).toEqual({
    ok: false,
    reason: "Use an https:// address for a server on another computer.",
  });
  expect(parseInvite("http://127.0.0.1:43124")).toMatchObject({
    ok: true,
    address: { origin: "http://127.0.0.1:43124", secure: false },
  });
  // Without a scheme, a loopback address has no certificate to offer, so it means http.
  expect(parseInvite("localhost:3000#t")).toMatchObject({
    address: { origin: "http://localhost:3000" },
    token: "t",
  });
  expect(parseInvite("[::1]:3000")).toMatchObject({ address: { origin: "http://[::1]:3000" } });
});

test("text that is not an address says so", () => {
  for (const text of ["", "   ", "ftp://example.app", "two words", "https://user:pw@example.app"])
    expect(parseInvite(text).ok).toBe(false);
  expect(parseInvite("example.app#%E0%A4%A")).toEqual({
    ok: false,
    reason: "The invite's token is damaged. Ask for the invite again.",
  });
});

test("a server is named after its host until it can name itself", () => {
  expect(nameFromHost("tokamak-example.up.railway.app")).toBe("tokamak-example");
  expect(nameFromHost("127.0.0.1:43124")).toBe("127.0.0.1:43124");
  expect(nameFromHost("localhost:3000")).toBe("localhost:3000");
});
