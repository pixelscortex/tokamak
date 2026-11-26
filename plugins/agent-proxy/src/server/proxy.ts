import { httpAction } from "@tokamak/sdk";
import type {} from "@tokamak/sdk/web";
import { internal } from "./_generated/internal";
import { companyAddresses } from "./addresses";
import { OAUTH_BETA } from "./claude";
import { turnKeyHash } from "./sets";

const error = (status: number, type: string, message: string) =>
  Response.json({ type: "error", error: { type, message } }, { status });

function requestKey(headers: Headers) {
  const apiKey = headers.get("x-api-key");
  const auth = headers.get("authorization");
  const bearer = auth?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1];
  if (auth !== null && (!bearer || (apiKey !== null && apiKey !== bearer))) return null;
  const key = bearer ?? apiKey;
  return key && turnKeyHash(key);
}

/** Only a known account window rules the account out of subsequent requests. */
function accountLimit(response: Response): number {
  if (response.status !== 429) return 0;
  const headers = response.headers;
  let until = 0;
  for (const window of ["5h", "7d"]) {
    const prefix = `anthropic-ratelimit-unified-${window}`;
    if (headers.get(`${prefix}-status`)?.toLowerCase() === "rejected") {
      const reset = Number(
        headers.get(`${prefix}-reset`) ?? headers.get("anthropic-ratelimit-unified-reset"),
      );
      if (Number.isFinite(reset)) until = Math.max(until, reset * 1000);
    }
  }
  return until;
}

function claudeHeaders(incoming: Headers, access: string) {
  const headers = new Headers(incoming);
  // CLIProxyAPI's Claude executor uses Bearer + the OAuth beta instead of an API key.
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${access}`);
  const betas = headers.get("anthropic-beta");
  if (!betas?.split(",").some((beta) => beta.trim() === OAUTH_BETA))
    headers.set("anthropic-beta", betas ? `${betas},${OAUTH_BETA}` : OAUTH_BETA);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  return headers;
}

function targetUrl(base: string, path: string, requestUrl: string) {
  // Route params are decoded. Use the original encoded remainder and query.
  const slash = path.indexOf("/", 1);
  const remainder = slash === -1 ? "/" : path.slice(slash);
  const query = requestUrl.indexOf("?");
  return base.replace(/\/$/, "") + remainder + (query === -1 ? "" : requestUrl.slice(query));
}

export const proxy = httpAction({
  path: "/:set/*",
  async handler(ctx, request) {
    const hash = requestKey(request.headers);
    if (!hash) return error(401, "authentication_error", "Missing or invalid turn key.");

    try {
      const args = { set: ctx.params.set!, hash };
      const route = await ctx.runQuery(internal.sets.candidates, args);
      if (!route.ok) return error(401, "authentication_error", route.error);

      for (const account of route.accounts) {
        const { owner } = route;
        const login = await ctx.runAction(internal.logins.fresh, { owner, account: account.id });
        if (!login) continue;
        const addresses = await companyAddresses(ctx);
        // Recheck after renewal: the turn can end, or the account can be removed,
        // paused, signed out, or limited while the provider answers.
        const current = await ctx.runQuery(internal.sets.candidates, args);
        if (!current.ok) return error(401, "authentication_error", current.error);
        if (!current.accounts.some(({ id }) => id === account.id)) continue;
        if (request.signal.aborted) return new Response(null, { status: 499 });

        const response = await fetch(targetUrl(addresses.anthropic.api, ctx.path, request.url), {
          method: request.method,
          headers: claudeHeaders(request.headers, login.access),
          body: request.body,
          redirect: "manual",
          signal: request.signal,
        });
        try {
          await ctx.runMutation(internal.sets.recordForward, {
            owner,
            subscription: account.subscription,
            account: account.id,
            limitedUntil: accountLimit(response),
          });
        } catch (cause) {
          await response.body?.cancel();
          throw cause;
        }
        return response;
      }
      return error(503, "overloaded_error", "No usable Claude subscription in this set.");
    } catch {
      // Fetch and host errors may carry request details. Never surface those.
      return error(502, "api_error", "The Claude request could not be forwarded.");
    }
  },
});
