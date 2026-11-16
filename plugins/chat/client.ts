/** UI-safe references: importing the backend action's inferred type also imports
 * its Web API declarations, which do not belong in a native QuickJS UI. */
import { createApi, type ApiFromModule, type FunctionReference, type Id, type Doc } from "@tokamak/sdk";

import type { Model } from "./backend/_functions";

export const api = createApi<{
  threads: ApiFromModule<typeof import("./backend/threads")>;
  messages: ApiFromModule<typeof import("./backend/messages")>;
  permissions: Pick<ApiFromModule<typeof import("./backend/permissions")>, "answer">;
  runs: {
    running: FunctionReference<
      "query",
      {},
      {
        runId: Id<"runs">;
        threadId: Id<"threads">;
        model: string;
        waiting: boolean;
      }[]
    >;
    active: FunctionReference<"query", { threadId: Id<"threads"> }, Doc<Model, "runs"> | null>;
    cancel: FunctionReference<"mutation", { runId: Id<"runs"> }, null>;
    observe: FunctionReference<"mutation", { sweepId: string; tick: number }, null>;
  };
  agents: {
    list: FunctionReference<"action", {}, { id: string; title: string }[]>;
    checkFolder: FunctionReference<"action", { path: string }, null>;
  };
  chat: {
    send: FunctionReference<
      "action",
      { threadId: Id<"threads">; text: string },
      {
        runId: Id<"runs">;
        messageId: Id<"messages">;
        status: "done" | "error" | "cancelled";
      }
    >;
  };
}>("chat");
