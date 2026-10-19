/// <reference lib="webworker" />
import { solveLinkGraph, type LinkGraphInput } from '@transportsim/shared';

/** Solves cargodist link graphs off the room's tick thread. */
self.onmessage = (e: MessageEvent<{ id: number; inputs: LinkGraphInput[] }>) => {
  self.postMessage({ id: e.data.id, results: e.data.inputs.map(solveLinkGraph) });
};
