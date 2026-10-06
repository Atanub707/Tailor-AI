// Auto Apply — Candidate Answer Bank persistence (SQLite, user-scoped).
//
// Separate table (auto_apply_answer_bank) — existing tables are untouched.
// Values are stored as JSON so booleans/numbers/arrays round-trip exactly.

import { getDb } from '../../storage/fileStorage.js';
import { normalizeQuestion, canonicalKeyForQuestion } from './answerCanonicalizer.js';
import type {
  AnswerBankRecord, AnswerBankUpsert, AnswerValue, AnswerType,
  AnswerSourceKind, AnswerVerificationStatus, AnswerSensitivity,
} from './answerBankTypes.js';

export { answerBankConfigFromEnv } from './answerBankTypes.js';

export function ensureAnswerBankSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS auto_apply_answer_bank (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      canonical_key TEXT,
      canonical_question TEXT NOT NULL,
      normalized_question TEXT NOT NULL,
      question_category TEXT,
      answer_type TEXT NOT NULL,
      answer_value TEXT NOT NULL,
      source TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      reusable INTEGER NOT NULL DEFAULT 1,
      aliases TEXT NOT NULL DEFAULT '[]',
      provenance TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_aab_user ON auto_apply_answer_bank (user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_aab_user_canonical
      ON auto_apply_answer_bank (user_id, canonical_key) WHERE canonical_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_aab_user_norm
      ON auto_apply_answer_bank (user_id, normalized_question);
    CREATE TABLE IF NOT EXISTS auto_apply_run_answers (
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      canonical_key TEXT,
      canonical_question TEXT NOT NULL,
      normalized_question TEXT NOT NULL,
      answer_type TEXT NOT NULL,
      answer_value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, job_id, normalized_question)
    );
  `);
  const cols = getDb().prepare('PRAGMA table_info(auto_apply_answer_bank)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'options')) {
    getDb().exec(`ALTER TABLE auto_apply_answer_bank ADD COLUMN options TEXT NOT NULL DEFAULT '[]'`);
  }
}

function mapRow(row: Record<string, unknown>): AnswerBankRecord {
  let value: AnswerValue = null;
  try { value = JSON.parse(String(row.answer_value)) as AnswerValue; } catch { value = null; }
  let aliases: string[] = [];
  try { const parsed = JSON.parse(String(row.aliases || '[]')); if (Array.isArray(parsed)) aliases = parsed.map(String); } catch { /* ignore */ }
  return {
    id: String(row.id),
    userId: String(row.user_id),
    canonicalKey: row.canonical_key ? String(row.canonical_key) : undefined,
    canonicalQuestion: String(row.canonical_question),
    normalizedQuestion: String(row.normalized_question),
    questionCategory: row.question_category ? String(row.question_category) : undefined,
    answerType: String(row.answer_type) as AnswerType,
    answerValue: value,
    options: JSON.parse(String(row.options || '[]')) as string[],
    source: String(row.source) as AnswerSourceKind,
    verificationStatus: String(row.verification_status) as AnswerVerificationStatus,
    sensitivity: String(row.sensitivity) as AnswerSensitivity,
    reusable: Number(row.reusable) === 1,
    aliases,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : undefined,
    usageCount: Number(row.usage_count ?? 0),
    provenance: row.provenance ? String(row.provenance) : undefined,
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
  };
}

export function listAnswers(userId: string): AnswerBankRecord[] {
  ensureAnswerBankSchema();
  const rows = getDb().prepare('SELECT * FROM auto_apply_answer_bank WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function getAnswerById(userId: string, id: string): AnswerBankRecord | undefined {
  ensureAnswerBankSchema();
  const row = getDb().prepare('SELECT * FROM auto_apply_answer_bank WHERE user_id = ? AND id = ?').get(userId, id) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : undefined;
}

/** Upsert keyed by canonical key when known, otherwise by normalized question.
 *  Never crosses users; never touches a foreign record. */
export function upsertAnswer(userId: string, input: AnswerBankUpsert): AnswerBankRecord {
  ensureAnswerBankSchema();
  const now = new Date().toISOString();
  const normalized = normalizeQuestion(input.canonicalQuestion);
  const canonicalKey = input.canonicalKey ?? canonicalKeyForQuestion(input.canonicalQuestion);
  const existing = canonicalKey
    ? (getDb().prepare('SELECT * FROM auto_apply_answer_bank WHERE user_id = ? AND canonical_key = ?').get(userId, canonicalKey) as Record<string, unknown> | undefined)
    : (getDb().prepare('SELECT * FROM auto_apply_answer_bank WHERE user_id = ? AND normalized_question = ?').get(userId, normalized) as Record<string, unknown> | undefined);

  if (existing) {
    const id = String(existing.id);
    getDb().prepare(`
      UPDATE auto_apply_answer_bank SET
        canonical_key = ?, canonical_question = ?, normalized_question = ?, question_category = ?,
        answer_type = ?, answer_value = ?, source = ?, verification_status = ?, sensitivity = ?,
        options = ?, reusable = ?, aliases = ?, provenance = ?, expires_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ?
    `).run(
      canonicalKey ?? null, input.canonicalQuestion, normalized, input.questionCategory ?? null,
      input.answerType, JSON.stringify(input.answerValue ?? null),
      input.source ?? 'USER_PROVIDED', input.verificationStatus ?? 'VERIFIED', input.sensitivity ?? 'NORMAL',
      JSON.stringify(input.options ?? []), (input.reusable ?? true) ? 1 : 0, JSON.stringify(input.aliases ?? []), input.provenance ?? null,
      input.expiresAt ?? null, now, userId, id
    );
    return getAnswerById(userId, id)!;
  }

  const id = `ab-${userId.slice(-6)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  getDb().prepare(`
    INSERT INTO auto_apply_answer_bank (
      id, user_id, canonical_key, canonical_question, normalized_question, question_category,
      answer_type, answer_value, source, verification_status, sensitivity, options, reusable, aliases,
      provenance, expires_at, created_at, updated_at, last_used_at, usage_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
  `).run(
    id, userId, canonicalKey ?? null, input.canonicalQuestion, normalized, input.questionCategory ?? null,
    input.answerType, JSON.stringify(input.answerValue ?? null), input.source ?? 'USER_PROVIDED',
    input.verificationStatus ?? 'VERIFIED', input.sensitivity ?? 'NORMAL', JSON.stringify(input.options ?? []),
    (input.reusable ?? true) ? 1 : 0,
    JSON.stringify(input.aliases ?? []), input.provenance ?? null, input.expiresAt ?? null, now, now
  );
  return getAnswerById(userId, id)!;
}

/** EEO/sensitive labels are flagged at collection (conservative, mirrors the
 *  engine classifier) — never inferred, only displayed as metadata. */
const SENSITIVE_LABEL_RE = /(gender|race|ethnicity|veteran|disability|sexual orientation|demographic)/i;

/**
 * Collect REQUIRED-but-unanswered questions from a real application run as
 * PENDING bank entries ("answer once, reuse forever"). Safety:
 *  - never overwrites or updates an existing entry (answered or pending)
 *  - stored NON-REUSABLE + REVIEW_REQUIRED → the matcher can never fill them
 *  - answering via the normal bank upsert flips the SAME row to verified
 */
export function collectPendingQuestions(
  userId: string,
  questions: Array<{ question: string; category?: string; answerType?: AnswerType; options?: string[]; sensitivity?: AnswerSensitivity }>
): { created: number; skipped: number } {
  ensureAnswerBankSchema();
  let created = 0;
  let skipped = 0;
  for (const q of questions) {
    const text = String((q && q.question) || '').trim();
    if (!text || text.length > 500) {
      skipped += 1;
      continue;
    }
    const normalized = normalizeQuestion(text);
    const key = canonicalKeyForQuestion(text);
    const existing = getDb()
      .prepare('SELECT id FROM auto_apply_answer_bank WHERE user_id = ? AND (canonical_key = ? OR normalized_question = ?)')
      .get(userId, key ?? '__none__', normalized) as Record<string, unknown> | undefined;
    if (existing) {
      skipped += 1;
      continue;
    }
    upsertAnswer(userId, {
      canonicalQuestion: text,
      canonicalKey: key,
      questionCategory: q.category,
      answerType: q.answerType ?? 'TEXTAREA',
      options: q.options,
      answerValue: '',
      source: 'AUTO_COLLECTED',
      verificationStatus: 'REVIEW_REQUIRED',
      sensitivity: q.sensitivity ?? (SENSITIVE_LABEL_RE.test(text) ? 'SENSITIVE' : 'NORMAL'),
      reusable: false,
    });
    created += 1;
  }
  return { created, skipped };
}

/** A pending question: collected from a run, not yet answered by the user. */
export function isPendingQuestion(a: Pick<AnswerBankRecord, 'source' | 'verificationStatus'>): boolean {
  return a.source === 'AUTO_COLLECTED' && a.verificationStatus === 'REVIEW_REQUIRED';
}

export function updateAnswer(
  userId: string,
  id: string,
  patch: Partial<Pick<AnswerBankRecord, 'answerValue' | 'reusable' | 'verificationStatus' | 'sensitivity' | 'expiresAt' | 'questionCategory' | 'aliases'>>
): AnswerBankRecord | undefined {
  ensureAnswerBankSchema();
  const existing = getAnswerById(userId, id);
  if (!existing) return undefined;
  const next = {
    answerValue: patch.answerValue !== undefined ? patch.answerValue : existing.answerValue,
    reusable: patch.reusable !== undefined ? patch.reusable : existing.reusable,
    verificationStatus: patch.verificationStatus ?? existing.verificationStatus,
    sensitivity: patch.sensitivity ?? existing.sensitivity,
    expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : existing.expiresAt,
    questionCategory: patch.questionCategory !== undefined ? patch.questionCategory : existing.questionCategory,
    aliases: patch.aliases ?? existing.aliases,
  };
  getDb().prepare(`
    UPDATE auto_apply_answer_bank SET
      answer_value = ?, reusable = ?, verification_status = ?, sensitivity = ?,
      expires_at = ?, question_category = ?, aliases = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `).run(
    JSON.stringify(next.answerValue ?? null), next.reusable ? 1 : 0, next.verificationStatus, next.sensitivity,
    next.expiresAt ?? null, next.questionCategory ?? null, JSON.stringify(next.aliases), new Date().toISOString(),
    userId, id
  );
  return getAnswerById(userId, id);
}

export function deleteAnswer(userId: string, id: string): boolean {
  ensureAnswerBankSchema();
  const r = getDb().prepare('DELETE FROM auto_apply_answer_bank WHERE user_id = ? AND id = ?').run(userId, id);
  return r.changes > 0;
}

export function recordUsage(userId: string, id: string): void {
  ensureAnswerBankSchema();
  getDb().prepare('UPDATE auto_apply_answer_bank SET usage_count = usage_count + 1, last_used_at = ? WHERE user_id = ? AND id = ?')
    .run(new Date().toISOString(), userId, id);
}

// ── RUN-SCOPED one-shot answers ("Remember" OFF) ─────────────────────────
// Used for THIS job's run only: never written to the reusable bank, never
// visible to other applications, never overwriting a remembered answer.

const RUN_ANSWER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function upsertRunAnswer(
  userId: string,
  jobId: string,
  input: { canonicalQuestion: string; answerType?: AnswerType; answerValue: AnswerValue }
): AnswerBankRecord {
  ensureAnswerBankSchema();
  const now = new Date().toISOString();
  const normalized = normalizeQuestion(input.canonicalQuestion);
  const canonicalKey = canonicalKeyForQuestion(input.canonicalQuestion);
  getDb().prepare(`
    INSERT INTO auto_apply_run_answers
      (user_id, job_id, canonical_key, canonical_question, normalized_question, answer_type, answer_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, job_id, normalized_question) DO UPDATE SET
      canonical_key = excluded.canonical_key,
      canonical_question = excluded.canonical_question,
      answer_type = excluded.answer_type,
      answer_value = excluded.answer_value,
      created_at = excluded.created_at
  `).run(
    userId, jobId, canonicalKey ?? null, input.canonicalQuestion, normalized,
    input.answerType ?? 'TEXTAREA', JSON.stringify(input.answerValue ?? null), now
  );
  // Opportunistic cleanup — run answers expire by themselves.
  try {
    getDb().prepare('DELETE FROM auto_apply_run_answers WHERE user_id = ? AND created_at < ?')
      .run(userId, new Date(Date.now() - RUN_ANSWER_TTL_MS).toISOString());
  } catch { /* cleanup is best-effort */ }
  return {
    id: `run-${jobId}-${normalized.slice(0, 40)}`,
    userId,
    canonicalKey,
    canonicalQuestion: input.canonicalQuestion,
    normalizedQuestion: normalized,
    answerType: input.answerType ?? 'TEXTAREA',
    answerValue: input.answerValue ?? null,
    source: 'USER_PROVIDED',
    verificationStatus: 'VERIFIED',
    sensitivity: 'NORMAL',
    reusable: true,
    aliases: [],
    createdAt: now,
    updatedAt: now,
    usageCount: 0,
    provenance: `job:${jobId}`,
  };
}

/** Run-scoped answers for THIS job, shaped exactly like bank records so every
 *  resolution path (concept, prefix, bank, Laya) consumes them unchanged. */
export function listRunAnswers(userId: string, jobId: string): AnswerBankRecord[] {
  ensureAnswerBankSchema();
  const rows = getDb()
    .prepare('SELECT * FROM auto_apply_run_answers WHERE user_id = ? AND job_id = ? AND created_at >= ?')
    .all(userId, jobId, new Date(Date.now() - RUN_ANSWER_TTL_MS).toISOString()) as Record<string, unknown>[];
  return rows.map((row) => {
    let value: AnswerValue = null;
    try { value = JSON.parse(String(row.answer_value)) as AnswerValue; } catch { value = null; }
    return {
      id: `run-${jobId}-${String(row.normalized_question).slice(0, 40)}`,
      userId,
      canonicalKey: row.canonical_key ? String(row.canonical_key) : undefined,
      canonicalQuestion: String(row.canonical_question),
      normalizedQuestion: String(row.normalized_question),
      answerType: String(row.answer_type) as AnswerType,
      answerValue: value,
      source: 'USER_PROVIDED' as AnswerSourceKind,
      verificationStatus: 'VERIFIED' as AnswerVerificationStatus,
      sensitivity: 'NORMAL' as AnswerSensitivity,
      reusable: true,
      aliases: [],
      createdAt: String(row.created_at),
      updatedAt: String(row.created_at),
      usageCount: 0,
      provenance: `job:${jobId}`,
    };
  });
}
