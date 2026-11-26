import type { ActionContext, MutationContext, QueryContext } from "./functions";
import { callHost, type HostBridge } from "./host";
import { jsonSnapshot } from "./values";

declare const pointBrand: unique symbol;

type PointContext = Pick<QueryContext<{}> | MutationContext<{}> | ActionContext, "call">;

interface Point {
  readonly [pointBrand]: true;
  <T>(ctx: PointContext, name: string, value: T): Promise<T>;
  <T>(
    ctx: PointContext,
    name: string,
    value: T,
    options: { collect: true },
  ): Promise<readonly PointContribution<T>[]>;
  <I, R>(ctx: PointContext, name: string, input: I, run: (input: I) => R): Promise<PointResult<Awaited<R>>>;
}
export type PointContribution<T> = { readonly plugin: string; readonly value: T };

type PointResult<T> = T extends void ? null : T;
type PointOption<I, R> = { collect: true } | ((args: I) => R);
type PointBinding = <I, R>(name: string, args: I, option?: PointOption<I, R>) => Promise<unknown>;
export type PointLifetime = { active: boolean };

const bindings = new WeakMap<PointContext, PointBinding>();

export const point = (async <I, R>(ctx: PointContext, name: string, args: I, option?: PointOption<I, R>) => {
  const binding = bindings.get(ctx);
  if (!binding) throw new Error("point(ctx, ...) requires the context of its query, mutation or action");
  return binding(name, args, option);
}) as Point;

export function bindPoint<C extends PointContext>(
  ctx: C,
  host: HostBridge,
  lifetime: PointLifetime,
  scope: Pick<HostBridge, "pointOwner" | "hookPoints"> = host,
): C {
  const { name: owner, declared } = scope.pointOwner ?? {};
  const active = scope.hookPoints;
  const points = active?.length ? new Set(active) : undefined;
  const requireActive = () => {
    if (!lifetime.active) throw new Error("Cannot use point(ctx, ...) after its call has ended");
  };

  bindings.set(ctx, async <I, R>(name: string, args: I, option?: PointOption<I, R>) => {
    requireActive();
    if (!declared?.includes(name))
      throw new Error(`Point "${name}" is not declared by function "${owner ?? "unknown"}"`);
    const run = typeof option === "function" ? option : undefined;
    const collect = typeof option === "object" && option.collect === true;
    if (!points?.has(name)) {
      if (collect) return [];
      if (!run) return args;
      const result = await run(args);
      return result === undefined ? null : result;
    }

    const input = await callHost(host, "point.stage", {
      name,
      stage: collect ? "collect" : "before",
      args: jsonSnapshot(args, "point input", Infinity, true),
    });
    if (!run) return input;

    requireActive();
    const result = await run(input as I);
    requireActive();
    return callHost(host, "point.stage", {
      name,
      stage: "after",
      args: input,
      result: jsonSnapshot(result === undefined ? null : result, "point result", Infinity, true),
    });
  });
  return ctx;
}
