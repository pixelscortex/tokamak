function inspect(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (value instanceof Error) {
    const label = String(value);
    const stack = value.stack;
    return !stack || stack.startsWith(label) ? stack || label : `${label}\n${stack}`;
  }
  if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[Function: ${value.name || "(anonymous)"}]`;
  if (value === null || typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= 4) return Array.isArray(value) ? "[Array]" : "[Object]";
  seen.add(value);
  const show = (item: unknown) => inspect(item, seen, depth + 1);
  let result: string;
  if (Array.isArray(value)) {
    result = value.length ? `[ ${value.slice(0, 100).map(show).join(", ")} ]` : "[]";
  } else {
    const properties = Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 100);
    result = properties.length
      ? `{ ${properties
          .map(
            ([key, prop]) =>
              `${/^[\w$]+$/.test(key) ? key : JSON.stringify(key)}: ${"value" in prop ? show(prop.value) : "[Getter/Setter]"}`,
          )
          .join(", ")} }`
      : "{}";
  }
  seen.delete(value);
  return result;
}

function format(args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first !== "string" || rest.length === 0) return args.map((value) => inspect(value)).join(" ");
  let consumed = 0;
  const substituted = first.replace(/%[%sdjo]/g, (token) => {
    if (token === "%%") return "%";
    if (consumed === rest.length) return token;
    const value = rest[consumed++];
    if (token === "%d")
      return typeof value === "bigint"
        ? `${value}n`
        : String(typeof value === "symbol" ? NaN : Number(value));
    if (token === "%j") {
      try {
        return JSON.stringify(value) ?? "undefined";
      } catch {
        return "[Circular]";
      }
    }
    return inspect(value);
  });
  return [substituted, ...rest.slice(consumed).map((value) => inspect(value))].join(" ");
}

export function installConsole(target: Console, emit: (message: object) => void) {
  const log = (level: string, text: string) => emit({ type: "log", level, text: text.slice(0, 8192) });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    target[level] = (...args: unknown[]) => log(level, format(args));
  }
  target.dir = (value: unknown) => log("log", inspect(value));
  target.trace = (...args: unknown[]) => {
    const error = new Error(format(args));
    error.name = "Trace";
    log("error", inspect(error));
  };
}
