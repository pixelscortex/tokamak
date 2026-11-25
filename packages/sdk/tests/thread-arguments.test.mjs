import { expect, test } from "bun:test";
import { threadArgument } from "../src/functions";
import cases from "./fixtures/thread-arguments.json";

for (const { name, schema, args, thread } of cases) {
  test(`call thread: ${name}`, () => {
    expect(threadArgument(schema, args) ?? null).toBe(thread);
  });
}
