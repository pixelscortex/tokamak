import type { User } from "@tokamak/sdk";
import { bearerHeaders } from "./auth";
import type { Endpoint } from "./endpoint";

export type MemberEntry = User & { hasAccount: boolean };
export interface MembersSnapshot {
  viewer: User;
  members: MemberEntry[];
}

export type MemberEdit = { kind: "add" } | { kind: "reset" | "remove" | "role"; member: MemberEntry };

export async function updateMembers(
  endpoint: Endpoint,
  path: string,
  signal: AbortSignal,
  body?: object,
): Promise<string | undefined> {
  const response = await fetch(new URL(path, endpoint.http), {
    method: "POST",
    headers: { ...bearerHeaders(endpoint.token), ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) return "Forbidden";
  const failure = await response.json().catch(() => undefined);
  return typeof failure?.kind === "string" ? failure.kind : "MemberManagementUnavailable";
}
