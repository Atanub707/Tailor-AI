import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import Database from 'better-sqlite3';
import { Job, MasterCv, JobFilterQueryParams } from '../../src/types.js';
import { classifyWorkMode, classifyFromText } from '../scraper/workMode.js';
import { extractContactsFrom, ContactType } from '../extract/contactExtractor.js';

export interface HrContact {
  id: string;
  email: string | null;
  phone: string | null;
  whatsapp: boolean;
  recruiterName: string | null;
  recruiterUrl: string | null;
  name: string | null;
  type: ContactType;
  typeLabel: string;
  company: string;
  jobRole: string;
  sourceJobId: string;
  sourceJobUrl: string;
  jobCount: number;
  context: string;
  firstSeen: string;
  lastSeen: string;
  lastEmailSent?: string;
  emailStatus?: string;
  emailMessageId?: string;
  notes?: string;
  followUpAt?: string;
  followedUp?: boolean;
  pipelineStatus?: string;
}

export interface ContactEmail { id: string; recipient: string; subject: string; body: string; attachmentName: string | null; status: string; sentAt: string; }

const DATA_DIR = process.env.TAILOR_DATA_DIR || path.join(process.cwd(), 'data');
const JSON_FILE_PATH = path.join(DATA_DIR, 'jobs.json');
const SQLITE_DB_PATH = path.join(DATA_DIR, 'ats_jobs.sqlite');
const LEGACY_PRIMARY_JSON = path.join(DATA_DIR, 'ats_jobs.sqlite.json');

// Request-scoped identity: the middleware wraps each request with the
// authenticated user id, and storage functions resolve the current user from it.
const authContext = new AsyncLocalStorage<{ userId: string }>();

export function getCurrentUserId(): string {
  return authContext.getStore()?.userId || '';
}

export function runWithUser<T>(userId: string, fn: () => T): T {
  return authContext.run({ userId }, fn);
}

// ─────────────────── Sessions ───────────────────
export function createSession(userId: string): string {
  const token = crypto.randomBytes(24).toString('hex');
  getDb().prepare('INSERT OR REPLACE INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, userId, new Date().toISOString());
  return token;
}

export function getSessionUser(token: string): string | undefined {
  try {
    const row = getDb().prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
    return row?.user_id;
  } catch { return undefined; }
}

export function deleteSession(token: string): void {
  try {
    getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
  } catch { /* ignore */ }
}

// ─────────────────── Auth / Users ───────────────────
export interface User {
  id: string;
  email: string;
  name: string;
  isGuest: boolean;
  createdAt: string;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export interface RecoveryQuestionsInput {
  q1: string;
  a1: string;
  q2: string;
  a2: string;
}

export function createUser(email: string, name: string, password?: string, recovery?: RecoveryQuestionsInput): User {
  const d = getDb();
  const existing = d.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) throw new Error('An account with this email already exists.');
  const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const isGuest = !password;
  const salt = isGuest ? '' : crypto.randomBytes(8).toString('hex');
  const passHash = isGuest ? '' : hashPassword(password!, salt);
  const createdAt = new Date().toISOString();
  // Answers are hashed with the same per-account salt (never stored plain),
  // normalized the same way at write and verify time.
  const normA1 = recovery?.a1.trim().toLowerCase() ?? '';
  const normA2 = recovery?.a2.trim().toLowerCase() ?? '';
  const a1 = !isGuest && recovery ? hashPassword(normA1, salt) : '';
  const a2 = !isGuest && recovery ? hashPassword(normA2, salt) : '';
  d.prepare('INSERT INTO users (id, email, name, salt, pass_hash, is_guest, created_at, recovery_q1, recovery_a1, recovery_q2, recovery_a2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, email.toLowerCase().trim(), name, salt, passHash, isGuest ? 1 : 0, createdAt, recovery?.q1 ?? null, a1 || null, recovery?.q2 ?? null, a2 || null);
  return { id, email: email.toLowerCase().trim(), name, isGuest, createdAt };
}

export function verifyLogin(email: string, password: string): User | null {
  const d = getDb();
  const row = d.prepare('SELECT id, email, name, salt, pass_hash, is_guest, created_at FROM users WHERE email = ?')
    .get(email.toLowerCase().trim()) as { id: string; email: string; name: string; salt: string; pass_hash: string; is_guest: number; created_at: string } | undefined;
  if (!row || row.is_guest === 1) return null;
  const hash = hashPassword(password, row.salt);
  if (hash !== row.pass_hash) return null;
  return { id: row.id, email: row.email, name: row.name, isGuest: false, createdAt: row.created_at };
}

// ─── Password recovery (security questions) ───

export interface RecoveryInfo {
  exists: boolean;
  hasRecovery: boolean;
  q1?: string;
  q2?: string;
}

export function getRecoveryInfo(email: string): RecoveryInfo {
  const d = getDb();
  const row = d.prepare('SELECT is_guest, recovery_q1, recovery_q2 FROM users WHERE email = ?')
    .get(email.toLowerCase().trim()) as { is_guest: number; recovery_q1: string | null; recovery_q2: string | null } | undefined;
  if (!row || row.is_guest === 1) return { exists: false, hasRecovery: false };
  return {
    exists: true,
    hasRecovery: !!row.recovery_q1 && !!row.recovery_q2,
    q1: row.recovery_q1 || undefined,
    q2: row.recovery_q2 || undefined,
  };
}

// Verifies both answers; on success sets a new password. Throws with a
// user-facing message on mismatch so the route can count attempts.
export function resetPasswordWithRecovery(email: string, answer1: string, answer2: string, newPassword: string): User {
  const d = getDb();
  const row = d.prepare('SELECT id, email, name, salt, pass_hash, is_guest, recovery_a1, recovery_a2, created_at FROM users WHERE email = ?')
    .get(email.toLowerCase().trim()) as { id: string; email: string; name: string; salt: string; pass_hash: string; is_guest: number; recovery_a1: string | null; recovery_a2: string | null; created_at: string } | undefined;
  if (!row || row.is_guest === 1 || !row.recovery_a1 || !row.recovery_a2) {
    throw new Error('This account has no recovery questions set.');
  }
  const ok1 = hashPassword(answer1.trim().toLowerCase(), row.salt) === row.recovery_a1;
  const ok2 = hashPassword(answer2.trim().toLowerCase(), row.salt) === row.recovery_a2;
  if (!ok1 || !ok2) {
    throw new Error('Recovery answers do not match.');
  }
  const newSalt = crypto.randomBytes(8).toString('hex');
  // Re-hash the answers with the NEW salt (they were salted with the old one).
  d.prepare('UPDATE users SET salt = ?, pass_hash = ?, recovery_a1 = ?, recovery_a2 = ? WHERE id = ?')
    .run(
      newSalt,
      hashPassword(newPassword, newSalt),
      hashPassword(answer1.trim().toLowerCase(), newSalt),
      hashPassword(answer2.trim().toLowerCase(), newSalt),
      row.id
    );
  return { id: row.id, email: row.email, name: row.name, isGuest: false, createdAt: row.created_at };
}

// Authed: set/update recovery questions (requires the current password).
export function setRecoveryQuestions(userId: string, currentPassword: string, recovery: RecoveryQuestionsInput): void {
  const d = getDb();
  const row = d.prepare('SELECT salt, pass_hash, is_guest FROM users WHERE id = ?').get(userId) as { salt: string; pass_hash: string; is_guest: number } | undefined;
  if (!row || row.is_guest === 1) throw new Error('Only password accounts can set recovery questions.');
  if (hashPassword(currentPassword, row.salt) !== row.pass_hash) {
    throw new Error('Current password is incorrect.');
  }
  d.prepare('UPDATE users SET recovery_q1 = ?, recovery_a1 = ?, recovery_q2 = ?, recovery_a2 = ? WHERE id = ?')
    .run(recovery.q1, hashPassword(recovery.a1.trim().toLowerCase(), row.salt), recovery.q2, hashPassword(recovery.a2.trim().toLowerCase(), row.salt), userId);
}

export function listUsers(): User[] {
  try {
    const d = getDb();
    return (d.prepare('SELECT id, email, name, is_guest, created_at FROM users ORDER BY is_guest ASC, name').all() as any[])
      .map((r) => ({ id: r.id, email: r.email, name: r.name, isGuest: r.is_guest === 1, createdAt: r.created_at }));
  } catch { return []; }
}

// Users worth refreshing in the background watcher: someone with stored jobs
// OR a session within the window (a real, recent user). Dormant/test users
// with neither are skipped — the watcher writes a full corpus per user, so
// this is what keeps a many-user install from doing N× the work.

export function getUserById(id: string): User | undefined {
  try {
    const d = getDb();
    const r = d.prepare('SELECT id, email, name, is_guest, created_at FROM users WHERE id = ?').get(id) as any;
    return r ? { id: r.id, email: r.email, name: r.name, isGuest: r.is_guest === 1, createdAt: r.created_at } : undefined;
  } catch { return undefined; }
}

// ─────────────────── Database ───────────────────
const DEFAULT_MASTER_CV: MasterCv = {
  fullName: 'Alex Mercer',
  email: 'alex.mercer.dev@example.com',
  phone: '+1 (555) 234-5678',
  location: 'San Francisco, CA (Open to Remote)',
  linkedin: 'https://linkedin.com/in/alexmercer-dev',
  github: 'https://github.com/alexmercer-dev',
  website: 'https://alexmercer.dev',
  summary: 'Results-driven Senior Full-Stack & AI Software Engineer with 6+ years of experience architecting scalable cloud services, TypeScript/React single-page applications, Express backends, and AI LLM integrations. Proven track record in optimizing application performance, leading automated testing pipelines, and implementing high-throughput REST APIs and microservices.',
  experiences: [
    {
      id: 'exp-1',
      title: 'Senior Software Engineer',
      company: 'Apex Cloud Systems',
      location: 'San Francisco, CA',
      dates: '2022 - Present',
      responsibilities: [
        'Architected and deployed high-concurrency microservices processing 12M+ monthly REST API requests with 99.98% uptime.',
        'Engineered AI-assisted search and automated document processing workflows using Gemini LLM APIs, reducing content processing latency by 45%.',
        'Led cross-functional team of 6 engineers, standardizing TypeScript patterns, automated CI/CD unit testing, and code review practices.',
        'Optimized frontend React/Vite web application rendering performance, reducing First Contentful Paint (FCP) by 35% through dynamic code splitting.'
      ]
    },
    {
      id: 'exp-2',
      title: 'Full Stack Web Developer',
      company: 'Nexus Digital Solutions',
      location: 'Oakland, CA',
      dates: '2019 - 2022',
      responsibilities: [
        'Built full-stack React and Express node services for enterprise financial dashboarding with real-time websocket metrics.',
        'Migrated legacy monolithic application to Dockerized microservices on AWS Cloud, reducing infrastructure costs by 28%.',
        'Implemented robust PostgreSQL and SQLite database queries with indexing strategies to speed up complex report generation.'
      ]
    },
    {
      id: 'exp-3',
      title: 'Software Development Intern',
      company: 'Innovate Labs',
      location: 'San Jose, CA',
      dates: '2018 - 2019',
      responsibilities: [
        'Developed interactive UI components in React and standard Web APIs for client web applications.',
        'Authored comprehensive unit tests and automated integration tests maintaining 88%+ code coverage.'
      ]
    }
  ],
  education: [
    {
      id: 'edu-1',
      degree: 'B.S. in Computer Science',
      institution: 'University of California, Berkeley',
      dates: '2015 - 2019',
      details: 'Graduated with Honors. Coursework in Data Structures, Distributed Systems, AI & Machine Learning.'
    }
  ],
  skills: [
    {
      category: 'Languages',
      items: ['TypeScript', 'JavaScript (ES6+)', 'Python', 'SQL', 'HTML5/CSS3']
    },
    {
      category: 'Frameworks & Libraries',
      items: ['React.js', 'Node.js', 'Express.js', 'Tailwind CSS', 'Vite', 'Next.js']
    },
    {
      category: 'AI & Data Tools',
      items: ['Gemini API (@google/genai)', 'OpenAI APIs', 'Prompt Engineering', 'Vector Embeddings', 'SQLite', 'PostgreSQL']
    },
    {
      category: 'Cloud & DevOps',
      items: ['Docker', 'AWS (S3, EC2)', 'Cloud Run', 'RESTful APIs', 'Git', 'CI/CD Pipelines']
    }
  ],
  projects: [
    {
      id: 'proj-1',
      name: 'AI Job Matcher & Resume Builder',
      description: 'Full-stack platform that analyzes job postings against candidate profiles and automatically generates ATS-optimized resumes.',
      technologies: ['TypeScript', 'React', 'Node.js', 'Gemini AI', 'Tailwind CSS'],
      dates: '2023 - 2024',
      link: 'https://github.com/example/job-matcher'
    }
  ],
  certifications: [
    {
      id: 'cert-1',
      name: 'AWS Certified Solutions Architect – Associate',
      issuer: 'Amazon Web Services',
      date: '2023'
    },
    {
      id: 'cert-2',
      name: 'Google Cloud Certified Professional Cloud Developer',
      issuer: 'Google Cloud',
      date: '2022'
    }
  ]
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ─────────────────── SQLite connection ───────────────────
let db: Database.Database | null = null;
let dbPathOverride: string | null = null;

export function initDbWithPath(path: string): Database.Database {
  dbPathOverride = path;
  if (db) { try { db.close(); } catch { /* noop */ } db = null; }
  return getDb();
}

export function resetDbForTests(): void {
  dbPathOverride = null;
  if (db) { try { db.close(); } catch { /* noop */ } db = null; }
}

/**
 * Close and reopen the canonical SQLite connection.
 *
 * WHY: a long-lived better-sqlite3 connection can hold file descriptors to
 * deleted/orphaned WAL/SHM inodes after a Docker restart (bind-mount inode
 * swap). That stale connection then reports SQLITE_CORRUPT ("database disk
 * image is malformed") on writes even though the on-disk database is healthy
 * (PRAGMA quick_check = ok from any fresh connection). Reopening gives the
 * process a clean handle on the current WAL/SHM files. Exactly one connection
 * exists at a time — this never creates a second permanent one.
 */
export function resetDbConnection(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* best-effort close — the connection may already be wedged */
    }
    db = null;
  }
  // Reopen lazily via getDb() — restores journal_mode=WAL + base schema.
  getDb();
}

function isCorruptError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { code?: string }).code === 'SQLITE_CORRUPT' ||
      String((err as Error).message || '').includes('database disk image is malformed'))
  );
}

