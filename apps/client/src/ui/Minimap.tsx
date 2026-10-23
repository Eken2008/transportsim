import {
  CARGOS,
  CARGO_IDS,
  COMPANY_COLORS,
  OWNER_NONE,
  OverviewKind,
  industryType,
  overviewBand,
  overviewKind,
  reputationLabel,
  reputationOf,
  type Overview,
} from '@transportsim/shared';
import { useEffect, useRef, useState } from 'react';
import { client } from '../net/client.ts';
import { storageGet, storageSet } from '../net/identity.ts';
import { useApp } from '../store.ts';
import { COMPACT, matches, useMedia } from './media.ts';
import { focusOn, useMyRole } from './windows.tsx';

type Layer = 'terrain' | 'owners' | 'industries' | 'towns' | 'cargo';
const LAYERS: { id: Layer; icon: string; label: string; hint: string }[] = [
  { id: 'terrain', icon: '⛰', label: 'Land', hint: 'Land and water, towns, industries, track and roads' },
  { id: 'owners', icon: '🏢', label: 'Owners', hint: 'Track, roads and stations in their company’s colour' },
  { id: 'industries', icon: '🏭', label: 'Industries', hint: 'Industries in the colour of what they make' },
  { id: 'towns', icon: '🏘', label: 'Towns', hint: 'Towns by size, coloured by your reputation: red poor, green good' },
  { id: 'cargo', icon: '⛓', label: 'Cargo', hint: 'Last month’s cargo flows between stations: thicker carries more' },
];
const WIDTHS = { small: 210, large: 420 } as const;
type Size = keyof typeof WIDTHS;
const PREFS_KEY = 'ts.minimap';

interface Prefs {
  layer: Layer;
  size: Size;
  open: boolean;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(storageGet(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      layer: LAYERS.some((l) => l.id === p.layer) ? p.layer! : 'terrain',
      size: p.size === 'large' ? 'large' : 'small',
      // On a phone it starts hidden, as it would cover much of the screen.
      open: p.open ?? !matches(COMPACT),
    };
  } catch {
    return { layer: 'terrain', size: 'small', open: !matches(COMPACT) };
  }
}

// ---- colours ---------------------------------------------------------------------

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const KIND_COLORS: Record<number, RGB> = {
  [OverviewKind.Sea]: [43, 88, 132],
  [OverviewKind.Waterway]: [70, 132, 186],
  [OverviewKind.Land]: [96, 142, 66],
  [OverviewKind.Trees]: [54, 100, 46],
  [OverviewKind.Snow]: [232, 238, 242],
  [OverviewKind.Desert]: [214, 193, 138],
  [OverviewKind.Field]: [176, 162, 88],
  [OverviewKind.Town]: [158, 156, 150],
  [OverviewKind.Industry]: [178, 104, 72],
  [OverviewKind.Road]: [206, 196, 170],
  [OverviewKind.Rail]: [64, 56, 52],
  [OverviewKind.Station]: [245, 245, 245],
  [OverviewKind.Building]: [214, 122, 92],
  [OverviewKind.WaterWorks]: [130, 160, 180],
};
const HIGH: RGB = [176, 168, 120];
const DARK: RGB = [16, 24, 32];
/** Kinds a company owns (drawn in its colour on the owners layer). */
const OWNED = new Set<number>([OverviewKind.Road, OverviewKind.Rail, OverviewKind.Station, OverviewKind.Building, OverviewKind.WaterWorks]);
const NATURAL = new Set<number>([OverviewKind.Land, OverviewKind.Trees, OverviewKind.Field]);

/** The colour of one overview cell on a layer. */
function cellColor(cell: number, owner: number, layer: Layer, ownerColor: (id: number) => RGB | null): RGB {
  const kind = overviewKind(cell);
  let c = KIND_COLORS[kind] ?? KIND_COLORS[OverviewKind.Land]!;
  // Higher land is paler, so hills show.
  if (NATURAL.has(kind)) c = mix(c, HIGH, Math.min(1, overviewBand(cell) / 12) * 0.7);
  if (layer === 'terrain') return c;
  if (layer === 'owners') {
    if (OWNED.has(kind) && owner !== OWNER_NONE) return ownerColor(owner) ?? c;
    return mix(c, DARK, kind === OverviewKind.Town ? 0.35 : 0.55);
  }
  // Under towns, industries and cargo flows the map steps back.
  return mix(c, DARK, kind === OverviewKind.Sea || kind === OverviewKind.Waterway ? 0.45 : 0.62);
}

