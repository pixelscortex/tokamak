import { bindActionCall, type ActionContext } from "./functions";
import { callHost, type HostBridge } from "./host";

const httpActionBrand = Symbol("tokamak.httpAction");

// Resolve the platform types in the author's project so the portable SDK can
// still be checked without the optional web declarations.
type WebType<K extends string> = typeof globalThis extends Record<K, { prototype: infer T }> ? T : never;

type HttpActionCapabilities = Pick<ActionContext, "runQuery" | "runMutation" | "runAction" | "env">;

export interface HttpActionContext extends HttpActionCapabilities {
  readonly serverUrl: string;
  readonly path: string;
  readonly originalHost: string | null;
  readonly params: Readonly<Record<string, string>>;
}

export interface HttpActionDefinition<Path extends string = string> {
  readonly [httpActionBrand]: true;
  readonly path: Path;
  readonly handler: (
    ctx: HttpActionContext,
    request: WebType<"Request">,
  ) => WebType<"Response"> | Promise<WebType<"Response">>;
}

/** Declare an HTTP route in the plugin's server part. */
export function httpAction<const Path extends string>(
  definition: Omit<HttpActionDefinition<Path>, typeof httpActionBrand>,
): HttpActionDefinition<Path> {
  return Object.freeze({ ...definition, [httpActionBrand]: true as const });
}

// The generated HTTP entry passes a request-scoped host bridge, never a global.
export function bindHttpAction({ handler }: HttpActionDefinition) {
  return (
    context: Omit<HttpActionContext, keyof HttpActionCapabilities>,
    request: WebType<"Request">,
    bridge: HostBridge,
  ) => {
    const capabilities = {
      runQuery: bindActionCall(bridge, "query"),
      runMutation: bindActionCall(bridge, "mutation"),
      runAction: bindActionCall(bridge, "action"),
      env: (name: string) => callHost(bridge, "action.env", { name }),
    } as HttpActionCapabilities;
    return handler(Object.freeze(Object.assign(context, capabilities)), request);
  };
}
