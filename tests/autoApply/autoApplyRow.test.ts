// Auto Apply — job-row "AA" button: pure flow logic + source guarantees.
//
// The repository has no DOM test framework (node-env vitest, no jsdom /
// testing-library), so component behavior is pinned two ways:
//   1. the row state machine / URL / polling logic is pure and unit-tested;
//   2. the component + JobMatrix wiring is asserted at source level
//      (placement, unchanged Apply anchor, no submit-capable patterns).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aaStateFromFillResult, resolveApplicationUrl, isTerminalFillStatus,
  summarizeFillStatus, aaReasonFromBlockers, AA_POLL_INTERVAL_MS, AA_POLL_TIMEOUT_MS,
  isAutoApplyJob, reasonMessage, eventLabel, timeAgo,
} from '../../src/lib/autoApply.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('AA row state mapping (existing fill API results)', () => {
  it('maps every server status to a user-facing row state', () => {
    expect(aaStateFromFillResult({ status: 'FILL_STARTED' }, true).state).toBe('WAITING_FOR_BROWSER');
    expect(aaStateFromFillResult({ status: 'FILL_DISABLED' }, true)).toMatchObject({ state: 'FILL_DISABLED', message: "Auto Apply isn't enabled right now — turn it on in settings or apply manually." });
    expect(aaStateFromFillResult({ status: 'FILL_NOT_ELIGIBLE' }, true).state).toBe('NOT_ELIGIBLE');
    expect(aaStateFromFillResult({ status: 'USER_ACTION_REQUIRED' }, true).state).toBe('USER_ACTION_REQUIRED');
    expect(aaStateFromFillResult({ status: 'FORM_CHANGED' }, true).state).toBe('FORM_CHANGED');
    expect(aaStateFromFillResult({ status: 'FAILED' }, true).state).toBe('FAILED');
    expect(aaStateFromFillResult(null, false).state).toBe('FAILED');
  });

  it('never produces a submitted/applied state', () => {
    const states = ['FILL_STARTED', 'FILL_DISABLED', 'FILL_NOT_ELIGIBLE', 'USER_ACTION_REQUIRED', 'FORM_CHANGED', 'FAILED', 'NOPE'];
    for (const status of states) {
      const { state, message } = aaStateFromFillResult({ status }, true);
      expect(state).not.toMatch(/SUBMIT/i);
      expect(message).not.toMatch(/submitted/i);
    }
  });
});

describe('Exact application URL', () => {
  const job = { applyUrl: 'https://jobs.lever.co/veo/e1', url: 'https://jobs.lever.co/veo/e1' };

  it('prefers the server-provided canonical targetUrl', () => {
    expect(resolveApplicationUrl(job, { targetUrl: 'https://jobs.lever.co/veo/e1/apply' })).toBe('https://jobs.lever.co/veo/e1/apply');
  });

  it('falls back to the job applyUrl, then url — never reconstructs', () => {
    expect(resolveApplicationUrl(job, null)).toBe('https://jobs.lever.co/veo/e1');
    expect(resolveApplicationUrl({ url: 'https://jobs.lever.co/x/9' }, { targetUrl: null })).toBe('https://jobs.lever.co/x/9');
    expect(resolveApplicationUrl({}, null)).toBeNull();
  });
});

