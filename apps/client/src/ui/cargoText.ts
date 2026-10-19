import { CARGOS, CARGO_IDS, type CargoId, type CargoPacket } from '@transportsim/shared';

/** "120 passengers · 30 bags of mail". */
export function capacityText(caps: Partial<Record<CargoId, number>>): string {
  const parts = CARGO_IDS.filter((c) => caps[c]).map((c) => `${caps[c]} ${c === 'passengers' ? 'seats' : `${CARGOS[c].unit} of ${CARGOS[c].name.toLowerCase()}`}`);
  return parts.length ? parts.join(' · ') : 'no cargo space';
}

/** Cargo aboard against capacity, per cargo: "40/120 passengers · 10/30 mail". */
export function loadText(cargo: readonly CargoPacket[], caps: Partial<Record<CargoId, number>>): string {
  const parts = CARGO_IDS.filter((c) => caps[c]).map((c) => {
    const n = cargo.reduce((s, p) => s + (p.cargo === c ? p.n : 0), 0);
    return `${n}/${caps[c]} ${c === 'passengers' ? 'passengers' : CARGOS[c].name.toLowerCase()}`;
  });
  return parts.length ? parts.join(' · ') : '—';
}
