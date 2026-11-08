import { test, expect } from "bun:test";
import { definePlugin, validate, v } from "../src/index.ts";

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

test("ID validators accept unambiguous plugin-qualified IDs without granting ownership", () => {
  const id = v.id("items").description;
  validate(id, "acme.notes/items:key");
  validate(id, "items:key");
  // Ownership is a host decision, not something a client-side shape validator
  // can grant. Different logical tables and malformed qualifiers still fail.
  for (const value of ["acme.notes/other:key", "../items:key", "acme.notes//items:key", "Bad/items:key"]) {
    expect(() => validate(id, value)).toThrow();
  }
});
