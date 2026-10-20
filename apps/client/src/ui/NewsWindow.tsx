import { COMPANY_COLORS, formatDate, type NewsItem } from '@transportsim/shared';
import { useEffect, useRef, useState } from 'react';
import { client } from '../net/client.ts';
import { placeViews } from '../render/vehicleViews.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { Win, focusOn, useMyRole } from './windows.tsx';

const ICONS: Record<NewsItem['kind'], string> = { company: '🏢', station: '🚉', finance: '💰', agreement: '🤝', vehicle: '🔧', accident: '💥', town: '🏛️' };

function look(n: NewsItem): void {
  const w = client.world?.map.width;
  if (n.tile === undefined || !w) return;
  focusOn(n.tile % w, Math.floor(n.tile / w));
}

/** The vehicle a news item is about, if it still exists. */
const vehicleOf = (n: NewsItem) => (n.vehicle !== undefined && client.world?.trains.has(n.vehicle) ? n.vehicle : undefined);

function NewsLine({ n }: { n: NewsItem }) {
  const company = useApp((s) => s.global?.companies.find((c) => c.id === n.company));
  return (
    <div className="news-line">
      <span aria-hidden>{ICONS[n.kind]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{n.text}</div>
        {n.detail && <div className="small">Why: {n.detail}</div>}
        <div className="muted small">
          {formatDate(n.date)}
          {company && (
            <>
              {' · '}
              <span className="company-swatch tiny" style={{ background: COMPANY_COLORS[company.color] }} /> {company.name}
            </>
          )}
        </div>
      </div>
      {vehicleOf(n) !== undefined && (
        <button className="ghost small" title="Open the vehicle" aria-label="Open the vehicle" onClick={() => openWindow({ kind: 'train', id: n.vehicle! })}>
          🚂
        </button>
      )}
      {n.tile !== undefined && (
        <button className="ghost small" title="Show on the map" aria-label="Show on the map" onClick={() => look(n)}>
          ⌖
        </button>
      )}
    </div>
  );
}

export function NewsWindow({ w }: { w: GameWindow & { kind: 'news' } }) {
  const news = useApp((s) => s.news);
  const mine = useMyRole().companyId;
  const [onlyMine, setOnlyMine] = useState(false);
  const shown = news.filter((n) => !onlyMine || n.company === mine).slice().reverse();
  return (
    <Win w={w} title="News" width={400}>
      {mine !== null && (
        <div className="row" role="radiogroup" aria-label="Show" style={{ marginBottom: 8 }}>
          <button className={!onlyMine ? 'primary' : ''} aria-pressed={!onlyMine} onClick={() => setOnlyMine(false)}>
            Everyone
          </button>
          <button className={onlyMine ? 'primary' : ''} aria-pressed={onlyMine} onClick={() => setOnlyMine(true)}>
            My company
          </button>
        </div>
      )}
      <div className="news-list">
        {shown.length === 0 && <p className="muted">No news yet.</p>}
        {shown.map((n) => (
          <NewsLine key={n.id} n={n} />
        ))}
      </div>
    </Win>
  );
}

const TICKER_MS = 8000;
const HEADLINE_MS = 20000;

/** News worth a look at where it happened: accidents anywhere, and firsts at one's own stations. */
function isHeadline(n: NewsItem, mine: number | null): boolean {
  return n.tile !== undefined && (n.kind === 'accident' || (n.kind === 'station' && mine !== null && n.company === mine));
}

/** Opens the vehicle a news item is about, else looks at where it happened, else opens the news. */
function show(n: NewsItem): void {
  const v = vehicleOf(n);
  if (v !== undefined) openWindow({ kind: 'train', id: v });
  else if (n.tile !== undefined) look(n);
  else openWindow({ kind: 'news', id: 0 });
}

/** A live view of a place, drawn by the game renderer. */
function PlaceView({ tile }: { tile: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    placeViews.set(canvas, tile);
    return () => void placeViews.delete(canvas);
  }, [tile]);
  return <canvas ref={ref} className="news-view" aria-hidden />;
}

/** Hides an item a while after it was set. */
function useFor(ms: number): [NewsItem | null, (n: NewsItem | null) => void] {
  const [item, setItem] = useState<NewsItem | null>(null);
  useEffect(() => {
    if (!item) return;
    const id = setTimeout(() => setItem(null), ms);
    return () => clearTimeout(id);
  }, [item, ms]);
  return [item, setItem];
}

/**
 * The latest news, shown under the date for a few seconds; headlines get a card with a live view
 * of where they happened, kept for longer.
 */
export function NewsTicker() {
  const fresh = useApp((s) => s.fresh);
  const mine = useMyRole().companyId;
  const [line, setLine] = useFor(TICKER_MS);
  const [headline, setHeadline] = useFor(HEADLINE_MS);
  useEffect(() => {
    const big = fresh.filter((n) => isHeadline(n, mine));
    const small = fresh.filter((n) => !isHeadline(n, mine));
    if (big.length) setHeadline(big[big.length - 1]!);
    if (small.length) setLine(small[small.length - 1]!);
    // Only new arrivals; a change of company doesn't replay them.
  }, [fresh]);
  if (!line && !headline) return null;
  return (
    <div className="news-stack">
      {line && (
        <button
          key={line.id}
          className="panel news-ticker"
          onClick={() => show(line)}
          title={`${line.detail ? `Why: ${line.detail}\n` : ''}Click to see ${line.vehicle !== undefined ? 'the vehicle' : 'where'}; all news in 📰 News`}
        >
          <span aria-hidden>{ICONS[line.kind]}</span> {line.text}
        </button>
      )}
      {headline && (
        <div key={headline.id} className={`panel news-headline ${headline.kind}`} role="status">
          <div className="head">
            <span aria-hidden>{ICONS[headline.kind]}</span>
            <span className="muted small">{formatDate(headline.date)}</span>
            <button className="ghost small" title="Close" aria-label="Close" onClick={() => setHeadline(null)}>
              ✕
            </button>
          </div>
          <button className="view-btn" onClick={() => look(headline)} title="Click to look there; all news in 📰 News">
            <PlaceView tile={headline.tile!} />
            <div>{headline.text}</div>
            {headline.detail && <div className="small muted">Why: {headline.detail}</div>}
          </button>
        </div>
      )}
    </div>
  );
}
