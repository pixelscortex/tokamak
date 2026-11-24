/** Keep positive discovery answers briefly; never hide a fresh install or sign-in. */
export const AGENT_INFO_MAX_AGE_MS = 15_000;

export function agentInfoCache<Context, Info extends { installed: boolean; signedIn: boolean }>(
  probe: (ctx: Context) => Promise<Info>,
  revision: () => Promise<string>,
) {
  let cached: { revision: string; until: number; info: Info } | undefined;
  let generation = 0;
  return {
    async read(ctx: Context, { fresh = false } = {}): Promise<Info & { cacheUntil?: number }> {
      if (fresh) {
        generation++;
        cached = undefined;
      }
      const current = await revision();
      if (cached?.revision === current && cached.until > Date.now())
        return { ...cached.info, cacheUntil: cached.until };
      const request = ++generation;
      const info = await probe(ctx);
      if (!info.installed || !info.signedIn || request !== generation) return info;
      const until = Date.now() + AGENT_INFO_MAX_AGE_MS;
      cached = { revision: current, until, info };
      return { ...info, cacheUntil: until };
    },
    invalidate() {
      generation++;
      cached = undefined;
    },
  };
}
