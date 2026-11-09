/** Window-owned query cache bridges contribution remounts during UI reload.
 * Dormant entries stay subscribed until the window closes, bounded by the same
 * 128-entry limit as the wire transport. Reload never closes the SDK session. */
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
        entry.stop = transport.subscribe(name, args, event => {
          current.last = event;
          for (const notify of current.observers) {
            try { notify(event); } catch { /* isolate contribution observers */ }
          }
        });
        entries.set(key, entry);
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
