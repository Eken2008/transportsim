import type { Random } from '../util/random.ts';

const PREFIX = [
  'Ash', 'Brook', 'Clay', 'Elm', 'Fair', 'Glen', 'Hart', 'Kings', 'Lang', 'Mill', 'North', 'Oak',
  'Pine', 'Red', 'Stone', 'Thorn', 'West', 'Wick', 'Wood', 'Bram', 'Cold', 'Dun', 'Ever', 'Frost',
  'Holl', 'Iron', 'Marl', 'Nether', 'Rye', 'Sand', 'Silver', 'Tal', 'Wend', 'Alder', 'Birch', 'Cran',
  'East', 'Gold', 'Haw', 'Lark', 'Moor', 'Pen', 'Quarry', 'Ros', 'South', 'Thistle', 'Wil', 'Yar',
];
const SUFFIX = [
  'ford', 'bury', 'ton', 'ham', 'field', 'wick', 'stead', 'by', 'mouth', 'bridge', 'dale', 'worth',
  'ley', 'hurst', 'combe', 'more', 'port', 'well', 'gate', 'haven', 'chester', 'thorpe', 'wood', 'brook',
];
const DECOR = ['Upper ', 'Lower ', 'Great ', 'Little ', 'New ', 'Old '];

/** Generate a unique fictional English-style town name. */
export function townName(rng: Random, used: Set<string>): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    let name = rng.pick(PREFIX) + rng.pick(SUFFIX);
    if (attempt > 40 || rng.chance(0.08)) name = rng.pick(DECOR) + name;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `Town ${used.size + 1}`;
  used.add(fallback);
  return fallback;
}
