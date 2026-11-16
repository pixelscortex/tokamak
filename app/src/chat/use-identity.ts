import { createSignal, onCleanup } from "solid-js";
import type { ResultOf, TokamakClient } from "@tokamak/sdk";
import { api } from "../../../plugins/chat/client";

export type Identity = ResultOf<typeof api.members.hello>;

/** Announces this member on connect and keeps the server's view of who we are.
 * The role comes from the server's caller, never from local configuration. */
export function useIdentity(client: TokamakClient, setError: (error: string) => void) {
  const [identity, setIdentity] = createSignal<Identity>();
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  void client
    .mutation(api.members.hello, {})
    .then((value) => {
      if (alive) setIdentity(value);
    })
    .catch((cause) => {
      if (alive) setError(String(cause));
    });

  return identity;
}

/** The owner keeps the original "K" mark; guests show their own initial. */
export function authorInitial(author: { role?: "owner" | "guest"; name?: string }) {
  if (author.role !== "guest") return "K";
  return Array.from(author.name ?? "?")[0]?.toUpperCase() ?? "?";
}
