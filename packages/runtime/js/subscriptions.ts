/** Window-owned query cache bridges contribution remounts during UI reload.
 * Dormant entries stay subscribed until the window closes, bounded by the same
 * 128-entry limit as the wire transport. Terminal failures evict dead entries
 * so Reload can re-subscribe without closing the SDK session. */
import type { ClientTransport, JsonValue, SubscriptionEvent } from "@tokamak/sdk";
export function retainSubscriptions(transport: ClientTransport): ClientTransport & { dispose(): void } {
  const entries = new Map<string, {
    observers: Set<(event: SubscriptionEvent<JsonValue>) => void>;
    last?: SubscriptionEvent<JsonValue>;
    stop: () => void;
  }>();
  return {
    query: (name, args) => transport.query(name, args),
    mutation: (name, args) => transport.mutation(name, args),
    subscribe(name, args, observer) {
      const key = JSON.stringify([name, args]);
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= 128) {
          const dormant = [...entries].find(([, e]) => !e.observers.size);
          if (!dormant) throw new Error("Window query subscription capacity exceeded");
          dormant[1].stop(); entries.delete(dormant[0]);
        }
        entry = { observers: new Set(), stop: () => {} };
        const current = entry;
        entries.set(key, entry);
        try {
          entry.stop = transport.subscribe(name, args, event => {
            current.last = event;
            // Terminal responses release the wire observer. Keep the failure
            // for existing owners, but a remount must open a fresh subscription.
            if ("error" in event && event.terminal && entries.get(key) === current) entries.delete(key);
            for (const notify of current.observers) {
              try { notify(event); } catch { /* isolate contribution observers */ }
            }
          });
        } catch (error) {
          if (entries.get(key) === current) entries.delete(key);
          throw error;
        }
      }
      entry.observers.add(observer);
      try { if (entry.last) observer(entry.last); }
      catch (error) { entry.observers.delete(observer); throw error; }
      return () => { entry.observers.delete(observer); };
    },
    dispose() {
      for (const entry of entries.values()) entry.stop();
      entries.clear();
    },
  };
}
