const production = {
  anthropic: {
    authorize: "https://claude.ai/oauth/authorize",
    token: "https://platform.claude.com/v1/oauth/token",
    api: "https://api.anthropic.com",
  },
  openai: {
    authorize: "https://auth.openai.com/oauth/authorize",
    token: "https://auth.openai.com/oauth/token",
    api: "https://chatgpt.com/backend-api",
  },
} as const;

export type Company = keyof typeof production;
export type Addresses = { [C in Company]: { [K in keyof (typeof production)[C]]: string } };

// QuickJS does not expose ambient environment variables. Tests inject addresses
// at the server call site; this helper is never registered as a plugin function.
export function companyAddresses(override?: Addresses): Addresses {
  const addresses = override ?? production;
  return { anthropic: { ...addresses.anthropic }, openai: { ...addresses.openai } };
}
