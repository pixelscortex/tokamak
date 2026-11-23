function inspect(value: unknown, seen = new Set<object>(), depth = 0, maxDepth = 4): string {
  if (value instanceof Error) return inspectError(value);
  if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[Function: ${value.name || "(anonymous)"}]`;
  if (value === null || typeof value !== "object") return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  return inspectCompound(value, seen, depth, maxDepth);
}

function inspectError(error: Error): string {
  const label = String(error);
  const stack = error.stack;
  return !stack || stack.startsWith(label) ? stack || label : `${label}\n${stack}`;
}

function inspectCompound(value: object, seen: Set<object>, depth: number, maxDepth: number): string {
  if (seen.has(value)) return "[Circular]";
  if (depth >= maxDepth) return Array.isArray(value) ? "[Array]" : "[Object]";
  seen.add(value);
  const show = (item: unknown) => inspect(item, seen, depth + 1, maxDepth);
  const result = inspectObject(value, show);
  seen.delete(value);
  return result;
}

function inspectObject(value: object, show: (item: unknown) => string): string {
  if (Array.isArray(value)) {
    return value.length ? `[ ${value.slice(0, 100).map(show).join(", ")} ]` : "[]";
  }
  if (value instanceof Map) {
    return collection(
      `Map(${value.size})`,
      "{",
      "}",
      value.size,
      value,
      ([key, item]) => `${show(key)} => ${show(item)}`,
    );
  }
  if (value instanceof Set) {
    return collection(`Set(${value.size})`, "{", "}", value.size, value, show);
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const items = value as unknown as Iterable<unknown> & { length: number };
    return collection(`${value.constructor.name}(${items.length})`, "[", "]", items.length, items, show);
  }

  const properties = Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 100);
  return properties.length
    ? `{ ${properties
        .map(
          ([key, prop]) =>
            `${/^[\w$]+$/.test(key) ? key : JSON.stringify(key)}: ${"value" in prop ? show(prop.value) : "[Getter/Setter]"}`,
        )
        .join(", ")} }`
    : "{}";
}

function collection<T>(
  label: string,
  open: string,
  close: string,
  size: number,
  values: Iterable<T>,
  show: (item: T) => string,
): string {
  const parts: string[] = [];
  for (const item of values) {
    if (parts.length === 100) break;
    parts.push(show(item));
  }
  if (size > parts.length) parts.push(`... ${size - parts.length} more items`);
  return `${label} ${open}${parts.length ? ` ${parts.join(", ")} ` : ""}${close}`;
}

function format(args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first !== "string" || rest.length === 0) return args.map((value) => inspect(value)).join(" ");
  let consumed = 0;
  const substituted = first.replace(/%[%sdifjoOc]/g, (token) => {
    if (token === "%%") return "%";
    if (consumed === rest.length) return token;
    return formatValue(token, rest[consumed++]);
  });
  return [substituted, ...rest.slice(consumed).map((value) => inspect(value))].join(" ");
}

function number(value: unknown, read: (input: unknown) => number): string {
  return String(typeof value === "symbol" ? NaN : read(value));
}

function formatValue(token: string, value: unknown): string {
  switch (token) {
    case "%d":
      return typeof value === "bigint" ? `${value}n` : number(value, Number);
    case "%i":
      return typeof value === "bigint" ? `${value}n` : number(value, (input) => parseInt(String(input)));
    case "%f":
      return number(value, (input) => parseFloat(String(input)));
    case "%c":
      return "";
    case "%O":
      return inspect(value, new Set(), 0, 3);
    case "%j":
      try {
        return JSON.stringify(value) ?? "undefined";
      } catch {
        return "[Circular]";
      }
    default:
      return inspect(value);
  }
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
