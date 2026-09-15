/**
 * Discovery started from the UI, running in the background.
 *
 * A full pass takes minutes, far longer than a request should stay open, so the
 * button starts a job and the page polls its state. Only one pass runs at a
 * time: two concurrent passes would hit the same boards twice and race on the
 * same rows.
 */

import type { EngineRun } from "../engines/registry.ts";

export interface EngineProgress {
  engine: string;
  status: string;
  fetched: number;
  inserted: number;
  error: string | null;
}

export interface DiscoveryState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  engines: EngineProgress[];
  fetched: number;
  inserted: number;
  /** New postings ranked after discovery finished; null until then. */
  ranked: number | null;
  error: string | null;
}

export type DiscoverRunner = (
  onFinish: (run: EngineRun, inserted: number) => void,
) => Promise<unknown>;

// A function, not a shared constant: spreading one object would share its
// `engines` array, so every pass appended to the previous pass's rows.
function idle(): DiscoveryState {
  return {
    running: false, startedAt: null, finishedAt: null, engines: [],
    fetched: 0, inserted: 0, ranked: null, error: null,
  };
}

export class DiscoveryJob {
  private current: DiscoveryState = idle();
  private pending: Promise<void> | null = null;

  constructor(
    private readonly runner: DiscoverRunner,
    /** Ranks what discovery added, so new postings arrive sorted. */
    private readonly rankNew?: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  state(): DiscoveryState {
    return { ...this.current, engines: [...this.current.engines] };
  }

  /** Start a pass. Returns false, and changes nothing, if one is already running. */
  start(): boolean {
    if (this.current.running) return false;

    this.current = { ...idle(), running: true, startedAt: this.now().toISOString() };

    this.pending = (async () => {
      try {
        await this.runner((run, inserted) => {
          this.current.engines.push({
            engine: run.engine,
            status: run.status,
            fetched: run.fetched,
            inserted,
            error: run.error ?? null,
          });
          this.current.fetched += run.fetched;
          this.current.inserted += inserted;
        });
        if (this.rankNew) this.current.ranked = this.rankNew();
      } catch (err) {
        this.current.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.current.running = false;
        this.current.finishedAt = this.now().toISOString();
      }
    })();

    return true;
  }

  /** Resolves when the running pass ends. For tests and shutdown. */
  async settled(): Promise<void> {
    await this.pending;
  }
}
