import type { GameState } from '../sim/state.ts';
import { cargoCount, type JumpOrder, type Train } from './train.ts';

/** Days between services before a train needs one. */
export const SERVICE_INTERVAL_DAYS = 150;

export function needsService(state: GameState, t: Train): boolean {
  return state.date - (t.lastService ?? t.builtDays) > SERVICE_INTERVAL_DAYS;
}

/** The value a jump order's condition looks at. */
export function conditionValue(state: GameState, t: Train, o: JumpOrder): number {
  switch (o.cond) {
    case 'load': {
      const cap = state.rail.statsOf(t).capacity;
      return cap > 0 ? (cargoCount(t) / cap) * 100 : 0;
    }
    case 'age':
      return (state.date - t.builtDays) / 365;
    case 'reliability':
      return (t.reliability ?? 1) * 100;
    default:
      return 0;
  }
}

export function conditionMet(state: GameState, t: Train, o: JumpOrder): boolean {
  if (o.cond === 'always') return true;
  if (o.cond === 'service') return needsService(state, t);
  const v = conditionValue(state, t, o);
  return o.op === 'ge' ? v >= (o.value ?? 0) : v < (o.value ?? 0);
}

/** If the current order is a jump, follow jumps until a real order (gives up after a full round). */
export function settleOrders(state: GameState, t: Train): void {
  const n = t.orders.length;
  if (n === 0) {
    t.orderIndex = 0;
    return;
  }
  let i = t.orderIndex % n;
  for (let guard = 0; guard < n; guard++) {
    const o = t.orders[i]!;
    if (o.kind !== 'jump') break;
    i = conditionMet(state, t, o) ? Math.min(Math.max(0, o.to), n - 1) : (i + 1) % n;
  }
  t.orderIndex = i;
}

/** Move to the next order, following conditional jumps. */
export function advanceOrder(state: GameState, t: Train): void {
  if (t.orders.length === 0) return;
  t.orderIndex = (t.orderIndex + 1) % t.orders.length;
  settleOrders(state, t);
  t.routeFor = '';
  state.dirtyTrains.add(t.id);
}

/** Index of the order after the current one (following jumps), without changing the train. */
export function peekNextOrder(state: GameState, t: Train): number {
  const saved = t.orderIndex;
  t.orderIndex = (t.orderIndex + 1) % Math.max(1, t.orders.length);
  settleOrders(state, t);
  const next = t.orderIndex;
  t.orderIndex = saved;
  return next;
}
