// Background ATS ingestion — EXTRACT (bounded) → TRANSFORM (reuse existing
// normalizers) → LOAD (upsert into ats_jobs).
//
// This module is PROFESSION-NEUTRAL by construction: it fetches boards and
// stores every normalized job. There is no "DevOps"/"Security"/etc. anywhere
// here — the generic relevance engine decides relevance at QUERY time.
//
// Safety rules (all config-driven):
//   * bounded concurrency (never Promise.all over thousands of boards)
//   * per-board timeout
//   * exponential backoff + jitter on failures (never endless retry)
//   * a failed board fetch records failure state and NEVER deactivates jobs
//   * refresh cadence scales with observed board activity
//   * batched SQLite transactions (one per board)

import type { Job } from '../../src/types.js';
import { fetchAtsBoard } from '../providers/directAtsProvider.js';
import { classifyFromText } from '../scraper/workMode.js';
import {
  upsertAtsJobs,
  recordBoardAttempt,
  boardSlug,
  type AtsJobRow,
  type BoardRefreshRow,
} from './atsRepository.js';

export interface AtsIndexConfig {
  concurrency: number;
  timeoutMs: number;
  absenceGraceHours: number;
  retentionDays: number;
  failureBackoffBaseMs: number;
  refreshIntervalsMs: { veryActive: number; active: number; normal: number; quiet: number };
}

export function defaultAtsIndexConfig(env: NodeJS.ProcessEnv = process.env): AtsIndexConfig {
  const num = (key: string, fallback: number): number => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    concurrency: Math.min(Math.max(num('ATS_INDEX_CONCURRENCY', 10), 1), 20),
    timeoutMs: num('ATS_INDEX_TIMEOUT_MS', 15000),
    absenceGraceHours: num('ATS_ABSENCE_GRACE_HOURS', 48),
    retentionDays: num('ATS_INACTIVE_RETENTION_DAYS', 30),
    failureBackoffBaseMs: num('ATS_INDEX_FAILURE_BACKOFF_MS', 60 * 60e3),
    refreshIntervalsMs: {
      veryActive: num('ATS_INTERVAL_VERY_ACTIVE_MS', 2 * 3600e3),
      active: num('ATS_INTERVAL_ACTIVE_MS', 4 * 3600e3),
      normal: num('ATS_INTERVAL_NORMAL_MS', 12 * 3600e3),
      quiet: num('ATS_INTERVAL_QUIET_MS', 24 * 3600e3),
    },
  };
}

/** Refresh cadence by observed activity: busy boards refresh more often. */
export function refreshIntervalMs(cfg: AtsIndexConfig, lastJobCount: number | null | undefined): number {
  if (lastJobCount === null || lastJobCount === undefined) return cfg.refreshIntervalsMs.normal;
  if (lastJobCount >= 100) return cfg.refreshIntervalsMs.veryActive;
  if (lastJobCount >= 20) return cfg.refreshIntervalsMs.active;
  if (lastJobCount >= 1) return cfg.refreshIntervalsMs.normal;
  return cfg.refreshIntervalsMs.quiet;
}

/** Exponential backoff with jitter — capped so failures never starve a board. */
export function failureBackoffMs(cfg: AtsIndexConfig, failures: number): number {
  const base = cfg.failureBackoffBaseMs * 2 ** Math.min(failures, 4);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function toAtsRow(j: Job, platform: string, slug: string): AtsJobRow {
  const workMode = classifyFromText(`${j.location || ''} ${j.description || ''}`.slice(0, 2000));
  return {
    fingerprint: j.fingerprint || `${platform}-${j.externalId || j.id}`,
    ats_platform: platform,
    external_id: String(j.externalId ?? j.id ?? ''),
    company: j.company || '',
    company_slug: slug,
    title: j.title || '',
    location: j.location,
    employment_type: j.employmentType,
    work_mode: workMode ?? undefined,
    posted_date: j.postedDate,
    posted_date_semantics: j.postedDateSemantics,
    apply_url: j.applyUrl || j.url,
    job_url: j.url || j.applyUrl,
    description: j.description,
    first_seen_at: '',
    last_seen_at: '',
    last_fetched_at: new Date().toISOString(),
    is_active: 1,
  };
}

export interface BoardSyncResult {
  ok: boolean;
  jobs: number;
}

/** Sync ONE board: fetch → normalize → upsert → record refresh state. */
export async function syncBoard(board: BoardRefreshRow, cfg: AtsIndexConfig): Promise<BoardSyncResult> {
  const slug = boardSlug(board.careerUrl, board.atsPlatform);
  if (!slug) {
    // Unparseable URL — count as a failure so it backs off, never retried hot.
    const next = new Date(Date.now() + failureBackoffMs(cfg, board.failureCount + 1)).toISOString();
    recordBoardAttempt(board.atsPlatform, board.atsCompanySlug || slug || '', false, 0, next);
    return { ok: false, jobs: 0 };
  }
  const t0 = Date.now();
  try {
    const jobs = await fetchAtsBoard('ATS-Index', board.atsPlatform, slug, board.companyName, cfg.timeoutMs);
    const rows = jobs.map((j) => toAtsRow(j, board.atsPlatform, slug));
    const { inserted, updated } = upsertAtsJobs(rows);
    const next = new Date(Date.now() + refreshIntervalMs(cfg, rows.length)).toISOString();
    recordBoardAttempt(board.atsPlatform, slug, true, rows.length, next);
    console.log(`[ATS Index][${board.atsPlatform}] synced ${slug}: ${rows.length} active, ${inserted} new, ${updated} updated, ${Date.now() - t0}ms`);
    return { ok: true, jobs: rows.length };
  } catch (err: any) {
    // A malformed/uninitialized board row must never crash the cycle —
    // failureCount defaults to 0 (fresh board = first failure).
    const failures = (board.failureCount ?? 0) + 1;
    const next = new Date(Date.now() + failureBackoffMs(cfg, failures)).toISOString();
    recordBoardAttempt(board.atsPlatform, slug, false, 0, next);
    console.warn(`[ATS Index][${board.atsPlatform}] ${slug} failed: ${String(err?.message || err).slice(0, 160)} (failures=${failures}, next=${next.slice(0, 19)})`);
    return { ok: false, jobs: 0 };
  }
}

export interface CycleResult {
  boards: number;
  ok: number;
  failed: number;
  jobs: number;
}

/**
 * Sync a batch of boards with bounded concurrency. Worker-pool pattern:
 * at most `cfg.concurrency` boards in flight — never a mass Promise.all.
 */
export async function syncBoards(boards: BoardRefreshRow[], cfg: AtsIndexConfig): Promise<CycleResult> {
  const result: CycleResult = { boards: boards.length, ok: 0, failed: 0, jobs: 0 };
  if (boards.length === 0) return result;
  let idx = 0;
  const workers = Array.from({ length: Math.min(cfg.concurrency, boards.length) }, async () => {
    while (idx < boards.length) {
      const board = boards[idx++];
      const r = await syncBoard(board, cfg);
      if (r.ok) {
        result.ok++;
        result.jobs += r.jobs;
      } else {
        result.failed++;
      }
    }
  });
  await Promise.all(workers);
  return result;
}