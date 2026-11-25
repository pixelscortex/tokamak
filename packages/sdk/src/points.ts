import { callHost, type HostBridge } from "./host";
import { jsonSnapshot } from "./values";

declare const pointBrand: unique symbol;

export interface Point {
  readonly [pointBrand]: true;
  <T>(name: string, value: T): Promise<T>;
  <I, R>(name: string, input: I, run: (input: I) => R): Promise<Awaited<R>>;
}

export function bindPoint(host: HostBridge, active?: readonly string[]): Point {
  const points = active?.length ? new Set(active) : undefined;
  return (async <I, R>(name: string, args: I, run?: (args: I) => R) => {
    if (!points?.has(name)) return run ? run(args) : args;

    const input = await callHost(host, "point.stage", {
      name,
      stage: "before",
      args: jsonSnapshot(args, "point input"),
    });
    if (!run) return input;

    const result = await run(input as I);
    return callHost(host, "point.stage", {
      name,
      stage: "after",
      args: input,
      result: jsonSnapshot(result, "point result"),
    });
  }) as Point;
}
