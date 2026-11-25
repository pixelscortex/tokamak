import type {} from "@tokamak/sdk/web";
import type { Addresses } from "./addresses";
import { challenge } from "./pkce";

/**
 * Claude's subscription sign-in, done by the server over the network the way
 * CLIProxyAPI does it (internal/auth/claude/anthropic_auth.go, public source):
 * the same client id, scopes, authorize parameters and redirect as the
 * Claude Code CLI, a JSON token exchange that carries `state`, and a JSON
 * refresh with the narrower scope. The redirect is a localhost address no one
 * listens on: with `code=true` Claude's page shows `code#state` for the
 * person to paste, and a browser that does follow it ends on a link that
 * holds both.
 *
 * Nothing here logs or throws a login. Errors name the step and the HTTP
 * status only, never a response body.
 */

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const REDIRECT = "http://localhost:54545/callback";
const REFRESH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/** A new login also asks for the Console scope, as the native client does. */
const AUTHORIZE_SCOPE = `org:create_api_key ${REFRESH_SCOPE}`;
/** The subscription login works on the API only with this beta (CLIProxyAPI's request shape). */
export const OAUTH_BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 20_000;

/** The headers the native client's HTTP library sends to the OAuth endpoints. */
const OAUTH_HEADERS = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
  "user-agent": "axios/1.15.2",
};

export function signInLink(addresses: Addresses, verifier: string, state: string): string {
  const link = new URL(addresses.anthropic.authorize);
  const query = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT,
    scope: AUTHORIZE_SCOPE,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  return `${link.origin}${link.pathname}?${query.toString()}`;
}

export type Pasted = { code: string; state: string | undefined } | { error: string };

/**
 * What the person pasted: the whole link the browser ended on, or the
 * `code#state` Claude's page shows, or the code alone.
 */
export function readPasted(text: string): Pasted {
  const value = text.trim();
  if (!value) return { error: "Paste the link or the code from the sign-in page." };
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { error: "That link could not be read. Paste the whole link." };
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) return { error: "The sign-in page did not give a code. Start again." };
    if (!code) return { error: "That link has no code in it. Paste the whole link." };
    // A pasted Claude code can carry its state after a "#" inside the parameter too.
    const [bare, inner] = code.split("#", 2) as [string, string | undefined];
    return { code: bare, state: url.searchParams.get("state") ?? inner };
  }
  const [code, state] = value.split("#", 2) as [string, string | undefined];
  if (!code || /\s/.test(code))
    return { error: "That is not a sign-in code. Paste the code as the page shows it." };
  return { code, state };
}

export interface Login {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: number;
}

export interface Identity {
  readonly accountId: string;
  readonly email?: string;
  readonly organization?: string;
}

export class SignInError extends Error {
  constructor(
    readonly kind: "Refused" | "Unreachable",
    message: string,
  ) {
    super(message);
  }
}

async function post(url: string, body: Record<string, string>, step: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: OAUTH_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SignInError("Unreachable", `Claude could not be reached (${step}). Try again.`);
  }
}

type TokenAnswer = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: { uuid?: unknown; email_address?: unknown };
  organization?: { uuid?: unknown; name?: unknown };
};

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

function login(answer: TokenAnswer, previousRefresh?: string): Login {
  const access = text(answer.access_token);
  // A renewal that sends no new refresh token keeps the old one (CLIProxyAPI does the same).
  const refresh = text(answer.refresh_token) ?? previousRefresh;
  const seconds = typeof answer.expires_in === "number" ? answer.expires_in : 0;
  if (!access || !refresh) throw new SignInError("Refused", "Claude answered without a login. Start again.");
  return { access, refresh, expiresAt: Date.now() + seconds * 1000 };
}

/** Trades the pasted code for a login, with the verifier only the server holds. */
export async function exchange(
  addresses: Addresses,
  pasted: { code: string; state: string },
  verifier: string,
): Promise<{ login: Login; identity: Partial<Identity> }> {
  const response = await post(
    addresses.anthropic.token,
    {
      grant_type: "authorization_code",
      code: pasted.code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state: pasted.state,
    },
    "sign-in",
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new SignInError(
      response.status >= 500 ? "Unreachable" : "Refused",
      response.status >= 500
        ? `Claude could not finish the sign-in (HTTP ${response.status}). Try again.`
        : "Claude did not accept that code. It may have been used or expired. Start again.",
    );
  }
  const answer = (await response.json()) as TokenAnswer;
  return {
    login: login(answer),
    identity: {
      accountId: text(answer.account?.uuid),
      email: text(answer.account?.email_address),
      organization: text(answer.organization?.name),
    },
  };
}

/** A renewed login, `"refused"` when Claude will not renew it, or null when it could not be asked. */
export async function renew(addresses: Addresses, refresh: string): Promise<Login | "refused" | null> {
  let response: Response;
  try {
    response = await post(
      addresses.anthropic.token,
      { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh, scope: REFRESH_SCOPE },
      "renewal",
    );
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    // 400 and 401 are a dead refresh token (invalid_grant); 429 and 5xx are worth another try later.
    return response.status === 400 || response.status === 401 ? "refused" : null;
  }
  try {
    return login((await response.json()) as TokenAnswer, refresh);
  } catch {
    return null;
  }
}

async function get(url: string, access: string, headers: Record<string, string> = {}) {
  try {
    const response = await fetch(url, {
      headers: { ...OAUTH_HEADERS, authorization: `Bearer ${access}`, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return (await response.json()) as Record<string, unknown>;
    await response.body?.cancel();
  } catch {
    // The profile and the model list are advisory: the sign-in does not fail on them.
  }
  return undefined;
}

const PLANS: Record<string, string> = {
  claude_max: "Max",
  claude_pro: "Pro",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
};

/** The plan, email and organisation the profile endpoint reports. */
export async function profile(
  addresses: Addresses,
  access: string,
): Promise<{ plan: string; identity: Partial<Identity> }> {
  const answer = (await get(`${addresses.anthropic.api}/api/oauth/profile`, access)) as
    | {
        account?: { uuid?: unknown; email?: unknown; has_claude_max?: unknown; has_claude_pro?: unknown };
        organization?: { name?: unknown; organization_type?: unknown };
      }
    | undefined;
  const type = text(answer?.organization?.organization_type);
  const plan =
    (type && PLANS[type]) ??
    (answer?.account?.has_claude_max === true
      ? "Max"
      : answer?.account?.has_claude_pro === true
        ? "Pro"
        : "Free");
  return {
    plan,
    identity: {
      accountId: text(answer?.account?.uuid),
      email: text(answer?.account?.email),
      organization: text(answer?.organization?.name),
    },
  };
}

/** The models this login may use, by the names Claude gives them. */
export async function models(addresses: Addresses, access: string): Promise<{ id: string; name: string }[]> {
  const answer = await get(`${addresses.anthropic.api}/v1/models?limit=100`, access, {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": OAUTH_BETA,
  });
  const data = Array.isArray(answer?.data) ? (answer.data as { id?: unknown; display_name?: unknown }[]) : [];
  return data.flatMap((model) => {
    const id = text(model.id);
    return id ? [{ id, name: text(model.display_name) ?? id }] : [];
  });
}
