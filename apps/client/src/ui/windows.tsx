import {
  MAX_TRAIN_LENGTH,
  RAIL_VEHICLES,
  AIRCRAFT,
  AIRPORT_TYPES,
  SHIPS,
  stationDocks,
  ROAD_VEHICLES,
  CARGOS,
  CARGO_IDS,
  cargoAmount,
  unitCargo,
  isAvailable,
  MAX_SERVICE_INTERVAL,
  MIN_SERVICE_INTERVAL,
  SERVICE_INTERVAL_DAYS,
  baseReliability,
  isElectrified,
  lifespan,
  longestPlatform,
  railVehicle,
  ratingParts,
  ratingPercent,
  roleAllows,
  segTile,
  trainStats,
  ymdFromDays,
  type CompanyRole,
  type Station,
  type CargoId,
  type TrainInfo,
  type TrainUnit,
} from '@transportsim/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { client } from '../net/client.ts';
import { closeWindow, openWindow, toast, useApp, windowKey, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { catchmentRect, residentsIn } from '../game/catchment.ts';
import { CompanyWindow } from './CompanyWindow.tsx';
import { LineSwatch, LineWindow, LinesWindow, VehicleLine } from './LinesWindow.tsx';
import { capacityText, loadText } from './cargoText.ts';
import { NewsWindow } from './NewsWindow.tsx';
import { FinancesWindow, LeagueWindow } from './FinancesWindow.tsx';
import { StatsWindow } from './StatsWindow.tsx';
import { GameInfoWindow } from './GameInfoWindow.tsx';
import { IndustryWindow } from './IndustryWindow.tsx';
import { TownWindow } from './TownWindow.tsx';

/** Re-render periodically (for live values read from the non-reactive world mirror). */
export function useTick(ms: number): void {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function useMyCompany(): number | null {
  return useMyRole().companyId;
}

/** The local player's company and role in it. */
export function useMyRole(): { companyId: number | null; role: CompanyRole | null } {
  const room = useApp((s) => s.room);
  const global = useApp((s) => s.global);
  const me = global?.players.find((p) => p.id === room?.playerId);
  const company = global?.companies.find((c) => c.id === me?.companyId);
  const role = (me && company?.members.find((m) => m.name === me.name)?.role) || null;
  return { companyId: company ? company.id : null, role };
}

export function act(cmd: Parameters<typeof client.command>[0]): void {
  void client.command(cmd).then((r) => {
    if (!r.ok && r.error) toast(r.error, 'error');
  });
}

export function focusOn(x: number, y: number): void {
  useApp.setState((s) => ({ focus: { x, y, seq: (s.focus?.seq ?? 0) + 1 } }));
}

// ---- window shell ------------------------------------------------------------

let zTop = 10;

export function Win({ w, title, children, width = 340 }: { w: GameWindow; title: ReactNode; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => {
    const n = useApp.getState().windows.length;
    return { x: 70 + (n % 6) * 28, y: 80 + (n % 6) * 28 };
  });
  const [z, setZ] = useState(() => ++zTop);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  return (
    <div
      ref={ref}
      className="panel window"
      style={{ left: pos.x, top: pos.y, width, zIndex: z }}
      onPointerDown={() => setZ(++zTop)}
      role="dialog"
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <div
        className="window-title"
        onPointerDown={(e) => {
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx));
          const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy));
          setPos({ x, y });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <span className="window-name">{title}</span>
        <button className="ghost" aria-label="Close" onClick={() => closeWindow(w)}>
          ✕
        </button>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}

export function WindowLayer() {
  const windows = useApp((s) => s.windows);
  return (
    <>
      {windows.map((w) => {
        const key = windowKey(w);
        switch (w.kind) {
          case 'train':
            return <TrainWindow key={key} w={w} />;
          case 'depot':
            return <DepotWindow key={key} w={w} />;
          case 'station':
            return <StationWindow key={key} w={w} />;
          case 'trains':
            return <TrainListWindow key={key} w={w} />;
          case 'lines':
            return <LinesWindow key={key} w={w} />;
          case 'line':
            return <LineWindow key={key} w={w} />;
          case 'company':
            return <CompanyWindow key={key} w={w} />;
          case 'news':
            return <NewsWindow key={key} w={w} />;
          case 'finances':
            return <FinancesWindow key={key} w={w} />;
          case 'league':
            return <LeagueWindow key={key} w={w} />;
          case 'stats':
            return <StatsWindow key={key} w={w} />;
          case 'game':
            return <GameInfoWindow key={key} w={w} />;
          case 'industry':
            return <IndustryWindow key={key} w={w} />;
          case 'town':
            return <TownWindow key={key} w={w} />;
          case 'roadDepot':
          case 'hangar':
          case 'shipDepot':
            return <RoadDepotWindow key={key} w={w} />;
        }
      })}
    </>
  );
}

// ---- trains ------------------------------------------------------------------

function stationName(id: number): string {
  return client.world?.state.stations.get(id)?.name ?? `Station #${id}`;
}

export function trainStatus(t: TrainInfo): string {
  if (t.status === 'depot') return t.mode === 'air' ? 'In hangar' : 'In depot';
  if (t.brakeFail) return 'Brake failure!';
  if (t.brokenDown) return 'Broken down';
  if (t.serviceTrip) return 'Heading for a service';
  if (t.status === 'loading') return `Loading at ${stationName(t.lastStation)}`;
  if (t.status === 'stopped') return 'Stopped';
  if (t.depot >= 0) return 'Waiting to leave the depot';
  if (t.toDepot) return 'Heading for depot';
  const o = t.orders[t.orderIndex];
  if (!o) return 'No orders';
  if (o.kind === 'station') return `Heading to ${stationName(o.station)}`;
  if (o.kind === 'waypoint') return `Heading via ${client.world?.state.waypoints.get(o.waypoint)?.name ?? 'a waypoint'}`;
  return o.kind === 'depot' ? 'Heading for a depot service' : 'Waiting for a usable order';
}

function useTrain(id: number): TrainInfo | undefined {
  useApp((s) => s.trainsRev);
  return client.world?.trains.get(id);
}

function TrainWindow({ w }: { w: GameWindow & { kind: 'train' } }) {
  useTick(400);
  const t = useTrain(w.id);
  const my = useMyRole();
  const mine = my.companyId === t?.owner && roleAllows(my.role, 'operate');
  const canBuild = mine && roleAllows(my.role, 'build');
  if (!t) {
    return (
      <Win w={w} title="Train">
        <p className="muted">This train no longer exists.</p>
      </Win>
    );
  }
  const stats = trainStats(t.units);
  const motion = client.world?.motions.get(t.id)?.m;

  return (
    <Win w={w} title={t.name} width={360}>
      <div className="kv">
        <span>Status</span>
        <b>{trainStatus(t)}</b>
        <span>Speed</span>
        <b className="mono">
          {Math.round(motion?.speed ?? 0)} / {stats.maxSpeed} km/h
        </b>
        <span>Cargo</span>
        <b className="mono small">{loadText(t.cargo, stats.capacities)}</b>
        <span>Profit</span>
        <b className="mono">
          {formatMoney(t.profitThisYear)} <span className="muted">(last year {formatMoney(t.profitLastYear)})</span>
        </b>
        <span>Consist</span>
        <span className="muted">
          {t.units.length} vehicles · {stats.length.toFixed(1)} tiles · {stats.power.toLocaleString()} kW
        </span>
      </div>
      <Upkeep t={t} mine={mine} />
      {mine && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          {t.status === 'depot' || t.status === 'stopped' ? (
            <button className="primary" onClick={() => act({ type: 'trainAction', id: t.id, action: 'start' })}>
              ▶ Start
            </button>
          ) : (
            <button onClick={() => act({ type: 'trainAction', id: t.id, action: 'stop' })}>■ Stop</button>
          )}
          {t.status !== 'depot' && (
            <>
              <button onClick={() => act({ type: 'trainAction', id: t.id, action: 'toDepot' })}>
                {t.toDepot ? 'Cancel depot' : t.mode === 'air' ? 'Go to hangar' : 'Go to depot'}
              </button>
              {t.mode !== 'air' && (
                <button onClick={() => act({ type: 'trainAction', id: t.id, action: 'reverse' })} title="Only when stopped">
                  ⇄ Reverse
                </button>
              )}
            </>
          )}
          {t.orders.length > 1 && <button onClick={() => act({ type: 'trainAction', id: t.id, action: 'skip' })}>Skip order</button>}
          {canBuild && (
            <button title="Buy a copy of it, on the same line, in its depot (or the nearest one)" onClick={() => act({ type: 'cloneVehicle', id: t.id })}>
              ⧉ Duplicate
            </button>
          )}
          {t.status === 'depot' && canBuild && (
            <button className="danger" onClick={() => confirm(`Sell ${t.name}?`) && act({ type: 'trainAction', id: t.id, action: 'sell' })}>
              Sell
            </button>
          )}
          {motion && (motion.path.length > 0 || motion.air || motion.ship) && (
            <button
              className="ghost"
              onClick={() => {
                if (motion.air) return focusOn(Math.floor(motion.air[0]), Math.floor(motion.air[1]));
                if (motion.ship) return focusOn(Math.floor(motion.ship[0]), Math.floor(motion.ship[1]));
                const tile = segTile(motion.path[0]!);
                const width = client.world!.map.width;
                focusOn(tile % width, Math.floor(tile / width));
              }}
            >
              ⌖ Locate
            </button>
          )}
        </div>
      )}
      <ConsistEditor t={t} mine={canBuild} />
      <VehicleLine
        t={t}
        mine={mine}
        warn={(o) => (o.kind === 'station' ? <PlatformWarning station={o.station} length={stats.length} /> : null)}
      />
    </Win>
  );
}

