export function bearerHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function socketProtocols(token: string | null): string[] | undefined {
  if (!token) return;
  // Browsers cannot set Authorization on WebSocket upgrades. Parentheses are
  // not valid subprotocol characters even though encodeURIComponent leaves them.
  const credential = encodeURIComponent(token).replace(/[()]/g, (char) => (char === "(" ? "%28" : "%29"));
  return ["tokamak", `tokamak.bearer.${credential}`];
}
