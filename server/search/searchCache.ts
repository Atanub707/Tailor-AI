// Short-TTL search candidate cache.
// Stores provider candidates for a query fingerprint for a short window
// (default 45 min). Same query within TTL → cached candidates, no provider
// call. Larger LIMIT → top-up only the shortage. Transient by design: cached
// candidates are NOT durable jobs — only user-interacted candidates are
// promoted to the durable jobs table.

import { getDb } from '../storage/fileStorage.js';
import { ensureV2Tables } from '../storage/v2Tables.js';
import type { NormalizedJob } from '../providers/types.js';

export interface CachedCandidate {
  fingerprint: string;
  provider: string;
  job: NormalizedJob;
  relevanceScore: number;
  matchType?: string;
  discoveredAt: string;
}

function ttlMinutes(): number {
  const v = Number(process.env.SEARCH_CACHE_TTL_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : 45;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Lazy cleanup: drop expired rows for this user (cheap, called on read). */
export function purgeExpiredCache(userId: string): void {
  try {
    ensureV2Tables();
    getDb().prepare('DELETE FROM search_cache WHERE user_id = ? AND expires_at < ?').run(userId, nowIso());
  } catch { /* non-fatal */ }
}

/** Cached candidates for a query fingerprint that are still valid. */
export function getCachedCandidates(userId: string, queryFp: string): CachedCandidate[] {
  try {
    ensureV2Tables();
    purgeExpiredCache(userId);
    const rows = getDb().prepare(
      `SELECT job_fingerprint, provider, job_json, relevance_score, match_type, discovered_at
       FROM search_cache WHERE user_id = ? AND query_fp = ? ORDER BY relevance_score DESC, discovered_at DESC`
    ).all(userId, queryFp) as Array<{
      job_fingerprint: string; provider: string; job_json: string;
      relevance_score: number; match_type: string | null; discovered_at: string;
    }>;
    return rows.map((r) => ({
      fingerprint: r.job_fingerprint,
      provider: r.provider,
      job: JSON.parse(r.job_json) as NormalizedJob,
      relevanceScore: r.relevance_score,
      matchType: r.match_type ?? undefined,
      discoveredAt: r.discovered_at,
    }));
  } catch { return []; }
}

/**
 * Store candidates for a query fingerprint. Idempotent per fingerprint
 * (INSERT OR IGNORE semantics via unique handling in the caller — we upsert
 * by replacing this query's slice each time, refreshing TTL).
 */
export function storeCandidates(userId: string, queryFp: string, candidates: CachedCandidate[]): void {
  if (!candidates.length) return;
  try {
    ensureV2Tables();
    const db = getDb();
    const expires = new Date(Date.now() + ttlMinutes() * 60 * 1000).toISOString();
    const del = db.prepare('DELETE FROM search_cache WHERE user_id = ? AND query_fp = ?');
    const ins = db.prepare(
      `INSERT INTO search_cache (user_id, query_fp, job_fingerprint, provider, job_json, relevance_score, match_type, discovered_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      del.run(userId, queryFp);
      for (const c of candidates) {
        ins.run(userId, queryFp, c.fingerprint, c.provider, JSON.stringify(c.job), c.relevanceScore, c.matchType ?? null, c.discoveredAt, expires);
      }
    });
    tx();
  } catch { /* non-fatal — cache miss next time */ }
}

/** All unique cached fingerprints for a query (for dedupe across providers). */
export function cachedFingerprints(userId: string, queryFp: string): Set<string> {
  return new Set(getCachedCandidates(userId, queryFp).map((c) => c.fingerprint));
}