function paint(ov: Overview, layer: Layer, ownerColor: (id: number) => RGB | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ov.w;
  canvas.height = ov.h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(ov.w, ov.h);
  const cache = new Map<number, RGB>();
  for (let i = 0; i < ov.cells.length; i++) {
    const key = ov.cells[i]! * 256 + ov.owners[i]!;
    let c = cache.get(key);
    if (!c) cache.set(key, (c = cellColor(ov.cells[i]!, ov.owners[i]!, layer, ownerColor)));
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Reputation -1000..1000 as red (poor) to green (good). */
const reputationColor = (r: number) => `hsl(${Math.round(Math.max(0, Math.min(1, (r + 600) / 1400)) * 120)}, 70%, 52%)`;

function industryColor(type: string): string {
  const t = industryType(type);
  const c = t?.produces[0] ?? t?.accepts[0];
  return c ? CARGOS[c].color : '#b26848';
}

// ---- the panel ----------------------------------------------------------------------

/**
 * A map of the whole world in the corner: click or drag to move the camera, with a frame
 * showing what the camera sees, and layers for owners, industries, towns and cargo flows.
 */
export function Minimap({ view }: { view: () => [number, number][] | null }) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const update = (p: Partial<Prefs>) =>
    setPrefs((old) => {
      const next = { ...old, ...p };
      storageSet(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const company = useMyRole().companyId;
  const companies = useApp((s) => s.global?.companies);
  const map = client.world?.map;
  // The large map fits a narrow screen.
  const narrow = useMedia('(max-width: 460px)');
  const width = narrow && prefs.size === 'large' ? Math.min(WIDTHS.large, window.innerWidth - 36) : WIDTHS[prefs.size];
  const height = map ? Math.round((width * map.height) / map.width) : width;

  // Owner colours change only when companies are founded or recoloured.
  const colorKey = companies?.map((c) => `${c.id}:${c.color}`).join() ?? '';
  const live = useRef({ layer: prefs.layer, company, colorKey });
  live.current = { layer: prefs.layer, company, colorKey };

  useEffect(() => {
    if (!prefs.open) return;
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d')!;
    let base: HTMLCanvasElement | null = null;
    let baseKey = '';
    let raf = 0;
    let last = 0;
    let drawn = '';
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 100) return;
      last = now;
      const world = client.world;
      const ov = world?.overview;
      if (!world || !ov) return;
      const { layer, company: me } = live.current;
      const key = `${world.overviewRev}|${layer}|${live.current.colorKey}`;
      // Only draw again when the map or the camera's frame has changed.
      const quad = view();
      const frame = `${key}|${me}|${world.townsRev}|${world.industriesRev}|${world.stationsRev}|${world.flowsRev}|${quad?.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}`;
      if (frame === drawn) return;
      drawn = frame;
      if (key !== baseKey) {
        const byId = new Map(useApp.getState().global?.companies.map((c) => [c.id, hex(COMPANY_COLORS[c.color % COMPANY_COLORS.length]!)]) ?? []);
        base = paint(ov, layer, (id) => byId.get(id) ?? null);
        baseKey = key;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(base!, 0, 0, width, height);
      const k = width / world.map.width;
      if (layer === 'industries') {
        for (const ind of world.state.industries.values()) {
          ctx.fillStyle = industryColor(ind.type);
          ctx.fillRect(ind.x * k, ind.y * k, Math.max(2.5, ind.w * k), Math.max(2.5, ind.h * k));
        }
      } else if (layer === 'towns') {
        for (const t of world.state.towns.values()) {
          const r = Math.max(2, Math.sqrt(t.population) * 0.14) * (width / 210);
          ctx.beginPath();
          ctx.arc(t.x * k, t.y * k, r, 0, Math.PI * 2);
          ctx.fillStyle = me === null ? '#c8c8c8' : reputationColor(reputationOf(t, me));
          ctx.fill();
        }
      } else if (layer === 'cargo') {
        const flows = world.flows;
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.85;
        for (let i = 0; i + 3 < flows.length; i += 4) {
          const a = world.state.stations.get(flows[i]!);
          const b = world.state.stations.get(flows[i + 1]!);
          const cargo = CARGO_IDS[flows[i + 2]!];
          if (!a || !b || !cargo) continue;
          ctx.strokeStyle = CARGOS[cargo].color;
          ctx.lineWidth = Math.min(6, 1 + Math.log2(1 + flows[i + 3]! / 100)) * (width / 210);
          ctx.beginPath();
          ctx.moveTo(a.x * k, a.y * k);
          ctx.lineTo(b.x * k, b.y * k);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // What the camera sees.
      if (quad) {
        ctx.beginPath();
        quad.forEach(([x, y], j) => (j ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
        ctx.closePath();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [prefs.open, width, height, view]);

  /** Tile coordinates under a pointer event. */
  const tileAt = (e: React.PointerEvent): [number, number] | null => {
    const m = client.world?.map;
    if (!m) return null;
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * m.width, ((e.clientY - r.top) / r.height) * m.height];
  };

  /** What is under the pointer, by name. */
  const describe = (x: number, y: number): string | null => {
    const world = client.world!;
    const near = (8 * world.map.width) / width;
    const layer = prefs.layer;
    if (layer === 'industries' || layer === 'terrain') {
      for (const ind of world.state.industries.values()) {
        if (x >= ind.x - 1 && x <= ind.x + ind.w + 1 && y >= ind.y - 1 && y <= ind.y + ind.h + 1) return ind.name;
      }
    }
    if (layer === 'cargo' || layer === 'owners') {
      let best: { d: number; name: string } | null = null;
      for (const st of world.state.stations.values()) {
        const d = Math.hypot(st.x - x, st.y - y);
        if (d < near && (!best || d < best.d)) best = { d, name: st.name };
      }
      if (best) return best.name;
    }
    let town: { d: number; text: string } | null = null;
    for (const t of world.state.towns.values()) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < near * 1.5 && (!town || d < town.d)) {
        const rep = layer === 'towns' && company !== null ? ` · ${reputationLabel(reputationOf(t, company)).toLowerCase()} reputation` : '';
        town = { d, text: `${t.name} (${t.population.toLocaleString('en-GB')})${rep}` };
      }
    }
    return town?.text ?? null;
  };

  const dragging = useRef(false);
  const layerInfo = LAYERS.find((l) => l.id === prefs.layer)!;

  if (!prefs.open) {
    return (
      <div className="panel minimap closed">
        <button className="ghost" title="Show the map" onClick={() => update({ open: true })}>
          🗺 Map
        </button>
      </div>
    );
  }
  return (
    <div className="panel minimap" style={{ width: width + 16 }}>
      <div className="minimap-bar">
        <div className="seg" role="radiogroup" aria-label="Map layer">
          {LAYERS.map((l) => (
            <button
              key={l.id}
              role="radio"
              aria-checked={prefs.layer === l.id}
              aria-label={l.label}
              className={prefs.layer === l.id ? 'primary' : 'ghost'}
              title={`${l.label}: ${l.hint}`}
              onClick={() => update({ layer: l.id })}
            >
              {l.icon}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="ghost" title={prefs.size === 'small' ? 'Larger map' : 'Smaller map'} aria-label={prefs.size === 'small' ? 'Larger map' : 'Smaller map'} onClick={() => update({ size: prefs.size === 'small' ? 'large' : 'small' })}>
          {prefs.size === 'small' ? '⤢' : '⤡'}
        </button>
        <button className="ghost" title="Hide the map" aria-label="Hide the map" onClick={() => update({ open: false })}>
          ✕
        </button>
      </div>
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        aria-label={`Map: ${layerInfo.label.toLowerCase()}. Click to move the camera there.`}
        onPointerDown={(e) => {
          const p = tileAt(e);
          if (!p) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          focusOn(Math.floor(p[0]), Math.floor(p[1]));
        }}
        onPointerMove={(e) => {
          const p = tileAt(e);
          if (!p) return;
          if (dragging.current) focusOn(Math.floor(p[0]), Math.floor(p[1]));
          else setHover(describe(p[0], p[1]));
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerLeave={() => setHover(null)}
      />
      <div className="minimap-caption muted small">{hover ?? layerInfo.hint}</div>
    </div>
  );
}
