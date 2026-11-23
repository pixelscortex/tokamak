import { createHash } from "node:crypto";
import { platform } from "node:os";
import path, { sep, delimiter, posix, join } from "node:path";
import { URL } from "node:url";

const action = (invoke) => ({ kind: "action", args: { kind: "any" }, invoke });

export const functions = {
  modules: action(() => [
    createHash("sha256").update("action").digest("hex").length,
    platform(),
    join("a", "b"),
    new URL("https://example.com").hostname,
    { sep, delimiter, joined: posix.join("a", "b"), samePosix: path.posix === posix },
  ]),
  fetch: action(async (url) => (await fetch(url)).text()),
  timerThenFetch: action(async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return (await fetch(url)).text();
  }),
};
