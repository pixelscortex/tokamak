import { test, expect } from "bun:test";
import { definePlugin } from "../src/index.ts";

test("plugin descriptors snapshot valid stable identities and reject malformed ones", () => {
  const source = { id: "acme.notes", version: "0.1.0" };
  const plugin = definePlugin(source);
  source.id = "changed";
  expect(plugin).toEqual({ id: "acme.notes", version: "0.1.0" });
  expect(Object.isFrozen(plugin)).toBe(true);
  for (const id of ["", "../escape", "Uppercase", "a/b", "a..b", "a".repeat(129)]) {
    expect(() => definePlugin({ id, version: "0.1.0" })).toThrow();
  }
  for (const version of ["", "latest", "1", "^1.0.0", "01.0.0", "1.0.0-01", "1.0.0-..", "1.0.0+"]) {
    expect(() => definePlugin({ id: "acme.notes", version })).toThrow();
  }
  expect(definePlugin({ id: "acme.notes", version: "1.0.0-alpha.1+build.01" }).version)
    .toBe("1.0.0-alpha.1+build.01");
  expect(() => definePlugin({ id: "acme.notes", version: "1.0.0", permissions: [] })).toThrow();
});
