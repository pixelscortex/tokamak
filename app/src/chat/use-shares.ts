import { createMemo, createSignal } from "solid-js";
import { useQuery } from "@tokamak/sdk/solid";
import type { Id, TokamakClient } from "@tokamak/sdk";
import { api } from "../../../plugins/chat/client";

export type Sharing = ReturnType<typeof useShares>;

/** Owner-only subscriptions: known members and every thread share.
 * Create this only for the owner; the server refuses both queries for guests. */
export function useShares(client: TokamakClient, ownerId: string) {
  const members = useQuery(client, api.members.list, () => ({}));
  const shares = useQuery(client, api.threads.shares, () => ({}));
  const [saving, setSaving] = createSignal(false);
  const loading = () => members.data() === undefined || shares.data() === undefined;

  const guests = createMemo(() => (members.data() ?? [])
    .filter(member => member.memberId !== ownerId)
    .sort((a, b) => a.name.localeCompare(b.name)));

  const byThread = createMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const share of shares.data() ?? []) {
      const set = map.get(share.threadId) ?? new Set<string>();
      set.add(share.memberId);
      map.set(share.threadId, set);
    }
    return map;
  });

  const has = (threadId: string, memberId: string) => byThread().get(threadId)?.has(memberId) ?? false;

  async function toggle(threadId: Id<"threads">, memberId: string) {
    if (loading() || saving()) return;
    setSaving(true);
    try {
      const reference = has(threadId, memberId) ? api.threads.unshare : api.threads.share;
      await client.mutation(reference, { threadId, memberId });
    } finally {
      setSaving(false);
    }
  }

  return {
    members: guests,
    loading,
    error: () => members.error()?.message ?? shares.error()?.message,
    count: (threadId: string) => byThread().get(threadId)?.size ?? 0,
    has,
    toggle,
    saving,
  };
}
