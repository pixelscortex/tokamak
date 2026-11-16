import { getOwner, onCleanup, runWithOwner } from "solid-js";
import type { TokamakClient } from "@tokamak/sdk";
import type { MemoryRouter } from "@tokamak/runtime/router";
import type { Shortcuts } from "@tokamak/sdk/client";
import { useChat } from "./use-chat";
import { useDrafts } from "./use-drafts";

// The loader owns this module's root and disposes it on unload/reload.
const owner = getOwner();
let session: { chat: ReturnType<typeof useChat>; composer: ReturnType<typeof useDrafts> } | undefined;
export function useChatSession(client: TokamakClient, router: MemoryRouter, shortcuts: Shortcuts) {
  if (!owner) throw new Error("Chat requires a plugin module owner");
  return (session ??= runWithOwner(owner, () => {
    const chat = useChat(client);
    const composer = useDrafts(chat);
    onCleanup(
      shortcuts.registerShortcut("Meta+n", () => {
        void chat.createThread().then((id) => {
          if (id) router.navigate("/chat");
        });
      }),
    );
    onCleanup(() => {
      session = undefined;
    });
    return { chat, composer };
  })!);
}
