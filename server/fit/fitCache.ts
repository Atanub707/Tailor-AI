// Fit result cache — SQLite, deterministic invalidation.
// Keyed by (jobId, profileUpdatedAt, masterCvUpdatedAt, jobDescriptionHash,
// fitEngineVersion): any input change invalidates. No complex infrastructure.

import { getDb, getCurrentUserId } from '../storage/fileStorage.js';
import { FIT_ENGINE_VERSION, type FitResult } from './fitEngine.js';
import { createHash } from 'node:crypto';

export function ensureFitCacheSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS fit_results (
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      cv_key TEXT NOT NULL,
      jd_hash TEXT NOT NULL,
      engine_version INTEGER NOT NULL,
      result TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, job_id)
    );
  `);
}

export function jdHash(description: string): string {
  return createHash('sha256').update(String(description || '')).digest('hex').slice(0, 16);
}

export interface FitCacheKey {
  profileUpdatedAt?: string;
  masterCvUpdatedAt?: string;
  jdHash: string;
}

export function getCachedFit(userId: string, jobId: string, key: FitCacheKey): FitResult | undefined {
  try {
    ensureFitCacheSchema();
    const row = getDb()
      .prepare('SELECT result, profile_key, cv_key, jd_hash, engine_version FROM fit_results WHERE user_id = ? AND job_id = ?')
      .get(userId, jobId) as { result: string; profile_key: string; cv_key: string; jd_hash: string; engine_version: number } | undefined;
    if (!row) return undefined;
    if (row.engine_version !== FIT_ENGINE_VERSION) return undefined;
    if (row.profile_key !== (key.profileUpdatedAt || '')) return undefined;
    if (row.cv_key !== (key.masterCvUpdatedAt || '')) return undefined;
    if (row.jd_hash !== key.jdHash) return undefined;
    return JSON.parse(row.result) as FitResult;
  } catch {
    return undefined;
  }
}

export function storeCachedFit(userId: string, jobId: string, key: FitCacheKey, result: FitResult): void {
  try {
    ensureFitCacheSchema();
    getDb()
      .prepare(`
        INSERT INTO fit_results (user_id, job_id, profile_key, cv_key, jd_hash, engine_version, result, calculated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, job_id) DO UPDATE SET
          profile_key = excluded.profile_key, cv_key = excluded.cv_key,
          jd_hash = excluded.jd_hash, engine_version = excluded.engine_version,
          result = excluded.result, calculated_at = excluded.calculated_at
      `)
      .run(userId, jobId, key.profileUpdatedAt || '', key.masterCvUpdatedAt || '', key.jdHash, FIT_ENGINE_VERSION, JSON.stringify(result), result.calculatedAt);
  } catch { /* non-fatal */ }
}

export function fitCacheKeyFor(profileUpdatedAt: string | undefined, masterCvUpdatedAt: string | undefined, description: string): FitCacheKey {
  return { profileUpdatedAt, masterCvUpdatedAt, jdHash: jdHash(description) };
}

export { getCurrentUserId };