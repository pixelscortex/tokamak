import { onCleanup } from "solid-js";
import type { AttributeWarning } from "./component-attributes";
import type { LoadedPartAction } from "./component-parts";
import { screenElementName } from "./screen-search";

type WarningKey = readonly [kind: string, plugin: string, target: string];
type Alert = { plugins: readonly string[]; messages: Map<string, number>; sticky: boolean };

export function componentAlerts(
  notify: (messages: readonly string[]) => void,
  attributeWarning: (warning: AttributeWarning) => void,
  writeWarning: (message: string) => void,
) {
  const active = new Map<string, Alert>();
  const logged = new Map<string, Pick<Alert, "plugins" | "sticky">>();
  let skipped: ReadonlySet<string> = new Set();
  const stale = new Map<string, string>();
  let last: string[] = [];
  let pending = false;
  let closed = false;
  onCleanup(() => (closed = true));

  function changed() {
    if (pending || closed) return;
    pending = true;
    // Several mounted rows and layer stages can change in the same turn.
    queueMicrotask(() => {
      pending = false;
      if (closed) return;
      const next = [
        ...new Set([
          ...skipped,
          ...stale.values(),
          ...[...active.values()].map(({ messages }) => [...messages.keys()].sort()[0]!),
        ]),
      ].sort();
      if (next.length === last.length && next.every((message, i) => message === last[i])) return;
      last = next;
      notify(next);
    });
  }

  function log(
    key: string,
    plugins: readonly string[],
    message: string,
    sticky = false,
    detail?: AttributeWarning,
  ) {
    if (logged.has(key)) return;
    logged.set(key, { plugins, sticky });
    writeWarning(message);
    if (detail) attributeWarning(detail);
  }

  function record(key: string, plugins: readonly string[], message: string, sticky = false) {
    let alert = active.get(key);
    if (!alert) {
      alert = { plugins, messages: new Map(), sticky };
      active.set(key, alert);
    } else if (sticky) return;

    const messages = alert.messages;
    const count = messages.get(message) ?? 0;
    messages.set(message, count + 1);
    if (!count) changed();
    if (sticky) return;
    return () => {
      const count = messages.get(message)!;
      if (count > 1) messages.set(message, count - 1);
      else {
        messages.delete(message);
        if (active.get(key) !== alert) return;
        if (!messages.size) active.delete(key);
        changed();
      }
    };
  }

  return {
    warn(key: WarningKey, message: string, detail?: AttributeWarning) {
      const plugins = detail?.otherPlugin ? [key[1], detail.otherPlugin] : [key[1]];
      const id = JSON.stringify(key);
      const sticky = detail?.kind === "attr-error";
      if (detail) {
        const release = record(
          id,
          plugins,
          message.replace(detail.target, screenElementName(detail.target)),
          sticky,
        );
        if (release) onCleanup(release);
      }
      log(id, plugins, message, sticky, detail);
    },
    failure(item: LoadedPartAction, cause: unknown, consoleMessage: string) {
      const id = JSON.stringify(["error", item.plugin, item.id]);
      const error = cause instanceof Error ? cause.message : String(cause);
      const message = `${item.plugin} (${item.id}) failed on ${screenElementName(item.action.target)}: ${error}`;
      record(id, [item.plugin], message, true);
      log(id, [item.plugin], consoleMessage, true);
    },
    interference(kind: string, cause: LoadedPartAction, affected: LoadedPartAction, message: string) {
      const id = JSON.stringify([kind, cause.plugin, affected.plugin, affected.action.target]);
      const plugins = [cause.plugin, affected.plugin];
      const release = record(id, plugins, message)!;
      log(id, plugins, message);
      return release;
    },
    mismatch(plugin: string, target: string) {
      const key = JSON.stringify([plugin, target]);
      if (stale.has(key)) return;
      const message = `Plugin "${plugin}": targets a different element at ${target}; skipping this addition`;
      stale.set(key, message);
      writeWarning(message);
      changed();
    },
    skipped(messages: string[]) {
      const next = new Set(messages);
      for (const message of next) if (!skipped.has(message)) writeWarning(message);
      skipped = next;
      changed();
    },
    clear(plugin: string, includeFailures = false) {
      let forgotten = false;
      for (const [key, alert] of active)
        if ((!alert.sticky || includeFailures) && alert.plugins.includes(plugin))
          forgotten = active.delete(key) || forgotten;
      for (const key of stale.keys())
        if (JSON.parse(key)[0] === plugin) forgotten = stale.delete(key) || forgotten;
      for (const [key, { plugins, sticky }] of logged)
        if ((!sticky || includeFailures) && plugins.includes(plugin)) logged.delete(key);
      if (forgotten) changed();
    },
  };
}