/** Reliability, age and servicing of a train. */
function Upkeep({ t, mine }: { t: TrainInfo; mine: boolean }) {
  const date = useApp((s) => s.global?.date ?? 0);
  const rel = Math.round((t.reliability ?? baseReliability(t.units)) * 100);
  const age = (date - t.builtDays) / 365;
  const life = lifespan(t.units);
  const sinceService = date - (t.lastService ?? t.builtDays);
  const interval = t.serviceInterval ?? SERVICE_INTERVAL_DAYS;
  return (
    <div className="kv" style={{ marginTop: 6 }}>
      <span>Reliability</span>
      <span className="row">
        <span className="rating-bar" aria-hidden style={{ maxWidth: 90 }}>
          <span style={{ width: `${rel}%`, background: rel < 50 ? 'var(--bad)' : rel < 75 ? 'var(--accent)' : 'var(--ok)' }} />
        </span>
        <b className="mono">{rel}%</b>
        {(t.breakdowns ?? 0) > 0 && <span className="muted small">{t.breakdowns} breakdowns</span>}
      </span>
      <span>Age</span>
      <span className={age >= life ? 'neg' : ''}>
        {age.toFixed(1)} years <span className="muted small">(design life {life})</span>
      </span>
      <span>Service</span>
      <span className="row small">
        {sinceService} days ago · every
        {mine ? (
          <input
            key={interval}
            type="number"
            min={MIN_SERVICE_INTERVAL}
            max={MAX_SERVICE_INTERVAL}
            step={10}
            defaultValue={interval}
            aria-label="Service interval (days)"
            style={{ width: 58, padding: '2px 4px' }}
            onBlur={(e) => {
              const v = Math.round(+e.target.value);
              if (v !== interval) act({ type: 'trainSettings', id: t.id, serviceInterval: v });
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          ` ${interval}`
        )}
        days
      </span>
    </div>
  );
}

/** Warns when a train is longer than every platform of a station: it loads more slowly there. */
function PlatformWarning({ station, length }: { station: number; length: number }) {
  const w = client.world;
  const st = w?.state.stations.get(station);
  const longest = w && st ? longestPlatform(w.map, st) : 0;
  if (longest === 0 || length <= longest + 0.05) return null;
  return (
    <span className="warn-tag" title={`The train is ${length.toFixed(1)} tiles long but the longest platform here is ${longest}: it loads more slowly`}>
      ⚠ longer than the platform
    </span>
  );
}

function DepotWindow({ w }: { w: GameWindow & { kind: 'depot' } }) {
  useApp((s) => s.trainsRev);
  const global = useApp((s) => s.global);
  const settings = useApp((s) => s.room?.settings);
  const my = useMyRole();
  const company = my.companyId;
  const map = client.world?.map;
  const year = global ? ymdFromDays(global.date).year : 1900;
  const timeline = settings?.timeline ?? 'era';
  const engines = RAIL_VEHICLES.filter((v) => v.kind === 'loco' && isAvailable(v, year, timeline));
  const wagons = RAIL_VEHICLES.filter((v) => v.kind === 'wagon' && isAvailable(v, year, timeline));
  const [engine, setEngine] = useState(engines.filter((v) => v.traction !== 'electric').sort((a, b) => b.maxSpeed - a.maxSpeed)[0]?.id ?? engines[0]?.id ?? '');
  const [wagon, setWagon] = useState(wagons.find((v) => v.cargoes?.[0] === 'passengers')?.id ?? wagons[0]?.id ?? '');
  const wagonType = railVehicle(wagon);
  const [cargoChoice, setCargo] = useState<CargoId | ''>('');
  const cargo = cargoChoice && wagonType?.cargoes?.includes(cargoChoice) ? cargoChoice : wagonType?.cargoes?.[0];
  const [count, setCount] = useState(4);
  const units = useMemo<TrainUnit[]>(
    () => [...(engine ? [{ type: engine }] : []), ...Array.from({ length: wagon ? count : 0 }, () => ({ type: wagon, cargo }))],
    [engine, wagon, count, cargo],
  );
  const stats = trainStats(units);
  const price = units.reduce((s, u) => s + (railVehicle(u.type)?.cost ?? 0), 0);
  const inDepot = [...(client.world?.trains.values() ?? [])].filter((t) => t.status === 'depot' && t.depot === w.id);
  const x = map ? w.id % map.width : 0;
  const y = map ? Math.floor(w.id / map.width) : 0;
  const ours = map?.layers.owner[w.id] === company;
  const powered = !!map && isElectrified(map.layers.railType[w.id]!);
  const mine = ours && roleAllows(my.role, 'build');
  const canStart = ours && roleAllows(my.role, 'operate');

  return (
    <Win w={w} title={`Train depot (${x}, ${y})`} width={380}>
      <InsideHeader vehicles={inDepot} canStart={canStart} />
      {inDepot.length === 0 && <p className="muted">No trains in this depot.</p>}
      {inDepot.map((t) => (
        <div className="list-row" key={t.id}>
          <b style={{ flex: 1 }}>{t.name}</b>
          <LineTag t={t} />
          <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
          {canStart && (
            <button className="primary" disabled={t.orders.length === 0} title={t.orders.length ? '' : 'Put it on a line with stops first'} onClick={() => act({ type: 'trainAction', id: t.id, action: 'start' })}>
              ▶
            </button>
          )}
        </div>
      ))}
      {mine && (
        <>
          <h4>Buy a train</h4>
          <label className="field">
            <span>Engine</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              {engines.map((v) => (
                <option key={v.id} value={v.id} disabled={v.traction === 'electric' && !powered}>
                  {v.name} — {v.maxSpeed} km/h, {v.power} kW, {formatMoney(v.cost)}
                  {v.traction === 'electric' && !powered ? ' (needs an electrified depot)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="row" style={{ gap: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 0 }}>
              <span>Wagons</span>
              <select value={wagon} onChange={(e) => setWagon(e.target.value)}>
                {wagons.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} — {v.capacity} {v.cargoes?.[0] === 'passengers' ? 'seats' : CARGOS[v.cargoes?.[0] ?? 'goods'].unit}, {v.maxSpeed} km/h
                  </option>
                ))}
              </select>
            </label>
            {wagonType?.cargoes && wagonType.cargoes.length > 1 && (
              <label className="field" style={{ width: 110 }}>
                <span>Carrying</span>
                <select value={cargo} onChange={(e) => setCargo(e.target.value as CargoId)}>
                  {wagonType.cargoes.map((c) => (
                    <option key={c} value={c}>
                      {CARGOS[c].name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field" style={{ width: 80 }}>
              <span>Count</span>
              <input type="number" min={0} max={20} value={count} onChange={(e) => setCount(Math.max(0, Math.min(20, Math.round(+e.target.value))))} />
            </label>
          </div>
          <p className="muted small" style={{ margin: '0 0 10px' }}>
            {capacityText(stats.capacities)} · max {stats.maxSpeed} km/h · {stats.length.toFixed(1)} tiles long
            {stats.length > MAX_TRAIN_LENGTH ? ' (too long!)' : ''} · running cost {formatMoney(stats.runningCost)}/yr
          </p>
          <button className="primary" style={{ width: '100%' }} disabled={!engine} onClick={() => act({ type: 'buyTrain', depot: w.id, units })}>
            Buy for {formatMoney(price)}
          </button>
        </>
      )}
    </Win>
  );
}

/** Buy buses and trucks, and see the ones parked inside. */
/** A road depot, airport hangar or ship depot: vehicles inside, and buying one. */
function RoadDepotWindow({ w }: { w: GameWindow & { kind: 'roadDepot' | 'hangar' | 'shipDepot' } }) {
  useApp((s) => s.trainsRev);
  const global = useApp((s) => s.global);
  const settings = useApp((s) => s.room?.settings);
  const my = useMyRole();
  const map = client.world?.map;
  const year = global ? ymdFromDays(global.date).year : 1900;
  const air = w.kind === 'hangar';
  const airport = air && map ? client.world?.state.stations.get(map.layers.data[w.id]!) : undefined;
  const sea = w.kind === 'shipDepot';
  const types = (air ? AIRCRAFT : sea ? SHIPS : ROAD_VEHICLES).filter((v) => isAvailable(v, year, settings?.timeline ?? 'era'));
  /** Heavy jets can't be bought at a small airport. */
  const tooBig = (t: { heavy?: boolean }) => air && !!t.heavy && airport?.airport?.kind !== 'large';
  const [type, setType] = useState(types.filter((t) => t.cargoes?.[0] === 'passengers' && !tooBig(t)).at(-1)?.id ?? types[0]?.id ?? '');
  const v = railVehicle(type) ?? types[0];
  const [cargoChoice, setCargo] = useState<CargoId | ''>('');
  const cargo = cargoChoice && v?.cargoes?.includes(cargoChoice) ? cargoChoice : v?.cargoes?.[0];
  const inDepot = [...(client.world?.trains.values() ?? [])].filter((t) => t.status === 'depot' && t.depot === w.id);
  const ours = map?.layers.owner[w.id] === my.companyId;
  const canBuy = ours && roleAllows(my.role, 'build');
  const canStart = ours && roleAllows(my.role, 'operate');
  const x = map ? w.id % map.width : 0;
  const y = map ? Math.floor(w.id / map.width) : 0;
  return (
    <Win w={w} title={air ? `${airport?.name ?? 'Airport'} hangar` : sea ? `Ship depot (${x}, ${y})` : `Road depot (${x}, ${y})`} width={360}>
      <InsideHeader vehicles={inDepot} canStart={canStart} />
      {inDepot.length === 0 && <p className="muted">No {air ? 'aircraft in this hangar' : sea ? 'ships in this depot' : 'vehicles in this depot'}.</p>}
      {inDepot.map((t) => (
        <div className="list-row" key={t.id}>
          <b style={{ flex: 1 }}>{t.name}</b>
          <LineTag t={t} />
          <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
          {canStart && (
            <button className="primary" disabled={t.orders.length === 0} title={t.orders.length ? '' : 'Put it on a line with stops first'} onClick={() => act({ type: 'trainAction', id: t.id, action: 'start' })}>
              ▶
            </button>
          )}
        </div>
      ))}
      {canBuy && v && (
        <>
          <h4>Buy {air ? 'an aircraft' : sea ? 'a ship' : 'a road vehicle'}</h4>
          <div className="row" style={{ gap: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 0 }}>
              <span>Vehicle</span>
              <select value={v.id} onChange={(e) => setType(e.target.value)}>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {t.capacity} {t.cargoes?.[0] === 'passengers' ? 'seats' : CARGOS[t.cargoes?.[0] ?? 'goods'].unit}, {t.maxSpeed} km/h
                    {t.heavy ? ' (large airports)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {v.cargoes && v.cargoes.length > 1 && (
              <label className="field" style={{ width: 110 }}>
                <span>Carrying</span>
                <select value={cargo} onChange={(e) => setCargo(e.target.value as CargoId)}>
                  {v.cargoes.map((c) => (
                    <option key={c} value={c}>
                      {CARGOS[c].name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="muted small" style={{ margin: '0 0 10px' }}>
            {air
              ? v.heavy
                ? airport?.airport?.kind === 'large'
                  ? 'A heavy jet: lands only at large airports (and may crash at small ones).'
                  : 'A heavy jet: needs a large airport to be bought here.'
                : 'Flies between airports.'
              : sea
                ? 'Sails between docks; steer it with buoys.'
                : cargo === 'passengers'
                ? 'A bus: uses bus stops.'
                : 'A truck: uses truck stops.'}{' '}
            Running cost {formatMoney(v.runningCost)}/yr.
          </p>
          <button className="primary" style={{ width: '100%' }} disabled={tooBig(v)} onClick={() => act({ type: 'buyTrain', depot: w.id, units: [{ type: v.id, cargo }] })}>
            Buy for {formatMoney(v.cost)}
          </button>
        </>
      )}
    </Win>
  );
}

function StationWindow({ w }: { w: GameWindow & { kind: 'station' } }) {
  useTick(1000);
  useApp((s) => s.trainsRev);
  const st = client.world?.state.stations.get(w.id);
  if (!st) {
    return (
      <Win w={w} title="Station">
        <p className="muted">This station no longer exists.</p>
      </Win>
    );
  }
  const company = client.world?.state.companies.get(st.owner);
  const serving = [...(client.world?.state.lines.values() ?? [])].filter((l) => l.orders.some((o) => o.kind === 'station' && o.station === st.id));
  const vehicles = [...(client.world?.trains.values() ?? [])];
  const waiting = CARGO_IDS.flatMap((cargo) =>
    Object.entries(st.waiting[cargo] ?? {}).map(([dest, n]) => ({ cargo, dest: Number(dest), n })),
  ).sort((a, b) => b.n - a.n);
  return (
    <Win w={w} title={st.name}>
      <div className="kv">
        <span>Owner</span>
        <b>{company?.name ?? '—'}</b>
        <span>Platforms</span>
        <b className="mono">
          {st.tiles} tiles{client.world ? `, longest ${longestPlatform(client.world.map, st)}` : ''}
        </b>
        {client.world && stationDocks(client.world.map, st).length > 0 && (
          <>
            <span>Docks</span>
            <b className="mono">{stationDocks(client.world.map, st).length}</b>
          </>
        )}
        {st.airport && (
          <>
            <span>Airport</span>
            <b>
              {AIRPORT_TYPES[st.airport.kind].name}, {AIRPORT_TYPES[st.airport.kind].gates} gates
            </b>
          </>
        )}
        <span>Waiting</span>
        <b className="mono small">
          {CARGO_IDS.filter((c) => st.waiting[c])
            .map((c) => cargoAmount(c, Object.values(st.waiting[c]!).reduce((a, b) => a + b, 0)))
            .join(' · ') || 'nothing'}
        </b>
        <span>Accepts</span>
        <span className="small">{st.accepts?.length ? st.accepts.map((c) => CARGOS[c].name).join(', ') : 'nothing'}</span>
        <span>Catchment</span>
        <b className="mono">{client.world ? residentsIn(client.world.map, catchmentRect(client.world.map, st)).toLocaleString('en-GB') : 0} residents</b>
        {st.share !== undefined && st.share < 1 && (
          <>
            <span>Share</span>
            <b className="mono" title="Other stations cover some of the same houses; the better rated a station, the more passengers it gets">
              {Math.round(st.share * 100)}% <span className="muted">(competing stations nearby)</span>
            </b>
          </>
        )}
      </div>
      <RatingBreakdown st={st} />
      <CatchmentToggle id={st.id} />
      {waiting.length > 0 && (
        <ul className="plain small">
          {waiting.slice(0, 8).map((x) => {
            const dest = client.world?.state.stations.get(x.dest);
            return (
              <li key={`${x.cargo}-${x.dest}`}>
                <span className="cargo-dot" style={{ background: CARGOS[x.cargo].color }} /> {cargoAmount(x.cargo, x.n)} →{' '}
                {dest ? (
                  <button className="link" title="Locate this station" onClick={() => focusOn(dest.x, dest.y)}>
                    {dest.name}
                  </button>
                ) : (
                  stationName(x.dest)
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h4>Lines calling here</h4>
      {serving.length === 0 && <p className="muted">None yet.</p>}
      {serving.map((l) => {
        const n = vehicles.filter((t) => t.line === l.id).length;
        return (
          <div className="list-row" key={l.id}>
            <LineSwatch line={l} />
            <b style={{ flex: 1 }}>{l.name}</b>
            <span className="muted small">
              {n} {n === 1 ? 'vehicle' : 'vehicles'}
            </span>
            <button onClick={() => openWindow({ kind: 'line', id: l.id })}>Open</button>
          </div>
        );
      })}
    </Win>
  );
}

function RatingBreakdown({ st }: { st: Station }) {
  const date = useApp((s) => s.global?.date ?? 0);
  const p = ratingParts(st, date);
  const part = (v: number) => <b className={`mono ${v < 0 ? 'neg' : ''}`}>{v > 0 ? `+${v}` : v}</b>;
  const now = ratingPercent(st.rating);
  const target = ratingPercent(p.target);
  return (
    <details className="rating">
      <summary>
        <span>Rating</span>
        <span className="rating-bar" aria-hidden>
          <span style={{ width: `${now}%` }} />
        </span>
        <b className="mono">{now}%</b>
        {target !== now && <span className="muted small mono">{target > now ? '↗' : '↘'} {target}%</span>}
      </summary>
      <div className="kv small">
        <span>Last train called</span>
        <span>
          {st.lastPickup === undefined ? 'never' : p.days === 0 ? 'today' : `${p.days} day${p.days === 1 ? '' : 's'} ago`} {part(p.pickup)}
        </span>
        <span>Passengers waiting</span>
        <span>
          {st.waitingTotal} {part(p.waiting)}
        </span>
        <span>Its top speed</span>
        <span>
          {p.speedKmh === null ? '—' : `${p.speedKmh} km/h`} {part(p.speed)}
        </span>
        <span>Its age</span>
        <span>
          {p.ageYears === null ? '—' : `${p.ageYears} years`} {part(p.age)}
        </span>
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        The rating moves a little each day towards {target}%. Frequent, fast, modern trains and short queues raise it; a
        higher rating brings more passengers.
      </p>
    </details>
  );
}

function TrainListWindow({ w }: { w: GameWindow & { kind: 'trains' } }) {
  useTick(1000);
  useApp((s) => s.trainsRev);
  const company = useMyCompany();
  const trains = [...(client.world?.trains.values() ?? [])].filter((t) => t.owner === company).sort((a, b) => a.id - b.id);
  return (
    <Win w={w} title="Your vehicles" width={480}>
      <button style={{ width: '100%', marginBottom: 8 }} onClick={() => openWindow({ kind: 'lines', id: 0 })}>
        Lines…
      </button>
      {trains.length === 0 && <p className="muted">No vehicles yet. Build a depot (7 for trains, J for road vehicles), click it, and buy one.</p>}
      {trains.map((t) => (
        <div className="list-row" key={t.id}>
          <b style={{ width: 70 }}>{t.name}</b>
          <span className="muted small" style={{ flex: 1, minWidth: 0 }}>
            {trainStatus(t)}
          </span>
          <LineTag t={t} />
          <span className={`mono small ${t.profitThisYear < 0 ? 'neg' : ''}`}>{formatMoney(t.profitThisYear)}</span>
          <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
        </div>
      ))}
    </Win>
  );
}

function CatchmentToggle({ id }: { id: number }) {
  const shown = useApp((s) => s.catchmentFor === id);
  return (
    <button style={{ marginTop: 10, width: '100%' }} className={shown ? 'primary' : ''} aria-pressed={shown} onClick={() => useApp.setState({ catchmentFor: shown ? null : id })}>
      {shown ? 'Hide catchment area' : 'Show catchment area'}
    </button>
  );
}

/** Vehicles of a train; editable (reorder, add, remove, refit) while it's parked in a depot. */
function ConsistEditor({ t, mine }: { t: TrainInfo; mine: boolean }) {
  const current = t.units;
  const currentKey = JSON.stringify(current);
  const [draft, setDraft] = useState<TrainUnit[]>(current);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const global = useApp((st) => st.global);
  const timeline = useApp((st) => st.room?.settings.timeline ?? 'era');
  const year = global ? ymdFromDays(global.date).year : 1900;
  const available = RAIL_VEHICLES.filter((v) => isAvailable(v, year, timeline));
  const [toAdd, setToAdd] = useState(available.find((v) => v.kind === 'wagon')?.id ?? available[0]?.id ?? '');
  useEffect(() => setDraft(JSON.parse(currentKey) as TrainUnit[]), [currentKey]);

  const editable = mine && t.status === 'depot';
  /** Road vehicles and aircraft are a single vehicle that can only be refitted. */
  const road = t.mode === 'road' || t.mode === 'air' || t.mode === 'water';
  const changed = JSON.stringify(draft) !== currentKey;
  const preview = changed ? client.preview({ type: 'editConsist', id: t.id, units: draft }) : null;
  const stats = trainStats(draft);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.length || from === to) return;
    const next = draft.slice();
    const [u] = next.splice(from, 1);
    next.splice(to, 0, u!);
    setDraft(next);
  };
  const refit = (i: number, cargo: CargoId) => setDraft(draft.map((u, k) => (k === i ? { type: u.type, cargo } : u)));

  return (
    <>
      <h4>Vehicles</h4>
      {!editable && mine && <p className="muted small" style={{ margin: '0 0 6px' }}>{road ? 'Send it to a depot to refit it.' : 'Send the train to a depot to rearrange, refit or change its vehicles.'}</p>}
      <ol className="consist">
        {draft.map((u, i) => {
          const v = railVehicle(u.type);
          const cargo = unitCargo(u);
          return (
            <li
              key={i + u.type}
              draggable={editable}
              className={dragFrom === i ? 'dragging' : ''}
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => editable && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null) move(dragFrom, i);
                setDragFrom(null);
              }}
              onDragEnd={() => setDragFrom(null)}
            >
              {editable && <span className="grip" aria-hidden>⋮⋮</span>}
              <span className={`unit-kind ${v?.kind ?? ''}`} style={cargo ? { borderColor: CARGOS[cargo].color } : undefined}>
                {v?.mode === 'air' ? 'Aircraft' : v?.mode === 'water' ? 'Ship' : v?.mode === 'road' ? (cargo === 'passengers' ? 'Bus' : 'Truck') : v?.kind === 'loco' ? 'Engine' : cargo ? CARGOS[cargo].name : 'Wagon'}
              </span>
              <span className="order-name">{v?.name ?? u.type}</span>
              {editable && v?.cargoes && v.cargoes.length > 1 && (
                <select value={cargo} onChange={(e) => refit(i, e.target.value as CargoId)} aria-label={`Refit ${v.name}`} style={{ padding: '2px 4px' }}>
                  {v.cargoes.map((c) => (
                    <option key={c} value={c}>
                      {CARGOS[c].name}
                    </option>
                  ))}
                </select>
              )}
              {editable && !road && (
                <>
                  <button className="ghost small" disabled={i === 0} aria-label="Move forward" onClick={() => move(i, i - 1)}>
                    ↑
                  </button>
                  <button className="ghost small" disabled={i === draft.length - 1} aria-label="Move back" onClick={() => move(i, i + 1)}>
                    ↓
                  </button>
                  <button className="ghost small" aria-label="Remove vehicle" onClick={() => setDraft(draft.filter((_, k) => k !== i))}>
                    ✕
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ol>
      {editable && (
        <>
          <div className="row" style={{ marginBottom: 8, display: road ? 'none' : undefined }}>
            <select value={toAdd} onChange={(e) => setToAdd(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="Vehicle to add">
              {available.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {formatMoney(v.cost)}
                </option>
              ))}
            </select>
            <button onClick={() => toAdd && setDraft([...draft, { type: toAdd }])}>+ Add</button>
            <button className="ghost" title="Reverse the order of all vehicles" onClick={() => setDraft(draft.slice().reverse())}>
              ⇄
            </button>
          </div>
          {changed && (
            <div className="row wrap">
              <span className={`small ${preview && !preview.ok ? 'neg' : 'muted'}`} style={{ flex: 1 }}>
                {preview && !preview.ok
                  ? preview.error
                  : `${capacityText(stats.capacities)} · ${stats.maxSpeed} km/h · ${stats.length.toFixed(1)} tiles · ${preview && preview.ok ? (preview.cost >= 0 ? 'costs ' + formatMoney(preview.cost) : 'refund ' + formatMoney(-preview.cost)) : ''}`}
              </span>
              <button className="ghost" onClick={() => setDraft(current)}>
                Reset
              </button>
              <button className="primary" disabled={!preview?.ok} onClick={() => act({ type: 'editConsist', id: t.id, units: draft })}>
                Apply
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** The line a vehicle runs on, as a small coloured tag. */
function LineTag({ t }: { t: TrainInfo }) {
  useApp((s) => s.linesRev);
  const line = t.line !== undefined ? client.world?.state.lines.get(t.line) : undefined;
  return (
    <span className="muted small row" style={{ gap: 4, maxWidth: 120, overflow: 'hidden', whiteSpace: 'nowrap' }} title={line ? line.name : 'Not on a line'}>
      {line ? (
        <>
          <LineSwatch line={line} />
          {line.name}
        </>
      ) : (
        'no line'
      )}
    </span>
  );
}

/** "Inside" heading of a depot, with a button to start every vehicle in it that has somewhere to go. */
function InsideHeader({ vehicles, canStart }: { vehicles: TrainInfo[]; canStart: boolean }) {
  const ready = vehicles.filter((t) => t.orders.length > 0);
  return (
    <div className="row" style={{ marginBottom: 6 }}>
      <h4 style={{ margin: 0, flex: 1 }}>Inside</h4>
      {canStart && vehicles.length > 1 && (
        <button
          className="primary small"
          disabled={ready.length === 0}
          title={ready.length < vehicles.length ? 'Vehicles without a line with stops stay behind' : 'Start every vehicle in here'}
          onClick={() => ready.forEach((t) => act({ type: 'trainAction', id: t.id, action: 'start' }))}
        >
          ▶ Start all ({ready.length})
        </button>
      )}
    </div>
  );
}
