// Auto Apply — job-row "AA" action (AUTO FILL + VERIFY, never submit).
//
// Order in the row: [ Tailor ] [ Apply ] [ AA ] [ Delete ] — Apply is
// untouched and remains the manual flow. AA starts the existing fill-only
// pipeline, opens the EXACT Lever application URL in a popup-safe tab, and
// polls the existing status API until the read-back verdict arrives, and — only
// when the user explicitly approves — runs the server-controlled submit pipeline
// through the companion. There is no page-scripted submit anywhere here.

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import type { Job } from '../types';
import {
  fetchAutoApplyStatus,
  isAutoApplyJob,
  hasHttpApplyUrl,
  aaStateFromFillResult,
  isTerminalFillStatus,
  aaReasonFromBlockers,
  summarizeFillStatus,
  fetchSubmissionDecision,
  submissionBlockerMessage,
  reasonMessage,
  eventLabel,
  type SubmissionDecisionView,
  AA_POLL_INTERVAL_MS,
  type AaRowState,
} from '../lib/autoApply';
import { openInspectorFor } from '../lib/autoApplyInspector';
import { AutoApplyInspector } from './AutoApplyInspector';
import {
  continueDesktopExecution,
  tailorBrowserBridge,
  desktopHealth,
  waitForDesktop,
  launchTailorBrowser,
  createDesktopHandoff,
  startDesktopExecution,
  focusTailorBrowser,
  focusFieldInBrowser,
  fetchSessionScreenshot,
  assertDesktopSubmitted,
  stopDesktopExecution,
  submitDesktopExecution,
  fetchDesktopExecutionStatus,
  fetchActiveExecutions,
  mapDesktopStateToRow,
} from '../lib/browserExecutionTransport';
import { pushDesktopEvent, resetDesktopTimeline } from '../lib/desktopTimeline';
import { AnswerChatPanel, type AnswerChatQuestion, type AnswerChatBrowserItem } from './AnswerChatPanel';
import type { AutoApplyDryRunResult } from '../../server/autoApply/autoApplyTypes';

interface AutoApplyButtonProps {
  job: Job;
}

