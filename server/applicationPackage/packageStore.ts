// Application Package — SQLite storage: versioned per (user, job),
// immutable once READY, deterministic input fingerprint.

import { getDb } from '../storage/fileStorage.js';
import { createHash } from 'node:crypto';
import { PACKAGE_VERSION, type ApplicationPackage, type PackageStatus } from './packageModel.js';

export function ensurePackageSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS application_packages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, job_id, version)
    );
  `);
}

export interface PackageInputKeys {
  jobId: string;
  jdHash: string;
  profileUpdatedAt?: string;
  masterCvUpdatedAt?: string;
  fitEngineVersion?: number;
  fitScore?: number;
  tailoredResumeVersionId?: string;
  tailorEngineVersion?: number;
  answersState: string;
}

/** Deterministic fingerprint — stable serialization, no volatile timestamps. */
export function packageInputFingerprint(keys: PackageInputKeys): string {
  const stable = JSON.stringify({
    jobId: keys.jobId,
    jdHash: keys.jdHash,
    profileUpdatedAt: keys.profileUpdatedAt ?? '',
    masterCvUpdatedAt: keys.masterCvUpdatedAt ?? '',
    fitEngineVersion: keys.fitEngineVersion ?? 0,
    fitScore: keys.fitScore ?? 0,
    tailoredResumeVersionId: keys.tailoredResumeVersionId ?? '',
    tailorEngineVersion: keys.tailorEngineVersion ?? 0,
    answersState: keys.answersState,
  });
  return createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

export function nextPackageVersion(userId: string, jobId: string): number {
  ensurePackageSchema();
  const row = getDb().prepare('SELECT MAX(version) v FROM application_packages WHERE user_id = ? AND job_id = ?').get(userId, jobId) as { v: number | null };
  return (row?.v ?? 0) + 1;
}

export function storePackage(pkg: ApplicationPackage): ApplicationPackage {
  ensurePackageSchema();
  getDb()
    .prepare(`
      INSERT INTO application_packages (id, user_id, job_id, version, status, data, input_fingerprint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, job_id, version) DO UPDATE SET
        status = excluded.status, data = excluded.data, updated_at = excluded.updated_at
    `)
    .run(pkg.id, pkg.userId, pkg.jobId, pkg.version, pkg.status, JSON.stringify(pkg), pkg.inputFingerprint, pkg.createdAt, pkg.updatedAt);
  return pkg;
}

export function getLatestPackage(userId: string, jobId: string): ApplicationPackage | undefined {
  ensurePackageSchema();
  const row = getDb().prepare('SELECT data FROM application_packages WHERE user_id = ? AND job_id = ? ORDER BY version DESC LIMIT 1').get(userId, jobId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as ApplicationPackage) : undefined;
}

export function listPackages(userId: string, jobId: string): ApplicationPackage[] {
  ensurePackageSchema();
  const rows = getDb().prepare('SELECT data FROM application_packages WHERE user_id = ? AND job_id = ? ORDER BY version DESC').all(userId, jobId) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as ApplicationPackage);
}

export function getPackageById(userId: string, packageId: string): ApplicationPackage | undefined {
  ensurePackageSchema();
  const row = getDb().prepare('SELECT data FROM application_packages WHERE user_id = ? AND id = ?').get(userId, packageId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as ApplicationPackage) : undefined;
}

/** Mark a package STALE (externally) WITHOUT touching its historical content. */
export function markPackageStale(userId: string, packageId: string): void {
  ensurePackageSchema();
  const pkg = getPackageById(userId, packageId);
  if (!pkg || pkg.status === 'STALE') return;
  const staleCopy: ApplicationPackage = { ...pkg, status: 'STALE', updatedAt: new Date().toISOString() };
  getDb()
    .prepare('UPDATE application_packages SET status = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(staleCopy.status, JSON.stringify(staleCopy), staleCopy.updatedAt, packageId, userId);
}

export function snapshotHash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

export function createPackageId(userId: string, jobId: string, version: number): string {
  return `pkg-${userId.slice(-6)}-${jobId.slice(-8)}-v${version}`;
}

export function freshPackage(userId: string, jobId: string, version: number): ApplicationPackage {
  const now = new Date().toISOString();
  return {
    id: createPackageId(userId, jobId, version),
    userId,
    jobId,
    version,
    status: 'DRAFT',
    jobSnapshot: { jobId, company: '', title: '', jd: '', jdHash: '' },
    applicantSnapshot: { personal: {}, contact: {}, links: {}, locationPrefs: {}, workAuthorization: {}, preferences: {}, applicationDefaults: {} },
    masterCvProvenance: {},
    fitSnapshot: { score: 0, grade: '', strengths: [], gaps: [], blockers: [], unknowns: [] },
    resumeSnapshot: null,
    answers: [],
    questions: [],
    generatedContent: { generatedAnswers: [] },
    validation: { ready: false, status: 'DRAFT', missingFields: [], needsInput: [], blockers: [], warnings: [] },
    inputFingerprint: '',
    createdAt: now,
    updatedAt: now,
  };
}

export type { PackageStatus };