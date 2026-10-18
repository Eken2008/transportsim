import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * Save games live only in this browser (IndexedDB). The server never stores them.
 * Data is the server's msgpack snapshot, gzipped with the browser's CompressionStream.
 */
export interface SaveRecord {
  id: string;
  /** Groups autosaves of the same game lineage for rotation. */
  gameKey: string;
  name: string;
  kind: 'auto' | 'manual' | 'imported';
  createdAt: number;
  /** In-game date (days since 1970). */
  gameDate: number;
  size: number;
  data: Blob;
}

interface SaveDB extends DBSchema {
  saves: { key: string; value: SaveRecord; indexes: { byGame: string; byCreated: number } };
}

const AUTOSAVES_PER_GAME = 3;
let dbPromise: Promise<IDBPDatabase<SaveDB>> | null = null;

function db(): Promise<IDBPDatabase<SaveDB>> {
  dbPromise ??= openDB<SaveDB>('transportsim', 1, {
    upgrade(d) {
      const store = d.createObjectStore('saves', { keyPath: 'id' });
      store.createIndex('byGame', 'gameKey');
      store.createIndex('byCreated', 'createdAt');
    },
  });
  return dbPromise;
}

export async function gzip(bytes: Uint8Array): Promise<Blob> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function gunzip(blob: Blob): Promise<Uint8Array> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function listSaves(): Promise<SaveRecord[]> {
  try {
    const all = await (await db()).getAllFromIndex('saves', 'byCreated');
    return all.reverse();
  } catch {
    return [];
  }
}

export async function putSave(
  rec: Omit<SaveRecord, 'id' | 'createdAt' | 'size' | 'data'>,
  snapshot: Uint8Array,
): Promise<SaveRecord> {
  const data = await gzip(snapshot);
  const record: SaveRecord = { ...rec, id: crypto.randomUUID(), createdAt: Date.now(), size: data.size, data };
  const d = await db();
  await d.put('saves', record);
  if (rec.kind === 'auto') {
    // Rotate: keep only the newest N autosaves for this game.
    const same = (await d.getAllFromIndex('saves', 'byGame', rec.gameKey))
      .filter((s) => s.kind === 'auto')
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const old of same.slice(AUTOSAVES_PER_GAME)) await d.delete('saves', old.id);
  }
  return record;
}

export async function deleteSave(id: string): Promise<void> {
  await (await db()).delete('saves', id);
}

export async function loadSaveBytes(id: string): Promise<Uint8Array> {
  const rec = await (await db()).get('saves', id);
  if (!rec) throw new Error('Save not found');
  return gunzip(rec.data);
}

export function exportSave(rec: SaveRecord): void {
  const url = URL.createObjectURL(rec.data);
  const a = document.createElement('a');
  const date = new Date(rec.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `${rec.name.replace(/[^\w-]+/g, '_')}-${date}.tsave`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importSave(file: File): Promise<SaveRecord> {
  // Validate that it decompresses before storing.
  const bytes = await gunzip(file);
  return putSave(
    { gameKey: `import:${file.name}`, name: file.name.replace(/\.tsave$/i, ''), kind: 'imported', gameDate: 0 },
    bytes,
  );
}

/** Ask the browser not to evict our saves under storage pressure. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* not supported */
  }
}
