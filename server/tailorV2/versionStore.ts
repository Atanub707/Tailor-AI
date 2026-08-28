// Tailor V2 — versioned storage + PDF text-layer verification.

import { getDb, getCurrentUserId } from '../storage/fileStorage.js';
import type { TailorDraft } from './drafter.js';
import type { TailorVerification } from './verifier.js';

export const TAILOR_V2_VERSION = 1;

export interface TailoredResumeVersionRow {
  id: string;
  userId: string;
  jobId: string;
  version: number;
  masterCvUpdatedAt?: string;
  profileUpdatedAt?: string;
  jdHash: string;
  fitEngineVersion?: number;
  tailorEngineVersion: number;
  content: TailorDraft;
  verification: TailorVerification;
  stale: boolean;
  createdAt: string;
}

export function ensureTailorV2Schema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS tailored_resume_versions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      master_cv_updated_at TEXT,
      profile_updated_at TEXT,
      jd_hash TEXT NOT NULL,
      fit_engine_version INTEGER,
      tailor_engine_version INTEGER NOT NULL,
      content TEXT NOT NULL,
      verification TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, job_id, version)
    );
  `);
}

export function nextTailorVersion(userId: string, jobId: string): number {
  ensureTailorV2Schema();
  const row = getDb().prepare('SELECT MAX(version) v FROM tailored_resume_versions WHERE user_id = ? AND job_id = ?').get(userId, jobId) as { v: number | null };
  return (row?.v ?? 0) + 1;
}

export function storeTailorVersion(userId: string, jobId: string, content: TailorDraft, verification: TailorVerification, keys: { masterCvUpdatedAt?: string; profileUpdatedAt?: string; jdHash: string; fitEngineVersion?: number }): TailoredResumeVersionRow {
  ensureTailorV2Schema();
  const version = nextTailorVersion(userId, jobId);
  const row: TailoredResumeVersionRow = {
    id: `t2-${userId.slice(-8)}-${jobId.slice(-10)}-v${version}`,
    userId,
    jobId,
    version,
    masterCvUpdatedAt: keys.masterCvUpdatedAt,
    profileUpdatedAt: keys.profileUpdatedAt,
    jdHash: keys.jdHash,
    fitEngineVersion: keys.fitEngineVersion,
    tailorEngineVersion: TAILOR_V2_VERSION,
    content,
    verification,
    stale: false,
    createdAt: new Date().toISOString(),
  };
  getDb()
    .prepare(`
      INSERT INTO tailored_resume_versions (id, user_id, job_id, version, master_cv_updated_at, profile_updated_at, jd_hash, fit_engine_version, tailor_engine_version, content, verification, stale, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(row.id, row.userId, row.jobId, row.version, row.masterCvUpdatedAt || null, row.profileUpdatedAt || null, row.jdHash, row.fitEngineVersion ?? null, row.tailorEngineVersion, JSON.stringify(row.content), JSON.stringify(row.verification), row.stale ? 1 : 0, row.createdAt);
  return row;
}

export function getLatestTailorVersion(userId: string, jobId: string): TailoredResumeVersionRow | undefined {
  ensureTailorV2Schema();
  const row = getDb().prepare('SELECT * FROM tailored_resume_versions WHERE user_id = ? AND job_id = ? ORDER BY version DESC LIMIT 1').get(userId, jobId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapRow(row);
}

export function listTailorVersions(userId: string, jobId: string): TailoredResumeVersionRow[] {
  ensureTailorV2Schema();
  const rows = getDb().prepare('SELECT * FROM tailored_resume_versions WHERE user_id = ? AND job_id = ? ORDER BY version DESC').all(userId, jobId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function markTailorVersionsStale(userId: string, jobId: string, exceptVersion?: number): number {
  ensureTailorV2Schema();
  if (exceptVersion === undefined) {
    return getDb().prepare('UPDATE tailored_resume_versions SET stale = 1 WHERE user_id = ? AND job_id = ?').run(userId, jobId).changes;
  }
  return getDb().prepare('UPDATE tailored_resume_versions SET stale = 1 WHERE user_id = ? AND job_id = ? AND version != ?').run(userId, jobId, exceptVersion).changes;
}

function mapRow(row: Record<string, unknown>): TailoredResumeVersionRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    jobId: String(row.job_id),
    version: Number(row.version),
    masterCvUpdatedAt: row.master_cv_updated_at ? String(row.master_cv_updated_at) : undefined,
    profileUpdatedAt: row.profile_updated_at ? String(row.profile_updated_at) : undefined,
    jdHash: String(row.jd_hash),
    fitEngineVersion: row.fit_engine_version ? Number(row.fit_engine_version) : undefined,
    tailorEngineVersion: Number(row.tailor_engine_version),
    content: JSON.parse(String(row.content)) as TailorDraft,
    verification: JSON.parse(String(row.verification)) as TailorVerification,
    stale: Number(row.stale) === 1,
    createdAt: String(row.created_at),
  };
}

export { getCurrentUserId };