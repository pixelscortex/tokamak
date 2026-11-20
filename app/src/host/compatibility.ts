import { version } from "../../src-tauri/tauri.conf.json";

export const appVersion = version;

export function compatibility(app: unknown, build: unknown): "fits" | "app-too-old" | "other-line" {
  const parse = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const exact = /^(?:tokamak@)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    const legacy = /^tokamak@\^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    const parts = exact?.slice(1) ?? (legacy && [legacy[1]!, legacy[2]!, "0"]);
    return parts?.map(BigInt);
  };
  const installed = parse(app);
  const requested = parse(build);
  if (!installed || !requested || installed[0] !== requested[0] || installed[1] !== requested[1])
    return "other-line";
  return requested[2]! > installed[2]! ? "app-too-old" : "fits";
}

export async function serverCompatibility(origin: string) {
  try {
    const response = await fetch(new URL("/version", origin), {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return compatibility(appVersion, (await response.json())?.version);
  } catch {
    // Keep messages available when the server's version cannot be checked.
  }
  return "other-line";
}
