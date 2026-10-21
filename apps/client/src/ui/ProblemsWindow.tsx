import { useApp, openWindow, type GameWindow } from '../store.ts';
import { client } from '../net/client.ts';
import { companyProblems, stationIssueText, type Problem } from '../game/problems.ts';
import { formatMoney } from './format.ts';
import { LineSwatch } from './LinesWindow.tsx';
import { Win, focusOn, trainStatus, useMyRole, useTick } from './windows.tsx';

type Group = Problem['issue'];

/** Groups in the order they are shown, most urgent first, with what to do about each. */
const GROUPS: { issue: Group; title: string; hint: string }[] = [
  { issue: 'lost', title: 'Lost vehicles', hint: 'They can’t find a way to their next stop: check the track, or the line’s stops.' },
  { issue: 'stopped', title: 'Stopped outside a depot', hint: 'Start them again, or send them to a depot.' },
  { issue: 'pilingUp', title: 'Cargo piling up', hint: 'More cargo waits than is collected, which lowers the rating: add vehicles to the lines calling here.' },
  { issue: 'falling', title: 'Station ratings falling', hint: 'Call more often, with faster, newer vehicles, or carry the waiting cargo away.' },
  { issue: 'loss', title: 'Losing money', hint: 'They lost money last year: try another line, or sell them.' },
  { issue: 'noLine', title: 'Not on a line', hint: 'Out of the depot with nowhere to go: put them on a line.' },
  { issue: 'old', title: 'Past their design life', hint: 'Old vehicles break down more: replace them, or turn on autorenew in the company window.' },
  { issue: 'empty', title: 'Lines with no vehicles', hint: 'Put vehicles on them, or delete them.' },
];

/** The local player's company's problems (empty for spectators); re-reads them every couple of seconds. */
export function useProblems(): Problem[] {
  useTick(2000);
  useApp((s) => s.trainsRev);
  useApp((s) => s.linesRev);
  useApp((s) => s.summaryRev);
  const date = useApp((s) => s.global?.date ?? 0);
  const company = useMyRole().companyId;
  const world = client.world;
  return world && company !== null ? companyProblems(world, company, date) : [];
}

/** Everything that needs looking at in the company's network, each with a way to get to it. */
export function ProblemsWindow({ w }: { w: GameWindow & { kind: 'problems' } }) {
  const problems = useProblems();
  const company = useMyRole().companyId;
  return (
    <Win w={w} title={problems.length ? `Problems (${problems.length})` : 'Problems'} label="Problems" width={480}>
      {company === null && <p className="muted">Found or join a company first.</p>}
      {company !== null && problems.length === 0 && <p className="muted">Nothing needs looking at. Your vehicles, stations and lines are running well.</p>}
      {GROUPS.map((g) => {
        const list = problems.filter((p) => p.issue === g.issue);
        if (!list.length) return null;
        return (
          <section key={g.issue} className="problem-group">
            <h4>
              {g.title} <span className="muted small">({list.length})</span>
            </h4>
            <p className="muted small">{g.hint}</p>
            {list.slice(0, 50).map((p) => (
              <ProblemRow key={key(p)} p={p} />
            ))}
            {list.length > 50 && <p className="muted small">…and {list.length - 50} more.</p>}
          </section>
        );
      })}
    </Win>
  );
}

const key = (p: Problem) => `${p.kind}:${p.kind === 'vehicle' ? p.vehicle.id : p.kind === 'station' ? p.station.id : p.line.id}`;

function ProblemRow({ p }: { p: Problem }) {
  if (p.kind === 'vehicle') {
    const t = p.vehicle;
    const detail = p.issue === 'loss' ? `${formatMoney(t.profitLastYear)} last year` : p.issue === 'old' ? `${((client.world!.state.date - t.builtDays) / 365).toFixed(0)} years old` : trainStatus(t);
    return (
      <div className="list-row">
        <b style={{ flex: '0 0 auto' }}>{t.name}</b>
        <span className="muted small" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {detail}
        </span>
        <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
      </div>
    );
  }
  if (p.kind === 'station') {
    const st = p.station;
    return (
      <div className="list-row">
        <b style={{ flex: '0 0 auto' }}>{st.name}</b>
        <span className="muted small" style={{ flex: 1, minWidth: 0 }}>
          {stationIssueText(p.issue, st, p.target)}
        </span>
        <button className="ghost" title="Move the camera there" onClick={() => focusOn(st.x, st.y)}>
          Locate
        </button>
        <button onClick={() => openWindow({ kind: 'station', id: st.id })}>Open</button>
      </div>
    );
  }
  return (
    <div className="list-row">
      <LineSwatch line={p.line} />
      <b style={{ flex: 1 }}>{p.line.name}</b>
      <button onClick={() => openWindow({ kind: 'line', id: p.line.id })}>Open</button>
    </div>
  );
}

/** Top-bar button: how many problems there are, opening the list. */
export function ProblemsButton() {
  const n = useProblems().length;
  return (
    <button
      className={n ? 'problems-btn has' : 'problems-btn'}
      title={n ? `${n} problem${n === 1 ? '' : 's'} need looking at` : 'No problems'}
      aria-label={`Problems: ${n}`}
      onClick={() => openWindow({ kind: 'problems', id: 0 })}
    >
      ⚠<span className="mono"> {n}</span>
    </button>
  );
}
