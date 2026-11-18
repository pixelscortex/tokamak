import type { Endpoint } from "./endpoint";

/** Sync the existing connect form's saved name before opening the session. */
export async function syncDisplayName(endpoint: Endpoint, name?: string, request = fetch): Promise<void> {
  if (!name?.trim()) return;
  const url = new URL("/account", endpoint.http);
  if (endpoint.token) url.searchParams.set("token", endpoint.token);
  const response = await request(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("Could not read your server identity.");
  const user = (await response.json()) as { name: string };
  if (user.name === name.trim()) return;
  const renamed = await request(url, {
    method: "POST",
    // A simple browser request avoids a cross-origin preflight for desktop.
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ name: name.trim() }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!renamed.ok) throw new Error("Could not update your server name.");
}
