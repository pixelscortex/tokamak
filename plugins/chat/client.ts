/** UI-safe references: importing the backend action's inferred type also imports
 * its Web API declarations, which do not belong in a native QuickJS UI. */
import { createApi, type ApiFromModule, type FunctionReference, type Id } from "@tokamak/sdk";

export const api = createApi<{
  threads: ApiFromModule<typeof import("./backend/threads")>;
  members: ApiFromModule<typeof import("./backend/members")>;
  messages: ApiFromModule<typeof import("./backend/messages")>;
  permissions: Pick<ApiFromModule<typeof import("./backend/permissions")>, "answer">;
  runs: ApiFromModule<typeof import("./backend/runs")>;
  agents: {
    list: FunctionReference<"action", {}, { id: string; title: string }[]>;
    checkFolder: FunctionReference<"action", { path: string }, null>;
  };
  chat: {
    send: FunctionReference<"action", { threadId: Id<"threads">; text: string }, {
      runId: Id<"runs">;
      messageId: Id<"messages">;
      status: "done" | "error" | "cancelled";
    }>;
  };
}>("chat");