export const AutoApplyButton: React.FC<AutoApplyButtonProps> = ({ job }) => {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<AaRowState>('IDLE');
  const [message, setMessage] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [result, setResult] = useState<AutoApplyDryRunResult | null>(null);
  const [open, setOpen] = useState(false);
  const [midRunAsks, setMidRunAsks] = useState<AnswerChatQuestion[] | null>(null);
  const [midRunBrowser, setMidRunBrowser] = useState<AnswerChatBrowserItem[]>([]);
  const [midRunReview, setMidRunReview] = useState<string | null>(null);
  const [midRunHoldUntil, setMidRunHoldUntil] = useState<number | null>(null);
  const [evidenceImage, setEvidenceImage] = useState<string | null>(null);
  const [midRunEvents, setMidRunEvents] = useState<Array<{ label: string; at: string }>>([]);
  const [localEvents, setLocalEvents] = useState<Array<{ label: string; at: string }>>([]);
  const handledAskSigRef = useRef('');
  // ONE notification per execution (market pattern: batch, never spam).
  const notifiedExecRef = useRef<Set<string>>(new Set());
  // When the user answered an ask and it PERSISTS (answer didn't resolve the
  // field), the chat reopens after this cooldown instead of dead-ending.
  const answeredAtRef = useRef(0);
  const desktopBridge = tailorBrowserBridge();
  const pollRef = useRef<number | null>(null);
  const askPollRef = useRef<number | null>(null);
  // Jobs tailored during THIS session — retries (Action Required → full retry)
  // must never trigger another tailor. The row's job prop is stale: the list
  // payload may omit tailoredCv and AA's own tailor never writes back to it.
  const tailoredJobsRef = useRef<Set<string>>(new Set());
  // The tailor step is an LLM call with an external budget. When the budget is
  // gone, retrying is pointless — the user gets the Master CV path instead.
  const skipTailoringRef = useRef(false);
  const tailorRetryRef = useRef(0);
  const [failedStep, setFailedStep] = useState<'tailor' | null>(null);
  const needsTailoring = () =>
    !skipTailoringRef.current &&
    !job.tailoredCv &&
    !tailoredJobsRef.current.has(job.id) &&
    !['tailored', 'applied'].includes(String((job as { state?: string }).state || ''));
  const [decision, setDecision] = useState<SubmissionDecisionView | null>(null);
  const [currentExecution, setCurrentExecution] = useState<{ executionId: string; attemptId: string; jobId: string; jobTitle: string; company: string } | null>(null);
  const [desktopUnavailable, setDesktopUnavailable] = useState(false);
  const [phase, setPhase] = useState<'IDLE' | 'TAILOR' | 'BROWSER' | 'FILL' | 'VERIFY' | 'SUBMIT'>('IDLE');
  const [paneVisible, setPaneVisible] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAutoApplyStatus().then((s) => { if (alive) setEnabled(s.enabled); });
    return () => { alive = false; };
  }, []);

  useEffect(() => () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    if (askPollRef.current !== null) window.clearInterval(askPollRef.current);
  }, []);

  useEffect(() => {
    if (!desktopBridge) return;
    void desktopBridge
      .getState()
      .then((s) => {
        const v = (s as { paneVisible?: boolean } | null)?.paneVisible;
        if (typeof v === 'boolean') setPaneVisible(v);
      })
      .catch(() => { /* pane state defaults to hidden until a session shows it */ });
  }, [desktopBridge]);

  // RELOAD ADOPTION: after a page refresh the row forgot its live execution —
  // reconnect to the session that is STILL running (server knows; the bridge
  // proves it is alive) instead of dead-ending on a stale row. This runs in
  // the REAL browser too (plain loopback fetches with CORS) — not only inside
  // the Electron debug UI.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [execs, health] = await Promise.all([fetchActiveExecutions(), desktopHealth()]);
        const exec = execs.find((e) => e.jobId === job.id);
        if (!exec || !alive) return;
        // Never adopt without an attemptId: an unpolled "Action needed" row is
        // worse than none (it can never update itself).
        if (!exec.attemptId) return;
        const live = (health.sessions || []).find((s) => s.executionId === exec.executionId);
        if (!live) return;
        setCurrentExecution({ executionId: exec.executionId, attemptId: exec.attemptId, jobId: job.id, jobTitle: job.title, company: job.company });
        setAttemptId(exec.attemptId);
        setState('USER_ACTION_REQUIRED');
        setMessage('This job is already running in Tailor Browser — the run continues by itself and closes when it finishes.');
        startDesktopStatusPolling(exec.attemptId);
        startAskWatcher(exec.executionId);
      } catch { /* adoption is best-effort; clicking Auto Apply still recovers */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  if (!enabled) return null;

  const autoApplyable = isAutoApplyJob(job) && hasHttpApplyUrl(job);
  if (!autoApplyable) return null; // Auto Apply renders ONLY where it can actually run (Lever + Greenhouse)
  const busy = state === 'STARTING' || state === 'FILLING' || state === 'VERIFYING' || state === 'WAITING_FOR_BROWSER' || state === 'SUBMITTING';
  const succeeded = state === 'READY_FOR_REVIEW' || state === 'APPLIED';
  const attention = state === 'FAILED' || state === 'FORM_CHANGED' || state === 'USER_ACTION_REQUIRED' || state === 'NEEDS_REVIEW';

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (askPollRef.current !== null) {
      window.clearInterval(askPollRef.current);
      askPollRef.current = null;
    }
  };

  const pollOnce = async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/auto-apply/fill/${id}/status`);
      if (!res.ok) return false;
      const data = await res.json();
      if (data.readyForUserSubmission) {
        stopPolling();
        setState('READY_FOR_REVIEW');
        setMessage('Application filled and verified. Review it in the browser before submitting.');
        void fetchSubmissionDecision(id).then((d) => setDecision(d)).catch(() => {});
        return true;
      }
      if (isTerminalFillStatus(data)) {
        stopPolling();
        setState('NEEDS_REVIEW');
        setMessage(summarizeFillStatus(data));
        return true;
      }
    } catch { /* transient — polling continues until the deadline */ }
    return false;
  };


  const runDryRun = async () => {
    try {
      const res = await fetch('/api/auto-apply/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setResult(null);
        setMessage(data?.error || 'Auto Apply preview failed.');
        setOpen(false);
      } else {
        const next = data as AutoApplyDryRunResult;
        setResult(next);
        // The CHAT is the only surface: it opens exactly when required answers
        // are missing. Nothing else ever pops up.
        setOpen((next?.unresolvedFields ?? []).some((f) => f.requiresUser));
      }
    } catch {
      setMessage('Could not reach the Auto Apply service.');
      setOpen(false);
    }
  };

  const handleAaClick = async () => {
    if (busy || !autoApplyable) return;
    // Ask for notification permission on the user's gesture — the ONE ping per
    // run when the agent needs them (never spam).
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
    } catch { /* notifications are best-effort */ }
    setState('STARTING');
    setMessage('Starting Auto Apply…');
    // Pre-flight: when required questions are still missing, ask them in the
    // left-side chat BEFORE starting any browser work.
    if (!(await preflightNeedsInput())) { setState('IDLE'); setMessage(null); return; }
    // Tailor Browser (desktop transport): the REAL Chromium view does the work —
    // no extension, no session claim, no external tab.
    if (desktopBridge) { await runDesktopFlow(); return; }
    await runChromeHandoffFlow();
  };

  /** Tailor step with honest failure handling: quota → Master CV offer;
   *  transient → bounded auto-retry with backoff; never a click loop. */
  const ensureTailored = async (): Promise<boolean> => {
    if (!needsTailoring()) return true;
    setPhase('TAILOR');
    setMessage(tailorRetryRef.current ? `Retrying tailoring (attempt ${tailorRetryRef.current + 1} of 3)…` : 'Tailoring your CV…');
    try {
      const controller = new AbortController();
      const tailorTimer = window.setTimeout(() => controller.abort(), 6 * 60 * 1000);
      const tail = await fetch(`/api/jobs/${job.id}/tailor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: job.tailorMode ?? 'enhanced' }),
        signal: controller.signal,
      });
      window.clearTimeout(tailorTimer);
      const tdata = await tail.json().catch(() => null);
      if (!tail.ok) {
        const code = String(tdata?.code || '');
        if (code === 'quota') {
          setFailedStep('tailor');
          setState('NEEDS_REVIEW');
          setPhase('IDLE');
          setMessage(tdata?.error || 'The AI budget is used up — continue with your Master CV.');
          return false;
        }
        if (tailorRetryRef.current < 2) {
          tailorRetryRef.current += 1;
          const waitS = tailorRetryRef.current === 1 ? 10 : 30;
          setMessage(`The AI service is busy — retrying tailoring in ${waitS}s…`);
          await new Promise((r) => window.setTimeout(r, waitS * 1000));
          return ensureTailored();
        }
        setFailedStep('tailor');
        setState('NEEDS_REVIEW');
        setPhase('IDLE');
        setMessage(tdata?.error || 'Tailoring failed — retry, or continue with your Master CV.');
        return false;
      }
      tailoredJobsRef.current.add(job.id);
      tailorRetryRef.current = 0;
      setMessage('Tailored CV ready — starting Auto Apply…');
      return true;
    } catch {
      if (tailorRetryRef.current < 2) {
        tailorRetryRef.current += 1;
        const waitS = tailorRetryRef.current === 1 ? 10 : 30;
        setMessage(`Tailoring timed out — retrying in ${waitS}s…`);
        await new Promise((r) => window.setTimeout(r, waitS * 1000));
        return ensureTailored();
      }
      setFailedStep('tailor');
      setState('NEEDS_REVIEW');
      setPhase('IDLE');
      setMessage('Tailoring timed out — retry, or continue with your Master CV.');
      return false;
    }
  };

  // ── Chrome → Tailor Browser handoff (execution: desktop) ─────────────
  // Chrome NEVER opens the ATS: no window.open, no navigation, no new tab, no
  // silent extension fallback. The backend mints a single-use token; the
  // loopback desktop bridge claims it and the REAL Chromium does the work.
  const runChromeHandoffFlow = async () => {
    stopPolling();
    setMessage(null);
    setDesktopUnavailable(false);
    setPhase('IDLE');
    setState('STARTING');
    // ── Step 0: tailor (LLM). Quota exhaustion is NOT retried — the user is
    // offered the Master CV path instead; transient failures auto-retry with
    // backoff. The user is never the retry mechanism.
    if (!(await ensureTailored())) return;
    setFailedStep(null);
    setPhase('BROWSER');
    setMessage('Starting Tailor Browser…');
    try {
      let health = await desktopHealth();
      if (!health.available) {
        launchTailorBrowser(); // launch intent only — no job data crosses the protocol
        setMessage('Starting Tailor Browser…');
        health = await waitForDesktop(8000, 500);
      }
      if (health.appMismatch) {
        setState('USER_ACTION_REQUIRED');
        setMessage("Something else is using Taylor's connection — quit that app, then try again. Nothing was submitted.");
        setDesktopUnavailable(true);
        return;
      }
      if (!health.available) {
        setState('USER_ACTION_REQUIRED');
        setMessage('Tailor Browser is closed — open it and we’ll pick up where you left off.');
        setDesktopUnavailable(true);
        return;
      }
      const handoff = await createDesktopHandoff(job.id);
      if (!handoff.ok || !handoff.executionToken) {
        setState('FAILED');
        setMessage(handoff.message || 'Tailor Browser could not start this application.');
        return;
      }
      setMessage('Opening application…');
      const started = await startDesktopExecution(job.id, handoff.executionToken);
      if (started.code === 'ALREADY_ACTIVE') {
        // This job ALREADY has a live session (e.g. the page was reloaded and
        // the row lost its state). ADOPT it — never dead-end: remember the
        // session, bring the window forward, and keep watching it.
        const existing = (Array.isArray(started.current) ? started.current : []).find((c) => c && String(c.jobId || '') === job.id) || (Array.isArray(started.current) ? started.current[0] : null);
        if (existing && existing.executionId) {
          setAttemptId(existing.attemptId ? String(existing.attemptId) : null);
          setCurrentExecution({ executionId: String(existing.executionId), attemptId: String(existing.attemptId || ''), jobId: job.id, jobTitle: job.title, company: job.company });
          if (existing.attemptId) startDesktopStatusPolling(String(existing.attemptId));
          startAskWatcher(String(existing.executionId));
          void focusTailorBrowser(String(existing.executionId));
          setState('USER_ACTION_REQUIRED');
          setMessage('This job is already open in Tailor Browser — bringing it forward. Finish the action there; the run continues by itself.');
          return;
        }
        setState('USER_ACTION_REQUIRED');
        setMessage('This job is already running — bringing it forward.');
        return;
      }
      if (started.busy) {
        // Concurrency limit reached: this job is QUEUED — it starts by itself
        // as soon as a slot frees (bounded retry while the tab stays open).
        setMessage('One application at a time — this one starts by itself when a slot frees.');
        setState('WAITING_FOR_BROWSER');
        const deadline = Date.now() + 120_000; // bounded: 2 minutes, then a real error
        let activeCount = Array.isArray(started.current) ? started.current.length : 0;
        while (Date.now() < deadline) {
          await new Promise((r) => window.setTimeout(r, 5000));
          const retryToken = await createDesktopHandoff(job.id);
          if (!retryToken.ok || !retryToken.executionToken) continue;
          const retry = await startDesktopExecution(job.id, retryToken.executionToken);
          if (retry.code === 'ALREADY_ACTIVE') {
            const existing = (Array.isArray(retry.current) ? retry.current : []).find((c) => c && String(c.jobId || '') === job.id) || (Array.isArray(retry.current) ? retry.current[0] : null);
            if (existing && existing.executionId) {
              setAttemptId(existing.attemptId ? String(existing.attemptId) : null);
              setCurrentExecution({ executionId: String(existing.executionId), attemptId: String(existing.attemptId || ''), jobId: job.id, jobTitle: job.title, company: job.company });
              if (existing.attemptId) startDesktopStatusPolling(String(existing.attemptId));
              startAskWatcher(String(existing.executionId));
              void focusTailorBrowser(String(existing.executionId));
              setState('USER_ACTION_REQUIRED');
              setMessage('This job is already open in Tailor Browser — bringing it forward. Finish the action there; the run continues by itself.');
              setDesktopUnavailable(false);
              return;
            }
            setState('USER_ACTION_REQUIRED');
            setMessage('This job is already running — bringing it forward.');
            setDesktopUnavailable(false);
            return;
          }
          if (retry.busy) activeCount = Array.isArray(retry.current) ? retry.current.length : activeCount;
          if (retry.accepted && retry.attemptId) {
            setAttemptId(retry.attemptId);
            setCurrentExecution({ executionId: String(retry.desktopExecutionId || ''), attemptId: retry.attemptId, jobId: job.id, jobTitle: job.title, company: job.company });
            startDesktopStatusPolling(retry.attemptId);
            startAskWatcher(String(retry.desktopExecutionId || ''));
            return;
          }
          if (!retry.busy) {
            const reason = aaReasonFromBlockers(retry.blockers) || retry.message || null;
            setState('NEEDS_REVIEW');
            setMessage(reason || 'Auto Apply needs preparation for this job — open Review.');
            return;
          }
        }
        setState('USER_ACTION_REQUIRED');
        setMessage(
          activeCount
            ? `No free Auto Apply slot — ${activeCount} runs are active (some wait for you in Tailor Browser). Finish or stop them, then click Auto Apply again.`
            : 'No free Auto Apply slot — finish the active runs in Tailor Browser, then click Auto Apply again.'
        );
        return;
      }
      if (!started.accepted || !started.attemptId) {
        // Show the REAL reason from the server (readiness/resume/answers), never
        // a masked failure — and offer Review so the fix is one click away.
        const reason = aaReasonFromBlockers(started.blockers) || started.message || null;
        setState('NEEDS_REVIEW');
        setMessage(reason || 'Auto Apply needs preparation for this job — open Review.');
        return;
      }
      setAttemptId(started.attemptId);
      setCurrentExecution({
        executionId: String(started.desktopExecutionId || ''),
        attemptId: started.attemptId,
        jobId: job.id,
        jobTitle: job.title,
        company: job.company,
      });
      startDesktopStatusPolling(started.attemptId);
      startAskWatcher(String(started.desktopExecutionId || ''));
    } catch {
      setState('FAILED');
      setMessage("Auto Apply couldn't start.");
    }
  };

  // Live per-job status from the backend (desktop execution is the source of truth).
  const startDesktopStatusPolling = (id: string) => {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      const status = await fetchDesktopExecutionStatus(id);
      if (!status) return;
      const view = mapDesktopStateToRow(status.state);
      if (!view) return;
      setState(view.state);
      setMessage(reasonMessage(view.state, view.message, status.event));
      if (view.state === 'FILLING') setPhase('FILL');
      else if (view.state === 'VERIFYING') setPhase('VERIFY');
      else if (view.state === 'SUBMITTING') setPhase('SUBMIT');
      if (view.terminal) {
        stopPolling();
        setMidRunAsks(null);
        setMidRunBrowser([]);
        setMidRunReview(null);
        setMidRunHoldUntil(null);
        setEvidenceImage(null);
        setMidRunEvents([]);
        setLocalEvents([]);
        if (view.state === 'READY_FOR_REVIEW') {
          void fetchSubmissionDecision(id).then(setDecision).catch(() => {});
        }
      }
    }, AA_POLL_INTERVAL_MS);
  };

  // Mid-run human questions: watch the loopback bridge while the run is live.
  // When the agent pauses with QUESTIONS_REQUIRED, the answer chat opens BY
  // ITSELF with the form's own options; each answer is saved to the Answer
  // Bank and the agent loop (which keeps watching) resumes on its next cycle.
  const startAskWatcher = (executionId: string) => {
    if (askPollRef.current !== null) {
      window.clearInterval(askPollRef.current);
      askPollRef.current = null;
    }
    if (!executionId) return;
    askPollRef.current = window.setInterval(async () => {
      const health = await desktopHealth();
      const s = (health.sessions || []).find((x) => x.executionId === executionId);
      if (!s) return;
      const mappedEvents = (s.events || [])
        .map((e) => ({ label: eventLabel(e.type, e.detail), at: e.at }))
        .filter((e): e is { label: string; at: string } => !!e.label);
      if (mappedEvents.length) setMidRunEvents(mappedEvents);
      const asks = s.asks || [];
      const chatQs: AnswerChatQuestion[] = asks
        .filter((a) => !a.human)
        .map((a, i) => ({ providerFieldId: `ask-${i}`, label: a.label, options: a.options }));
      const browserItems: AnswerChatBrowserItem[] = asks
        .filter((a) => a.human)
        .map((a) => ({ label: a.label, reason: a.reason, ref: a.ref, name: a.name }));
      const review = s.waitReason === 'SUBMISSION_UNCONFIRMED'
        ? "The site didn't confirm the submission — open the employer page and check whether it went through. If it did, no action is needed."
        : s.waitReason === 'SUBMISSION_REJECTED'
          ? 'The form rejected the submission — fix the highlighted fields in Tailor Browser; the run continues by itself.'
          : null;
      if (!asks.length && !review) return;
      // ONE notification per execution, on the FIRST moment it needs you
      // (batched, opt-in via granted permission — never spam).
      if (!notifiedExecRef.current.has(executionId) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        notifiedExecRef.current.add(executionId);
        try {
          new Notification('Tailor AI — action needed', {
            body: `${job.title} · ${job.company}: ${review ? 'the submission needs a check' : chatQs.length ? 'answer a question to continue' : 'finish a step in Tailor Browser'}`,
            tag: `aa-${executionId}`,
          });
        } catch { /* notifications are best-effort */ }
      }
      const sig = `${executionId}|${asks.map((a) => a.label).join('|')}|${review ? 'review' : ''}`;
      // A saved answer that did NOT resolve the question (the ask persists)
      // must not dead-end: reopen after a cooldown so the user can retry.
      const unansweredRetry = answeredAtRef.current > 0 && Date.now() - answeredAtRef.current > 15_000;
      if (sig !== handledAskSigRef.current || unansweredRetry) {
        handledAskSigRef.current = sig;
        answeredAtRef.current = 0;
        setMidRunAsks(chatQs.length ? chatQs : null);
        setMidRunBrowser(browserItems);
        setMidRunReview(review);
        setMidRunHoldUntil(typeof s.waitUntil === 'number' ? s.waitUntil : null);
        setOpen(true);
        void refreshEvidence(executionId);
      }
    }, AA_POLL_INTERVAL_MS);
  };

  /** Evidence: a small live-page JPEG inside the panel (best-effort). */
  const refreshEvidence = async (executionId: string) => {
    const r = await fetchSessionScreenshot(executionId);
    if (r.ok && r.image) setEvidenceImage(r.image);
  };

  /** "It submitted" — the user IS the evidence: record a USER_ASSERTED receipt
   *  (server-side, idempotent) and move the job to Applied. */
  const handleAssertSubmitted = async () => {
    if (!currentExecution) return;
    const r = await assertDesktopSubmitted(currentExecution.executionId);
    if (r.ok) {
      stopPolling();
      setOpen(false);
      setMidRunReview(null);
      setMidRunBrowser([]);
      setMidRunAsks(null);
      setEvidenceImage(null);
      setState('APPLIED');
      setMessage('Marked as submitted — receipt saved.');
      return;
    }
    setMessage("Couldn't record that — the session may have closed. Check the employer page.");
  };

  /** "It didn't submit" — the user confirms nothing went through: close this
   *  session and start a FRESH run (new attempt; safe because the old one is
   *  abandoned with no receipt). */
  const handleAssertNotSubmitted = async () => {
    if (!currentExecution) return;
    setMessage('Restarting the application from a fresh session…');
    try { await stopDesktopExecution(currentExecution.executionId); } catch { /* cleanup best-effort */ }
    setCurrentExecution(null);
    setAttemptId(null);
    stopPolling();
    setOpen(false);
    setMidRunReview(null);
    setMidRunBrowser([]);
    setMidRunAsks(null);
    setEvidenceImage(null);
    setState('IDLE');
    await handleAaClick();
  };

  /** "Open in browser" from the Needs-you panel: focus the window AND land on
   *  the exact field (scroll + highlight) when the ask carries a ref/name. */
  const handleOpenBrowserItem = async (item?: AnswerChatBrowserItem) => {
    if (!currentExecution) return;
    await focusTailorBrowser(currentExecution.executionId);
    if (item && (item.ref || item.name)) {
      void focusFieldInBrowser(currentExecution.executionId, item.ref, item.name);
    }
    setMessage(item ? `Tailor Browser focused on: ${String(item.label).slice(0, 80)}` : 'Tailor Browser opened.');
  };

  const stopCurrentExecution = async () => {
    if (!currentExecution) return;
    await stopDesktopExecution(currentExecution.executionId);
    setCurrentExecution(null);
    setAttemptId(null);
    stopPolling();
    setMidRunAsks(null);
    setMidRunBrowser([]);
    setMidRunReview(null);
    setMidRunHoldUntil(null);
    setEvidenceImage(null);
    setMidRunEvents([]);
    setLocalEvents([]);
    setFailedStep(null);
    handledAskSigRef.current = '';
    answeredAtRef.current = 0;
    setState('IDLE');
    setMessage('Stopped the Tailor Browser session.');
  };

  const runDesktopFlow = async () => {
    if (!desktopBridge) return;
    stopPolling();
    handledAskSigRef.current = '';
    answeredAtRef.current = 0;
    setMidRunAsks(null);
    setMidRunBrowser([]);
    setMidRunReview(null);
    setMidRunHoldUntil(null);
    setEvidenceImage(null);
    setMidRunEvents([]);
    setLocalEvents([]);
    setMessage(null);
    setState('STARTING');
    // Step 0: apply with the job's TAILORED CV (V1 engine — the same pipeline
    // the manual Tailor button runs). Generate it first when missing; the
    // server builds the package + attached PDF from this exact tailored CV.
    if (needsTailoring()) {
      setPhase('TAILOR');
      setMessage('Tailoring your CV…');
      try {
        const controller = new AbortController();
        const tailorTimer = window.setTimeout(() => controller.abort(), 6 * 60 * 1000);
        const tail = await fetch(`/api/jobs/${job.id}/tailor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: job.tailorMode ?? 'enhanced' }),
          signal: controller.signal,
        });
        window.clearTimeout(tailorTimer);
        const tdata = await tail.json().catch(() => null);
        if (!tail.ok) {
          setState('NEEDS_REVIEW');
          setMessage(tdata?.error || 'Tailoring failed — try again.');
          setPhase('IDLE');
          return;
        }
        tailoredJobsRef.current.add(job.id);
        setMessage('Tailored CV ready — starting Auto Apply…');
      } catch {
        setState('NEEDS_REVIEW');
        setMessage('Tailoring timed out or failed — try again.');
        setPhase('IDLE');
        return;
      }
    }
    try {
      const res = await fetch('/api/auto-apply/browser/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || (data.status !== 'BROWSER_READY' && data.status !== 'USER_ACTION_REQUIRED')) {
        const view = aaStateFromFillResult(data, res.ok);
        setState(view.state);
        setMessage(view.message);
        if (view.state !== 'FILL_DISABLED')
        return;
      }
      const attempt = String(data.attemptId);
      setAttemptId(attempt);
      resetDesktopTimeline(attempt);
      openInspectorFor({ attemptId: attempt, jobId: job.id, jobTitle: job.title, company: job.company });
      desktopBridge.onEvent((ev) => pushDesktopEvent(attempt, ev));
      let resumeBytes: Uint8Array | null = null;
      if (data.plan?.resume?.url) {
        try {
          const rr = await fetch(String(data.plan.resume.url));
          if (rr.ok) resumeBytes = new Uint8Array(await rr.arrayBuffer());
        } catch { /* resume stays null; the run flags it */ }
      }
      await desktopBridge.createSession(String(data.userId || ''));
      const run = (await desktopBridge.runFill({
        plan: data.plan,
        resumeBytes,
        resumeSha256: data.plan?.resume?.sha256,
        resumeFilename: data.plan?.resume?.filename,
      })) as { ok?: boolean; pending?: boolean; statuses?: string } | null;
      if (run && run.pending) {
        setState('USER_ACTION_REQUIRED');
        setMessage('Action required: complete the CAPTCHA in the Tailor Browser panel.');
      } else if (run && run.ok) {
        setState('READY_FOR_REVIEW');
        setMessage('Application filled and verified in Tailor Browser.');
        void fetchSubmissionDecision(attempt).then(setDecision).catch(() => {});
      } else {
        setState('NEEDS_REVIEW');
        setMessage('Fill needs review — see the Tailor Browser panel.');
      }
    } catch {
      setState('FAILED');
      setMessage("Auto Apply couldn't start.");
    }
  };

  // Explicit approval (Chrome): the SERVER authorizes a single-use submission;
  // the desktop revalidates and clicks the real Lever control exactly once.
  const handleSubmitApplication = async () => {
    if (!currentExecution || submitBusy) return;
    setSubmitBusy(true);
    setState('SUBMITTING');
    setMessage('Submitting…');
    const result = await submitDesktopExecution(currentExecution.executionId);
    setSubmitBusy(false);
    if (result.ok && result.verified) {
      setState('APPLIED');
      setMessage('Applied ✓ — confirmed by the job board.');
      return;
    }
    setState(result.ok ? 'NEEDS_REVIEW' : 'READY_FOR_REVIEW');
    const code = result.code || '';
    setMessage(
      code === 'CAPTCHA_REQUIRED'
        ? 'Complete the CAPTCHA in Tailor Browser, then click Submit Application again.'
        : code === 'VERIFICATION_FAILED'
          ? 'The form needs review in Tailor Browser before submitting.'
          : code === 'ALREADY_SUBMITTED'
            ? 'This application was already submitted.'
            : code === 'PRIOR_SUBMISSION_UNVERIFIED'
              ? 'A previous submission may have gone through — check the site first.'
              : code === 'SUBMIT_DISABLED'
                ? 'Submission is not enabled.'
                : code === 'SUBMITTED_UNVERIFIED'
                  ? 'Submission may have occurred, but confirmation could not be verified. Check the site before retrying.'
                  : code === 'SUBMISSION_REJECTED'
                    ? 'The form rejected the submission — fix the highlighted fields in Tailor Browser and retry.'
                    : result.ok
                      ? 'Submitted — waiting for confirmation.'
                      : "Couldn't submit yet — check the page in Tailor Browser."
    );
  };

  const handleAttentionClick = async () => {
    if (!attemptId || !currentExecution) {
      // No live session: a previous failure must never dead-end. If answers
      // are missing the chat opens; otherwise RETRY the full apply flow.
      setMessage('This run stopped — starting a fresh one. Your answers are saved and reused.');
      await handleAaClick();
      return;
    }
    // Liveness: a session is USABLE only if the bridge knows it AND its page
    // is alive (not crashed, not blank). A dead/white view never gets focused —
    // we stop it and retry the whole apply instead.
    try {
      const health = await desktopHealth();
      const live = (health.sessions || []).find((s) => s.executionId === currentExecution.executionId);
      const usable = !!live && !live.crashed && !!live.pageUrl && live.pageUrl !== 'about:blank';
      if (!usable) {
        setMessage('This run stopped — starting a fresh one…');
        try { await stopDesktopExecution(currentExecution.executionId); } catch { /* cleanup best-effort */ }
        setCurrentExecution(null);
        setAttemptId(null);
        setState('IDLE');
        await handleAaClick();
        return;
      }
      // The ACTION decides the response: questions open the chat (right
      // drawer), browser-only asks get named + focused, a CAPTCHA needs the
      // visible window, anything else gets the window brought forward with the
      // REAL reason. Feedback is set in EVERY branch — never a silent click.
      const reason = live.waitReason || '';
      const asks = live.asks || [];
      if (reason === 'QUESTIONS_REQUIRED' && asks.length) {
        const chatQs: AnswerChatQuestion[] = asks.filter((a) => !a.human).map((a, i) => ({ providerFieldId: `ask-${i}`, label: a.label, options: a.options }));
        const browserItems: AnswerChatBrowserItem[] = asks.filter((a) => a.human).map((a) => ({ label: a.label, reason: a.reason, ref: a.ref, name: a.name }));
        handledAskSigRef.current = `${currentExecution.executionId}|${asks.map((a) => a.label).join('|')}`;
        setMidRunAsks(chatQs.length ? chatQs : null);
        setMidRunBrowser(browserItems);
        setMidRunReview(null);
        setMidRunHoldUntil(typeof live.waitUntil === 'number' ? live.waitUntil : null);
        setOpen(true);
        void refreshEvidence(currentExecution.executionId);
        setMessage(chatQs.length
          ? 'This run needs your input — answer in the panel, then it continues by itself.'
          : 'This run needs a step in Tailor Browser — open it from the panel.');
        return;
      }
      if (reason === 'SUBMISSION_UNCONFIRMED' || reason === 'SUBMISSION_REJECTED') {
        setMidRunAsks(null);
        setMidRunBrowser([]);
        setMidRunReview(reason === 'SUBMISSION_UNCONFIRMED'
          ? "The site didn't confirm the submission — open the employer page and check whether it went through. If it did, no action is needed."
          : 'The form rejected the submission — fix the highlighted fields in Tailor Browser; the run continues by itself.');
        setMidRunHoldUntil(typeof live.waitUntil === 'number' ? live.waitUntil : null);
        setOpen(true);
        void refreshEvidence(currentExecution.executionId);
        setMessage(reason === 'SUBMISSION_UNCONFIRMED' ? 'Checking the submission outcome — see the panel.' : 'The form rejected the submission — see the panel.');
        return;
      }
      if (reason === 'CAPTCHA_REQUIRED') {
        await focusTailorBrowser(currentExecution.executionId);
        setMessage('Complete the CAPTCHA in the Tailor Browser window — the run continues and submits by itself.');
        return;
      }
      if (reason === 'SUBMISSION_UNCONFIRMED') {
        await focusTailorBrowser(currentExecution.executionId);
        setMessage("The site didn't confirm the submission — check the employer page in Tailor Browser before retrying.");
        return;
      }
      if (reason === 'SUBMISSION_REJECTED') {
        await focusTailorBrowser(currentExecution.executionId);
        setMessage('The form rejected the submission — fix the highlighted fields in Tailor Browser.');
        return;
      }
      if (reason === 'VERIFICATION_REQUIRED') {
        await focusTailorBrowser(currentExecution.executionId);
        setMessage('The form needs a quick check in Tailor Browser — fix what is highlighted there.');
        return;
      }
      const focused = await focusTailorBrowser(currentExecution.executionId);
      if (!focused.ok) {
        setMessage('Tailor Browser is closed — open it and we’ll pick up where you left off.');
        setDesktopUnavailable(true);
        return;
      }
      setMessage('Tailor Browser opened — complete the action there; the run continues by itself.');
    } catch {
      // Bridge probe failed — still try to bring the window forward, with feedback.
      const focused = await focusTailorBrowser(currentExecution.executionId);
      setMessage(focused.ok ? 'Tailor Browser opened — complete the action there.' : 'Tailor Browser is closed — open it, then click Action needed.');
      if (!focused.ok) setDesktopUnavailable(true);
    }
  };

  /** Returns true when it is OK to proceed. When required questions are
   *  missing it opens the left chat and returns false. Never blocks on a
   *  failed preview (the real run surfaces errors). */
  const preflightNeedsInput = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/auto-apply/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      if (!res.ok) return true;
      const data = (await res.json()) as AutoApplyDryRunResult;
      setResult(data);
      const pending = (data?.unresolvedFields ?? []).filter((f) => f.requiresUser);
      if (pending.length > 0) {
        setOpen(true);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  /** Chat saves: one answer at a time, straight into the Answer Bank. */
  const handleSaveAnswer = async (question: string, answer: string, remember: boolean): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auto-apply/answer-bank/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, question, answer, remember }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: (data && data.error) || 'Could not save that answer — try again.' };
      answeredAtRef.current = Date.now();
      setLocalEvents((prev) => [...prev.slice(-7), { label: `You answered: ${String(question).slice(0, 60)}`, at: new Date().toISOString() }]);
      // RESUME NOW: the answer is in the bank — nudge the desktop agent so it
      // stops waiting and continues immediately (idempotent; no-op if it is
      // already running).
      if (currentExecution && currentExecution.executionId) {
        const cont = await continueDesktopExecution(currentExecution.executionId);
        if (!cont.ok) {
          // The answer IS saved (server-side) — but the run may be gone.
          // Say so honestly instead of promising a resume that can't happen.
          const health = await desktopHealth();
          if (!health.available) {
            setMessage("Tailor Browser isn't running — your answer is saved. Restart the run to continue.");
            setDesktopUnavailable(true);
          } else {
            setMessage('Your answer is saved. The run already moved on — check the row.');
          }
        }
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the Auto Apply service.' };
    }
  };

  const chatQuestions = midRunAsks && midRunAsks.length
    ? midRunAsks
    : (result?.unresolvedFields ?? [])
        .filter((f) => f.requiresUser)
        .map((f) => ({ providerFieldId: f.providerFieldId, label: f.label, options: f.options }));

  const phaseLabel =
    phase === 'TAILOR' ? 'Tailoring CV…'
      : phase === 'BROWSER' ? (state === 'WAITING_FOR_BROWSER' ? 'Queued…' : 'Starting…')
        : phase === 'FILL' ? 'Filling…'
          : phase === 'VERIFY' ? 'Verifying…'
            : phase === 'SUBMIT' ? 'Submitting…'
              : 'Working…';
  // 4-step run indicator: Tailoring → Applying → Filling → Submitting
  const phaseIndex = phase === 'TAILOR' ? 0 : phase === 'BROWSER' ? 1 : phase === 'FILL' || phase === 'VERIFY' ? 2 : phase === 'SUBMIT' ? 3 : -1;
  const label = busy
    ? phaseLabel
    : state === 'APPLIED' ? 'Applied'
      : succeeded ? 'Ready'
        : attention ? 'Action needed'
          : 'Auto Apply';
  const title = busy
    ? 'Auto Apply is working in the background — you can stay here.'
    : state === 'APPLIED'
      ? 'Application submitted — confirmed by the job board.'
      : succeeded
        ? 'Application filled and verified. Review and submit when ready.'
        : attention
          ? message || 'Auto Apply needs your attention.'
          : 'Auto Apply this job in a controlled browser — you stay here.';

  return (
    <>
      <button
        type="button"
        onClick={() => void (attention ? handleAttentionClick() : handleAaClick())}
        disabled={busy || succeeded}
        title={title}
        aria-label="Auto Apply"
        className={`inline-flex items-center gap-1.5 h-[38px] px-3.5 rounded-lg text-xs font-extrabold border transition-colors cursor-pointer disabled:opacity-60 ${
          state === 'APPLIED'
            ? 'bg-emerald-600 text-white border-emerald-600'
            : attention
              ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600'
              : succeeded
                ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                : 'bg-violet-600 text-white border-violet-600 hover:bg-violet-700'
        }`}
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : attention ? (
          <AlertTriangle className="w-3.5 h-3.5" />
        ) : (
          <Sparkles className="w-3.5 h-3.5" />
        )}
        <span>{label}</span>
        {busy && phaseIndex >= 0 && (
          <span className="flex items-center gap-[3px] ml-1" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <i
                key={i}
                className={`block h-1.5 w-1.5 rounded-full transition-colors ${
                  i < phaseIndex ? 'bg-white' : i === phaseIndex ? 'bg-white animate-pulse' : 'bg-white/35'
                }`}
              />
            ))}
          </span>
        )}
      </button>
      {currentExecution && (busy || attention || state === 'READY_FOR_REVIEW') && (
        <button
          type="button"
          onClick={() => void stopCurrentExecution()}
          title="Stop this run in Tailor Browser"
          className="text-[10.5px] font-bold text-[var(--color-faint)] underline whitespace-nowrap cursor-pointer hover:text-[var(--color-ink)]"
        >
          Stop
        </button>
      )}
      {failedStep === 'tailor' && (
        <button
          type="button"
          onClick={() => {
            skipTailoringRef.current = true;
            setFailedStep(null);
            tailorRetryRef.current = 0;
            setMessage('Continuing with your Master CV — you can tailor this job later.');
            void runChromeHandoffFlow();
          }}
          title="Start Auto Apply now using your Master CV — tailoring can be done later"
          className="text-[10.5px] font-bold text-[var(--color-brand)] underline whitespace-nowrap cursor-pointer"
        >
          Continue with Master CV
        </button>
      )}
      {desktopUnavailable && (
        <button
          type="button"
          onClick={() => {
            launchTailorBrowser();
            void (async () => {
              const h = await waitForDesktop(8000, 500);
              if (h.available) {
                await handleAaClick();
              } else {
                setMessage('Tailor Browser still not detected — open it, then click Action needed.');
              }
            })();
          }}
          title="Launch the Tailor Browser desktop app"
          className="text-[10.5px] font-bold text-[var(--color-brand)] underline whitespace-nowrap cursor-pointer"
        >
          Launch Tailor Browser
        </button>
      )}
      {state === 'READY_FOR_REVIEW' && currentExecution && (
        <button
          type="button"
          onClick={() => void handleSubmitApplication()}
          disabled={submitBusy}
          title="One server-authorized submission through Tailor Browser — final revalidation runs first, then the real submit is clicked exactly once."
          className="text-[10.5px] font-bold text-emerald-700 underline whitespace-nowrap cursor-pointer disabled:opacity-50"
        >
          {submitBusy ? 'Submitting…' : 'Submit Application'}
        </button>
      )}
      {state === 'READY_FOR_REVIEW' && decision && !decision.allowed && decision.blockerCodes.length > 0 && (
        <span className="text-[10.5px] text-amber-700 whitespace-nowrap" title={decision.blockerCodes.join(', ')}>
          {submissionBlockerMessage(decision.blockerCodes)}
        </span>
      )}
            {open && (chatQuestions.length > 0 || midRunBrowser.length > 0 || !!midRunReview) && (
        <AnswerChatPanel
          key={`${chatQuestions.map((q) => q.label).join('|')}|${midRunBrowser.map((b) => b.label).join('|')}|${midRunReview ? 'review' : ''}`}
          jobTitle={job.title}
          company={job.company}
          questions={chatQuestions}
          browserItems={midRunBrowser}
          reviewNote={midRunReview}
          onOpenBrowser={(item) => void handleOpenBrowserItem(item)}
          waitUntil={midRunHoldUntil}
          evidenceImage={evidenceImage}
          onRefreshEvidence={() => { if (currentExecution) void refreshEvidence(currentExecution.executionId); }}
          onAssertSubmitted={() => void handleAssertSubmitted()}
          onAssertNotSubmitted={() => void handleAssertNotSubmitted()}
          timeline={[...midRunEvents, ...localEvents].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))}
          onSaveAnswer={handleSaveAnswer}
          onSubmit={async () => {
            if (midRunAsks || midRunBrowser.length || midRunReview) {
              setOpen(false);
              setMidRunAsks(null);
              setMidRunBrowser([]);
              setMidRunReview(null);
              setMessage('Saved — the run continues by itself; I will close this when it finishes.');
              return;
            }
            setOpen(false);
            await handleAaClick();
          }}
          submitLabel={midRunAsks || midRunBrowser.length || midRunReview ? 'Continue' : undefined}
          footnote={midRunAsks || midRunBrowser.length || midRunReview ? 'The run resumes by itself — you can close this.' : undefined}
          onClose={() => { setOpen(false); setMidRunAsks(null); setMidRunBrowser([]); setMidRunReview(null); }}
        />
      )}
    </>
  );
};
