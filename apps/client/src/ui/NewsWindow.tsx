import { COMPANY_COLORS, formatDate, type NewsItem } from '@transportsim/shared';
import { useEffect, useState } from 'react';
import { client } from '../net/client.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { Win, focusOn, useMyRole } from './windows.tsx';

const ICONS: Record<NewsItem['kind'], string> = { company: '🏢', station: '🚉', finance: '💰', agreement: '🤝', vehicle: '🔧', accident: '💥', town: '🏛️' };

function look(n: NewsItem): void {
  const w = client.world?.map.width;
  if (n.tile === undefined || !w) return;
  focusOn(n.tile % w, Math.floor(n.tile / w));
}

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

/** The latest news item, shown under the date for a few seconds. */
export function NewsTicker() {
  const item = useApp((s) => s.ticker);
  const [visible, setVisible] = useState<NewsItem | null>(null);
  useEffect(() => {
    if (!item) return;
    setVisible(item);
    const id = setTimeout(() => setVisible(null), TICKER_MS);
    return () => clearTimeout(id);
  }, [item]);
  if (!visible) return null;
  return (
    <button className="panel news-ticker" onClick={() => (visible.tile !== undefined ? look(visible) : openWindow({ kind: 'news', id: 0 }))} title={`${visible.detail ? `Why: ${visible.detail}\n` : ''}Click to see where; all news in 📰 News`}>
      <span aria-hidden>{ICONS[visible.kind]}</span> {visible.text}
    </button>
  );
}
