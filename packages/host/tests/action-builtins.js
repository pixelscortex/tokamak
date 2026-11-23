import { createHash } from "node:crypto";
import { platform } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

export const functions = {
  modules: {
    kind: "action",
    args: { kind: "any" },
    invoke: () => [
      createHash("sha256").update("action").digest("hex").length,
      platform(),
      join("a", "b"),
      new URL("https://example.com").hostname,
    ],
  },
};
