import { callHost, type HostBridge } from "./host";
import { jsonSnapshot } from "./values";

declare const pointBrand: unique symbol;

export interface Point {
  readonly [pointBrand]: true;
  <T>(name: string, value: T): Promise<T>;
  <I, R>(name: string, input: I, run: (input: I) => R): Promise<PointResult<Awaited<R>>>;
}

type PointResult<T> = T extends void ? null : T;

export function bindPoint(
  host: HostBridge,
  scope: Pick<HostBridge, "pointOwner" | "hookPoints"> = host,
): Point {
  const { name: owner, declared } = scope.pointOwner ?? {};
  const active = scope.hookPoints;
  const points = active?.length ? new Set(active) : undefined;
  return (async <I, R>(name: string, args: I, run?: (args: I) => R) => {
    if (!declared?.includes(name))
      throw new Error(`Point "${name}" is not declared by function "${owner ?? "unknown"}"`);
    if (!points?.has(name)) {
      if (!run) return args;
      const result = await run(args);
      return result === undefined ? null : result;
    }

    const input = await callHost(host, "point.stage", {
      name,
      stage: "before",
      args: jsonSnapshot(args, "point input", Infinity, true),
    });
    if (!run) return input;

    const result = await run(input as I);
    return callHost(host, "point.stage", {
      name,
      stage: "after",
      args: input,
      result: jsonSnapshot(result === undefined ? null : result, "point result", Infinity, true),
    });
  }) as Point;
}
