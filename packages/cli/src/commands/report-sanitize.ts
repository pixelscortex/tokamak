import { homedir } from "node:os";

const credentialKey =
  /authorization|cookie|token|secret|password|passwd|api[\s_.-]*key|access[\s_.-]*key|bearer|session/i;
const assignment = /(?:^|[\s{,])["']?([\w.-]+(?:[ \t]+(?:key|token))?)["']?\s*([:=])/gi;
const address = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'`]+/gi;

export function reportSanitizer(secrets: (string | undefined)[]) {
  const home = homedir();
  const variants = [
    ...new Set(
      secrets
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => {
          const encoded = encodeURIComponent(value);
          const bytes = Buffer.from(value);
          return [
            value,
            encoded,
            encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
            new URLSearchParams({ value }).toString().slice(6),
            bytes.toString("base64"),
            bytes.toString("base64").replace(/=+$/, ""),
            bytes.toString("base64url"),
          ];
        }),
    ),
  ].sort((a, b) => b.length - a.length);

  function known(text: string) {
    for (const secret of variants) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  }

  function shorten(text: string) {
    return home.length > 1 ? text.replaceAll(home, "~") : text;
  }

  function value(text: string, log = false) {
    // Decode escaped credential keys before recognizing assignments.
    text = known(text).replace(/\\u([\da-f]{4})|\\x([\da-f]{2})/gi, (_, unicode, hex) =>
      String.fromCharCode(Number.parseInt(unicode ?? hex, 16)),
    );
    text = known(text).replace(address, (match) => {
      try {
        const url = new URL(match);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[omitted invalid address]";
      }
    });
    // Drop the entire message when there is a credential assignment: cookies
    // and authorization values can contain multiple words and delimiters.
    for (const [, key, separator] of text.matchAll(assignment)) {
      if (credentialKey.test(key!) || (separator === "=" && /^[A-Z][A-Z0-9_]*$/.test(key!))) {
        return "[REDACTED: credential-bearing text]";
      }
    }
    return shorten(text)
      .replace(/\b(?:bearer|basic)\s+\S+/gi, "[REDACTED]")
      .replace(log ? /[a-zA-Z0-9+/_-]{32,}(?:={1,2})?/g : /[a-zA-Z0-9+_-]{32,}(?:={1,2})?/g, "[REDACTED]");
  }

  function logLine(line: string) {
    const match =
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(?:([\w.:-]+):\s+)?(.*)$/.exec(
        line,
      );
    if (!match) return `[omitted unrecognized log line: ${Buffer.byteLength(line)} bytes]`;
    const [, time, level, component, message] = match;
    return `${known(time!)} ${known(level!)} ${component ? value(component) + ": " : ""}${value(message!, true)}`;
  }

  function indexPath(path: string) {
    const short = value(path);
    return /^~(?:[\\/]|$)/.test(short) ? short : "[path outside home omitted]";
  }

  return {
    value,
    indexPath,
    logLine,
    buildId: (id: string | null) => (id && /^[a-f0-9]{64}$/i.test(id) ? known(id) : "unknown"),
  };
}
