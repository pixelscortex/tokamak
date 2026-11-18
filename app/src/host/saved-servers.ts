/**
 * What this device remembers about servers: the remote servers it joined (with their
 * access tokens), the one selected last, and the name the person goes by.
 *
 * Everything sits in localStorage for now. Tokens are secrets, so this module is the
 * only code that reads or writes them; moving them to the OS keychain later means
 * changing these two functions and nothing else.
 */

export interface SavedServer {
  id: string;
  name: string;
  /** An origin, as produced by `parseInvite`. */
  address: string;
  token: string;
  /**
   * The name this person uses on the server, synchronized after connecting.
   */
  displayName?: string;
  /** When it was last selected, in ms since the epoch. */
  lastUsed?: number;
}

export interface SavedState {
  servers: SavedServer[];
  /** The last selected server's id; "local" is This Mac. */
  selected?: string;
  /** The name used last, offered as the default on the next server. */
  displayName?: string;
}

const key = "tokamak.servers";

export function loadServers(storage: Storage = localStorage): SavedState {
  try {
    const raw = JSON.parse(storage.getItem(key) ?? "null") as Partial<SavedState> | null;
    const servers = Array.isArray(raw?.servers) ? raw.servers.filter(valid) : [];
    return {
      servers,
      ...(typeof raw?.selected === "string" ? { selected: raw.selected } : {}),
      ...(typeof raw?.displayName === "string" ? { displayName: raw.displayName } : {}),
    };
  } catch {
    return { servers: [] };
  }
}

export function storeServers(state: SavedState, storage: Storage = localStorage): void {
  storage.setItem(key, JSON.stringify(state));
}

function valid(entry: unknown): entry is SavedServer {
  const server = entry as SavedServer;
  return (
    !!server &&
    typeof server.id === "string" &&
    typeof server.name === "string" &&
    typeof server.address === "string" &&
    typeof server.token === "string"
  );
}
