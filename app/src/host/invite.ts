/**
 * Server addresses and invites.
 *
 * An invite is one string a server's owner can send: `https://<address>/join#<token>`.
 * The token sits in the fragment, so a browser that opens the link never sends it to
 * the server in the request line. `<address>#<token>` is accepted too, and so is a bare
 * address or URL without a token.
 */

export interface ServerAddress {
  /** The server's origin, such as `https://tokamak.example.app`; no path, no slash. */
  origin: string;
  /** Host and port as typed, such as `tokamak.example.app` or `127.0.0.1:43124`. */
  host: string;
  secure: boolean;
}

export type ParsedInvite =
  | { ok: true; address: ServerAddress; token?: string }
  | { ok: false; reason: string };

const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isLoopback(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    name === "localhost" || name.endsWith(".localhost") || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name)
  );
}

/** Reads an address, a URL or a whole invite. */
export function parseInvite(input: string): ParsedInvite {
  const text = input.trim();
  if (!text) return { ok: false, reason: "Enter the server's address." };
  const hash = text.indexOf("#");
  const rest = hash < 0 ? text : text.slice(0, hash);
  let token: string | undefined;
  if (hash >= 0) {
    try {
      token = decodeURIComponent(text.slice(hash + 1)).trim() || undefined;
    } catch {
      return { ok: false, reason: "The invite's token is damaged. Ask for the invite again." };
    }
  }
  const address = parseAddress(rest);
  return address.ok ? { ok: true, address: address.address, ...(token ? { token } : {}) } : address;
}

function parseAddress(text: string): { ok: true; address: ServerAddress } | { ok: false; reason: string } {
  const bad = { ok: false, reason: "That doesn't look like a server address." } as const;
  if (!text || /\s/.test(text)) return bad;
  let url: URL;
  try {
    // A bare loopback address is a server on this computer, which has no certificate.
    const bare = !scheme.test(text);
    url = new URL(bare ? `https://${text}` : text);
    if (bare && isLoopback(url.hostname)) url = new URL(`http://${text}`);
  } catch {
    return bad;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return bad;
  if (!url.hostname || url.username || url.password) return bad;
  if (url.protocol === "http:" && !isLoopback(url.hostname))
    return { ok: false, reason: "Use an https:// address for a server on another computer." };
  return { ok: true, address: { origin: url.origin, host: url.host, secure: url.protocol === "https:" } };
}

/** The one invite format: `https://<address>/join#<token>`. */
export function buildInvite(origin: string, token: string): string {
  return `${new URL(origin).origin}/join#${encodeURIComponent(token)}`;
}

/**
 * A name for a server until it can report its own: the first label of a domain
 * (`tokamak-pixelscortex` for `tokamak-pixelscortex.up.railway.app`), or the whole
 * host for an IP address or a loopback name.
 */
export function nameFromHost(host: string): string {
  const hostname = host.replace(/:\d+$/, "");
  if (isLoopback(hostname) || /^[\d.]+$/.test(hostname) || hostname.startsWith("[")) return host;
  return hostname.split(".")[0] || host;
}
