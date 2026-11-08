/** Portable packaging identity. Loading/lifecycle/capabilities are host concerns. */
export interface PluginDefinition {
  readonly id: string;
  readonly version: string;
}

function versionSyntax(version: string): boolean {
  const [head, build, ...extra] = version.split("+");
  if (extra.length || version.length > 256) return false;
  const separator = head!.indexOf("-");
  const core = separator < 0 ? head! : head!.slice(0, separator);
  const prerelease = separator < 0 ? undefined : head!.slice(separator + 1);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(core)) return false;
  const identifiers = (part: string, pre: boolean) => part.split(".").every(id =>
    /^[0-9A-Za-z-]+$/.test(id) && !(pre && /^\d+$/.test(id) && id.length > 1 && id[0] === "0"));
  return (prerelease === undefined || identifiers(prerelease, true))
    && (build === undefined || identifiers(build, false));
}

export function definePlugin(definition: PluginDefinition): Readonly<PluginDefinition> {
  if (!definition || typeof definition.id !== "string"
    || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(definition.id)
    || definition.id.length > 128) {
    throw new Error("Plugin id must be a stable lowercase identifier");
  }
  if (Object.keys(definition).some(key => key !== "id" && key !== "version")) {
    throw new Error("Unsupported plugin descriptor field; this format currently declares identity only");
  }
  if (typeof definition.version !== "string" || !versionSyntax(definition.version)) {
    throw new Error("Plugin version must be a semantic version");
  }
  return Object.freeze({ id: definition.id, version: definition.version });
}
