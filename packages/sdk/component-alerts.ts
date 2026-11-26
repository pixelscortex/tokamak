import { onCleanup } from "solid-js";
import type { AttributeWarning } from "./component-attributes";
import type { LoadedPartAction } from "./component-parts";
import { screenElementName } from "./screen-search";

type WarningKey = readonly [kind: string, plugin: string, target: string];
type Alert = { message: string; plugins: readonly string[]; count: number; sticky?: boolean };

export function componentAlerts(
  notify: (messages: readonly string[]) => void,
  attributeWarning: (warning: AttributeWarning) => void,
) {
  const active = new Map<string, Alert>();
  const logged = new Map<string, readonly string[]>();
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
        ...new Set([...skipped, ...stale.values(), ...[...active.values()].map((a) => a.message)]),
      ].sort();
      if (next.length === last.length && next.every((message, i) => message === last[i])) return;
      last = next;
      notify(next);
    });
  }

  function log(key: string, plugins: readonly string[], message: string, detail?: AttributeWarning) {
    if (logged.has(key)) return;
    logged.set(key, plugins);
    console.warn(message);
    if (detail) attributeWarning(detail);
  }

  function record(key: string, plugins: readonly string[], message: string, sticky = false) {
    let alert = active.get(key);
    if (!alert) {
      alert = { message, plugins, count: 0, sticky };
      active.set(key, alert);
      changed();
    }
    if (sticky) return;
    alert.count++;
    return () => {
      if (--alert.count === 0 && active.get(key) === alert) {
        active.delete(key);
        changed();
      }
    };
  }

  return {
    warn(key: WarningKey, message: string, detail?: AttributeWarning) {
      const plugins = detail?.otherPlugin ? [key[1], detail.otherPlugin] : [key[1]];
      const id = JSON.stringify(key);
      if (detail) {
        const release = record(
          id,
          plugins,
          message.replace(detail.target, screenElementName(detail.target)),
          detail.kind === "attr-error",
        );
        if (release) onCleanup(release);
      }
      log(id, plugins, message, detail);
    },
    failure(item: LoadedPartAction, cause: unknown, consoleMessage: string) {
      const id = JSON.stringify(["error", item.plugin, JSON.stringify([item.action.target, item.id])]);
      const error = cause instanceof Error ? cause.message : String(cause);
      const message = `${item.plugin} (${item.id}) failed on ${screenElementName(item.action.target)}: ${error}`;
      record(id, [item.plugin], message, true);
      log(id, [item.plugin], consoleMessage);
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
      console.warn(message);
      changed();
    },
    skipped(messages: string[]) {
      const next = new Set(messages);
      for (const message of next) if (!skipped.has(message)) console.warn(message);
      skipped = next;
      changed();
    },
    clear(plugin: string) {
      let forgotten = false;
      for (const [key, alert] of active)
        if (alert.plugins.includes(plugin)) forgotten = active.delete(key) || forgotten;
      for (const key of stale.keys())
        if (JSON.parse(key)[0] === plugin) forgotten = stale.delete(key) || forgotten;
      for (const [key, plugins] of logged) if (plugins.includes(plugin)) logged.delete(key);
      if (forgotten) changed();
    },
  };
}