/**
 * Run a DB operation with ONE automatic connection-recovery attempt for the
 * stale-connection SQLITE_CORRUPT condition:
 *
 *   op → SQLITE_CORRUPT → close+reopen connection → PRAGMA quick_check
 *     quick_check = ok  → retry op ONCE (whole operation, fresh transaction)
 *     quick_check ≠ ok  → surface the ORIGINAL error (no retry)
 *
 * Non-corrupt errors are never swallowed and never trigger a reconnect.
 * Maximum: 1 reconnect, 1 retry. No loops.
 */
export function withDbRecovery<T>(op: () => T): T {
  try {
    return op();
  } catch (err) {
    if (!isCorruptError(err)) throw err;
    console.warn(`[SQLite] connection recovery triggered (${(err as { code?: string }).code || 'SQLITE_CORRUPT'})`);
    try {
      resetDbConnection();
    } catch (reopenErr) {
      console.warn(`[SQLite] connection reopen failed: ${String((reopenErr as Error).message || reopenErr).slice(0, 120)} — no retry`);
      throw err;
    }
    let quickCheck = 'unknown';
    try {
      quickCheck = String((getDb().prepare('PRAGMA quick_check').get() as { quick_check?: string })?.quick_check ?? 'unknown');
    } catch (qcErr) {
      quickCheck = 'error';
    }
    console.warn(`[SQLite] connection reopened; quick_check=${quickCheck}`);
    if (quickCheck !== 'ok') {
      // On-disk integrity genuinely bad (or DB unreadable) — do NOT retry.
      console.warn('[SQLite] quick_check not ok — surfacing original error without retry');
      throw err;
    }
    console.warn('[SQLite] retrying operation once');
    try {
      const result = op();
      console.warn('[SQLite] retry succeeded');
      return result;
    } catch (retryErr) {
      console.warn(`[SQLite] retry failed: ${(retryErr as { code?: string }).code || String((retryErr as Error).message || retryErr).slice(0, 120)} — no second reconnect`);
      throw retryErr;
    }
  }
}

