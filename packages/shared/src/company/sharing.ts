/**
 * A track sharing agreement: the guest's trains may run on the host's track (and, with
 * `stations`, call at the host's stations), paying `fee` for every day a train spends on the
 * host's infrastructure. One side proposes, the other accepts; either side can end it.
 */
export interface Agreement {
  id: number;
  /** Company whose track is shared. */
  host: number;
  /** Company whose trains may use it. */
  guest: number;
  stations: boolean;
  /** Paid by the guest to the host per train per day on the host's track. */
  fee: number;
  status: 'proposed' | 'active';
  /** The company that proposed it (the other side accepts). */
  proposedBy: number;
  /** Day it was proposed, or became active. */
  since: number;
}

export const MAX_SHARING_FEE = 5_000;
/** Agreements (proposed or active) a company can be part of. */
export const MAX_AGREEMENTS = 16;

export function sanitizeAgreements(input: unknown, companies: ReadonlySet<number>): Agreement[] {
  if (!Array.isArray(input)) return [];
  const out: Agreement[] = [];
  const pairs = new Set<number>();
  for (const a of input) {
    if (!a || typeof a.id !== 'number' || !companies.has(a.host) || !companies.has(a.guest) || a.host === a.guest) continue;
    if (pairs.has(a.host * 256 + a.guest)) continue;
    pairs.add(a.host * 256 + a.guest);
    out.push({
      id: a.id,
      host: a.host,
      guest: a.guest,
      stations: a.stations === true,
      fee: Math.max(0, Math.min(MAX_SHARING_FEE, Math.round(Number(a.fee) || 0))),
      status: a.status === 'active' ? 'active' : 'proposed',
      proposedBy: a.proposedBy === a.guest ? a.guest : a.host,
      since: typeof a.since === 'number' ? a.since : 0,
    });
  }
  return out;
}
