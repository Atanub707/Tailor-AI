import { getDb, runWithUser, saveNewJobs, bumpLastSeen, markJobsInactive, getAllJobs, listUsers } from '../storage/fileStorage.js';
import { ensureV2Tables } from '../storage/v2Tables.js';
import { fetchBoard } from '../providers/directAtsProvider.js';
import { diffBoard } from './diff.js';
import type { Job } from '../../src/types.js';

const WATCHER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const MAX_CONCURRENT_BOARDS = 3;
const BOARDS_PER_CYCLE = 8;
const MAX_JOBS_PER_BOARD = 25;
const FREE_ATS_PLATFORMS = ['greenhouse', 'lever', 'ashby'];

// Board identity: normalized hostname + pathname of a career URL (lowercase,
// trailing slashes stripped). Job URLs extend the board path with /jobs/<id>
// etc., so a job belongs to a board when its identity starts with the board's
// (boards.greenhouse.io/stripe/jobs/1 → boards.greenhouse.io/stripe).
function boardIdentity(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function belongsToBoard(job: Job, boardId: string): boolean {
  const raw = job.applyUrl || job.url;
  if (!raw) return false;
  const id = boardIdentity(raw);
  return id === boardId || id.startsWith(`${boardId}/`);
}

let searchInFlight = false;

export function setSearchInFlight(v: boolean): void {
  searchInFlight = v;
}

export function isSearchInFlight(): boolean {
  return searchInFlight;
}

export interface WatcherStats {
  boardsChecked: number;
  added: number;
  updated: number;
  missing: number;
  errors: string[];
  skipped: boolean;
}

async function withConcurrencyLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * One refresh cycle: pick a rotating slice of active free-ATS boards (one
 * request per board), diff each against the users' stored jobs (scoped to the
 * board's own company — never the whole platform), persist changes. Never
 * throws — per-board errors are recorded and skipped. Skips entirely while a
 * user search is in flight.
 */
export async function watchOnce(): Promise<WatcherStats> {
  const stats: WatcherStats = { boardsChecked: 0, added: 0, updated: 0, missing: 0, errors: [], skipped: false };
  if (searchInFlight) {
    stats.skipped = true;
    return stats;
  }

  try {
    ensureV2Tables();
  } catch {
    // non-fatal — the board query below still guards against a missing table
  }

  const db = getDb();
  const users = listUsers();
  if (!users.length) return stats;

  const placeholders = FREE_ATS_PLATFORMS.map(() => '?').join(',');
  const all = db.prepare(
    `SELECT companyName, careerUrl, atsPlatform FROM company_career_sites WHERE isActive = 1 AND LOWER(atsPlatform) IN (${placeholders}) ORDER BY rowid`
  ).all(...FREE_ATS_PLATFORMS) as Array<{ companyName: string; careerUrl: string; atsPlatform: string }>;
  if (!all.length) return stats;

  // Rotating slice: the offset advances once per interval and wraps, so every
  // board is eventually refreshed (same rotation shape as the search path).
  const offset = Math.floor(Date.now() / WATCHER_INTERVAL_MS) % all.length;
  const boards = [...all.slice(offset), ...all.slice(0, offset)].slice(0, BOARDS_PER_CYCLE);

  await withConcurrencyLimit(boards, MAX_CONCURRENT_BOARDS, async (board) => {
    const platform = board.atsPlatform.toLowerCase();
    try {
      const fresh = await fetchBoard('Greenhouse', platform, board.companyName, board.careerUrl, MAX_JOBS_PER_BOARD);
      stats.boardsChecked++;
      // The fresh set is ONE company's board — the diff must be scoped to the
      // SAME company's stored jobs, not the whole platform. A platform-wide
      // `existing` set would put every other company's jobs on this platform
      // into `missing` and deactivate them (e.g. 5 greenhouse companies:
      // refreshing Stripe would hide the other 4).
      const boardId = boardIdentity(board.careerUrl);
      for (const user of users) {
        await runWithUser(user.id, async () => {
          const existing = getAllJobs().filter((j) => {
            if (j.atsPlatform !== platform) return false;
            // Same career-site board (hostname + path identity) — this
            // company's jobs on THIS board.
            if (belongsToBoard(j, boardId)) return true;
            // Fallback: a stored job whose URL can't be matched to the board
            // (e.g. a career-site URL that differs) still belongs to this
            // company — never wrongly mark legitimate jobs missing.
            return j.company === board.companyName;
          });
          const diff = diffBoard(existing, fresh, user.id);
          // Cap guard: fetchBoard slices at MAX_JOBS_PER_BOARD, so a board
          // with more live jobs than the cap would yield false "missing"
          // entries for the overflow (the 26th+ job). Absence is only
          // trustworthy when the fetch returned fewer jobs than its cap.
          // (Cross-company false-missing is already excluded by the
          // board-identity scoping above.)
          if (diff.missing.length && fresh.length >= MAX_JOBS_PER_BOARD) {
            diff.missing = [];
          }
          if (diff.added.length) {
            saveNewJobs(diff.added);
            stats.added += diff.added.length;
          }
          if (diff.bumped.length) {
            bumpLastSeen(diff.bumped);
            stats.updated += diff.bumped.length;
          }
          if (diff.missing.length) {
            markJobsInactive(diff.missing);
            stats.missing += diff.missing.length;
          }
        });
      }
    } catch (err: any) {
      stats.errors.push(`${board.companyName}: ${err?.message || err}`);
    }
  });

  return stats;
}

/** Start the background watcher. Returns a stop handle for tests/shutdown. */
export function startWatcher(intervalMs = WATCHER_INTERVAL_MS): { stop(): void } {
  const tick = async () => {
    try {
      const stats = await watchOnce();
      if (stats.added || stats.missing || stats.errors.length) {
        console.log(`[Indexer] watch cycle: ${stats.boardsChecked} boards, +${stats.added} new, ${stats.missing} removed, ${stats.errors.length} errors`);
      }
    } catch (err) {
      console.error('[Indexer] watch cycle failed (non-fatal):', err);
    }
  };
  void tick(); // immediate catch-up on boot
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}