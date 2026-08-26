import type { Job } from '../../src/types.js';

export interface BoardDiff {
  added: Job[];      // ids not seen before
  bumped: string[];  // ids still present — bump lastSeenAt
  missing: string[]; // previously-known ids absent from this fetch
}

/**
 * Pure incremental diff between the stored jobs for a board and a fresh fetch.
 * Identity = job.id. No DB writes here — the watcher (Task 4) persists via
 * saveNewJobs / bumpLastSeen / markJobsInactive.
 * `userId` is part of the plan contract (per-user board sets); the diff itself
 * is pure over the two arrays passed in.
 */
export function diffBoard(existingJobs: Job[], fresh: Job[], userId: string): BoardDiff {
  const existingIds = new Set(existingJobs.map((j) => j.id));
  const freshIds = new Set(fresh.map((j) => j.id));
  const added = fresh.filter((j) => !existingIds.has(j.id));
  const bumped = fresh.map((j) => j.id).filter((id) => existingIds.has(id));
  const missing = [...existingIds].filter((id) => !freshIds.has(id));
  return { added, bumped, missing };
}