export function getDb(): Database.Database {
  if (db) return db;
  ensureDataDir();
  db = new Database(dbPathOverride || SQLITE_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      salt TEXT,
      pass_hash TEXT,
      is_guest INTEGER DEFAULT 0,
      created_at TEXT,
      recovery_q1 TEXT,
      recovery_a1 TEXT,
      recovery_q2 TEXT,
      recovery_a2 TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS master_cv (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS manual_analysis (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT,
      company TEXT,
      description TEXT,
      score INTEGER,
      gap_analysis TEXT,
      diff TEXT,
      tailored_cv TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS interview_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cv_versions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL,
      note TEXT,
      pages INTEGER DEFAULT 0,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS portal_bookmarks (
      user_id TEXT NOT NULL,
      portal_name TEXT NOT NULL,
      created_at TEXT,
      PRIMARY KEY (user_id, portal_name)
    );
    CREATE TABLE IF NOT EXISTS hr_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      type TEXT NOT NULL DEFAULT 'company',
      type_label TEXT NOT NULL DEFAULT 'Company',
      company TEXT,
      job_role TEXT,
      source_job_id TEXT,
      source_job_url TEXT,
      job_count INTEGER DEFAULT 1,
      context TEXT,
      hidden INTEGER DEFAULT 0,
      first_seen TEXT,
      last_seen TEXT,
      phone TEXT
    );
    CREATE TABLE IF NOT EXISTS lp_history (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT
    );
  `);
  migrateToUsers(db);
  migrateRecoveryColumns(db);
  migrateContactsTable(db);
  ensureWhatsappColumn(db);
  ensureEmailColumns(db);
  ensureRecruitersFeatureColumns(db);
  ensureContactEmailsTable(db);
  ensureCandidateProfileTable(db);
  ensurePostsDailyTable(db);
  ensureContactIndexes(db);
  return db;
}

// Cold-email tracking on contacts (L2 SMTP): when the last email was sent,
// its status, and the provider message id. Nullable — safe to add.
function ensureEmailColumns(d: Database.Database): void {
  try {
    const cols = new Set((d.pragma('table_info(hr_contacts)') as any[]).map((c) => c.name));
    if (!cols.has('last_email_sent')) {
      d.exec(`ALTER TABLE hr_contacts ADD COLUMN last_email_sent TEXT`);
    }
    if (!cols.has('email_status')) {
      d.exec(`ALTER TABLE hr_contacts ADD COLUMN email_status TEXT`);
    }
    if (!cols.has('email_message_id')) {
      d.exec(`ALTER TABLE hr_contacts ADD COLUMN email_message_id TEXT`);
    }
  } catch (err) {
    console.error('email column migration failed:', err);
  }
}

function ensureRecruitersFeatureColumns(db: Database.Database): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(hr_contacts)`).all() as { name: string }[]).map((c) => c.name)
  );
  const adds: Array<[string, string]> = [
    ['notes', 'TEXT'],
    ['follow_up_at', 'TEXT'],
    ['followed_up', 'INTEGER DEFAULT 0'],
    ['pipeline_status', 'TEXT'],
  ];
  for (const [name, def] of adds) {
    if (!cols.has(name)) db.exec(`ALTER TABLE hr_contacts ADD COLUMN ${name} ${def}`);
  }
}

function ensureContactEmailsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      attachment_name TEXT,
      status TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_emails_contact ON contact_emails(contact_id);
  `);
}

function ensureCandidateProfileTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_profile (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

// ── LinkedIn Posts daily quota (1 Apify SEARCH per day) ──
// The actor fetches ~100 posts per run and bills ~$0.20 — the daily brake is
// on SEARCHES (spend), not on posts shown. Free engine is unlimited.
function ensurePostsDailyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts_daily_usage (
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day_key)
    );
  `);
}

const POSTS_DAILY_QUOTA = 1;

function postsDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getPostsDailyUsage(userId: string): { used: number; quota: number; resetAt: string } {
  const db = getDb();
  ensurePostsDailyTable(db);
  const row = db.prepare('SELECT count FROM posts_daily_usage WHERE user_id = ? AND day_key = ?').get(userId, postsDayKey()) as { count: number } | undefined;
  return { used: row?.count || 0, quota: POSTS_DAILY_QUOTA, resetAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString() };
}

// Increment the counter by n; returns the new used total.
export function addPostsDailyUsage(userId: string, n: number): number {
  const db = getDb();
  ensurePostsDailyTable(db);
  const key = postsDayKey();
  db.prepare(
    `INSERT INTO posts_daily_usage (user_id, day_key, count) VALUES (?, ?, ?)
     ON CONFLICT(user_id, day_key) DO UPDATE SET count = count + excluded.count`
  ).run(userId, key, n);
  return getPostsDailyUsage(userId).used;
}

// Light migration: whatsapp flag column (default 0). A simple ALTER is
// enough — no rebuild needed for a nullable column with a default.
function ensureWhatsappColumn(d: Database.Database): void {
  try {
    const cols = new Set((d.pragma('table_info(hr_contacts)') as any[]).map((c) => c.name));
    if (!cols.has('whatsapp')) {
      d.exec(`ALTER TABLE hr_contacts ADD COLUMN whatsapp INTEGER DEFAULT 0`);
      console.log('[Contacts] hr_contacts migrated to support whatsapp flags');
    }
  } catch (err) {
    console.error('whatsapp column migration failed:', err);
  }
}

// Partial unique indexes on the contact fields. NULLs may repeat, so
// phone-only rows coexist with email rows. Must run AFTER the migration
// has added the phone column on legacy databases.
function ensureContactIndexes(d: Database.Database): void {
  try {
    const cols = new Set((d.pragma('table_info(hr_contacts)') as any[]).map((c) => c.name));
    if (!cols.has('phone')) return;
    d.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON hr_contacts (user_id, email) WHERE email IS NOT NULL AND email != '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone ON hr_contacts (user_id, phone) WHERE phone IS NOT NULL AND phone != '';
    `);
  } catch (err) {
    console.error('Contact index creation failed:', err);
  }
}

// Older hr_contacts had email NOT NULL + UNIQUE(user_id, email) and no
// phone column. SQLite cannot drop NOT NULL via ALTER, so the table is
// rebuilt with nullable email, a phone column, and per-field unique
// indexes (NULLs are allowed to repeat, so phone-only rows coexist with
// email rows).
function migrateContactsTable(d: Database.Database): void {
  try {
    const cols = new Set((d.pragma('table_info(hr_contacts)') as any[]).map((c) => c.name));
    if (!cols.has('phone') || !cols.has('recruiter_url')) {
      d.exec(`
        CREATE TABLE hr_contacts_new (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT, name TEXT,
          type TEXT NOT NULL DEFAULT 'company', type_label TEXT NOT NULL DEFAULT 'Company',
          company TEXT, job_role TEXT, source_job_id TEXT, source_job_url TEXT,
          job_count INTEGER DEFAULT 1, context TEXT, hidden INTEGER DEFAULT 0,
          first_seen TEXT, last_seen TEXT, phone TEXT,
          recruiter_name TEXT, recruiter_url TEXT
        );
        INSERT INTO hr_contacts_new (id, user_id, email, name, type, type_label, company, job_role, source_job_id, source_job_url, job_count, context, hidden, first_seen, last_seen, phone, recruiter_name, recruiter_url)
          SELECT id, user_id, email, name, type, type_label, company, job_role, source_job_id, source_job_url, job_count, context, hidden, first_seen, last_seen, phone, NULL, NULL FROM hr_contacts;
        DROP TABLE hr_contacts;
        ALTER TABLE hr_contacts_new RENAME TO hr_contacts;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON hr_contacts (user_id, email) WHERE email IS NOT NULL AND email != '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone ON hr_contacts (user_id, phone) WHERE phone IS NOT NULL AND phone != '';
      `);
      console.log('[Contacts] hr_contacts migrated to support phones');
    }
  } catch (err) {
    console.error('hr_contacts migration failed:', err);
  }
}

// Idempotent: adds the recovery-question columns to users tables created
// before the forgot-password feature existed.
function migrateRecoveryColumns(d: Database.Database): void {
  const cols = new Set((d.pragma('table_info(users)') as any[]).map((c) => c.name));
  const add = (name: string) => {
    if (!cols.has(name)) {
      d.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT`);
    }
  };
  add('recovery_q1');
  add('recovery_a1');
  add('recovery_q2');
  add('recovery_a2');
}

/**
 * Migrates a pre-auth database into per-user isolation. Idempotent:
 * each step runs only if its precondition is unmet, so interrupted
 * migrations can be retried safely.
 */
