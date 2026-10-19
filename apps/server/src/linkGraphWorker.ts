import { solveLinkGraph, type LinkGraphResult, type LinkGraphRunner } from '@transportsim/shared';

/**
 * A link graph runner backed by a Bun Worker. Results come back asynchronously; if the worker
 * fails, graphs are solved on the calling thread instead.
 */
export class LinkGraphWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (results: LinkGraphResult[]) => void>();

  constructor() {
    try {
      this.worker = new Worker(new URL('./workers/linkGraph.ts', import.meta.url));
      this.worker.onmessage = (e: MessageEvent<{ id: number; results: LinkGraphResult[] }>) => {
        const done = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        done?.(e.data.results);
      };
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  readonly runner: LinkGraphRunner = (inputs, done) => {
    if (!this.worker) return done(inputs.map(solveLinkGraph));
    const id = this.nextId++;
    this.pending.set(id, done);
    this.worker.postMessage({ id, inputs });
  };

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
