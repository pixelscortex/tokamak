import { readFile } from "node:fs/promises";
import { action, v } from "@tokamak/sdk";

export const read = action({
  on: "caller",
  args: { path: v.string() },
  handler: (_, { path }) => readFile(path, "utf8"),
});

export const stay = action({
  on: "caller",
  args: { path: v.string() },
  handler: (ctx, { path }) =>
    ctx.proc(["/bin/sh", "-c", 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done', "fixture", path])
      .exited,
});
