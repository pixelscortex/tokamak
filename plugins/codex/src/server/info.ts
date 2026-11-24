import type { LocalContext } from "@tokamak/sdk";
import type { Info } from "plugin:ai/contracts";
import { AppServer } from "./rpc";

const MINIMUM_VERSION = "0.170.0";
const INSTALL = "npm install -g @openai/codex";
const SIGN_IN = "codex login";
const UNAVAILABLE: Info = {
  installed: false,
  signedIn: false,
  install: INSTALL,
  signIn: SIGN_IN,
  models: [],
  modes: [],
  speeds: [],
};

export async function codexInfo(ctx: LocalContext): Promise<Info> {
  if (!(await supported(ctx))) return UNAVAILABLE;
  const app = new AppServer(ctx);
  const available = { ...UNAVAILABLE, installed: true };
  try {
    await app.initialize();
    const { account, requiresOpenaiAuth } = await app.call<{
      account: object | null;
      requiresOpenaiAuth: boolean;
    }>("account/read", { refreshToken: false });
    if (!account && requiresOpenaiAuth !== false) return available;
    const [{ models, speeds }, modes] = await Promise.all([listModels(app), listModes(app)]);
    return { ...available, signedIn: true, models, modes, speeds };
  } finally {
    await app.close();
  }
}

type Model = {
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  serviceTiers?: { id: string }[];
};

async function listModels(app: AppServer) {
  const models: Model[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: { data: Model[]; nextCursor: string | null } = await app.call("model/list", {
      includeHidden: false,
      cursor,
    });
    models.push(...page.data.filter((model) => !model.hidden));
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Codex returned a repeated model cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  const tiers = new Set(models.flatMap((model) => model.serviceTiers?.map(({ id }) => id) ?? []));
  // With no catalog tiers there is no speed choice to show.
  tiers.delete("default");
  const speeds = tiers.size > 0 ? ["default", ...tiers] : [];
  return {
    speeds,
    models: models
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map((model) => ({
        id: model.model,
        name: model.displayName,
        efforts: model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort),
      })),
  };
}

async function listModes(app: AppServer) {
  const { data } = await app.call<{ data: { mode: string | null }[] }>("collaborationMode/list", {});
  // No selection already means Default. Keep it first when explicitly selected.
  return ["default", "plan"].filter((mode) => data.some((preset) => preset.mode === mode));
}

async function supported(ctx: LocalContext): Promise<boolean> {
  try {
    const child = ctx.proc(["codex", "--version"]);
    child.closeInput();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          let version: RegExpMatchArray | null = null;
          for await (const line of child.stdout) {
            version ??= line.match(/^codex-cli (\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/);
          }
          if ((await child.exited) !== 0 || !version) return false;
          const minimum = MINIMUM_VERSION.split(".").map(Number);
          const installed = version.slice(1).map(Number);
          const firstDifference = installed.findIndex((part, i) => part !== minimum[i]);
          return firstDifference === -1 || installed[firstDifference]! > minimum[firstDifference]!;
        })(),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), 5_000))),
      ]);
    } finally {
      clearTimeout(timer);
      child.stop();
    }
  } catch {
    return false;
  }
}
