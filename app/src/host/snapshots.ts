import { bearerHeaders } from "./auth";
import type { Endpoint } from "./endpoint";

export async function readSnapshots<T>(
  endpoint: Endpoint,
  path: string,
  signal: AbortSignal,
  update: (snapshot: T) => void,
) {
  const response = await fetch(new URL(path, endpoint.http), {
    headers: bearerHeaders(endpoint.token),
    cache: "no-store",
    signal,
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok || !response.body) throw new Error("Could not read the list");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) break;
      pending += decoder.decode(value, { stream: true });
      // The server sends one JSON snapshot per data line, ignoring SSE comments
      // used to keep the connection alive.
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.startsWith("data:")) update(JSON.parse(line.slice(5)) as T);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return true;
}
