import { expect, test } from 'bun:test';
import type { LinkGraphResult } from '@transportsim/shared';
import { LinkGraphWorker } from '../src/linkGraphWorker.ts';

test('link graphs are solved in a worker', async () => {
  const w = new LinkGraphWorker();
  const results = await new Promise<LinkGraphResult[]>((resolve) =>
    w.runner(
      [
        {
          cargo: 'passengers',
          symmetric: true,
          stations: [
            { id: 1, x: 0, y: 0, supply: 10, accepts: true },
            { id: 2, x: 10, y: 0, supply: 10, accepts: true },
          ],
          links: [
            { from: 1, to: 2, capacity: 50 },
            { from: 2, to: 1, capacity: 50 },
          ],
        },
      ],
      resolve,
    ),
  );
  w.terminate();
  expect(results).toHaveLength(1);
  expect(results[0]!.nextHop).toEqual([
    [1, [[2, 2]]],
    [2, [[1, 1]]],
  ]);
});
