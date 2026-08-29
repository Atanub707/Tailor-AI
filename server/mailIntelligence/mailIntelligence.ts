// Mail Intelligence foundation — connector contract, deterministic
// classifier, evidence matcher, status projection, storage. READ-ONLY
// classification; never clicks links, opens attachments, consumes OTP.
import type { Database } from 'better-sqlite3';
import { sha256 } from '../applicationEngine/contract.js';

// ── Connector contract (Gmail / Microsoft / generic IMAP) ────────────────

export interface MailMessage {
  providerMessageId: string;
  threadId?: string;
  senderAddress: string;
  senderName: string;
  subject: string;
  receivedAt: string;
  snippet?: string; // bounded, sanitized
  from: { address: string; name: string };
}

export interface MailboxConnector {
  id: 'gmail' | 'microsoft' | 'imap';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus(): 'connected' | 'disconnected' | 'error';
  pollMessages(since: string): Promise<MailMessage[]>;
}

export function normalizeMessageMetadata(raw: unknown): MailMessage {
  const r = raw as any;
  return {
    providerMessageId: String(r.providerMessageId || r.id || ''),
    threadId: r.threadId ? String(r.threadId) : undefined,
    senderAddress: String(r.senderAddress || r.from?.address || ''),
    senderName: String(r.senderName || r.from?.name || ''),
    subject: String(r.subject || '').slice(0, 500),
    receivedAt: String(r.receivedAt || new Date().toISOString()),
    snippet: typeof r.snippet === 'string' ? r.snippet.slice(0, 500) : undefined,
    from: { address: String(r.from?.address || r.senderAddress || ''), name: String(r.from?.name || r.senderName || '') },
  };
}

// ── Deterministic classifier (rule-based; NO LLM by default) ─────────────

export type MailClassification =
  | 'APPLICATION_RECEIVED'
  | 'APPLICATION_CONFIRMED'
  | 'ASSESSMENT_REQUIRED'
  | 'INTERVIEW_REQUEST'
  | 'INTERVIEW_SCHEDULED'
  | 'RECRUITER_MESSAGE'
  | 'ADDITIONAL_INFORMATION_REQUIRED'
  | 'REJECTION'
  | 'OFFER'
  | 'WITHDRAWAL_CONFIRMED'
  | 'GENERIC_JOB_EMAIL'
  | 'UNRELATED';

