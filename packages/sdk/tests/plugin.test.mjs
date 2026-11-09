import { test, expect } from "bun:test";
import { definePlugin, validate, v } from "../src/index.ts";

test("plugin descriptors snapshot valid stable identities and reject malformed ones", () => {
  const source = { id: "acme.notes", version: "0.1.0" };
  const plugin = definePlugin(source);
  source.id = "changed";
  expect(plugin).toEqual({ id: "acme.notes", version: "0.1.0" });
  expect(Object.isFrozen(plugin)).toBe(true);
  for (const id of ["", "../escape", "Uppercase", "a/b", "a..b"]) {
    expect(() => definePlugin({ id, version: "0.1.0" })).toThrow();
  }
  for (const version of ["", "latest", "1", "^1.0.0", "01.0.0", "1.0.0-01", "1.0.0-..", "1.0.0+"]) {
    expect(() => definePlugin({ id: "acme.notes", version })).toThrow();
  }
  expect(definePlugin({ id: "acme.notes", version: "1.0.0-alpha.1+build.01" }).version)
    .toBe("1.0.0-alpha.1+build.01");
  expect(() => definePlugin({ id: "acme.notes", version: "1.0.0", privateRuntime: true })).toThrow();
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

test("plugin capability descriptors are immutable JSON snapshots", () => {
  const source = {
    id: "acme.notes", version: "1.0.0", api: "tokamak@^0.1",
    depends: { "tokamak.core": "^0.1" }, optional: { "acme.ai": "*" },
    breaks: { "acme.legacy": "<1" }, provides: ["notes"], consumes: ["ai"],
    permissions: ["net:example.com"], placement: "hub",
    contributes: { commands: [{ title: "Summarize", tags: ["ai"] }] },
    exports: "./api.ts",
  };
  const plugin = definePlugin(source);
  source.depends["tokamak.core"] = "*";
  source.contributes.commands[0].tags.push("changed");
  expect(plugin.depends["tokamak.core"]).toBe("^0.1");
  expect(plugin.contributes.commands[0].tags).toEqual(["ai"]);
  expect(Object.isFrozen(plugin.contributes.commands[0].tags)).toBe(true);
  for (const patch of [
    { api: 42 }, { api: "node@1" }, { depends: [] }, { depends: { "../bad": "*" } },
    { optional: { good: 3 } }, { provides: [""] }, { consumes: ["ai", "ai"] },
    { permissions: [false] }, { placement: "browser" }, { exports: 3 },
    { contributes: { commands: {} } },
  ]) {
    expect(() => definePlugin({ id: "acme.notes", version: "1.0.0", ...patch })).toThrow();
  }
});
