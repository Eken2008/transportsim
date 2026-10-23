import { stationHas } from '@transportsim/shared';
import { useEffect } from 'react';
import { client } from '../net/client.ts';
import { storageGet, storageSet } from '../net/identity.ts';
import { openWindow, useApp } from '../store.ts';
import { COMPACT, useMedia } from './media.ts';

const SEEN_KEY = 'ts.tutorialSeen';

interface Step {
  title: string;
  how: React.ReactNode;
  done: boolean;
}

/**
 * A getting-started guide: the steps to a first working railway, each ticked off from the game
 * as the player does it. Shown once to new players; the help screen brings it back.
 */
export function Tutorial() {
  const open = useApp((s) => s.tutorial);
  const global = useApp((s) => s.global);
  const playerId = useApp((s) => s.room?.playerId);
  const done = useApp((s) => s.doneCommands);
  useApp((s) => s.trainsRev);
  // A phone shows just the step at hand.
  const compact = useMedia(COMPACT);

  // Show it the first time a player is in a game without trains of their own.
  useEffect(() => {
    if (storageGet(SEEN_KEY)) return;
    const timer = setTimeout(() => {
      const s = useApp.getState();
      const company = s.global?.players.find((p) => p.id === s.room?.playerId)?.companyId;
      const hasTrains = [...(client.world?.trains.values() ?? [])].some((t) => t.owner === company);
      if (!hasTrains) useApp.setState({ tutorial: true });
      storageSet(SEEN_KEY, '1');
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!open || !global) return null;
  const company = global.players.find((p) => p.id === playerId)?.companyId ?? null;
  const world = client.world;
  const myStations = company === null || !world ? [] : [...world.state.stations.values()].filter((st) => st.owner === company && stationHas(world.map, st, 'rail'));
  const myTrains = company === null || !world ? [] : [...world.trains.values()].filter((t) => t.owner === company && (!t.mode || t.mode === 'rail'));
  const income = global.companies.find((c) => c.id === company)?.finances.at(-1)?.ledger.income ?? 0;

  const steps: Step[] = [
    {
      title: 'Found a company',
      how: (
        <>
          Open the{' '}
          <button className="link" onClick={() => openWindow({ kind: 'company', id: 0 })}>
            company window
          </button>{' '}
          (<kbd>C</kbd>), name your company and press Found. You can also ask to join someone else's.
        </>
      ),
      done: company !== null,
    },
    {
      title: 'Lay a railway',
      how: (
        <>
          Pick the railway tool (<kbd>4</kbd>) and drag from one town towards another. Gentle slopes are fine; level land with <kbd>3</kbd> if a hill is in the
          way.
        </>
      ),
      done: done.includes('buildTrack') || myStations.length > 0,
    },
    {
      title: 'Build a station at each end',
      how: (
        <>
          The station tool (<kbd>6</kbd>, <kbd>R</kbd> turns it) goes on straight track near houses. The shaded area shows who it serves.
        </>
      ),
      done: myStations.length >= 2,
    },
    {
      title: 'Build a depot',
      how: (
        <>
          The depot tool (<kbd>7</kbd>) goes beside the line, facing the track; the arrow shows the way out.
        </>
      ),
      done: done.includes('buildDepot') || myTrains.length > 0,
    },
    {
      title: 'Buy a train',
      how: <>Click the depot and press Buy. An engine and a few coaches are a good start.</>,
      done: myTrains.length > 0,
    },
    {
      title: 'Put it on a line',
      how: <>In the train window, press "+ New line", then "Add stations" and click both stations, then Done.</>,
      done: myTrains.some((t) => t.orders.filter((o) => o.kind === 'station').length >= 2),
    },
    {
      title: 'Start it',
      how: <>Press ▶ Start. It leaves the depot and runs between your stations.</>,
      done: myTrains.some((t) => t.status !== 'depot'),
    },
    {
      title: 'Earn your first fares',
      how: (
        <>
          Passengers pay when they arrive. Watch the money in the top left, or the{' '}
          <button className="link" onClick={() => company !== null && openWindow({ kind: 'finances', id: company })}>
            books
          </button>{' '}
          (<kbd>F</kbd>). Then build more: more lines, signals (<kbd>9</kbd>) for several trains per line, buses, airports and ships.
        </>
      ),
      done: income > 0,
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  const close = () => useApp.setState({ tutorial: false });

  return (
    <div className="panel tutorial" role="complementary" aria-label="Getting started">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>
          Getting started
          {compact && current >= 0 && (
            <span className="muted">
              {' '}
              · step {current + 1} of {steps.length}
            </span>
          )}
        </b>
        <button className="ghost" aria-label="Close the guide" onClick={close}>
          ✕
        </button>
      </div>
      <ol className="tutorial-steps">
        {steps.map((s, i) => (compact && current >= 0 && i !== current ? null : (
          <li key={s.title} className={s.done ? 'done' : i === current ? 'current' : ''}>
            <span className="tick" aria-hidden>
              {s.done ? '✓' : i + 1}
            </span>
            <div>
              <b>{s.title}</b>
              {i === current && <p className="small">{s.how}</p>}
            </div>
          </li>
        )))}
      </ol>
      {current < 0 && (
        <p className="small" style={{ marginBottom: 0 }}>
          That's a working railway. 🎉{' '}
          <button className="link" onClick={close}>
            Close the guide
          </button>
        </p>
      )}
    </div>
  );
}