const SUBJECT_REJECTION = /(not (moving|selected)|unfortunately|unfortunately we.*(won't|will not|cannot)|we have decided|other candidates|we will not be|did not match)/i;
const SUBJECT_OFFER = /(offer|congratulations|we'd like to offer|you have been selected|welcome to (the )?team)/i;
const SUBJECT_INTERVIEW = /(interview|interviewer|schedule.*(call|meeting)|calendly|zoom invite|meet (you|with))/i;
const SUBJECT_ASSESSMENT = /(assessment|test|challenge|coding exercise|hackerrank|take-home|aptitude)/i;
const SUBJECT_CONFIRMED = /(application (has been )?received|thank you.*(apply|application)|we received your|application (is )?in|successfully (applied|submitted)|has been submitted successfully|submitted successfully)/i;
const SUBJECT_ADDITIONAL = /(additional information|more information|please (provide|update)|further details|missing (information|documents))/i;
const SUBJECT_WITHDRAWAL = /(withdraw|withdrawn)/i;
const SUBJECT_RECRUITER = /(recruiter|talent|your application.*(team|at)|we (love|enjoy) your)/i;
const SUBJECT_JOB = /(job|role|position|opportunity|candidate)/i;

export function classifyMail(msg: MailMessage): MailClassification {
  const s = `${msg.subject} ${msg.snippet ?? ''} ${msg.senderName}`.slice(0, 1000);
  if (SUBJECT_WITHDRAWAL.test(s)) return 'WITHDRAWAL_CONFIRMED';
  if (SUBJECT_OFFER.test(s)) return 'OFFER';
  if (SUBJECT_REJECTION.test(s)) return 'REJECTION';
  if (SUBJECT_INTERVIEW.test(s)) return /schedule|calendly|zoom/i.test(s) ? 'INTERVIEW_SCHEDULED' : 'INTERVIEW_REQUEST';
  if (SUBJECT_ASSESSMENT.test(s)) return 'ASSESSMENT_REQUIRED';
  if (SUBJECT_ADDITIONAL.test(s)) return 'ADDITIONAL_INFORMATION_REQUIRED';
  if (SUBJECT_CONFIRMED.test(s)) return 'APPLICATION_CONFIRMED';
  if (SUBJECT_RECRUITER.test(s)) return 'RECRUITER_MESSAGE';
  if (SUBJECT_JOB.test(s)) return 'GENERIC_JOB_EMAIL';
  return 'UNRELATED';
}

// ── Matcher: link mail to an application using evidence + confidence ─────

export interface MatchEvidence {
  company: string;
  jobTitle: string;
  provider: string;
  externalJobId?: string;
  appliedAt?: string;
  senderDomain: string;
  subject: string;
}

export type MailMatch =
  | { matched: true; applicationId: string; attemptId: string; confidence: 'strong' | 'weak'; evidence: string[] }
  | { matched: false; reason: 'UNMATCHED_JOB_MAIL' | 'MAIL_MATCH_REVIEW_REQUIRED' };

export function matchMailToApplication(msg: MailMessage, candidates: Array<{ applicationId: string; attemptId: string; company: string; jobTitle: string; provider: string; externalJobId?: string; appliedAt?: string }>): MailMatch {
  const senderDomain = msg.senderAddress.split('@')[1]?.toLowerCase() ?? '';
  const subject = msg.subject.toLowerCase();
  const strong: typeof candidates = [];
  const weak: typeof candidates = [];
  for (const c of candidates) {
    const evidence: string[] = [];
    const companyMatch = c.company.toLowerCase() && (senderDomain.includes(c.company.toLowerCase().replace(/\s+/g, '')) || subject.includes(c.company.toLowerCase()) || msg.senderName.toLowerCase().includes(c.company.toLowerCase()));
    if (companyMatch) evidence.push('company');
    if (c.externalJobId && subject.includes(c.externalJobId.toLowerCase())) evidence.push('externalJobId');
    if (c.jobTitle && subject.includes(c.jobTitle.toLowerCase())) evidence.push('jobTitle');
    if (evidence.length >= 2) strong.push(c);
    else if (evidence.length === 1) weak.push(c);
  }
  if (strong.length === 1) return { matched: true, applicationId: strong[0].applicationId, attemptId: strong[0].attemptId, confidence: 'strong', evidence: ['company+job/externalId'] };
  if (strong.length > 1 || weak.length > 0) return { matched: false, reason: 'MAIL_MATCH_REVIEW_REQUIRED' };
  return { matched: false, reason: 'UNMATCHED_JOB_MAIL' };
}

// ── Status projection from mail evidence ─────────────────────────────────

export type PostApplicationStatus = 'Assessment' | 'Interview' | 'Offer' | 'Rejected' | 'Withdrawn';

export function statusFromClassification(c: MailClassification): { status: PostApplicationStatus; actionRequiredReason?: string } | null {
  switch (c) {
    case 'ASSESSMENT_REQUIRED': return { status: 'Assessment', actionRequiredReason: 'ASSESSMENT_REQUIRED' };
    case 'INTERVIEW_REQUEST':
    case 'INTERVIEW_SCHEDULED': return { status: 'Interview' };
    case 'OFFER': return { status: 'Offer' };
    case 'REJECTION': return { status: 'Rejected' };
    case 'WITHDRAWAL_CONFIRMED': return { status: 'Withdrawn' };
    case 'ADDITIONAL_INFORMATION_REQUIRED': return { status: 'Assessment', actionRequiredReason: 'ADDITIONAL_INFORMATION_REQUIRED' };
    default: return null;
  }
}

// ── Storage ──────────────────────────────────────────────────────────────

export function ensureMailSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connector TEXT NOT NULL,
      status TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_message_evidence (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connector TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      thread_id TEXT,
      sender TEXT NOT NULL,
      subject TEXT NOT NULL,
      received_at TEXT NOT NULL,
      classification TEXT NOT NULL,
      matched_application_id TEXT,
      match_confidence TEXT,
      evidence_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (connector, provider_message_id)
    );
  `);
}

export function recordMailEvidence(
  db: Database,
  input: {
    userId: string;
    connector: string;
    msg: MailMessage;
    classification: MailClassification;
    matchedApplicationId?: string;
    matchConfidence?: 'strong' | 'weak';
  },
): { id: string; duplicate: boolean } {
  ensureMailSchema(db);
  const id = `mail-${sha256(`${input.connector}|${input.msg.providerMessageId}`).slice(0, 24)}`;
  const fingerprint = sha256(`${input.connector}|${input.msg.providerMessageId}|${input.classification}`).slice(0, 32);
  const existing = db.prepare('SELECT id FROM mail_message_evidence WHERE connector = ? AND provider_message_id = ?').get(input.connector, input.msg.providerMessageId) as any;
  if (existing) return { id, duplicate: true };
  db.prepare('INSERT INTO mail_message_evidence (id, user_id, connector, provider_message_id, thread_id, sender, subject, received_at, classification, matched_application_id, match_confidence, evidence_fingerprint, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, input.userId, input.connector, input.msg.providerMessageId, input.msg.threadId ?? null, input.msg.senderAddress, input.msg.subject, input.msg.receivedAt, input.classification, input.matchedApplicationId ?? null, input.matchConfidence ?? null, fingerprint, new Date().toISOString());
  return { id, duplicate: false };
}

/** SUCCESS_UNCONFIRMED browser result + strong confirmation mail → APPLIED
 *  (evidence source EMAIL_CONFIRMATION). */
export function canPromoteViaEmailConfirmation(attemptStatus: string, match: { matched: true; confidence: 'strong' }): boolean {
  return attemptStatus === 'SUCCESS_UNCONFIRMED' && match.confidence === 'strong';
}