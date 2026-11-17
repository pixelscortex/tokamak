import { createApi, type FunctionReference, type Id } from "@tokamak/sdk";
export interface Thread {
  _id: Id<"threads">;
  title: string;
  updatedAt: number;
}
export interface Message {
  _id: Id<"messages">;
  role: string;
  parts: { type: string; text?: string }[];
  status: string;
}
export const api = createApi<{
  threads: {
    list: FunctionReference<"query", {}, Thread[]>;
    create: FunctionReference<"action", { title?: string }, Id<"threads">>;
  };
  messages: { list: FunctionReference<"query", { threadId: Id<"threads"> }, Message[]> };
  chat: { send: FunctionReference<"action", { threadId: Id<"threads">; text: string }, unknown> };
}>("chat");
