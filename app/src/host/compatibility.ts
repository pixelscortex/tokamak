import { version } from "../../src-tauri/tauri.conf.json";

export const appVersion = version;

type Compatibility = "fits" | "app-too-old" | "newer-line" | "older-line" | "other-line";

export function compatibility(app: unknown, build: unknown): Compatibility {
  const parse = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const version = value.replace(/^tokamak@/, "");
    if (version === "^0.1") return [0n, 1n, 0n] as const;
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
        version,
      );
    if (!match || match[0] !== version) return undefined;
    if (match[4]?.split(".").some((id) => /^0\d+$/.test(id))) return undefined;
    return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)] as const;
  };
  const installed = parse(app);
  const requested = parse(build);
  if (!installed || !requested) return "other-line";
  const line = requested[0] - installed[0] || requested[1] - installed[1];
  if (line !== 0n) return line > 0n ? "newer-line" : "older-line";
  return requested[2] > installed[2] ? "app-too-old" : "fits";
}

export async function serverVersionNotice(origin: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/version", origin), {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const fit = compatibility(appVersion, (await response.json())?.version);
    if (fit === "newer-line") return "Update the app";
    if (fit === "older-line") return "This server needs an update";
  } catch {
    // A failed probe does not tell us which version is running.
  }
}
