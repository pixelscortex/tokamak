/**
 * Questions the client can ask a server before it connects.
 *
 * The server's `/health` answers `ok` but sends no CORS header, so a page on another
 * origin usually cannot read it. A `no-cors` request still tells whether anything
 * answered, which is all "found the server" claims.
 */

export type Reach = { ok: true; ms: number } | { ok: false; kind: "no-answer" | "not-tokamak"; ms: number };

export type Access = "accepted" | "rejected" | "unknown";

export interface ProbeOptions {
  signal?: AbortSignal;
  /** How long to wait for an answer before giving up. */
  timeout?: number;
}

export async function reach(origin: string, options: ProbeOptions = {}): Promise<Reach> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  return withTimeout(options, async (signal) => {
    const url = `${origin}/health`;
    try {
      const response = await fetch(url, { cache: "no-store", signal });
      if (response.ok && (await response.text()).trim() === "ok") return { ok: true, ms: ms() };
      return { ok: false, kind: "not-tokamak", ms: ms() };
    } catch {
      if (signal.aborted) return { ok: false, kind: "no-answer", ms: ms() };
    }
    try {
      await fetch(url, { cache: "no-store", mode: "no-cors", signal });
      return { ok: true, ms: ms() };
    } catch {
      return { ok: false, kind: "no-answer", ms: ms() };
    }
  });
}

/**
 * Asks for the plugin catalog with a token: the request every connection makes first.
 * The server lets an allowed origin read its 401, so a rejected token is told apart
 * from a refused origin or a lost connection, which both read as "unknown".
 */
export async function checkAccess(
  origin: string,
  token: string,
  options: ProbeOptions = {},
): Promise<Access> {
  return withTimeout(options, async (signal) => {
    try {
      const url = new URL("/plugins", origin);
      url.searchParams.set("token", token);
      const response = await fetch(url, { cache: "no-store", signal });
      if (response.ok) return "accepted";
      return response.status === 401 ? "rejected" : "unknown";
    } catch {
      return "unknown";
    }
  });
}

async function withTimeout<T>(options: ProbeOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeout ?? 10_000);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
