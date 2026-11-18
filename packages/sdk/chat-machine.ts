import { createContext } from "solid-js";
import type { Id } from "./src/values";

export interface ChatMachine {
  list(): Promise<{ id: string; plugin: string; title: string; folder?: boolean }[]>;
  configure(backendId: string, cwd: string): Promise<string>;
  send(args: {
    threadId: Id<"threads">;
    text: string;
    backendId: string;
    requestId: string;
    cwd: string;
  }): Promise<unknown>;
}

export type RemoteChat = { hub: string; machine?: ChatMachine };
export const ChatMachineContext = createContext<RemoteChat | null>(null);
