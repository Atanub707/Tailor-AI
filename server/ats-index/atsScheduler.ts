// In-process ATS index scheduler (OPTION A — same backend process).
//
// Chosen over a separate worker container because this is a local
// desktop-style Docker Compose app: one container keeps startup ordering,
// health checks, memory, and user confusion minimal, and the index must live
// on the persistent ./data volume anyway. Indexing is fully async: a cycle
// never blocks HTTP requests, and the app stays usable while it runs.
//
// Lifecycle rules:
//   * cycles never overlap (inProgress guard)
//   * a cycle = pick due boards (bounded batch) → bounded sync → stale
//     deactivation (grace-based) → retention purge
//   * network failures affect freshness only — they never clear the index

import { pickDueBoards, deactivateStaleJobs, purgeInactiveJobs } from './atsRepository.js';
import { syncBoards, defaultAtsIndexConfig, type AtsIndexConfig } from './atsIndexer.js';

// Process-wide flag so the status endpoint/UI can report a cycle in flight
// (index "building") even though the scheduler instances are private.
let anyCycleRunning = false;
export function isAtsCycleRunning(): boolean {
  return anyCycleRunning;
}

export class AtsScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private runningSince = 0;
  private runToken = 0;

  constructor(
    private readonly platform: string,
    private readonly cfg: AtsIndexConfig,
    private readonly tickMs: number,
    private readonly batchSize: number,
    /** Watchdog cap — generous by design: it breaks permanent freezes only. */
    private readonly hardCapMs: number = batchSize * (cfg.timeoutMs * 2) + 60e3
  ) {}

  start(): void {
    if (this.timer) return;
    // First tick fires immediately so a fresh install starts ingesting
    // without waiting a full tick interval; start() never blocks startup.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  inProgress(): boolean {
    return this.running;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      // A previous cycle's promise never settled. The inProgress guard must
      // never be a one-way latch: one hung await would otherwise freeze this
      // platform's ingestion permanently (observed: 4 days of no Greenhouse
      // syncs while every board sat due).
      const stuckFor = Date.now() - this.runningSince;
      if (stuckFor < this.hardCapMs) return;
      console.warn(
        `[ATS Index][${this.platform}] watchdog: previous cycle still running after ${Math.round(stuckFor / 1000)}s — resetting`
      );
      this.running = false;
    }
    this.running = true;
    this.runningSince = Date.now();
    const token = ++this.runToken;
    anyCycleRunning = true;
    try {
      const boards = pickDueBoards(this.platform, this.batchSize);
      if (boards.length === 0) return;
      const result = await syncBoards(boards, this.cfg);
      console.log(
        `[ATS Index][${this.platform}] cycle: ${result.boards} boards, ${result.ok} ok, ${result.failed} failed, ${result.jobs} jobs observed`
      );
      // Lifecycle maintenance per cycle — conservative by default.
      const deactivated = deactivateStaleJobs(this.cfg.absenceGraceHours, this.platform);
      const purged = purgeInactiveJobs(this.cfg.retentionDays, this.platform);
      if (deactivated || purged) {
        console.log(`[ATS Index][${this.platform}] lifecycle: ${deactivated} deactivated (stale), ${purged} purged (retention)`);
      }
    } catch (err: any) {
      console.error(`[ATS Index][${this.platform}] cycle error: ${String(err?.message || err).slice(0, 200)}`);
    } finally {
      // Only the CURRENT run may clear the flag — a watchdog-replaced run
      // finishing late must not open the door to overlapping cycles.
      if (this.runToken === token) {
        this.running = false;
        anyCycleRunning = false;
      }
    }
  }
}

export interface SchedulerOptions {
  tickMs?: number;
  batchSize?: number;
}

export function createAtsScheduler(platform: string, opts: SchedulerOptions = {}): AtsScheduler {
  const cfg = defaultAtsIndexConfig();
  const num = (key: string, fallback: number): number => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  // Provider-specific overrides (suffix per platform) — a platform with
  // different safe concurrency/cadence never inherits another's numbers.
  const numP = (key: string, fallback: number): number => {
    const v = Number(process.env[`${key}_${platform.toUpperCase()}`]);
    return Number.isFinite(v) && v > 0 ? v : num(key, fallback);
  };
  const cfgP: AtsIndexConfig = {
    ...cfg,
    concurrency: Math.min(Math.max(numP('ATS_INDEX_CONCURRENCY', cfg.concurrency), 1), 20),
    timeoutMs: numP('ATS_INDEX_TIMEOUT_MS', cfg.timeoutMs),
  };
  return new AtsScheduler(platform, cfgP, opts.tickMs ?? numP('ATS_INDEX_TICK_MS', 60e3), opts.batchSize ?? numP('ATS_INDEX_BATCH', 50));
}