import { test, expect } from "bun:test";
import { createMemoryRouter, matchRoute } from "../js/router.ts";

test("memory histories are independent, branch after back and preserve query/hash", () => {
  const a = createMemoryRouter("/threads");
  const b = createMemoryRouter("/plugins/notes");
  a.navigate("/threads/one?tab=items#latest");
  expect(a.location()).toEqual({
    href: "/threads/one?tab=items#latest",
    pathname: "/threads/one",
    search: "?tab=items",
    hash: "#latest",
  });
  expect(a.match("/threads/:id").params.id).toBe("one");
  a.back();
  expect(a.location().pathname).toBe("/threads");
  a.forward();
  expect(a.location().pathname).toBe("/threads/one");
  a.back();
  a.navigate("/threads/two");
  a.forward();
  expect(a.location().pathname).toBe("/threads/two");
  a.navigate("/threads/three", { replace: true });
  a.back();
  expect(a.location().pathname).toBe("/threads");
  expect(b.location().pathname).toBe("/plugins/notes");
  a.dispose();
  a.dispose();
  expect(() => a.navigate("/")).toThrow("disposed");
  b.dispose();
});

test("route matching handles encoded parameters, splats and malformed input", () => {
  expect(matchRoute("/threads/:id", "/threads/a%20b").params.id).toBe("a b");
  expect(matchRoute("/plugins/:id/*path", "/plugins/notes/editor/a").params).toEqual({
    id: "notes",
    path: "editor/a",
  });
  expect(matchRoute("/plugins/:id/*path", "/plugins/notes").params.path).toBe("");
  expect(matchRoute("/", "/").params).toEqual({});
  expect(matchRoute("/threads/:id", "/threads/one/")).toBeDefined();
  expect(matchRoute("/threads/:id", "/threads")).toBeUndefined();
  expect(matchRoute("/threads/:id/edit", "/threads//edit")).toBeUndefined();
  expect(matchRoute("/threads/:id", "/threads/%bad")).toBeUndefined();
  expect(matchRoute("/threads/:id", "/other/one")).toBeUndefined();
  expect(() => matchRoute("/:id/:id", "/one/two")).toThrow("duplicate");
  expect(() => matchRoute("/*rest/child", "/one/two")).toThrow("last");
  expect(Object.isFrozen(matchRoute("/threads/:id", "/threads/one").params)).toBe(true);
  for (const path of [
    "http://example.com",
    "//example.com",
    "/\\example.com",
    "/bad\npath",
    "/".repeat(2049),
  ]) {
    expect(() => createMemoryRouter(path)).toThrow("local absolute");
  }
});
