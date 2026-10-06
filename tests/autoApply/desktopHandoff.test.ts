// Chrome → Tailor Browser handoff (Phase 28): runtime token security +
// pure state mapping + static guarantees for the no-redirect contract.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import {
  createHandoffToken,
  claimHandoffToken,
  createExecution,
  postExecutionStatus,
  getExecutionForAttempt,
  getActiveExecutionForUser,
  getExecutionByStatusToken,
  markDesktopSubmitting,
  confirmDesktopSubmit,
  supersedeOtherBootExecutions,
  getActiveExecutionsForUser as getActiveExecs,
} from '../../server/autoApply/desktopHandoff.js';
import { getReceiptByAttempt, saveSubmissionReceipt } from '../../server/autoApply/submissionStore.js';
import { mapDesktopStateToRow, interpretHealth, DESKTOP_BRIDGE_BASE } from '../../src/lib/browserExecutionTransport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const require = createRequire(import.meta.url);

const button = read('src/components/AutoApplyButton.tsx');
const bridgeSrc = read('desktop/main/desktopBridge.cjs');
const mainSrc = read('desktop/main/main.cjs');
const serverSrc = read('server.ts');

function freshDb(): Database.Database {
  return new Database(':memory:');
}
const mint = (db: Database.Database, userId: string, jobId: string) =>
  createHandoffToken(db, userId, jobId, {
    getJobByIdFn: (id) => (id === 'job-1' ? { id: 'job-1', userId: 'u1' } : undefined),
  });
const codeOf = (r: unknown): string => String((r as { code?: string } | null)?.code || '');

