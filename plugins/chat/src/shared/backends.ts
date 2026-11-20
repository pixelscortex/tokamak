import type { FunctionReference, Id, JsonValue } from "@tokamak/sdk";
export type BackendOption = { id: string; title: string; folder?: boolean };
/** One earlier message; assistant records name the agent, model and effort that wrote them. */
export type HistoryRecord = {
  role: string;
  agent?: string;
  model?: string;
  effort?: string;
  content: string;
};
export type TurnArgs = {
  runId: Id<"runs">;
  token: string;
  messageId: Id<"messages">;
  threadId: Id<"threads">;
  backendId: string;
  text: string;
  history: HistoryRecord[];
  settings: JsonValue;
  state?: JsonValue;
};
export type TurnResult = {
  runId: Id<"runs">;
  messageId: Id<"messages">;
  status: "done" | "error" | "cancelled";
};
/** Today's provides/consumes contract: public backend module functions. */
export type BackendApi = {
  backend: {
    describe: FunctionReference<"action", {}, BackendOption[]>;
    configure: FunctionReference<"action", { backendId: string; settings: JsonValue }, JsonValue>;
    turn: FunctionReference<"action", TurnArgs, TurnResult>;
  };
};
