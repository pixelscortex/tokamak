import { createSignal, type Accessor } from "solid-js";
import { endpoint as configuredEndpoint, hosted, hostedTokenKey, type Endpoint } from "./endpoint";
import { nameFromHost } from "./invite";
import { loadServers, storeServers, type SavedServer, type SavedState } from "./saved-servers";

/**
 * The servers this window can show. "This Mac" is the server the desktop app starts
 * (in a development browser, the configured one stands in for it). A page served by a
 * hosted server has only that server, its origin.
 */
export type Server =
  | { id: "local"; kind: "local"; name: string }
  | (SavedServer & { kind: "remote" | "origin" });

export interface Servers {
  list: Accessor<readonly Server[]>;
  current: Accessor<Server>;
  /** Selects a server by id; false when there is no such server. */
  select(id: string): boolean;
  /** Saves a joined server, or updates the one already saved at that address. */
  save(entry: { address: string; token: string; name: string; displayName: string }): Server;
  rename(id: string, name: string): void;
  remove(id: string): void;
  /** The name used last, offered as the default on the next server. */
  displayName: Accessor<string>;
  /** False on a page served by a hosted server: it can only talk to its own origin. */
  canAdd: boolean;
  endpointOf(server: Server): Promise<Endpoint>;
}

export interface ServersOptions {
  /** How to reach This Mac. Absent on a page served by a hosted server. */
  local?: () => Endpoint | Promise<Endpoint>;
  /** The hosted server's origin when the page came from one. */
  origin?: string;
  storage?: Storage;
}

export function defaultServers(local?: () => Endpoint | Promise<Endpoint>): ServersOptions {
  return hosted() ? { origin: window.location.origin } : { local: local ?? configuredEndpoint };
}

export const thisMac: Server = { id: "local", kind: "local", name: "This Mac" };

export function createServers(options: ServersOptions): Servers {
  const storage = options.storage ?? localStorage;
  // Signal writes apply at the next flush; `latest` lets a save be selected right away.
  let latest = loadServers(storage);
  const [state, setState] = createSignal<SavedState>(latest, { ownedWrite: true });
  const update = (change: (previous: SavedState) => SavedState) => {
    latest = change(latest);
    setState(latest);
    storeServers(latest, storage);
  };

  const listOf = (saved: readonly SavedServer[]): readonly Server[] => {
    if (options.origin) {
      const origin = options.origin;
      const entry = saved.find((server) => server.address === origin);
      const legacy = storage.getItem(hostedTokenKey) ?? "";
      return [
        {
          id: "origin",
          name: nameFromHost(new URL(origin).host),
          address: origin,
          token: legacy,
          ...entry,
          kind: "origin",
        },
      ];
    }
    return [thisMac, ...saved.map((server) => ({ ...server, kind: "remote" as const }))];
  };
  const list = () => listOf(state().servers);

  const current = () => {
    const all = list();
    return all.find((server) => server.id === state().selected) ?? all[0]!;
  };

  return {
    list,
    current,
    select(id) {
      if (!listOf(latest.servers).some((server) => server.id === id)) return false;
      update((previous) => ({
        ...previous,
        selected: id,
        servers: previous.servers.map((server) =>
          server.id === id ? { ...server, lastUsed: Date.now() } : server,
        ),
      }));
      return true;
    },
    save(entry) {
      const existing = latest.servers.find((server) => server.address === entry.address);
      const id = existing?.id ?? (options.origin ? "origin" : crypto.randomUUID());
      const saved: SavedServer = {
        id,
        name: existing?.name ?? entry.name,
        address: entry.address,
        token: entry.token,
        displayName: entry.displayName,
        lastUsed: Date.now(),
      };
      update((previous) => ({
        ...previous,
        displayName: entry.displayName,
        servers: existing
          ? previous.servers.map((server) => (server.id === id ? saved : server))
          : [...previous.servers, saved],
      }));
      if (options.origin) storage.setItem(hostedTokenKey, entry.token);
      return listOf(latest.servers).find((server) => server.id === id)!;
    },
    rename(id, name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      update((previous) => ({
        ...previous,
        servers: previous.servers.map((server) => (server.id === id ? { ...server, name: trimmed } : server)),
      }));
    },
    remove(id) {
      if (options.origin) return;
      update((previous) => ({
        ...previous,
        servers: previous.servers.filter((server) => server.id !== id),
        selected: previous.selected === id ? thisMac.id : previous.selected,
      }));
    },
    displayName: () => state().displayName ?? "",
    canAdd: !options.origin,
    async endpointOf(server) {
      if (server.kind === "local") {
        if (!options.local) throw new Error("This window has no local server.");
        return options.local();
      }
      const http = new URL(server.address);
      const ws = new URL("/ws", http);
      ws.protocol = http.protocol === "https:" ? "wss:" : "ws:";
      return { http: http.origin, ws: ws.href, token: server.token };
    },
  };
}
