const CLIENT_ID_KEY = 'ts.clientId';
const NAME_KEY = 'ts.playerName';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

/** Stable per-browser id so a dropped host can reclaim their game. */
export function getClientId(): string {
  let id = storageGet(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    storageSet(CLIENT_ID_KEY, id);
  }
  return id;
}

export function getPlayerName(): string {
  return storageGet(NAME_KEY) ?? '';
}

export function setPlayerName(name: string): void {
  storageSet(NAME_KEY, name);
}

export { storageGet, storageSet };