describe('Handoff token security (Phase 5/24)', () => {
  it('8/12. creation is job-bound: only the owner can mint a token for their job', () => {
    const db = freshDb();
    expect(mint(db, 'u1', 'job-1')).toBeTruthy();
    expect(mint(db, 'u2', 'job-1')).toBeNull(); // cross-account refused
    expect(mint(db, 'u1', 'nope')).toBeNull();
  });

  it('11. claim returns the token-user binding (no cross-account execution)', () => {
    const db = freshDb();
    const t = mint(db, 'u1', 'job-1')!;
    const r = claimHandoffToken(db, t.token, 'job-1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claim.userId).toBe('u1');
  });

  it('10. replay is rejected (single-use CAS)', () => {
    const db = freshDb();
    const t = mint(db, 'u1', 'job-1')!;
    expect(claimHandoffToken(db, t.token, 'job-1').ok).toBe(true);
    const again = claimHandoffToken(db, t.token, 'job-1');
    expect(again.ok).toBe(false);
    expect(codeOf(again)).toBe('ALREADY_CLAIMED');
  });

  it('9. expiry is enforced (120s TTL)', () => {
    const db = freshDb();
    const t = mint(db, 'u1', 'job-1')!;
    db.prepare(`UPDATE desktop_handoff_tokens SET expires_at = ? WHERE token = ?`).run(new Date(Date.now() - 1000).toISOString(), t.token);
    const r = claimHandoffToken(db, t.token, 'job-1');
    expect(r.ok).toBe(false);
    expect(codeOf(r)).toBe('TOKEN_EXPIRED');
  });

  it('token is job-bound at claim time too (JOB_MISMATCH)', () => {
    const db = freshDb();
    const t = mint(db, 'u1', 'job-1')!;
    const r = claimHandoffToken(db, t.token, 'other-job');
    expect(r.ok).toBe(false);
    expect(codeOf(r)).toBe('JOB_MISMATCH');
  });

  it('unknown tokens are refused', () => {
    const db = freshDb();
    expect(claimHandoffToken(db, 'ffffffffffffffffffffffffffffffff', 'job-1').ok).toBe(false);
  });
});

describe('Desktop execution status (Phase 12/25)', () => {
  it('status intake requires the execution token and a known state', () => {
    const db = freshDb();
    const { statusToken } = createExecution(db, 'u1', 'job-1', 'att-1');
    expect(postExecutionStatus(db, 'wrong-token', 'FILLING', 'FIELDS_FILLED').ok).toBe(false);
    expect(postExecutionStatus(db, statusToken, 'NOT_A_STATE', 'x').code).toBe('BAD_STATE');
    expect(postExecutionStatus(db, statusToken, 'FILLING', 'FIELDS_FILLED').ok).toBe(true);
  });

  it('status is user-scoped and readable by attemptId (Chrome polls this)', () => {
    const db = freshDb();
    const { statusToken } = createExecution(db, 'u1', 'job-1', 'att-1');
    postExecutionStatus(db, statusToken, 'READY_FOR_REVIEW', 'READY_FOR_REVIEW');
    const exec = getExecutionForAttempt(db, 'u1', 'att-1');
    expect(exec?.state).toBe('READY_FOR_REVIEW');
    expect(getExecutionForAttempt(db, 'u2', 'att-1')).toBeNull();
  });

  it('busy detection: active + fresh executions only; completed ones free the slot', () => {
    const db = freshDb();
    const { statusToken } = createExecution(db, 'u1', 'job-1', 'att-1');
    expect(getActiveExecutionForUser(db, 'u1')?.attemptId).toBe('att-1');
    postExecutionStatus(db, statusToken, 'READY_FOR_REVIEW', 'done');
    expect(getActiveExecutionForUser(db, 'u1')).toBeNull();
    expect(getExecutionByStatusToken(db, statusToken)?.jobId).toBe('job-1');
  });
});

describe('Chrome row state mapping (pure)', () => {
  it('maps every desktop execution state to a row state; unknown states are ignored', () => {
    expect(mapDesktopStateToRow('DESKTOP_STARTING')?.message).toBe('Starting Tailor Browser…');
    expect(mapDesktopStateToRow('NAVIGATING')?.message).toBe('Opening application…');
    expect(mapDesktopStateToRow('FILLING')?.state).toBe('FILLING');
    expect(mapDesktopStateToRow('WAITING_FOR_USER')).toMatchObject({ state: 'USER_ACTION_REQUIRED', message: 'Action required in Tailor Browser', terminal: false });
    expect(mapDesktopStateToRow('READY_FOR_REVIEW')).toMatchObject({ state: 'READY_FOR_REVIEW', terminal: true });
    expect(mapDesktopStateToRow('FAILED')?.state).toBe('NEEDS_REVIEW');
    expect(mapDesktopStateToRow('SUBMITTED_VERIFIED')?.state).toBe('APPLIED');
    expect(mapDesktopStateToRow('WHATEVER')).toBeNull();
  });
});

describe('No-redirect contract (Phases 6/22/29)', () => {
  it('1/2/3. AA contains no Chrome navigation or tab opening anywhere', () => {
    expect(button).not.toMatch(/window\.open\(/);
    expect(button).not.toContain('tab.location.href');
    expect(button).not.toContain('location.href =');
    expect(button).not.toContain('target="_blank"');
    expect(button).not.toContain('Open application');
  });

  it('7/16/17. no silent extension fallback: companion paths removed from AA', () => {
    expect(button).not.toContain('assistBrowserCompanion');
    expect(button).not.toContain('ensureCompanionConnected');
    expect(button).not.toContain("fetch('/api/auto-apply/fill/start'");
  });

  it('handoff order: health → launch → token → bridge start → status polling', () => {
    const health = button.indexOf('await desktopHealth()');
    const launch = button.indexOf('launchTailorBrowser()');
    const token = button.indexOf('createDesktopHandoff(job.id)');
    const start = button.indexOf('startDesktopExecution(job.id');
    const poll = button.indexOf('startDesktopStatusPolling(started.attemptId)');
    expect(health).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(health);
    expect(token).toBeGreaterThan(launch);
    expect(start).toBeGreaterThan(token);
    expect(poll).toBeGreaterThan(start);
  });

  it('6/27. desktop unavailable → one explicit launch action, never an ATS tab', () => {
    expect(button).toContain("setMessage('Tailor Browser is not running.')");
    expect(button).toContain('Launch Tailor Browser');
    expect(button).not.toContain('Try again');
    expect(button).toContain('launchTailorBrowser()');
  });

  it('25. BUSY → no overwrite: explicit actions only', () => {
    expect(button).toContain("setMessage('Queued — waiting for a free slot…')");
    expect(button).toContain('retryToken.executionToken');
    expect(button).toContain('stopDesktopExecution(currentExecution.executionId)');
  });

  it('13/20. Eye focuses Tailor Browser in Chrome mode (never navigates)', () => {
    expect(button).toContain('handleAttentionClick');
    expect(button).toContain('focusTailorBrowser(');
  });

  it('27. submission executes in Tailor Browser only — Chrome triggers via the bridge, never page DOM', () => {
    expect(button).toContain('Submit Application');
    expect(button).toContain('submitDesktopExecution(currentExecution.executionId)');
    expect(button).not.toContain('requestControlledSubmit'); // extension-era submit path stays gone
    expect(button).not.toMatch(/form\.submit\(|requestSubmit|SubmitEvent/);
  });
});

describe('Desktop bridge security (Phase 4/13)', () => {
  it('13. loopback-only bind, origin allowlist, validated payloads', () => {
    expect(bridgeSrc).toContain("server.listen(port, '127.0.0.1')");
    expect(bridgeSrc).not.toContain('0.0.0.0');
    expect(bridgeSrc).toContain("'http://localhost:3000'");
    expect(bridgeSrc).toContain("'http://127.0.0.1:3000'");
    expect(bridgeSrc).toContain('TOKEN_RE');
    expect(bridgeSrc).toContain('JOB_ID_RE');
  });

  it('14/19. the job/plan comes from the backend — the page never supplies URLs or data', () => {
    expect(bridgeSrc).toContain('/api/auto-apply/desktop-handoff/claim');
    expect(bridgeSrc).toContain('data.plan');
    expect(bridgeSrc).not.toContain('body.url');
    expect(bridgeSrc).not.toMatch(/executeJavaScript|eval\(/);
  });

  it('handoff endpoints exist: health/start/focus/stop; BUSY answered explicitly', () => {
    expect(bridgeSrc).toContain("'/health'");
    expect(bridgeSrc).toContain("'/auto-apply/start'");
    expect(bridgeSrc).toContain("'/auto-apply/focus'");
    expect(bridgeSrc).toContain("'/auto-apply/stop'");
    expect(bridgeSrc).toContain('claim.status === 409'); // server limit status passed through verbatim
    expect(read('server.ts')).toContain("error: 'BUSY', limit, current: actives"); // limit enforced server-side
  });

  it('mapEventToState is pure and covers pause/ready/fail', () => {
    const { mapEventToState } = require('../../desktop/main/desktopBridge.cjs');
    expect(mapEventToState({ type: 'HUMAN_ACTION_REQUIRED' })).toBe('WAITING_FOR_USER');
    expect(mapEventToState({ type: 'READY_FOR_REVIEW' })).toBe('READY_FOR_REVIEW');
    expect(mapEventToState({ type: 'STATE', detail: 'NAVIGATING' })).toBe('NAVIGATING');
    expect(mapEventToState({ type: 'RUN_FAILED' })).toBe('FAILED');
    expect(mapEventToState({ type: 'NOTHING' })).toBeNull();
  });

  it('10/23. protocol is launch-only; bridge starts on launch and closes on exit', () => {
    expect(mainSrc).toContain("app.setAsDefaultProtocolClient('tailor-ai')");
    expect(mainSrc).toContain("app.on('open-url'");
    const openUrl = mainSrc.slice(mainSrc.indexOf("app.on('open-url'"), mainSrc.indexOf("app.on('second-instance'"));
    expect(openUrl).not.toContain('runFill');
    expect(mainSrc).toContain('createDesktopBridge');
    expect(mainSrc).toContain("app.on('will-quit'");
  });

  it('server: loopback-only claim/status/resume + single-use SQL + authed status poll', () => {
    expect(serverSrc).toContain("'/api/auto-apply/desktop-handoff'");
    expect(serverSrc).toContain("'/api/auto-apply/desktop-handoff/claim'");
    expect(serverSrc).toContain("'/api/auto-apply/desktop-execution/status'");
    expect(serverSrc).toContain("'/api/auto-apply/desktop-execution/resume'");
    expect(serverSrc).toContain("'/api/auto-apply/desktop-execution/:attemptId/status'");
    const claimBlock = serverSrc.slice(serverSrc.indexOf("'/api/auto-apply/desktop-handoff/claim'"), serverSrc.indexOf("'/api/auto-apply/desktop-execution/status'"));
    expect(claimBlock).toContain('assertLoopbackHost');
    expect(claimBlock).not.toContain('window');
  });

  it('bridge base URL is the fixed loopback port', () => {
    expect(DESKTOP_BRIDGE_BASE).toBe('http://127.0.0.1:45451');
  });
});

describe('Health identity (Phase 17/18)', () => {
  it('only the real Tailor Browser identity is accepted', () => {
    expect(interpretHealth({ available: true, app: 'tailor-browser', bootId: 'b1' }, true)).toEqual({ available: true, bootId: 'b1' });
    expect(interpretHealth({ available: true, app: 'something-else' }, true)).toEqual({ available: false, appMismatch: true });
    expect(interpretHealth({ available: true }, true)).toEqual({ available: false, appMismatch: true });
    expect(interpretHealth(null, false)).toEqual({ available: false });
    expect(interpretHealth({ available: false }, true)).toEqual({ available: false });
  });
});

describe('Explicit desktop submission — server-authorized, exactly once', () => {
  const nowIso = () => new Date().toISOString();
  const seed = (db: Database.Database) => {
    const { statusToken } = createExecution(db, 'u1', 'job-1', 'att-sub-1');
    return statusToken;
  };

  it('mark-submitting is a single-use CAS — a second authorization is refused', () => {
    const db = freshDb();
    const t = seed(db);
    expect(markDesktopSubmitting(db, t).ok).toBe(true);
    const again = markDesktopSubmitting(db, t);
    expect(again.ok).toBe(false);
    expect(String(again.code)).toBe('SUBMIT_ALREADY_MARKED');
  });

  it('a verified receipt blocks any further submission (duplicate protection)', () => {
    const db = freshDb();
    const t = seed(db);
    saveSubmissionReceipt(db, {
      id: 'r-pre', attemptId: 'att-sub-1', userId: 'u1', jobId: 'job-1', provider: 'lever', postingId: 'p1',
      submittedAt: nowIso(), confirmationType: 'SUCCESS_MESSAGE', confirmationFingerprint: 'abcdef12',
      resumeHash: '', submissionVerified: true, createdAt: nowIso(),
    });
    const r = markDesktopSubmitting(db, t);
    expect(r.ok).toBe(false);
    expect(String(r.code)).toBe('ALREADY_SUBMITTED');
  });

  it('confirmation creates the receipt, marks the job Applied, and is idempotent', () => {
    const db = freshDb();
    const t = seed(db);
    expect(markDesktopSubmitting(db, t).ok).toBe(true);
    const applied: unknown[] = [];
    const c1 = confirmDesktopSubmit(db, t, { confirmationType: 'SUCCESS_MESSAGE' }, {
      getJobFn: () => ({ id: 'job-1', state: 'ready' }),
      updateJobFn: (job) => { applied.push(job); return job; },
    });
    expect(c1.ok).toBe(true);
    expect(c1.jobApplied).toBe(true);
    expect(applied).toHaveLength(1);
    expect(getReceiptByAttempt(db, 'att-sub-1')?.submissionVerified).toBe(true);

    // Idempotent: a repeat confirmation never duplicates the receipt or re-applies the job.
    const c2 = confirmDesktopSubmit(db, t, {}, {});
    expect(c2.ok).toBe(true);
    expect(c2.duplicate).toBe(true);
    expect(applied).toHaveLength(1);
  });

  it('submitted execution state is terminal SUBMITTED_VERIFIED (Chrome shows Applied)', () => {
    const db = freshDb();
    const t = seed(db);
    markDesktopSubmitting(db, t);
    confirmDesktopSubmit(db, t, {}, { getJobFn: () => undefined, updateJobFn: (j) => j });
    expect(getExecutionByStatusToken(db, t)?.state).toBe('SUBMITTED_VERIFIED');
  });

  it('job → Applied default path runs in the execution owner context (bridge has no web session)', () => {
    const src = read('server/autoApply/desktopHandoff.ts');
    expect(src).toContain('runWithUser(userId, apply)');
    expect(src).toContain("transitionAttempt(db, userId, attemptId, 'SUBMISSION_OBSERVED')");
  });
});

describe('Parallel orchestrator — concurrency limit + pre-authorization', () => {
  it('max concurrency is clamped to the hard maximum of 5 (default 3)', async () => {
    const { maxConcurrencyFromEnv } = await import('../../server/autoApply/desktopHandoff.js');
    expect(maxConcurrencyFromEnv({ AUTO_APPLY_MAX_CONCURRENCY: '9' })).toBe(5);
    expect(maxConcurrencyFromEnv({ AUTO_APPLY_MAX_CONCURRENCY: '2' })).toBe(2);
    expect(maxConcurrencyFromEnv({})).toBe(3);
    expect(maxConcurrencyFromEnv({ AUTO_APPLY_MAX_CONCURRENCY: 'nope' })).toBe(3);
  });

  it('multiple active executions are tracked independently per user', async () => {
    const { getActiveExecutionsForUser, createExecution } = await import('../../server/autoApply/desktopHandoff.js');
    const db = freshDb();
    createExecution(db, 'u1', 'job-1', 'att-1');
    createExecution(db, 'u1', 'job-2', 'att-2');
    createExecution(db, 'u2', 'job-3', 'att-3');
    expect(getActiveExecutionsForUser(db, 'u1')).toHaveLength(2);
    expect(getActiveExecutionsForUser(db, 'u2')).toHaveLength(1);
  });

  it('server claim enforces the limit and passes preAuthorizedSubmit', () => {
    const serverS = read('server.ts');
    expect(serverS).toContain('maxConcurrencyFromEnv()');
    expect(serverS).toContain("error: 'BUSY', limit, current: actives");
    expect(serverS).toContain('preAuthorizedSubmit,');
  });

  it('desktop auto-submits ONLY when pre-authorized, through the same authorized chain', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    expect(bridge).toContain("state === 'READY_FOR_REVIEW' && entry.preAuthorizedSubmit && !entry.autoSubmitted");
    expect(bridge).toContain('async function runSubmit(executionId)');
    expect(bridge).toContain('mark-submitting');
  });

  it('orchestrator flags are configured (Lever only)', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toContain('AUTO_APPLY_ORCHESTRATOR_ENABLED=true');
    expect(compose).toContain('AUTO_APPLY_MAX_CONCURRENCY=5');
    expect(compose).toContain('AUTO_APPLY_BACKGROUND_EXECUTION=true');
  });
});

describe('Boot-bound crash recovery (no zombie BUSY)', () => {
  it('a new app boot supersedes executions from older boots', async () => {
    const db = freshDb();
    createExecution(db, 'u1', 'job-1', 'att-1', 'bootA');
    const b = createExecution(db, 'u1', 'job-2', 'att-2', 'bootB');
    const n = supersedeOtherBootExecutions(db, 'u1', 'bootB');
    expect(n).toBe(1);
    const actives = getActiveExecs(db, 'u1');
    expect(actives.map((x) => x.executionId)).toEqual([b.executionId]);
    expect(supersedeOtherBootExecutions(db, 'u1', '')).toBe(0); // never without a boot id
  });
});