function migrateToUsers(d: Database.Database): void {
  try {
    // 1. jobs table: add user_id if missing
    const jobCols = d.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
    if (!jobCols.some((c) => c.name === 'user_id')) {
      d.exec('ALTER TABLE jobs ADD COLUMN user_id TEXT');
      console.log('[Storage] Added user_id column to jobs table');
    }

    // 1b. jobs table: composite PK (user_id, id) — each account owns its own
    // copy of a job. With a global `id` PK, account B searching jobs account A
    // already saved silently failed with "already exists" (the real multi-
    // account bug). Id collisions across users keep the earliest owner.
    const jobPk = (d.prepare('PRAGMA table_info(jobs)').all() as { name: string; pk: number }[]).filter((c) => c.pk > 0);
    const hasComposite = jobPk.some((c) => c.name === 'user_id') && jobPk.some((c) => c.name === 'id');
    if (!hasComposite) {
      d.exec(`
        CREATE TABLE jobs_new (
          id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (user_id, id)
        );
      `);
      d.exec(`
        INSERT OR IGNORE INTO jobs_new (id, user_id, data)
        SELECT id, COALESCE(NULLIF(user_id, ''), '__owner__'), data FROM jobs
      `);
      d.exec('DROP TABLE jobs');
      d.exec('ALTER TABLE jobs_new RENAME TO jobs');
      console.log('[Storage] Rebuilt jobs table with per-user PK (user_id, id)');
    }

    // 2. master_cv table: rebuild into user-keyed schema
    const cvCols = d.prepare('PRAGMA table_info(master_cv)').all() as { name: string }[];
    if (!cvCols.some((c) => c.name === 'user_id')) {
      d.exec('ALTER TABLE master_cv RENAME TO master_cv_old');
      d.exec(`
        CREATE TABLE master_cv (
          user_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at TEXT
        );
      `);
      if (cvCols.some((c) => c.name === 'profile_id')) {
        const rows = d.prepare('SELECT profile_id, data, updated_at FROM master_cv_old').all() as { profile_id: string; data: string; updated_at: string }[];
        const keep = rows.find((r) => r.profile_id === 'default') || rows[0];
        if (keep) {
          d.prepare('INSERT INTO master_cv (user_id, data, updated_at) VALUES (?, ?, ?)')
            .run('__placeholder__', keep.data, keep.updated_at || new Date().toISOString());
        }
      } else if (cvCols.some((c) => c.name === 'data')) {
        const row = d.prepare('SELECT data, updated_at FROM master_cv_old LIMIT 1').get() as { data: string; updated_at: string } | undefined;
        if (row) {
          d.prepare('INSERT INTO master_cv (user_id, data, updated_at) VALUES (?, ?, ?)')
            .run('__placeholder__', row.data, row.updated_at || new Date().toISOString());
        }
      }
      d.exec('DROP TABLE master_cv_old');
      console.log('[Storage] Rebuilt master_cv table with user_id schema');
    }

    // 3. Ensure an owner exists for unclaimed data
    const userCount = (d.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    let adminId: string | undefined;
    if (userCount === 0) {
      const admin = createUser('admin@local', 'Admin');
      adminId = admin.id;
      console.log(`[Storage] Created admin user (admin@local, id=${admin.id})`);
    } else {
      adminId = (d.prepare('SELECT id FROM users ORDER BY is_guest ASC, created_at ASC LIMIT 1').get() as any)?.id;
    }

    if (adminId) {
      d.exec(`UPDATE jobs SET user_id = '${adminId}' WHERE user_id IS NULL OR user_id = '' OR user_id = '__owner__'`);
      d.exec(`UPDATE master_cv SET user_id = '${adminId}' WHERE user_id = '__placeholder__' OR user_id = ''`);
      const owned = (d.prepare('SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?').get(adminId) as { c: number }).c;
      console.log(`[Storage] Data isolation ready: ${owned} jobs owned by ${adminId}`);
    }
  } catch (err) {
    console.error('[Storage] User migration failed:', err);
  }
}

/** One-time import from legacy JSON files if the DB is empty */
function migrateFromLegacyJson(): void {
  ensureDataDir();
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number };
  if (row.c > 0) return;

  const legacyPath = [LEGACY_PRIMARY_JSON, JSON_FILE_PATH].find((p) => fs.existsSync(p));
  if (!legacyPath) return;

  try {
    const parsed: Job[] = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    const adminId = (d.prepare('SELECT id FROM users ORDER BY is_guest ASC, created_at ASC LIMIT 1').get() as any)?.id || '';
    const insert = d.prepare('INSERT OR IGNORE INTO jobs (id, user_id, data) VALUES (?, ?, ?)');
    const tx = d.transaction((jobs: Job[]) => {
      for (const j of jobs) insert.run(j.id, adminId, JSON.stringify(j));
    });
    tx(parsed);
    console.log(`[Storage] Imported ${parsed.length} jobs from legacy JSON into SQLite`);
  } catch (err) {
    console.warn('[Storage] Legacy JSON import failed:', err);
  }
}

migrateFromLegacyJson();

// ─────────────────── Master CV Storage (multi-profile) ───────────────────
// ─────────────────── Master CV Storage (per-user) ───────────────────
export function getMasterCv(userId?: string): MasterCv {
  const targetId = userId || getCurrentUserId();
  try {
    const d = getDb();
    const row = d.prepare('SELECT data FROM master_cv WHERE user_id = ?').get(targetId) as { data: string } | undefined;
    if (row) return JSON.parse(row.data);
  } catch (err) {
    console.error('Error reading master CV from DB:', err);
  }
  // No stored CV for this user — a fresh default (legacy JSON import is handled by the migration).
  saveMasterCv(DEFAULT_MASTER_CV, targetId);
  return DEFAULT_MASTER_CV;
}

