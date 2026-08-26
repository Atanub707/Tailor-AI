import type { Job } from '../../src/types.js';

export interface BoardDiff {
  added: Job[];      // ids not seen before
  bumped: string[];  // ids still present, unchanged — bump lastSeenAt
  changed: string[]; // ids still present but materially different — update stored data
  missing: string[]; // previously-known ids absent from this fetch
}

// Fields that, when they differ, mean the stored job is stale and must be
// updated in place. (lastSeenAt is handled by bumping and is deliberately
// NOT here — it's not a board-side material change.)
const MATERIAL_FIELDS: Array<keyof Job> = [
  'title',
  'company',
  'location',
  'applyUrl',
  'url',
  'postedDate',
  'description',
];

/**
 * True when the fresh job differs from the stored one in any material field.
 * Ignored: state, matchScore, tailoredCv, firstSeenAt/lastSeenAt/isActive —
 * those are app-owned, never board-owned.
 */
export function hasMaterialChange(stored: Job, fresh: Job): boolean {
  for (const field of MATERIAL_FIELDS) {
    if (String((stored as any)[field] ?? '') !== String((fresh as any)[field] ?? '')) return true;
  }
  return false;
}

/**
 * Pure incremental diff between the stored jobs for a board and a fresh fetch.
 * Identity = job.id. `changed` ids are present in both but with material
 * differences — the watcher updates those rows in place instead of only
 * bumping lastSeenAt, so board-side edits (title/location/URL) propagate to
 * the local corpus.
 */
export function diffBoard(existingJobs: Job[], fresh: Job[], _userId: string): BoardDiff {
  const existingIds = new Set(existingJobs.map((j) => j.id));
  const freshIds = new Set(fresh.map((j) => j.id));
  const byId = new Map(existingJobs.map((j) => [j.id, j]));
  const added = fresh.filter((j) => !existingIds.has(j.id));
  const bumped: string[] = [];
  const changed: string[] = [];
  for (const j of fresh) {
    if (!existingIds.has(j.id)) continue;
    const stored = byId.get(j.id);
    if (stored && hasMaterialChange(stored, j)) changed.push(j.id);
    else bumped.push(j.id);
  }
  const missing = [...existingIds].filter((id) => !freshIds.has(id));
  return { added, bumped, changed, missing };
}