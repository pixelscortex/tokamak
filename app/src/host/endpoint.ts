export type Endpoint = { http: string; ws: string; token: string | null };

export async function endpoint(): Promise<Endpoint> {
  const host = window as typeof window & {
    __TAURI_INTERNALS__?: { invoke<T>(command: string): Promise<T> };
  };
  if (host.__TAURI_INTERNALS__) {
    return host.__TAURI_INTERNALS__.invoke<Endpoint>("tokamak_endpoint");
  }
  const http = new URL(import.meta.env.VITE_TOKAMAK_HTTP || "http://127.0.0.1:43123");
  const ws = new URL("/ws", http);
  ws.protocol = http.protocol === "https:" ? "wss:" : "ws:";
  return { http: http.toString().replace(/\/$/, ""), ws: ws.toString(), token: null };
}
