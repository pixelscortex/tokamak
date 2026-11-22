import { bearerHeaders } from "./auth";
import type { Endpoint } from "./endpoint";

/** Sync the existing connect form's saved name before opening the session. */
export async function syncDisplayName(endpoint: Endpoint, name?: string, request = fetch): Promise<void> {
  if (!name?.trim()) return;
  const url = new URL("/account", endpoint.http);
  const headers = bearerHeaders(endpoint.token);
  const response = await request(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("Could not read your server identity.");
  const user = (await response.json()) as { name: string };
  if (user.name === name.trim()) return;
  const renamed = await request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "text/plain" },
    body: JSON.stringify({ name: name.trim() }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!renamed.ok) throw new Error("Could not update your server name.");
}
