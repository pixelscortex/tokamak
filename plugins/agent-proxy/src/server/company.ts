import type {} from "@tokamak/sdk/web";
import type { Addresses } from "./addresses";

/**
 * What every company's sign-in gives the rest of the plugin. `signins.ts` and
 * `logins.ts` know only this shape; each company's details (its link, what a
 * person may paste, how it trades a code, how it renews, where it reads the
 * plan and the models) live in one module per company: `claude.ts` and
 * `openai.ts`.
 *
 * Nothing that implements it logs or throws a login. Errors name the step and
 * the HTTP status only, never a response body.
 */
export interface SignInCompany {
  /** The name a person reads in messages: "Claude would not renew the login." */
  readonly name: string;
  /** The company's sign-in page, holding the PKCE challenge and `state`; never the verifier. */
  link(addresses: Addresses, verifier: string, state: string): string;
  /** What the person pasted, read into a code and the state it came back with. */
  readPasted(text: string): Pasted;
  /** Trades the code for a login with the verifier only the server holds. Throws `SignInError`. */
  exchange(
    addresses: Addresses,
    pasted: { code: string; state: string },
    verifier: string,
  ): Promise<SignedIn>;
  /** A new login for `refresh`; only a definite refusal is `refused`. Never throws. */
  renew(addresses: Addresses, refresh: string): Promise<Renewal>;
  /**
   * The plan, the account (its company id, email and organisation or
   * workspace) and the models the login may use. Advisory: a read that fails
   * leaves a field out instead of failing the sign-in.
   */
  details(addresses: Addresses, signedIn: SignedIn): Promise<Details>;
}

export type Pasted = { code: string; state: string | undefined } | { error: string };

export interface Login {
  readonly access: string;
  readonly refresh: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
  /** OpenAI's ID token: its claims name the workspace the login acts for. Claude has none. */
  readonly idToken?: string;
}

export interface Identity {
  /** The company's own id for the account, so the same login is never added twice. */
  readonly accountId: string;
  readonly email?: string;
  /** Claude's organisation, or the ChatGPT workspace. */
  readonly organization?: string;
}

export interface SignedIn {
  readonly login: Login;
  readonly identity: Partial<Identity>;
}

export interface Details {
  /** "Max", "Plus", "Business"…, or "Free" when the company named none. */
  readonly plan: string;
  readonly identity: Partial<Identity>;
  readonly models: { id: string; name: string }[];
}

export class SignInError extends Error {
  constructor(
    readonly kind: "Refused" | "Unreachable",
    message: string,
  ) {
    super(message);
  }
}

export type Renewal =
  | { readonly kind: "renewed"; readonly login: Login }
  /** The company will not renew this refresh token: the account must sign in again. */
  | { readonly kind: "refused" }
  /** Not now: 429 (with the wait it asked for), other errors, a network error or an unreadable answer. */
  | { readonly kind: "later"; readonly afterMs?: number };

/** Seconds or an HTTP date in `Retry-After`, as milliseconds from now. */
export function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
