import type { Company } from "./api";

/**
 * What the add-subscription dialog says for each company (Paper "2 · Add a
 * subscription"). The steps themselves are one flow for every company; only
 * these words differ. The sign-in, its link and what may be pasted are
 * agent-proxy's, one module per company.
 */
export interface CompanyWords {
  /** The company row and the method step's title. */
  readonly name: string;
  /** The subscription method and the plans under it. */
  readonly method: string;
  readonly plans: string;
  /** Where an API key would come from, under the disabled "API key" row. */
  readonly keys: string;
  /** "Sign in to Claude": the sign-in step's title. */
  readonly signIn: string;
  /** The return address the browser ends on, as the paste field's placeholder. */
  readonly returnAddress: string;
}

export const COMPANIES: readonly Company[] = ["anthropic", "openai"];

export const wordsOf: Record<Company, CompanyWords> = {
  anthropic: {
    name: "Anthropic",
    method: "Claude subscription",
    plans: "Pro · Max · Team · Enterprise",
    keys: "From the Anthropic console",
    signIn: "Sign in to Claude",
    returnAddress: "http://localhost:54545/callback?code=…",
  },
  openai: {
    name: "OpenAI",
    method: "ChatGPT subscription",
    plans: "Plus · Pro · Business · Enterprise",
    keys: "From the OpenAI platform",
    signIn: "Sign in to ChatGPT",
    returnAddress: "http://localhost:1455/auth/callback?code=…",
  },
};