export function saveMasterCv(cv: MasterCv, userId?: string): void {
  const targetId = userId || getCurrentUserId();
  try {
    const d = getDb();
    d.prepare(`
      INSERT INTO master_cv (user_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(targetId, JSON.stringify(cv), new Date().toISOString());
  } catch (err) {
    console.error('Error saving master CV:', err);
  }
}

// ─────────────────── Candidate Job Profile (per-user) ───────────────────
export interface CandidateProfile {
  workModes: string[];
  preferredLocations: string[];
  noticePeriod: string;
  availableFrom: string;
  employmentTypes: string[];
  yearsExperience: string;
  currentRole: string;
  currentCompany: string;
  currentSalary: string;
  expectedSalaryMin: string;
  expectedSalaryMax: string;
  salaryCurrency: string;
  jobSearchStatus: string;
  willingToRelocate: 'yes' | 'no' | 'certain-cities';
  willingToTravelPct: string;
  workAuthorization: string;
  needsSponsorship: boolean;
  languages: string[];
  preferredCompanySize: string;
  recruiterNote: string;
}

const EMPTY_CANDIDATE_PROFILE: CandidateProfile = {
  workModes: [], preferredLocations: [], noticePeriod: '', availableFrom: '',
  employmentTypes: [], yearsExperience: '', currentRole: '', currentCompany: '',
  currentSalary: '', expectedSalaryMin: '', expectedSalaryMax: '', salaryCurrency: '',
  jobSearchStatus: '', willingToRelocate: 'no', willingToTravelPct: '',
  workAuthorization: '', needsSponsorship: false, languages: [],
  preferredCompanySize: '', recruiterNote: '',
};

function normalizeRelocation(v: unknown): 'yes' | 'no' | 'certain-cities' {
  if (v === 'yes' || v === 'no' || v === 'certain-cities') return v;
  return v === true ? 'yes' : 'no';
}

export function getCandidateProfile(): CandidateProfile {
  const userId = getCurrentUserId();
  if (!userId) return { ...EMPTY_CANDIDATE_PROFILE };
  try {
    const row = getDb().prepare('SELECT data FROM candidate_profile WHERE user_id = ?').get(userId) as { data: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      return { ...EMPTY_CANDIDATE_PROFILE, ...parsed, willingToRelocate: normalizeRelocation(parsed.willingToRelocate) };
    }
  } catch (err) {
    console.error('Error reading candidate profile:', err);
  }
  return { ...EMPTY_CANDIDATE_PROFILE };
}

export function saveCandidateProfile(p: CandidateProfile): void {
  const userId = getCurrentUserId();
  if (!userId) return;
  try {
    getDb().prepare(`
      INSERT INTO candidate_profile (user_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(userId, JSON.stringify(p), new Date().toISOString());
  } catch (err) {
    console.error('Error saving candidate profile:', err);
  }
}

// ─────────────────── Jobs Storage (per-user) ───────────────────
function getJobsForUser(userId: string): Job[] {
  try {
    const d = getDb();
    const rows = d.prepare('SELECT data FROM jobs WHERE user_id = ?').all(userId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  } catch (err) {
    console.error('Error loading jobs:', err);
    return [];
  }
}

export function getAllJobs(): Job[] {
  const userId = getCurrentUserId();
  if (!userId) return [];
  return getJobsForUser(userId).map((j) => ({
    ...j,
    firstSeenAt: j.firstSeenAt || j.scrapedAt,
    lastSeenAt: j.lastSeenAt || j.scrapedAt,
    isActive: j.isActive !== false,
  }));
}

export function saveNewJobs(newJobs: Job[]): { added: Job[]; skipped: number; newContacts: HrContact[] } {
  const userId = getCurrentUserId();
  if (!userId) return { added: [], skipped: 0, newContacts: [] };
  const d = getDb();
  const existingUrls = new Set((d.prepare('SELECT data FROM jobs WHERE user_id = ?').all(userId) as { data: string }[])
    .map((r) => { try { return (JSON.parse(r.data) as Job).url?.toLowerCase().trim(); } catch { return ''; } })
    .filter(Boolean));

  const insert = d.prepare('INSERT OR IGNORE INTO jobs (id, user_id, data) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const job of newJobs) {
    job.firstSeenAt = job.firstSeenAt || now;
    job.lastSeenAt = now;
    job.isActive = job.isActive !== false;
  }
  const added: Job[] = [];
  let skipped = 0;

  const tx = d.transaction(() => {
    for (const job of newJobs) {
      const normalizedUrl = job.url?.toLowerCase().trim() || '';
      if (normalizedUrl && existingUrls.has(normalizedUrl)) {
        // Duplicate URL: enrich the existing row with the source/ATS the user
        // actually selected this time (e.g. an ATS job first stored as
        // source "Custom" becomes "Greenhouse"), then skip the insert.
        try {
          const existingRow = d.prepare('SELECT data FROM jobs WHERE user_id = ?').all(userId) as { data: string }[];
          const existing = existingRow.find((r) => {
            try { return (JSON.parse(r.data) as Job).url?.toLowerCase().trim() === normalizedUrl; } catch { return false; }
          });
          if (existing) {
            const parsed = JSON.parse(existing.data) as Job;
            if (job.source && parsed.source !== job.source) {
              updateJobInStorage({ ...parsed, source: job.source, atsPlatform: (job as any).atsPlatform || (parsed as any).atsPlatform } as Job);
            }
          }
        } catch { /* malformed row — leave as-is */ }
        skipped++;
        continue;
      }
      const result = insert.run(job.id, userId, JSON.stringify(job));
      if (result.changes > 0) {
        existingUrls.add(normalizedUrl);
        added.push(job);
      } else {
        skipped++;
      }
    }
  });
  tx();

  // Extract recruiter/HR emails from the newly stored descriptions.
  const newContacts: HrContact[] = [];
  for (const job of added) {
    try {
      newContacts.push(...upsertContactsFromJob(job));
    } catch (err) {
      console.error('Error extracting contacts from job:', err);
    }
  }

  return { added, skipped, newContacts };
}

// Bump lastSeenAt on jobs still present in a refresh. Idempotent.
// Save scraped jobs AND upgrade stored truncated copies in place. A job with
// `replacesUrl` (the Google-News token of the truncated stored copy) replaces
// that stored job instead of being saved as a duplicate — full description,
// real URL, recruiter name, contacts re-extracted.
export function persistJobsWithUpgrade(scrapedJobs: Job[]): { added: Job[]; skipped: number; newContacts: ReturnType<typeof upsertContactsFromJob>; upgradedCount: number } {
  const all = getAllJobs();
  const toUpgrade: Job[] = [];
  const toSave: Job[] = [];
  for (const j of scrapedJobs) {
    if (j.replacesUrl && all.some((e) => e.url?.toLowerCase() === j.replacesUrl.toLowerCase())) toUpgrade.push(j);
    else toSave.push(j);
  }
  const { added, skipped, newContacts } = saveNewJobs(toSave.map((j) => ({ ...j, replacesUrl: undefined })));
  let upgradedCount = 0;
  for (const job of toUpgrade) {
    const existing = all.find((e) => e.url?.toLowerCase() === job.replacesUrl.toLowerCase());
    if (!existing) continue;
    const { replacesUrl: _replaced, ...full } = job;
    updateJobInStorage({ ...existing, ...full, id: existing.id });
    try {
      upsertContactsFromJob({ ...existing, ...full, id: existing.id });
      upgradedCount++;
    } catch (err) {
      console.error('Error extracting contacts from upgraded job:', err);
    }
  }
  return { added, skipped, newContacts, upgradedCount };
}

// ─────────────────── LinkedIn Posts search history (server-side) ───────────────────
// Search results persist per user in SQLite (NOT as jobs): they survive any
// browser, refresh, or device. Explicit per-post saves still go to the jobs
// table via persistJobsWithUpgrade; the `saved` flag here mirrors that.

export interface LpHistoryPost {
  id: string;
  title: string;
  company: string;
  url: string;
  applyUrl?: string;
  postedDate?: string;
  description?: string;
  hashtags?: string[];
  saved?: boolean;
}

const LP_HISTORY_LIMIT = 200;

export function getLpHistory(userId: string): LpHistoryPost[] {
  try {
    const row = getDb().prepare('SELECT data FROM lp_history WHERE user_id = ?').get(userId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as LpHistoryPost[]) : [];
  } catch (err) {
    console.error('getLpHistory error:', err);
    return [];
  }
}

export function saveLpHistory(userId: string, posts: LpHistoryPost[]): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO lp_history (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(userId, JSON.stringify(posts.slice(0, LP_HISTORY_LIMIT)), new Date().toISOString());
  } catch (err) {
    console.error('saveLpHistory error:', err);
  }
}

export function mergeLpHistory(userId: string, fresh: LpHistoryPost[]): LpHistoryPost[] {
  if (fresh.length === 0) return getLpHistory(userId);
  const existing = getLpHistory(userId);
  const seen = new Set(existing.map((p) => p.id));
  const merged = [...existing];
  for (const p of fresh) {
    if (!seen.has(p.id)) {
      merged.unshift(p);
      seen.add(p.id);
    }
  }
  const capped = merged.slice(0, LP_HISTORY_LIMIT);
  saveLpHistory(userId, capped);
  return capped;
}

export function markLpHistorySaved(userId: string, postId: string): void {
  const posts = getLpHistory(userId);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx === -1) return;
  posts[idx] = { ...posts[idx], saved: true };
  saveLpHistory(userId, posts);
}

export function clearLpHistory(userId: string): void {
  try {
    getDb().prepare('DELETE FROM lp_history WHERE user_id = ?').run(userId);
  } catch (err) {
    console.error('clearLpHistory error:', err);
  }
}

// ─────────────────── Interview sessions (history) ───────────────────

export interface StoredInterview {
  id: string;
  role: string;
  total: number;
  overall: number;
  verdict: string;
  perQuestion: { question: string; jobTitle: string; score: number; feedback: string }[];
  createdAt: string;
}

export function saveInterviewSession(data: Omit<StoredInterview, 'createdAt'>): void {
  const userId = getCurrentUserId();
  if (!userId) return;
  const createdAt = new Date().toISOString();
  getDb().prepare('INSERT OR REPLACE INTO interview_sessions (id, user_id, data, created_at) VALUES (?, ?, ?, ?)')
    .run(data.id, userId, JSON.stringify(data), createdAt);
}

export function getInterviewHistory(limit = 30): StoredInterview[] {
  const userId = getCurrentUserId();
  if (!userId) return [];
  const rows = getDb()
    .prepare('SELECT data, created_at FROM interview_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as { data: string; created_at: string }[];
  return rows.map((r) => ({ ...JSON.parse(r.data) as Omit<StoredInterview, 'createdAt'>, createdAt: r.created_at }));
}

export function getInterviewSessionRecord(id: string): StoredInterview | null {
  const userId = getCurrentUserId();
  if (!userId) return null;
  const row = getDb().prepare('SELECT data, created_at FROM interview_sessions WHERE id = ? AND user_id = ?').get(id, userId) as { data: string; created_at: string } | undefined;
  if (!row) return null;
  return { ...JSON.parse(row.data) as Omit<StoredInterview, 'createdAt'>, createdAt: row.created_at };
}

// ─────────────────── HR / Recruiter contacts ───────────────────

export function upsertContactsFromJob(job: Job): HrContact[] {
  const userId = getCurrentUserId();
  if (!userId) return [];
  const d = getDb();
  const now = new Date().toISOString();
  const newRows: HrContact[] = [];
  const findByEmail = d.prepare('SELECT * FROM hr_contacts WHERE user_id = ? AND email = ?');
  const findByPhone = d.prepare('SELECT * FROM hr_contacts WHERE user_id = ? AND phone = ?');
  const insert = d.prepare(`
    INSERT INTO hr_contacts (id, user_id, email, phone, whatsapp, name, type, type_label, company, job_role, source_job_id, source_job_url, job_count, context, hidden, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
  `);
  const merge = d.prepare(`
    UPDATE hr_contacts SET
      job_count = job_count + 1,
      last_seen = ?,
      type = ?,
      type_label = ?,
      name = CASE WHEN ? IS NOT NULL THEN ? ELSE name END,
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      whatsapp = MAX(whatsapp, ?),
      company = CASE WHEN company = '' THEN ? ELSE company END,
      job_role = CASE WHEN job_role = '' THEN ? ELSE job_role END,
      context = ?
    WHERE id = ?
  `);

  const contacts = extractContactsFrom(job.description || '', job.company || '');

  for (const c of contacts) {
    let existing: any = c.email ? findByEmail.get(userId, c.email) : undefined;
    if (!existing && c.phone) existing = findByPhone.get(userId, c.phone);
    if (existing) {
      merge.run(now, c.type, c.typeLabel, c.name, c.name, c.email, c.phone, c.whatsapp ? 1 : 0, job.company || '', job.title || '', c.context, existing.id);
    } else {
      const rid = `hr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insert.run(
        rid,
        userId,
        c.email,
        c.phone,
        c.whatsapp ? 1 : 0,
        c.name,
        c.type,
        c.typeLabel,
        job.company || '',
        job.title || '',
        job.id,
        job.url || '',
        c.context,
        now,
        now,
      );
      newRows.push({
        id: rid, email: c.email, phone: c.phone, whatsapp: c.whatsapp,
        name: c.name, type: c.type as ContactType, typeLabel: c.typeLabel,
        company: job.company || '', jobRole: job.title || '',
        sourceJobId: job.id, sourceJobUrl: job.url || '', jobCount: 1,
        context: c.context, firstSeen: now, lastSeen: now,
        recruiterName: null, recruiterUrl: null,
      });
    }
  }

  // Recruiter enrichment — Apify actor output. Dedupe by LinkedIn URL,
  // then merge into a name-matching contact, else insert profile-only.
  // Runs AFTER the description loop so its name lookup finds the row the
  // loop just inserted by email/phone and attaches the URL to it instead
  // of creating a second, never-merged row.
  const recruiterName = job.recruiterName ? String(job.recruiterName) : '';
  const recruiterUrl = job.recruiterUrl ? String(job.recruiterUrl) : '';
  if (recruiterName || recruiterUrl) {
    const recFindByUrl = d.prepare('SELECT * FROM hr_contacts WHERE user_id = ? AND recruiter_url = ?');
    const recFindByName = d.prepare('SELECT * FROM hr_contacts WHERE user_id = ? AND lower(name) = lower(?)');
    const recUpdate = d.prepare(`
      UPDATE hr_contacts SET
        job_count = job_count + 1,
        last_seen = ?,
        type = 'recruit',
        type_label = 'Recruiting',
        name = CASE WHEN ? IS NOT NULL THEN ? ELSE name END,
        recruiter_name = COALESCE(?, recruiter_name),
        recruiter_url = COALESCE(?, recruiter_url),
        whatsapp = MAX(whatsapp, 0),
        company = CASE WHEN company = '' THEN ? ELSE company END,
        job_role = CASE WHEN job_role = '' THEN ? ELSE job_role END
      WHERE id = ?
    `);
    const existingRec =
      (recruiterUrl ? recFindByUrl.get(userId, recruiterUrl) : undefined) ||
      (recruiterName ? recFindByName.get(userId, recruiterName) : undefined);
    if (existingRec) {
      recUpdate.run(now, recruiterName || null, recruiterName || null, recruiterName || null, recruiterUrl || null, job.company || '', job.title || '', existingRec.id);
    } else {
      const rid = `hr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insert.run(rid, userId, null, null, 0, recruiterName || null, 'recruit', 'Recruiting', job.company || '', job.title || '', job.id, job.url || '', '', now, now);
      d.prepare('UPDATE hr_contacts SET recruiter_name = ?, recruiter_url = ? WHERE id = ?').run(recruiterName || null, recruiterUrl || null, rid);
      newRows.push({
        id: rid, email: null, phone: null, whatsapp: false,
        name: recruiterName || null, type: 'recruit', typeLabel: 'Recruiting',
        company: job.company || '', jobRole: job.title || '',
        sourceJobId: job.id, sourceJobUrl: job.url || '', jobCount: 1,
        context: '', firstSeen: now, lastSeen: now,
        recruiterName: recruiterName || null, recruiterUrl: recruiterUrl || null,
      });
    }
  }

  return newRows;
}

function mapContactRow(r: any): HrContact {
  return {
    id: r.id,
    email: r.email || null,
    phone: r.phone || null,
    whatsapp: r.whatsapp === 1,
    recruiterName: r.recruiter_name || null,
    recruiterUrl: r.recruiter_url || null,
    name: r.name || null,
    type: r.type,
    typeLabel: r.type_label,
    company: r.company || '',
    jobRole: r.job_role || '',
    sourceJobId: r.source_job_id || '',
    sourceJobUrl: r.source_job_url || '',
    jobCount: r.job_count || 1,
    context: r.context || '',
    firstSeen: r.first_seen || '',
    lastSeen: r.last_seen || '',
    lastEmailSent: r.last_email_sent || undefined,
    emailStatus: r.email_status || undefined,
    emailMessageId: r.email_message_id || undefined,
    notes: r.notes || '',
    followUpAt: r.follow_up_at || undefined,
    followedUp: !!r.followed_up,
    pipelineStatus: r.pipeline_status || undefined,
  };
}

// Record a cold-email send result on a contact (L2 SMTP pipeline).
export function recordContactEmail(id: string, status: 'sent' | 'failed', messageId?: string): void {
  const userId = getCurrentUserId();
  if (!userId || !id) return;
  getDb().prepare(
    `UPDATE hr_contacts SET last_email_sent = ?, email_status = ?, email_message_id = ? WHERE id = ? AND user_id = ?`
  ).run(new Date().toISOString(), status, messageId || null, id, userId);
}

export function getContactById(id: string): HrContact | undefined {
  const userId = getCurrentUserId();
  if (!userId || !id) return undefined;
  try {
    const row = getDb().prepare('SELECT * FROM hr_contacts WHERE id = ? AND user_id = ?').get(id, userId) as any;
    return row ? mapContactRow(row) : undefined;
  } catch (err) {
    console.error('Error loading contact:', err);
    return undefined;
  }
}

export function listContactsForJob(jobId: string, recruiterUrl?: string | null): HrContact[] {
  const userId = getCurrentUserId();
  if (!userId || !jobId) return [];
  try {
    const d = getDb();
    if (recruiterUrl) {
      const rows = d.prepare(
        'SELECT * FROM hr_contacts WHERE user_id = ? AND (source_job_id = ? OR recruiter_url = ?) ORDER BY job_count DESC'
      ).all(userId, jobId, recruiterUrl) as any[];
      return rows.map(mapContactRow);
    }
    const rows = d.prepare(
      'SELECT * FROM hr_contacts WHERE user_id = ? AND source_job_id = ? ORDER BY job_count DESC'
    ).all(userId, jobId) as any[];
    return rows.map(mapContactRow);
  } catch (err) {
    console.error('Error listing contacts for job:', err);
    return [];
  }
}

export function listContacts(opts?: { q?: string; company?: string }): HrContact[] {
  const userId = getCurrentUserId();
  if (!userId) return [];
  try {
    const d = getDb();
    const q = (opts?.q || '').trim().toLowerCase();
    const company = (opts?.company || '').trim();
    let sql = 'SELECT * FROM hr_contacts WHERE user_id = ? AND hidden = 0';
    const params: any[] = [userId];
    if (q) {
      sql += ' AND (lower(email) LIKE ? OR lower(coalesce(name,"")) LIKE ? OR lower(company) LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (company) {
      sql += ' AND company = ?';
      params.push(company);
    }
    sql += ' ORDER BY last_seen DESC';
    const rows = d.prepare(sql).all(...params) as any[];
    return rows.map(mapContactRow);
  } catch (err) {
    console.error('Error listing contacts:', err);
    return [];
  }
}

export function listContactCompanies(): string[] {
  const userId = getCurrentUserId();
  if (!userId) return [];
  try {
    const d = getDb();
    const rows = d.prepare(
      "SELECT DISTINCT company FROM hr_contacts WHERE user_id = ? AND hidden = 0 AND company != '' ORDER BY company"
    ).all(userId) as { company: string }[];
    return rows.map((r) => r.company);
  } catch {
    return [];
  }
}

export function setContactHidden(id: string, hidden: boolean): boolean {
  const userId = getCurrentUserId();
  if (!userId) return false;
  try {
    const d = getDb();
    return d.prepare('UPDATE hr_contacts SET hidden = ? WHERE id = ? AND user_id = ?').run(hidden ? 1 : 0, id, userId).changes > 0;
  } catch {
    return false;
  }
}

export function addContactNote(id: string, note: string): boolean {
  const userId = getCurrentUserId();
  if (!userId || !id) return false;
  return getDb().prepare('UPDATE hr_contacts SET notes = ? WHERE id = ? AND user_id = ?').run(note, id, userId).changes > 0;
}

export function setContactFollowUp(id: string, date: string | null): boolean {
  const userId = getCurrentUserId();
  if (!userId || !id) return false;
  return getDb().prepare('UPDATE hr_contacts SET follow_up_at = ? WHERE id = ? AND user_id = ?').run(date, id, userId).changes > 0;
}

export function setContactFollowedUp(id: string, value: boolean): boolean {
  const userId = getCurrentUserId();
  if (!userId || !id) return false;
  return getDb().prepare('UPDATE hr_contacts SET followed_up = ? WHERE id = ? AND user_id = ?').run(value ? 1 : 0, id, userId).changes > 0;
}

export function setContactPipeline(id: string, status: string | null): boolean {
  const userId = getCurrentUserId();
  if (!userId || !id) return false;
  const valid = ['replied', 'interview', 'offer', 'rejected'];
  const v = status && valid.includes(status) ? status : null;
  return getDb().prepare('UPDATE hr_contacts SET pipeline_status = ? WHERE id = ? AND user_id = ?').run(v, id, userId).changes > 0;
}

export function recordContactEmailDetail(contactId: string, detail: { recipient: string; subject: string; body: string; attachmentName?: string | null; status: 'sent' | 'failed' }): void {
  const userId = getCurrentUserId();
  if (!userId || !contactId) return;
  getDb().prepare(
    `INSERT INTO contact_emails (id, user_id, contact_id, recipient, subject, body, attachment_name, status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), userId, contactId, detail.recipient, detail.subject, detail.body, detail.attachmentName || null, detail.status, new Date().toISOString());
}

export function listContactEmails(contactId: string): ContactEmail[] {
  const userId = getCurrentUserId();
  if (!userId || !contactId) return [];
  const rows = getDb().prepare(
    'SELECT * FROM contact_emails WHERE user_id = ? AND contact_id = ? ORDER BY sent_at DESC'
  ).all(userId, contactId) as any[];
  return rows.map((r) => ({
    id: r.id, recipient: r.recipient, subject: r.subject, body: r.body,
    attachmentName: r.attachment_name || null, status: r.status, sentAt: r.sent_at,
  }));
}

export function getContactStats(): { total: number; withEmail: number; withPhone: number; sent: number; companies: number } {
  const userId = getCurrentUserId();
  if (!userId) return { total: 0, withEmail: 0, withPhone: 0, sent: 0, companies: 0 };
  const d = getDb();
  const one = (sql: string): number => (d.prepare(sql).get(userId) as { n: number }).n || 0;
  return {
    total: one('SELECT count(*) AS n FROM hr_contacts WHERE user_id = ? AND hidden = 0'),
    withEmail: one("SELECT count(*) AS n FROM hr_contacts WHERE user_id = ? AND hidden = 0 AND email IS NOT NULL AND email != ''"),
    withPhone: one("SELECT count(*) AS n FROM hr_contacts WHERE user_id = ? AND hidden = 0 AND phone IS NOT NULL AND phone != ''"),
    sent: one("SELECT count(*) AS n FROM hr_contacts WHERE user_id = ? AND hidden = 0 AND email_status = 'sent'"),
    companies: one("SELECT count(DISTINCT company) AS n FROM hr_contacts WHERE user_id = ? AND hidden = 0 AND company != ''"),
  };
}

export function listContactsCsv(): Array<{ email: string | null; name: string | null; company: string; jobRole: string; phone: string | null; whatsapp: boolean; recruiterUrl: string | null; typeLabel: string; context: string; lastSeen: string }> {
  const userId = getCurrentUserId();
  if (!userId) return [];
  const rows = getDb().prepare(
    'SELECT * FROM hr_contacts WHERE user_id = ? AND hidden = 0 ORDER BY last_seen DESC'
  ).all(userId) as any[];
  return rows.map((r) => ({
    email: r.email || null, name: r.name || r.recruiter_name || null, company: r.company || '',
    jobRole: r.job_role || '', phone: r.phone || null, whatsapp: !!r.whatsapp,
    recruiterUrl: r.recruiter_url || null, typeLabel: r.type_label || '',
    context: r.context || '', lastSeen: r.last_seen || '',
  }));
}

export function backfillContacts(): number {
  const userId = getCurrentUserId();
  if (!userId) return 0;
  let count = 0;
  for (const job of getJobsForUser(userId)) {
    const before = listContacts().length;
    upsertContactsFromJob(job);
    count += listContacts().length - before;
  }
  return count;
}

export function getJobById(id: string): Job | undefined {
  const userId = getCurrentUserId();
  if (!userId) return undefined;
  try {
    const d = getDb();
    const row = d.prepare('SELECT data FROM jobs WHERE id = ? AND user_id = ?').get(id, userId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  } catch {
    return undefined;
  }
}

export function updateJobInStorage(updatedJob: Job): Job {
  const userId = getCurrentUserId();
  try {
    const d = getDb();
    const result = d.prepare('UPDATE jobs SET data = ? WHERE id = ? AND user_id = ?').run(
      JSON.stringify({ ...updatedJob, updatedAt: new Date().toISOString() }),
      updatedJob.id,
      userId
    );
    if (result.changes > 0) return { ...updatedJob, updatedAt: new Date().toISOString() };
    return updatedJob;
  } catch (err) {
    console.error('Error updating job:', err);
    return updatedJob;
  }
}

export function deleteJobFromStorage(id: string): boolean {
  const userId = getCurrentUserId();
  try {
    const d = getDb();
    return d.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  } catch {
    return false;
  }
}

export function deleteAllJobs(): number {
  const userId = getCurrentUserId();
  try {
    const d = getDb();
    const result = d.prepare('DELETE FROM jobs WHERE user_id = ?').run(userId);
    return result.changes;
  } catch {
    return 0;
  }
}

export function queryJobs(params: JobFilterQueryParams) {
  let jobs = getAllJobs();

  // Default view: hide jobs removed from their source board. State tabs
  // (applied/tailored/ready/pending) still show them — history survives.
  if (!params.state || params.state === 'all') {
    jobs = jobs.filter((j) => j.isActive !== false);
  }

  // Search-context isolation: when jobIds are supplied (resolved from a
  // searchId by the caller), scope to only those jobs. Absent → current
  // behavior (all stored jobs).
  if (params.jobIds) {
    const ids = new Set(params.jobIds);
    jobs = jobs.filter((j) => ids.has(j.id));
  }

  // State filter
  if (params.state && params.state !== 'all') {
    jobs = jobs.filter((j) => j.state === params.state);
  }

  // Source filter
  if (params.source && params.source !== 'all') {
    jobs = jobs.filter((j) => j.source === params.source);
  }

  // Search keyword in title, company, description, or location
  if (params.search && params.search.trim()) {
    const q = params.search.toLowerCase().trim();
    jobs = jobs.filter(
      (j) =>
        j.title.toLowerCase().includes(q) ||
        j.company.toLowerCase().includes(q) ||
        j.location.toLowerCase().includes(q) ||
        j.description.toLowerCase().includes(q)
    );
  }

  // Work-mode filter: EXACT match only — a remote search shows only
  // remote-classified jobs; unknowns are excluded (never assumed).
  if (params.jobType && params.jobType !== 'all') {
    const wanted = params.jobType;
    jobs = jobs.filter((j) => classifyWorkMode(j) === wanted);
  }

  // Location filter (exact substring against the job's location field).
  // "remote"/"anywhere"/"worldwide" as location = no constraint.
  if (params.location && params.location.trim()) {
    const q = params.location.trim().toLowerCase();
    if (!/^(remote|anywhere|worldwide|open to remote)$/.test(q)) {
      jobs = jobs.filter((j) => j.location.toLowerCase().includes(q));
    }
  }

  // Date posted window (24h / 7d / 30d). Date-only values are treated as
  // end-of-day so a job posted "yesterday" still counts within 24h.
  // Malformed dates (doubled timestamps) are repaired via the YYYY-MM-DD
  // prefix; unparseable jobs are excluded from the window.
  if (params.datePostedFilter && params.datePostedFilter !== 'all') {
    const hours = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }[params.datePostedFilter];
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    jobs = jobs.filter((j) => {
      let t = j.postedDateParsed ? new Date(`${String(j.postedDateParsed).slice(0, 10)}T23:59:59Z`).getTime() : NaN;
      if (!Number.isFinite(t)) {
        const m = String(j.postedDate || '').match(/^(\d{4}-\d{2}-\d{2})/);
        t = m ? new Date(`${m[1]}T23:59:59Z`).getTime() : NaN;
      }
      if (!Number.isFinite(t)) t = new Date(j.postedDate).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }

  // Under-10 applicants: the low-competition flag is the authoritative
  // signal; a known count without the flag must be <= 10.
  if (params.under10Applicants) {
    jobs = jobs.filter((j) =>
      j.lowCompetition === true || (j.applicantCount !== undefined && j.applicantCount <= 10)
    );
  }

  // Min/Max Match score filter
  if (params.minScore !== undefined) {
    jobs = jobs.filter((j) => j.matchScore !== undefined && j.matchScore >= params.minScore!);
  }
  if (params.maxScore !== undefined) {
    jobs = jobs.filter((j) => j.matchScore !== undefined && j.matchScore <= params.maxScore!);
  }

  // Sorting
  const sortBy = params.sortBy || 'createdAt';
  const sortOrder = params.sortOrder || 'desc';

  jobs.sort((a, b) => {
    let valA: any = a[sortBy as keyof Job];
    let valB: any = b[sortBy as keyof Job];

    if (sortBy === 'matchScore') {
      valA = a.matchScore ?? -1;
      valB = b.matchScore ?? -1;
    }

    if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
    if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  const page = params.page && params.page > 0 ? params.page : 1;
  const limit = params.limit && params.limit > 0 ? params.limit : 20;
  const total = jobs.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const paginatedJobs = jobs.slice((page - 1) * limit, page * limit);

  return {
    jobs: paginatedJobs,
    total,
    page,
    limit,
    totalPages
  };
}

// Explicit export between SQLite and JSON
export function runStorageMigration(targetMode: 'sqlite' | 'json'): { success: boolean; message: string; count: number } {
  ensureDataDir();
  const currentJobs = getAllJobs();
  if (targetMode === 'sqlite') {
    return { success: true, message: `SQLite is already the primary store (${currentJobs.length} jobs).`, count: currentJobs.length };
  } else {
    const data = JSON.stringify(currentJobs, null, 2);
    fs.writeFileSync(JSON_FILE_PATH, data, 'utf-8');
    return { success: true, message: `Successfully backed up ${currentJobs.length} jobs to JSON file storage.`, count: currentJobs.length };
  }
}

// ─────────────────── Manual JD History ───────────────────
export interface ManualAnalysisRecord {
  id: string;
  role: string;
  company: string;
  description: string;
  score: number;
  gapAnalysis: any;
  diff: any | null;
  tailoredCv: any | null;
  createdAt: string;
}

export function saveManualAnalysis(record: Omit<ManualAnalysisRecord, 'id' | 'createdAt'> & { id?: string }): ManualAnalysisRecord {
  const userId = getCurrentUserId();
  const id = record.id || `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();
  getDb().prepare(`
    INSERT OR REPLACE INTO manual_analysis (id, user_id, role, company, description, score, gap_analysis, diff, tailored_cv, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    record.role,
    record.company,
    record.description,
    record.score,
    JSON.stringify(record.gapAnalysis ?? null),
    JSON.stringify(record.diff ?? null),
    JSON.stringify(record.tailoredCv ?? null),
    createdAt
  );
  return { ...record, id, createdAt };
}

export function listManualAnalyses(): { id: string; role: string; company: string; score: number; createdAt: string; hasTailoredCv: boolean }[] {
  const userId = getCurrentUserId();
  try {
    const rows = getDb()
      .prepare('SELECT id, role, company, score, tailored_cv, created_at FROM manual_analysis WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as any[];
    return rows.map((r) => ({
      id: r.id,
      role: r.role || '',
      company: r.company || '',
      score: r.score ?? 0,
      createdAt: r.created_at || '',
      hasTailoredCv: !!(r.tailored_cv && r.tailored_cv !== 'null'),
    }));
  } catch { return []; }
}

export function getManualAnalysis(id: string): ManualAnalysisRecord | undefined {
  const userId = getCurrentUserId();
  try {
    const r = getDb()
      .prepare('SELECT * FROM manual_analysis WHERE id = ? AND user_id = ?')
      .get(id, userId) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      role: r.role || '',
      company: r.company || '',
      description: r.description || '',
      score: r.score ?? 0,
      gapAnalysis: r.gap_analysis ? JSON.parse(r.gap_analysis) : undefined,
      diff: r.diff ? JSON.parse(r.diff) : null,
      tailoredCv: r.tailored_cv ? JSON.parse(r.tailored_cv) : null,
      createdAt: r.created_at || '',
    };
  } catch { return undefined; }
}

export function deleteManualAnalysis(id: string): boolean {
  const userId = getCurrentUserId();
  try {
    return getDb().prepare('DELETE FROM manual_analysis WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  } catch { return false; }
}

// ─────────────────── CV Versions (backups) ───────────────────
export function saveCvVersion(data: MasterCv, note: string, pages?: number): void {
  const userId = getCurrentUserId();
  const id = `cvver-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    getDb().prepare(`
      INSERT INTO cv_versions (id, user_id, data, note, pages, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, JSON.stringify(data), note, pages ?? 0, new Date().toISOString());
  } catch { /* ignore */ }
}

export function listCvVersions(): { id: string; note: string; pages: number; createdAt: string }[] {
  const userId = getCurrentUserId();
  try {
    return (getDb()
      .prepare('SELECT id, note, pages, created_at FROM cv_versions WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as any[]).map((r) => ({ id: r.id, note: r.note || '', pages: r.pages ?? 0, createdAt: r.created_at || '' }));
  } catch { return []; }
}

export function getCvVersion(id: string): { data: MasterCv; note: string } | undefined {
  const userId = getCurrentUserId();
  try {
    const r = getDb().prepare('SELECT data, note FROM cv_versions WHERE id = ? AND user_id = ?').get(id, userId) as any;
    if (!r) return undefined;
    return { data: JSON.parse(r.data), note: r.note || '' };
  } catch { return undefined; }
}

export function deleteCvVersion(id: string): boolean {
  const userId = getCurrentUserId();
  try {
    return getDb().prepare('DELETE FROM cv_versions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  } catch { return false; }
}

// ─────────────────── Job Portal Bookmarks ───────────────────
export function listPortalBookmarks(): string[] {
  const userId = getCurrentUserId();
  try {
    const rows = getDb().prepare('SELECT portal_name FROM portal_bookmarks WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[];
    return rows.map((r) => r.portal_name);
  } catch { return []; }
}

export function addPortalBookmark(portalName: string): boolean {
  const userId = getCurrentUserId();
  if (!userId) return false;
  try {
    getDb().prepare('INSERT OR IGNORE INTO portal_bookmarks (user_id, portal_name, created_at) VALUES (?, ?, ?)')
      .run(userId, portalName, new Date().toISOString());
    return true;
  } catch { return false; }
}

export function removePortalBookmark(portalName: string): boolean {
  const userId = getCurrentUserId();
  if (!userId) return false;
  try {
    return getDb().prepare('DELETE FROM portal_bookmarks WHERE user_id = ? AND portal_name = ?').run(userId, portalName).changes > 0;
  } catch { return false; }
}

// ─────────────────── Work-Type Data Fix (idempotent) ───────────────────
// The old LinkedIn scraper defaulted every job to "Full-time · Remote",
// so hybrid/on-site/unspecified jobs were mislabeled. Re-derive the label
// from the stored description using the same rules the scraper now uses;
// jobs with no work-mode hints keep their current label (never invented).
// Runs once at server boot; safe to re-run.
export function fixMislabeledWorkTypes(): number {
  let fixed = 0;
  try {
    const d = getDb();
    const users = d.prepare('SELECT DISTINCT user_id FROM jobs').all() as { user_id: string }[];
    for (const u of users) {
      const rows = d.prepare('SELECT data FROM jobs WHERE user_id = ?').all(u.user_id) as { data: string }[];
      for (const r of rows) {
        let j: Job;
        try { j = JSON.parse(r.data); } catch { continue; }
        if (j.source !== 'LinkedIn') continue;
        // Labels verified from the Apify actor's structured work_type field
        // are authoritative — never re-derived from description text.
        if ((j as any).workModeVerified) continue;
        const detectedMode = classifyFromText(j.description);
        let next: string | null = detectedMode ? `Full-time · ${detectedMode}` : null;
        if (next === null && j.jobType !== 'Full-time') next = 'Full-time'; // null / old buggy Remote → not stated
        if (next !== null && next !== j.jobType) {
          j.jobType = next;
          d.prepare('UPDATE jobs SET data = ? WHERE user_id = ? AND id = ?').run(JSON.stringify(j), u.user_id, j.id);
          fixed++;
        }
      }
    }
  } catch (err) {
    console.error('fixMislabeledWorkTypes error:', err);
  }
  return fixed;
}

// ─────────────────── Date Repair (idempotent) ───────────────────
// Some scraped jobs stored malformed dates (doubled timestamps like
// "2026-08-07T00:00:00.000ZT00:00:00.000Z"), breaking time-ago display
// ("Recently") and date-window filters. Normalize YYYY-MM-DD extraction.
export function repairJobDates(): number {
  let fixed = 0;
  try {
    const d = getDb();
    const users = d.prepare('SELECT DISTINCT user_id FROM jobs').all() as { user_id: string }[];
    for (const u of users) {
      const rows = d.prepare('SELECT data FROM jobs WHERE user_id = ?').all(u.user_id) as { data: string }[];
      for (const r of rows) {
        let j: Job;
        try { j = JSON.parse(r.data); } catch { continue; }
        const pd = String(j.postedDate || '');
        const pdp = String(j.postedDateParsed || '');
        const m = pd.match(/^(\d{4}-\d{2}-\d{2})/);
        const mPdp = pdp.slice(0, 10).match(/^\d{4}-\d{2}-\d{2}/);
        let day = m ? m[1] : (mPdp ? mPdp[1] : null);
        if (!day) {
          // Garbage date (e.g. "+058544-12-15..." from a ms/seconds bug):
          // fall back to the scrape date so the job shows a real age.
          const cm = String(j.createdAt || '').match(/^(\d{4}-\d{2}-\d{2})/);
          if (cm) day = cm[1];
        }
        if (!day) continue;
        const cm2 = String(j.createdAt || '').match(/^(\d{4}-\d{2}-\d{2})/);
        const isGarbage = !m && !mPdp;
        // Jobs repaired to the noon marker from a previous run have no real
        // post time — show the scrape time instead of a future date.
        const noonMarker = `${day}T12:00:00.000Z`;
        const endOfDayMarker = `${day}T23:59:59.000Z`;
        const isNoonRepair = pd === noonMarker || pd === endOfDayMarker;
        const newPosted = (isGarbage || isNoonRepair) && cm2
          ? String(j.createdAt)
          : noonMarker;
        // Never leave a FUTURE date on a stored job (timezone-ambiguous
        // scrapes) — clamp to the scrape time.
        let finalPosted = newPosted;
        const asTime = new Date(finalPosted).getTime();
        if (!isNaN(asTime) && asTime > Date.now() + 2 * 60 * 60 * 1000 && cm2) {
          finalPosted = String(j.createdAt);
        }
        const newParsed = day;
        if (pd !== finalPosted || pdp.slice(0, 10) !== newParsed) {
          j.postedDate = newPosted;
          j.postedDateParsed = newParsed;
          d.prepare('UPDATE jobs SET data = ? WHERE user_id = ? AND id = ?').run(JSON.stringify(j), u.user_id, j.id);
          fixed++;
        }
      }
    }
  } catch (err) {
    console.error('repairJobDates error:', err);
  }
  return fixed;
}
