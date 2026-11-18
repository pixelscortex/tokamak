import type { Endpoint } from "./endpoint";

/** Only the desktop shell installs this callback. Hosted browser pages do nothing. */
export async function serveHubs(local: Endpoint, hubs: { url: string; token: string }[]): Promise<string> {
  const url = new URL("/machine/hubs", local.http);
  if (local.token) url.searchParams.set("token", local.token);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(hubs),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      (await response.text()).split("\n")[0] || "Could not connect your machine to the saved servers.",
    );
  return ((await response.json()) as { machineId: string }).machineId;
}
