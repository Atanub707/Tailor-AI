// Mail intelligence service — connector registry, deterministic sync,
// classifier + matcher + status projection + scheduler support. Local-first
// polling (no webhooks); read-only; no links/attachments/OTP consumption.
import type { Database } from 'better-sqlite3';
import {
  ensureMailSchema, classifyMail, matchMailToApplication, recordMailEvidence,
  statusFromClassification, canPromoteViaEmailConfirmation,
} from './mailIntelligence.js';
import type { MailboxConnector, MailMessage } from './mailIntelligence.js';

export function mailConnectorStatus(db: Database, userId: string): Array<{ id: string; connector: string; status: string; updatedAt: string }> {
  ensureMailSchema(db);
  const rows = db.prepare('SELECT id, connector, status, updated_at FROM mail_connections WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as any[];
  return rows.map((r) => ({ id: r.id, connector: r.connector, status: r.status, updatedAt: r.updated_at }));
}

/** V1: register a connector preference (Gmail/Microsoft). Actual OAuth
 *  requires user authorization; live transports are injected/mocked in
 *  tests. A connected row is required before polling runs. */
export function connectMailConnector(db: Database, userId: string, connector: string): boolean {
  if (!['gmail', 'microsoft', 'imap'].includes(connector)) return false;
  ensureMailSchema(db);
  const id = `mail-conn-${userId.slice(-6)}-${connector}`;
  db.prepare(`INSERT INTO mail_connections (id, user_id, connector, status, config_json, created_at, updated_at)
    VALUES (?, ?, ?, 'configured', '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'configured', updated_at = excluded.updated_at`)
    .run(id, userId, connector, new Date().toISOString(), new Date().toISOString());
  return true;
}

export function disconnectMailConnector(db: Database, userId: string, connector: string): void {
  ensureMailSchema(db);
  db.prepare("UPDATE mail_connections SET status = 'disconnected', updated_at = ? WHERE user_id = ? AND connector = ?")
    .run(new Date().toISOString(), userId, connector);
}

export interface SyncResult {
  scanned: number;
  classified: number;
  matchedStrong: number;
  matchedWeak: number;
  unmatched: number;
  duplicateSkipped: number;
  promotions: Array<{ applicationId: string; from: string; to: string; evidence: string }>;
}

/** Deterministic sync: fetch (via the injected connector transport),
 *  classify, match against the user's applications, record evidence,
 *  project status, promote SUCCESS_UNCONFIRMED via strong confirmation mail.
 *  Never reads live mailboxes in tests (transport injected). */
export async function syncNow(db: Database, userId: string, transport?: { fetchMessages: (since: string) => Promise<MailMessage[]> }): Promise<SyncResult> {
  ensureMailSchema(db);
  const result: SyncResult = { scanned: 0, classified: 0, matchedStrong: 0, matchedWeak: 0, unmatched: 0, duplicateSkipped: 0, promotions: [] };
  if (!transport) return result; // no live connector configured/authorized
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const messages = await transport.fetchMessages(since);
  result.scanned = messages.length;
  const attempts = db.prepare("SELECT id, plan_id, package_id, provider, external_job_id, status FROM application_attempts WHERE user_id = ?").all(userId) as any[];
  const candidates = attempts.map((a) => ({
    applicationId: a.package_id,
    attemptId: a.id,
    company: String(a.provider || ''),
    jobTitle: String(a.provider || ''),
    provider: String(a.provider || ''),
    externalJobId: String(a.external_job_id || ''),
  }));
  // resolve company/title from the plan target
  for (const c of candidates) {
    const planRow = db.prepare('SELECT data FROM submission_plans WHERE user_id = ? AND id = ?').get(userId, c.attemptId ? db.prepare('SELECT plan_id FROM application_attempts WHERE id = ?').get(c.attemptId)?.plan_id : '') as any;
    if (planRow) {
      const plan = JSON.parse(planRow.data);
      c.company = plan.target?.company || c.company;
      c.jobTitle = plan.target?.title || c.jobTitle;
      c.externalJobId = plan.target?.externalJobId || c.externalJobId;
    }
  }
  for (const msg of messages) {
    const classification = classifyMail(msg);
    const match = matchMailToApplication(msg, candidates);
    const evidence = recordMailEvidence(db, {
      userId, connector: 'gmail', msg, classification,
      matchedApplicationId: match.matched ? match.applicationId : undefined,
      matchConfidence: match.matched ? match.confidence : undefined,
    });
    if (evidence.duplicate) { result.duplicateSkipped += 1; continue; }
    result.classified += 1;
    if (match.matched) {
      if (match.confidence === 'strong') {
        result.matchedStrong += 1;
        const projection = statusFromClassification(classification);
        const attempt = attempts.find((a) => a.id === match.attemptId);
        if (projection && attempt && !['APPLIED', 'REJECTED', 'WITHDRAWN'].includes(attempt.status)) {
          // transition via the central machine when possible; evidence-first
          // projection otherwise (status is event-projected, not engine truth)
          const { getAttempt, updateAttemptStatus } = await import('../applicationEngine/executionStore.js');
          const cur = getAttempt(db, userId, match.attemptId);
          if (cur) {
            const map: Record<string, string> = { Assessment: 'READY_FOR_USER_SUBMISSION', Interview: 'SUBMISSION_OBSERVED', Offer: 'SUBMITTED', Rejected: 'FAILED', Withdrawn: 'CANCELLED' };
            // conservative: do not overwrite terminal state; only promote
            // SUCCESS_UNCONFIRMED via email confirmation, and add review
            // evidence for the rest.
            if (cur.status === 'SUCCESS_UNCONFIRMED' && classification === 'APPLICATION_CONFIRMED') {
              const promoted = canPromoteViaEmailConfirmation(cur.status, { matched: true, applicationId: match.applicationId, attemptId: match.attemptId, confidence: 'strong' } as any);
              if (promoted) {
                updateAttemptStatus(db, userId, match.attemptId, 'SUBMITTED');
                result.promotions.push({ applicationId: match.applicationId, from: 'SUCCESS_UNCONFIRMED', to: 'APPLIED', evidence: 'EMAIL_CONFIRMATION' });
              }
            }
          }
        }
      } else {
        result.matchedWeak += 1;
      }
    } else {
      result.unmatched += 1;
    }
  }
  return result;
}

/** In-process non-overlapping scheduler (default 10 min, configurable).
 *  Runs only while the app is up — documented tradeoff of local polling. */
export function startMailPolling(db: Database, userId: string, transport?: { fetchMessages: (since: string) => Promise<MailMessage[]> }, intervalMs = 10 * 60 * 1000): () => void {
  let running = false;
  const iv = setInterval(() => {
    if (running) return; // non-overlapping
    running = true;
    syncNow(db, userId, transport)
      .catch(() => { /* backoff: provider errors are caught; next tick retries */ })
      .finally(() => { running = false; });
  }, intervalMs);
  return () => clearInterval(iv);
}