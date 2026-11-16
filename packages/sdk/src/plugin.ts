/** Portable packaging identity. Loading/lifecycle/capabilities are host concerns. */
import { jsonSnapshot, type JsonValue } from "./values";

export interface PluginDefinition {
  readonly id: string;
  readonly version: string;
  readonly api?: string;
  readonly depends?: Readonly<Record<string, string>>;
  readonly optional?: Readonly<Record<string, string>>;
  readonly breaks?: Readonly<Record<string, string>>;
  readonly provides?: readonly string[];
  readonly consumes?: readonly string[];
  readonly permissions?: readonly string[];
  readonly placement?: "hub" | "runner" | "hybrid";
  readonly contributes?: Readonly<Record<string, readonly JsonValue[]>>;
  readonly exports?: string;
}

function versionSyntax(version: string): boolean {
  const [head, build, ...extra] = version.split("+");
  if (extra.length) return false;
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
  definition = jsonSnapshot(definition, "plugin descriptor") as unknown as PluginDefinition;
  if (!definition || typeof definition.id !== "string"
    || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(definition.id)) {
    throw new Error("Plugin id must be a stable lowercase identifier");
  }
  const fields = ["id", "version", "api", "depends", "optional", "breaks", "provides",
    "consumes", "permissions", "placement", "contributes", "exports"];
  if (Object.keys(definition).some(key => !fields.includes(key))) {
    throw new Error("Unsupported plugin descriptor field");
  }
  if (typeof definition.version !== "string" || !versionSyntax(definition.version)) {
    throw new Error("Plugin version must be a semantic version");
  }
  validateRequirements(definition);
  validateLists(definition);
  validateMetadata(definition);
  function freeze(value: unknown): void {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(definition);
  return definition;
}

function validateRequirements(definition: PluginDefinition) {
  for (const key of ["depends", "optional", "breaks"] as const) {
    const map = definition[key];
    if (map === undefined) continue;
    if (!map || typeof map !== "object" || Array.isArray(map)
      || Object.entries(map).some(([id, range]) => !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id)
        || typeof range !== "string" || !range)) {
      throw new Error(`Invalid plugin ${key} requirements`);
    }
  }
}

function validateLists(definition: PluginDefinition) {
  for (const key of ["provides", "consumes", "permissions"] as const) {
    const list = definition[key];
    if (list !== undefined && (!Array.isArray(list)
      || list.some(value => typeof value !== "string" || !value)
      || new Set(list).size !== list.length)) throw new Error(`Invalid plugin ${key}`);
  }
}

function validateMetadata(definition: PluginDefinition) {
  if (definition.api !== undefined && (typeof definition.api !== "string"
    || !definition.api.startsWith("tokamak@"))) {
    throw new Error("Invalid host API requirement");
  }
  if (definition.placement !== undefined && !["hub", "runner", "hybrid"].includes(definition.placement)) {
    throw new Error("Invalid plugin placement");
  }
  if (definition.exports !== undefined && typeof definition.exports !== "string") throw new Error("Invalid plugin exports path");
  if (definition.contributes !== undefined && (!definition.contributes || typeof definition.contributes !== "object"
    || Array.isArray(definition.contributes) || Object.values(definition.contributes).some(value => !Array.isArray(value)))) {
    throw new Error("Plugin contributions must be static arrays");
  }
}
