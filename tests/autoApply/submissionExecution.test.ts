// Auto Apply Phase 5 — EXECUTION & idempotency proofs (§33) + static safety (§34),
// plus runtime store tests on an in-memory SQLite (no disk side effects).
// Extension-transport assertions were removed with the Tailor Browser pivot;
// server-side safety proofs remain.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  ensureSubmissionTables,
  createSubmitOrder,
  consumeSubmitOrder,
  getSubmitOrderForSession,
  saveSubmissionReceipt,
  getReceiptByAttempt,
  hasVerifiedReceiptForJob,
  getAutoApplyPreferences,
  setAutoApplyPreferences,
  recordVerificationEvidence,
  getLatestVerificationEvidence,
  logSubmissionEvent,
  listSubmissionEvents,
} from '../../server/autoApply/submissionStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const engine = read('server/autoApply/submissionEngine.ts');
const store = read('server/autoApply/submissionStore.ts');
const button = read('src/components/AutoApplyButton.tsx');

describe('Submission execution — one action, provable', () => {
  it('24. double click impossible: UI busy-gate + server CAS', () => {
    expect(button).toContain('if (busy || !lever) return;'); // AA click-level guard
    expect(engine).toContain("'READY_FOR_USER_SUBMISSION'");
    expect(engine).toMatch(/UPDATE application_attempts SET status = 'SUBMITTING'[\s\S]{0,120}AND status = 'READY_FOR_USER_SUBMISSION'/);
  });

  it('25. duplicate polling / repeat decisions never resubmit (receipt short-circuits)', () => {
    expect(engine).toContain('if (existing) {');
    expect(engine).toContain('receipt=existing');
  });

  it('26. session reconnect cannot resubmit: submit order is single-use', () => {
    expect(store).toMatch(/WHERE sessionId = \? AND consumedAt IS NULL/);
    expect(store).toContain('export function consumeSubmitOrder');
    const handoff = read('server/autoApply/desktopHandoff.ts');
    expect(handoff).toContain('markDesktopSubmitting'); // server CAS: exactly-once submit transition
  });

  it('27. restart cannot resubmit: consumption is server-side and atomic', () => {
    expect(store).toMatch(/UPDATE submit_orders SET consumedAt = \? WHERE sessionId = \? AND consumedAt IS NULL/);
  });

  it('28/29. network timeout & SUBMITTED_UNVERIFIED block retry (no blind second click)', () => {
    expect(engine).toContain("priorUnverified: ctx.attemptStatus === 'SUCCESS_UNCONFIRMED'");
    expect(engine).toContain("'SUBMISSION_UNVERIFIED'");
    expect(read('src/components/AutoApplyButton.tsx')).toContain('Submission may have occurred, but confirmation could not be verified.');
    expect(engine).toMatch(/if \(eventType === 'SUBMISSION_UNCONFIRMED'\)[\s\S]{0,220}NO retry/);
  });

  it('30/31. success is detected from real provider state', () => {
    expect(engine).toContain("String(metadata.confirmationEvidenceType || '') === 'SUCCESS_TEXT'");
  });

  it('32. false success is not accepted: receipt ONLY in the CONFIRMED branch', () => {
    const confirmedAt = engine.indexOf("if (eventType === 'SUBMISSION_CONFIRMED')");
    const saveAt = engine.indexOf('saveSubmissionReceipt(');
    expect(confirmedAt).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(confirmedAt);
  });

  it('33. job → Applied ONLY after a verified receipt is persisted', () => {
    const saveAt = engine.indexOf('saveSubmissionReceipt(');
    const appliedAt = engine.indexOf("state: 'applied'");
    expect(saveAt).toBeGreaterThan(-1);
    expect(appliedAt).toBeGreaterThan(saveAt);
    expect(engine.match(/state: 'applied'/g) || []).toHaveLength(1);
    expect(store).not.toContain("state: 'applied'");
  });

  it('34. receipt persisted with verification flag + posting identity', () => {
    expect(store).toContain('CREATE TABLE IF NOT EXISTS auto_submission_receipts');
    expect(store).toContain('attemptId TEXT NOT NULL UNIQUE');
    expect(store).toContain('submissionVerified INTEGER NOT NULL DEFAULT 0');
  });

  it('35. receipt duplicate protection is enforced at the database level', () => {
    expect(engine).toContain('getReceiptByAttempt');
    expect(engine).toContain('hasVerifiedReceiptForJob');
    expect(store).toContain('submissionVerified = 1 LIMIT 1');
  });

  it('36. already-submitted blocks via receipt OR attempt status', () => {
    expect(engine).toContain("ctx.attemptStatus === 'SUBMITTED'");
    expect(engine).toContain('hasVerifiedReceiptForJob(db, ctx.userId, ctx.jobId)');
  });

  it('37. current Apply behavior unchanged (no page-scripted submit in the UI)', () => {
    expect(/\.submit\s*\(/.test(button)).toBe(false);
    expect(/requestSubmit|SubmitEvent/.test(button)).toBe(false);
    expect(button).toContain("'/api/auto-apply/browser/start'");
  });

  it('38. fill-only mode unchanged: transport flag stays false; manual_review is the default path', () => {
    const fillExecution = read('server/autoApply/fillExecution.ts');
    expect(fillExecution).toContain('SUBMISSION_TRANSPORT_ENABLED = false');
    expect(engine).toContain('loadSubmissionConfig'); // derived from flag + preference, never hard-coded true
    expect(read('server/autoApply/submissionPolicy.ts')).toContain("'manual_review'");
  });
});

describe('Submission store — runtime idempotency (in-memory SQLite)', () => {
  const db = new Database(':memory:');
  ensureSubmissionTables(db);

  it('submit order: single-use across restarts (second consume returns null)', () => {
    createSubmitOrder(db, { id: 'sub-1', sessionId: 'sess-1', attemptId: 'att-1', userId: 'u1', payload: { attemptId: 'att-1', postingId: 'p1' } });
    const first = consumeSubmitOrder(db, 'sess-1');
    expect(first?.payload?.attemptId).toBe('att-1');
    const second = consumeSubmitOrder(db, 'sess-1');
    expect(second).toBeNull();
    expect(getSubmitOrderForSession(db, 'sess-1')?.consumedAt).toBeTruthy();
  });

  it('receipt: unique per attempt (duplicate insert rejected) + job-level lookup', () => {
    const receipt = {
      id: 'r1', attemptId: 'att-1', userId: 'u1', jobId: 'job-1', provider: 'lever', postingId: 'p1',
      submittedAt: new Date().toISOString(), confirmationType: 'SUCCESS_MESSAGE' as const,
      confirmationFingerprint: 'abcdef12', resumeHash: 'h1', submissionVerified: true, createdAt: new Date().toISOString(),
    };
    saveSubmissionReceipt(db, receipt);
    expect(getReceiptByAttempt(db, 'att-1')?.submissionVerified).toBe(true);
    expect(hasVerifiedReceiptForJob(db, 'u1', 'job-1')).toBe(true);
    expect(() => saveSubmissionReceipt(db, { ...receipt, id: 'r2' })).toThrow(/UNIQUE/);
  });

  it('preferences: OFF by default; explicit opt-in persists', () => {
    const before = getAutoApplyPreferences(db, 'u1');
    expect(before.autoSubmitEnabled).toBe(false);
    expect(before.mode).toBe('manual_review');
    const after = setAutoApplyPreferences(db, 'u1', { autoSubmitEnabled: true, mode: 'safe_auto' });
    expect(after.autoSubmitEnabled).toBe(true);
    expect(getAutoApplyPreferences(db, 'u1').mode).toBe('safe_auto');
  });

  it('verification evidence + audit events round-trip (PII-free shapes only)', () => {
    recordVerificationEvidence(db, 'u1', 'att-1', { statuses: 'VAV', resumeVerified: true, captchaPending: false });
    const ev = getLatestVerificationEvidence(db, 'att-1');
    expect(ev?.statuses).toBe('VAV');
    expect(ev?.resumeVerified).toBe(true);
    logSubmissionEvent(db, 'u1', 'att-1', 'SUBMISSION_STARTED', 'mode=EXPLICIT_APPROVAL');
    expect(listSubmissionEvents(db, 'att-1').some((e) => e.type === 'SUBMISSION_STARTED')).toBe(true);
  });
});
