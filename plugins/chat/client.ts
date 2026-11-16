/** UI-safe references: importing the backend action's inferred type also imports
 * its Web API declarations, which do not belong in a native QuickJS UI. */
import { createApi, type ApiFromModule, type FunctionReference, type Id, type Doc } from "@tokamak/sdk";

import type { Model } from "./backend/_functions";

export const api = createApi<{
  threads: {
    list: FunctionReference<"query", {}, Doc<Model, "threads">[]>;
    create: FunctionReference<"action", { title?: string }, Id<"threads">>;
    rename: FunctionReference<"mutation", { threadId: Id<"threads">; title: string }, null>;
    remove: FunctionReference<"mutation", { threadId: Id<"threads"> }, null>;
    setBackend: FunctionReference<
      "mutation",
      { threadId: Id<"threads">; backend: NonNullable<Doc<Model, "threads">["backend"]> },
      null
    >;
  };
  messages: ApiFromModule<typeof import("./backend/messages")>;
  permissions: Pick<ApiFromModule<typeof import("./backend/permissions")>, "answer">;
  runs: {
    running: FunctionReference<
      "query",
      {},
      {
        runId: Id<"runs">;
        threadId: Id<"threads">;
        waiting: boolean;
      }[]
    >;
    active: FunctionReference<"query", { threadId: Id<"threads"> }, Omit<Doc<Model, "runs">, "token"> | null>;
    cancel: FunctionReference<"mutation", { runId: Id<"runs"> }, null>;
    observe: FunctionReference<"mutation", { sweepId: string; tick: number }, null>;
  };
  backends: {
    list: FunctionReference<"action", {}, (import("./backends").BackendOption & { plugin: string })[]>;
    configure: FunctionReference<
      "action",
      { plugin: string; backendId: string; settings: import("@tokamak/sdk").JsonValue },
      import("@tokamak/sdk").JsonValue
    >;
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