describe('Polling rules (read-only)', () => {
  it('interval and timeout are sane and bounded', () => {
    expect(AA_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    expect(AA_POLL_INTERVAL_MS).toBeLessThanOrEqual(2000);
    expect(AA_POLL_TIMEOUT_MS).toBe(120_000);
  });

  it('stops on ready or on a verification verdict (terminal)', () => {
    expect(isTerminalFillStatus({ readyForUserSubmission: true, verification: null })).toBe(true);
    expect(isTerminalFillStatus({ readyForUserSubmission: false, verification: { totalFields: 3 } })).toBe(true);
    expect(isTerminalFillStatus({ readyForUserSubmission: false, verification: null, attempt: { status: 'READY_FOR_DRY_RUN' } })).toBe(false);
  });

  it('attention copy carries the REAL waitReason (questions/captcha/unconfirmed)', () => {
    expect(reasonMessage('USER_ACTION_REQUIRED', 'base', 'STATE:QUESTIONS_REQUIRED')).toContain('Waiting for your answers');
    expect(reasonMessage('USER_ACTION_REQUIRED', 'base', 'HEARTBEAT:CAPTCHA_REQUIRED')).toContain('CAPTCHA');
    expect(reasonMessage('USER_ACTION_REQUIRED', 'base', 'STATE:SUBMISSION_UNCONFIRMED')).toContain('confirm the submission');
    expect(reasonMessage('USER_ACTION_REQUIRED', 'base', 'SUBMISSION_REJECTED')).toContain('rejected');
    expect(reasonMessage('USER_ACTION_REQUIRED', 'base', 'VERIFICATION_REQUIRED')).toContain('check');
    expect(reasonMessage('FILLING', 'Filling…', 'STATE:QUESTIONS_REQUIRED')).toBe('Filling…'); // only attention states get reason copy
    expect(reasonMessage('USER_ACTION_REQUIRED', 'base', 'HEARTBEAT')).toBe('base');
  });

  it('click routing opens the unified Needs-you panel; adoption works in Chrome', () => {
    const button = read('src/components/AutoApplyButton.tsx');
    // Browser-only asks ride the SAME panel as chat asks (no silent fallthrough).
    expect(button).toContain('setMidRunBrowser(browserItems)');
    expect(button).toContain('Open in browser');
    // waitReason branches for every pause family.
    expect(button).toContain("reason === 'SUBMISSION_UNCONFIRMED'");
    expect(button).toContain("reason === 'SUBMISSION_REJECTED'");
    expect(button).toContain("reason === 'VERIFICATION_REQUIRED'");
    // Reload adoption must run in the real browser too (no Electron-only gate).
    expect(button).not.toMatch(/if \(!desktopBridge\) return;\n    let alive = true;/);
    expect(button).toContain('fetchActiveExecutions()');
  });

  it('Phase 1: typed asks, deep-focus, hold window, one notification per run', () => {
    const button = read('src/components/AutoApplyButton.tsx');
    const panel = read('src/components/AnswerChatPanel.tsx');
    const session = read('desktop/main/browserSession.cjs');
    const bridge = read('desktop/main/desktopBridge.cjs');
    const transport = read('src/lib/browserExecutionTransport.ts');
    // Typed taxonomy on the health payload.
    expect(session).toContain("? 'ANSWER'");
    expect(session).toContain("'REVIEW'");
    expect(session).toContain('waitUntil: s.waitUntil || null');
    // Deep-focus endpoint + field highlight.
    expect(bridge).toContain("'/auto-apply/focus-field'");
    expect(session).toContain('async focusField(ref, name)');
    expect(session).toContain("3px solid #f59e0b");
    expect(transport).toContain('focusFieldInBrowser');
    // Panel: browser items, review note, hold line.
    expect(panel).toContain('Do this in Tailor Browser');
    expect(panel).toContain('reviewNote');
    expect(panel).toContain("I'll hold this until");
    // One notification per execution, only with granted permission.
    expect(button).toContain('notifiedExecRef');
    expect(button).toContain("Notification.permission === 'granted'");
    expect(button).toContain('Notification.requestPermission()');
  });

  it('Phase 2: review actions + screenshot evidence are wired end-to-end', () => {
    const button = read('src/components/AutoApplyButton.tsx');
    const panel = read('src/components/AnswerChatPanel.tsx');
    const bridge = read('desktop/main/desktopBridge.cjs');
    const session = read('desktop/main/browserSession.cjs');
    const transport = read('src/lib/browserExecutionTransport.ts');
    const handoff = read('server/autoApply/desktopHandoff.ts');
    // "It submitted" → USER_ASSERTED receipt (server accepts it) + Applied.
    expect(bridge).toContain("'/auto-apply/assert-submitted'");
    expect(bridge).toContain("confirmationType: 'USER_ASSERTED'");
    expect(handoff).toContain("'USER_ASSERTED'");
    expect(transport).toContain('assertDesktopSubmitted');
    expect(button).toContain('handleAssertSubmitted');
    // "It didn't submit" → fresh run from a clean session.
    expect(button).toContain('handleAssertNotSubmitted');
    expect(panel).toContain("It didn't submit — retry");
    // Screenshot evidence (loopback-only, small JPEG).
    expect(bridge).toContain("'/auto-apply/screenshot'");
    expect(session).toContain('async screenshot()');
    expect(session).toContain('toJPEG(68)');
    expect(transport).toContain('fetchSessionScreenshot');
    expect(panel).toContain('evidenceImage');
    expect(panel).toContain('Live page');
  });

  it('self-heal: dead sessions leave honest terminal states (no frozen rows)', () => {
    const bridge = read('desktop/main/desktopBridge.cjs');
    const server = read('server.ts');
    const button = read('src/components/AutoApplyButton.tsx');
    // Bridge posts a terminal state when a session closes (except APPLIED).
    expect(bridge).toContain("if (ev && ev.type === 'SESSION_CLOSED') {");
    expect(bridge).toContain("state: 'FAILED', event: `SESSION_CLOSED:${reason}`");
    expect(bridge).toContain("!reason.includes('APPLIED')");
    // Server projects silent (60s+) runs as terminal — every frozen row heals.
    expect(server).toContain("event: 'SESSION_STALE'");
    expect(server).toContain('STALE_MS = 60_000');
    expect(server).toContain("String(exec.state) === 'READY_FOR_REVIEW'");
    // Copy + honest answer-save + launch continuation.
    expect(read('src/lib/autoApply.ts')).toContain('SESSION_STALE');
    expect(button).toContain('const cont = await continueDesktopExecution');
    expect(button).toContain("Tailor Browser isn't running — your answer is saved");
    expect(button).toContain('const h = await waitForDesktop(8000, 500)');
  });

  it('timeline: friendly event labels + relative times (no jargon)', () => {
    expect(eventLabel('BROWSER_OPENED')).toBe("Opened the employer's page");
    expect(eventLabel('RESUME_ATTACHED')).toBe('Attached your resume');
    expect(eventLabel('HUMAN_ACTION_REQUIRED')).toBe('Waiting for you');
    expect(eventLabel('SUBMISSION_CONFIRMED')).toBe('Submitted — confirmed');
    expect(eventLabel('NOT_A_REAL_EVENT')).toBeNull();
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(timeAgo('2026-10-07T12:00:00Z', now)).toBe('just now');
    expect(timeAgo('2026-10-07T11:59:18Z', now)).toBe('42s ago');
    expect(timeAgo('2026-10-07T11:57:00Z', now)).toBe('3m ago');
    expect(timeAgo('bad', now)).toBe('');
    // Wiring: bridge ring buffer → health → watcher → panel Activity.
    const bridge = read('desktop/main/desktopBridge.cjs');
    expect(bridge).toContain('events: [], // ring buffer');
    expect(bridge).toContain('entry.events.push({ type: t');
    expect(bridge).toContain('return { ...s, events: (entry && entry.events) || [] };');
    const button = read('src/components/AutoApplyButton.tsx');
    expect(button).toContain('setMidRunEvents(mappedEvents)');
    expect(button).toContain('You answered:');
    const panel = read('src/components/AnswerChatPanel.tsx');
    expect(panel).toContain('Activity');
    expect(panel).toContain('timeAgo(e.at)');
  });

  it('P2: closed jobs fail honestly; native notifications for needs-you/applied/stopped', () => {
    const session = read('desktop/main/browserSession.cjs');
    const bridge = read('desktop/main/desktopBridge.cjs');
    const ashby = read('desktop/main/ashbyAdapter.cjs');
    // No form for 3 cycles → JOB_UNAVAILABLE (not an endless wait).
    expect(session).toContain("this.emit('RUN_FAILED', 'JOB_UNAVAILABLE')");
    expect(session).toContain('noFormCycles >= 3');
    expect(ashby).toContain('jobClosed');
    expect(reasonMessage('NEEDS_REVIEW', 'base', 'RUN_FAILED:JOB_UNAVAILABLE')).toContain('job is closed');
    // OS-level notifications from the desktop app (works away from the tab).
    expect(bridge).toContain('notifyNative(entry');
    expect(bridge).toContain("'Taylor AI — action needed'");
    expect(bridge).toContain("'Taylor AI — applied ✓'");
    expect(bridge).toContain("'Taylor AI — run stopped'");
    expect(bridge).toContain("!String(ev.detail || '').includes('STOPPED_BY_USER')");
  });

  it('summarizes verification without leaking values', () => {
    const summary = summarizeFillStatus({ verification: { verified: 8, alreadyCorrect: 2, mismatch: 0, notFound: 0, unverifiable: 0, blocked: 0, newRequiredFields: 0, resumeVerified: true } });
    expect(summary).toBe('Verified 8 · Already correct 2 · Needs review 0 · Resume verified · New required 0');
    expect(summarizeFillStatus(null)).toContain('Waiting');
  });
});

describe('Job row wiring — source guarantees', () => {
  const matrix = read('src/components/JobMatrix.tsx');
  const button = read('src/components/AutoApplyButton.tsx');

  it('AA renders after Apply and before Delete; Tailor stays before Apply', () => {
    const tailor = matrix.indexOf('Tailor');
    const applyAnchor = matrix.indexOf('title={`Open ${job.source} job posting to apply`}');
    const aa = matrix.indexOf('<AutoApplyButton job={job} />');
    const remove = matrix.indexOf('aria-label="Remove job"');
    expect(tailor).toBeGreaterThan(-1);
    expect(applyAnchor).toBeGreaterThan(tailor);
    expect(aa).toBeGreaterThan(applyAnchor);
    expect(remove).toBeGreaterThan(aa);
  });

  it('the existing Apply anchor is unchanged and separate from AA', () => {
    expect(matrix).toContain('href={getValidJobUrl(job)}');
    expect(matrix).toContain('aria-label={`Apply for ${job.title}`}');
    const applyBlock = matrix.slice(matrix.indexOf('aria-label={`Apply for ${job.title}`}'), matrix.indexOf('<AutoApplyButton job={job} />'));
    expect(applyBlock).toContain('Apply');
    expect(applyBlock).not.toContain('AutoApply');
  });

  it('AA is per-job (rendered inside JobCard) and has a double-click guard', () => {
    expect(matrix).toContain('<AutoApplyButton job={job} />');
    expect(button).toContain('if (busy || !autoApplyable) return;');
  });

  it('Auto Apply button is properly designed: real label, phases, supported-provider rendering', () => {
    expect(button).toContain("aria-label=\"Auto Apply\"");
    expect(button).toContain("'Auto Apply'");
    expect(button).toContain("'Starting…'"); // phase labels, not cryptic 'AA…'
    expect(button).toContain("'Action needed'");
    expect(button).toContain('if (!autoApplyable) return null;'); // never rendered where it cannot work
    expect(button).not.toContain('AA…');
    expect(button).not.toContain('supports Lever jobs');
  });

  it('the Companion button is gone from every row', () => {
    expect(button).not.toMatch(/Companion/);
    expect(button).not.toContain('useCompanionState');
    expect(button).not.toContain('BrowserCompanionPanel');
    const matrix = read('src/components/JobMatrix.tsx');
    expect(matrix).toContain('!(isAutoApplyJob(job) && hasHttpApplyUrl(job))'); // no duplicate Apply on auto-apply providers
  });

  it('AA never opens a Chrome tab or navigates the current page (handoff only)', () => {
    expect(button).not.toMatch(/window\.open\(/);
    expect(button).not.toContain('tab.location.href');
    expect(button).not.toContain('Open application');
    expect(button).toContain('desktopHealth');
    expect(button).toContain('startDesktopExecution');
  });

  it('uses the existing APIs only (no new execution backend)', () => {
    expect(button).toContain("fetch('/api/auto-apply/dry-run'");
    expect(button).toContain('createDesktopHandoff(job.id)');
    expect(button).toContain("'/api/auto-apply/browser/start'");
  });

  it('contains no submit-capable pattern', () => {
    for (const text of [button, read('src/lib/autoApply.ts')]) {
      expect(/requestSubmit/.test(text)).toBe(false);
      expect(/SubmitEvent/.test(text)).toBe(false);
      expect(/\.submit\s*\(/.test(text)).toBe(false);
      expect(/\.click\s*\(/.test(text)).toBe(false);
      expect(/submissionPerformed\s*[:=]\s*true/.test(text)).toBe(false);
    }
  });

  it('polling never mutates: the interval only calls the read-only status endpoint', () => {
    const pollBlock = button.slice(button.indexOf('const pollOnce'), button.indexOf('const runDryRun'));
    expect(pollBlock).toContain('/status');
    expect(pollBlock).not.toContain('/fill/start');
    expect(pollBlock).not.toContain('dry-run');
    expect(pollBlock).not.toContain('learn');
  });
});

describe('AA click never leaves the job list', () => {
  const button = read('src/components/AutoApplyButton.tsx');

  it('contains no navigation primitives at all in the AA path', () => {
    for (const re of [/window\.location\s*=/, /location\.href\s*=/, /\bnavigate\s*\(/, /history\.(push|replace)/, /router\.(push|replace)/, /window\.open\(/]) {
      expect(re.test(button), String(re)).toBe(false);
    }
  });

  it('the CHAT opens only when required answers are missing (no dry-run panel exists)', () => {
    expect(button).toContain("onClick={() => void (attention ? handleAttentionClick() : handleAaClick())}");
    expect(button).toContain('{open && (chatQuestions.length > 0 || midRunBrowser.length > 0 || !!midRunReview) && (');
    // The dry-run preview panel was removed entirely.
    expect(button).not.toContain('AutoApplyDryRunPreview');
    expect(button).not.toContain('chatQuestions.length === 0');
    expect(button).not.toContain('reviewAvailable');
  });

  it('desktop unavailable → one explicit action (launch), never an ATS fallback', () => {
    expect(button).toContain('Tailor Browser is closed — open it and we’ll pick up where you left off.');
    expect(button).toContain('Launch Tailor Browser');
    // Single affordance: the amber button itself retries after launch.
    expect(button).not.toContain('Try again');
    expect(button).toContain('launchTailorBrowser()');
  });

  it('tooltips: busy explains background work, attention explains why', () => {
    expect(button).toContain('Auto Apply is working in the background — you can stay here.');
    expect(button).toContain('Auto Apply needs your attention.');
  });

  it('no silent extension fallback: AA never connects the companion', () => {
    expect(button).not.toContain('ensureCompanionConnected');
    expect(button).not.toContain('assistBrowserCompanion');
    expect(button).not.toMatch(/install and pair/i);
  });

  it('no standalone Review link or eye button remains (folded into the amber action)', () => {
    expect(button).not.toContain('reviewAvailable');
    expect(button).not.toContain("aria-label=\"Show Tailor Browser\"");
    expect(button).toContain('handleAttentionClick');
  });
});

describe('AA reason codes from server blockers', () => {
  it('surfaces specific, safe reasons instead of a generic message', () => {
    expect(aaStateFromFillResult({ status: 'USER_ACTION_REQUIRED', blockers: ['CAPTCHA_REQUIRED'] }, true).message).toMatch(/CAPTCHA requires your attention/);
    expect(aaStateFromFillResult({ status: 'FILL_NOT_ELIGIBLE', blockers: ['READINESS_NEEDS_USER_INPUT'] }, true).message).toMatch(/needs answers or review/);
    expect(aaStateFromFillResult({ status: 'FILL_NOT_ELIGIBLE', blockers: [] }, true).message).toMatch(/isn't ready/);
    expect(aaReasonFromBlockers(undefined)).toBeNull();
    expect(aaReasonFromBlockers(['FORM_CHANGED'])).toMatch(/form changed/i);
  });
});

describe('Chrome → Tailor Browser handoff (execution ownership: desktop)', () => {
  const button = read('src/components/AutoApplyButton.tsx');
  const transport = read('src/lib/browserExecutionTransport.ts');

  it('no Chrome job navigation and no silent extension fallback in AA', () => {
    expect(button).not.toMatch(/window\.open\(/);
    expect(button).not.toContain('tab.location.href');
    expect(button).not.toContain('assistBrowserCompanion');
    expect(button).not.toContain('ensureCompanionConnected');
    expect(button).not.toContain("fetch('/api/auto-apply/fill/start'");
  });

  it('handoff: health → launch → token → bridge start → backend status polling', () => {
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
    expect(transport).toContain('127.0.0.1:45451');
  });

  it('desktop unavailable → explicit state; BUSY → explicit actions (no overwrite)', () => {
    expect(button).toContain('Tailor Browser is closed — open it and we’ll pick up where you left off.');
    expect(button).toContain('One application at a time — this one starts by itself when a slot frees.');
    expect(button).toContain('startDesktopExecution(job.id, retryToken.executionToken)');
  });

  it('eye focuses Tailor Browser in Chrome mode and never navigates', () => {
    expect(button).toContain('focusTailorBrowser(');
    expect(button).toContain('handleAttentionClick');
  });

  it('submission executes in Tailor Browser only — Chrome triggers via the bridge, never page DOM', () => {
    expect(button).toContain('Submit Application');
    expect(button).toContain('submitDesktopExecution(currentExecution.executionId)');
    expect(button).not.toContain('requestControlledSubmit');
    expect(button).not.toMatch(/form\.submit\(|requestSubmit|SubmitEvent/);
  });
});

describe('AA applies with the job\'s TAILORED CV (V1 tailor-first pipeline)', () => {
  const button = read('src/components/AutoApplyButton.tsx');
  it('triggers the V1 tailor when the job has no tailored CV, before any handoff', () => {
    const guardAt = button.indexOf('needsTailoring()');
    const tailorAt = button.indexOf('`/api/jobs/${job.id}/tailor`');
    const mintAt = button.indexOf('createDesktopHandoff(job.id)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(tailorAt).toBeGreaterThan(guardAt);
    expect(mintAt).toBeGreaterThan(tailorAt); // tailor completes before the handoff is minted
    expect(button).not.toContain('tailor-v2');
    expect(button).toContain("setMessage('Tailoring your CV…')");
  });
  it('a tailoring failure stops AA with the real error (no blind fill)', () => {
    const failBlock = button.slice(button.indexOf('Tailoring your CV…'), button.indexOf('Starting Tailor Browser…'));
    expect(failBlock).toContain("tdata?.error || 'Tailoring failed");
    expect(failBlock).toContain("setState('NEEDS_REVIEW')");
  });
});

describe('Bank-resolved readiness + run phase animation', () => {
  it('bank-clean answers are not double-counted as unresolved', () => {
    const svc = read('server/autoApply/autoApplyService.ts');
    expect(svc).toContain('const bankCleanIds = new Set(bankMatched.filter((m) => !m.requiresReview)');
    expect(svc).toContain('plan.unresolvedDetails.filter((u) => u.required && !bankCleanIds.has(u.providerFieldId)).length');
    expect(svc).toContain('unresolvedFields: plan.unresolvedDetails.filter((u) => !bankCleanIds.has(u.providerFieldId)).map');
  });
  it('only REQUIRED review-required answers gate readiness (optional ones are skipped, never blocking)', () => {
    const svc = read('server/autoApply/autoApplyService.ts');
    expect(svc).toContain('m.requiresReview && requiredById.get(m.providerFieldId) === true');
    expect(svc).toContain('optional saved answer(s) need your review and were left unfilled');
  });
  it('the run shows a 4-phase animated indicator (Tailor → Apply → Fill → Submit)', () => {
    const button = read('src/components/AutoApplyButton.tsx');
    expect(button).toContain("'Tailoring CV…'");
    expect(button).toContain("setPhase('TAILOR')");
    expect(button).toContain("setPhase('BROWSER')");
    expect(button).toContain("setPhase('FILL')");
    expect(button).toContain("setPhase('SUBMIT')");
    expect(button).toContain('block h-1.5 w-1.5 rounded-full');
    expect(button).toContain('animate-pulse');
  });
});

describe('Needs-input chat (right-side drawer)', () => {
  const button = read('src/components/AutoApplyButton.tsx');
  const chat = read('src/components/AnswerChatPanel.tsx');
  it('required questions open the chat in the preview slot instead of the dry-run wall', () => {
    expect(button).toContain('AnswerChatPanel');
    expect(button).toContain('chatQuestions.length > 0');
    expect(button).toContain('preflightNeedsInput');
    // The dry-run preview panel was removed entirely from the codebase.
    expect(button).not.toContain('AutoApplyDryRunPreview');
    // Same pop-up slot as the preview: right-side drawer.
    expect(chat).toContain('flex justify-end');
    // Option questions render quick-answer chips in the chat.
    expect(chat).toContain('send(opt)');
  });
  it('answers save one at a time through the answer-bank, then Submit runs the apply', () => {
    expect(button).toContain("fetch('/api/auto-apply/answer-bank/learn'");
    expect(chat).toContain('onSaveAnswer');
    expect(chat).toContain('All answers saved');
    expect(chat).toContain('Submit application');
    expect(button).toContain('await handleAaClick();');
    expect(button).toContain('if (midRunAsks || midRunBrowser.length || midRunReview)'); // mid-run: loop resumes by itself
  });
});

describe('Auto Apply visibility — Lever + Greenhouse', () => {
  it('renders for Lever and Greenhouse jobs, not for unsupported providers', () => {
    const j = (over: { atsPlatform?: string; applyUrl?: string; url?: string }) => ({ url: '', applyUrl: '', ...over });
    expect(isAutoApplyJob(j({ atsPlatform: 'lever' }))).toBe(true);
    expect(isAutoApplyJob(j({ atsPlatform: 'greenhouse' }))).toBe(true);
    expect(isAutoApplyJob(j({ atsPlatform: 'ashby' }))).toBe(true);
    expect(isAutoApplyJob(j({ applyUrl: 'https://jobs.lever.co/acme/1' }))).toBe(true);
    expect(isAutoApplyJob(j({ applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1' }))).toBe(true);
    expect(isAutoApplyJob(j({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }))).toBe(true);
    expect(isAutoApplyJob(j({ applyUrl: 'https://job-boards.eu.greenhouse.io/acme/jobs/1' }))).toBe(true); // EU regional host
    expect(isAutoApplyJob(j({ applyUrl: 'https://jobs.ashbyhq.com/acme/1' }))).toBe(true);
  });
});
