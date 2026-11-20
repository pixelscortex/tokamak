/** The model and effort an ACP session reports, as names people recognise. */
export type SessionModel = { name?: string; id?: string; effort?: string };

type Choice = { value: string; name: string; description?: string };

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

function choices(options: unknown): Choice[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option): Choice[] => {
    if (!option || typeof option !== "object") return [];
    const item = option as Record<string, unknown>;
    if (Array.isArray(item.options)) return choices(item.options);
    const value = text(item.value);
    if (!value) return [];
    const description = text(item.description);
    return [{ value, name: text(item.name) ?? value, ...(description ? { description } : {}) }];
  });
}

function selected(options: unknown[], category: string) {
  const option = options.find(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && (item as Record<string, unknown>).category === category,
  );
  const current = text(option?.currentValue);
  if (!option || !current) return undefined;
  const list = choices(option.options);
  return { current, list, choice: list.find((item) => item.value === current) };
}

/**
 * Read the model and effort from a session/new, load or resume response, or a
 * `config_option_update` notification. Uses the ACP config options (`model` and
 * `thought_level` categories), falling back to the older `models` state.
 */
export function sessionModel(response: unknown): SessionModel | undefined {
  if (!response || typeof response !== "object") return undefined;
  const { configOptions, models } = response as { configOptions?: unknown; models?: unknown };
  const result: SessionModel = {};
  if (Array.isArray(configOptions)) {
    const model = selected(configOptions, "model");
    if (model) {
      let choice = model.choice;
      // A "default" choice names the model it stands for in its description
      // (Claude: "Opus"); prefer the concrete option, which carries the version.
      if (choice && model.current === "default" && choice.description) {
        const family = choice.description.toLowerCase();
        choice =
          model.list.find((item) => item.value !== "default" && item.name.toLowerCase().startsWith(family)) ??
          choice;
      }
      result.name = choice?.name ?? model.current;
      result.id = choice?.value ?? model.current;
    }
    const effort = selected(configOptions, "thought_level");
    if (effort) result.effort = effort.choice?.name ?? effort.current;
  }
  if (!result.name && models && typeof models === "object") {
    const state = models as { currentModelId?: unknown; availableModels?: unknown };
    const id = text(state.currentModelId);
    if (id) {
      const known = Array.isArray(state.availableModels)
        ? (state.availableModels as Record<string, unknown>[]).find((item) => item?.modelId === id)
        : undefined;
      result.id = id;
      result.name = text(known?.name) ?? id;
    }
  }
  return result.name || result.effort ? result : undefined;
}
