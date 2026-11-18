import { invoke, isTauri } from "@tauri-apps/api/core";

export type Endpoint = { http: string; ws: string; token: string | null };

export async function endpoint(): Promise<Endpoint> {
  if (isTauri()) return invoke<Endpoint>("tokamak_endpoint");
  const http = new URL(import.meta.env.VITE_TOKAMAK_HTTP || "http://127.0.0.1:43123");
  const ws = new URL("/ws", http);
  ws.protocol = http.protocol === "https:" ? "wss:" : "ws:";
  return {
    http: http.toString().replace(/\/$/, ""),
    ws: ws.toString(),
    token: import.meta.env.VITE_TOKAMAK_TOKEN || null,
  };
}
