export type NewsKind = 'company' | 'station' | 'finance' | 'agreement' | 'vehicle' | 'accident' | 'town' | 'market';

export interface NewsItem {
  id: number;
  /** Game date (days). */
  date: number;
  kind: NewsKind;
  text: string;
  /** The company the news is about, if any. */
  company?: number;
  /** A tile to look at, if any. */
  tile?: number;
  /** More on what happened (an accident's cause), shown under the text. */
  detail?: string;
  /** The vehicle the news is about, if any. */
  vehicle?: number;
}

/** News items kept in the game state (and saves). */
export const NEWS_HISTORY = 100;

export function sanitizeNews(input: unknown): NewsItem[] {
  if (!Array.isArray(input)) return [];
  const kinds: NewsKind[] = ['company', 'station', 'finance', 'agreement', 'vehicle', 'accident', 'town', 'market'];
  const out: NewsItem[] = [];
  for (const n of input.slice(-NEWS_HISTORY)) {
    if (!n || typeof n.id !== 'number' || typeof n.date !== 'number' || !kinds.includes(n.kind)) continue;
    out.push({
      id: n.id,
      date: n.date,
      kind: n.kind,
      text: String(n.text ?? '').slice(0, 200),
      company: typeof n.company === 'number' ? n.company : undefined,
      tile: typeof n.tile === 'number' ? n.tile : undefined,
      detail: typeof n.detail === 'string' ? n.detail.slice(0, 400) : undefined,
      vehicle: typeof n.vehicle === 'number' ? n.vehicle : undefined,
    });
  }
  return out;
}
