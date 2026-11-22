import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { readDescriptor } from "../src/descriptor";
import { definePlugin } from "@tokamak/sdk";

test("descriptor discovery never executes code and normalizes dependency IDs", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "tokamak-descriptor-"));
  try {
    await writeFile(
      resolve(root, "plugin.ts"),
      `
      import { definePlugin as plugin } from "@tokamak/sdk";
      throw new Error("descriptor was executed");
      export default plugin({id:"example", version:"0.1.0", name:"Example", description:"Example plugin", depends:["chat"], permissions:[]});
    `,
    );
    const descriptor = definePlugin(readDescriptor(root)!);
    expect(descriptor.depends).toEqual({ chat: "*" });
    expect(descriptor.name).toBe("Example");
    for (const expression of [
      "{...metadata}",
      "{id: identifier}",
      '{id:"x", depends: [getId()]}',
      '{id:"x", provides:["chat.backend"]}',
      '{id:"x", breaks:{chat:"*"}}',
    ]) {
      await writeFile(
        resolve(root, "plugin.ts"),
        `import {definePlugin} from "@tokamak/sdk"; export default definePlugin(${expression});`,
      );
      expect(() => readDescriptor(root)).toThrow("static literal metadata");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
