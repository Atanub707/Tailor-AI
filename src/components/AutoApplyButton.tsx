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
  isLeverJob,
  hasHttpApplyUrl,
  aaStateFromFillResult,
  isTerminalFillStatus,
  aaReasonFromBlockers,
  summarizeFillStatus,
  fetchSubmissionDecision,
  submissionBlockerMessage,
  type SubmissionDecisionView,
  AA_POLL_INTERVAL_MS,
  type AaRowState,
} from '../lib/autoApply';
import { openInspectorFor } from '../lib/autoApplyInspector';
import { AutoApplyInspector } from './AutoApplyInspector';
import {
  tailorBrowserBridge,
  desktopHealth,
  waitForDesktop,
  launchTailorBrowser,
  createDesktopHandoff,
  startDesktopExecution,
  focusTailorBrowser,
  stopDesktopExecution,
  submitDesktopExecution,
  fetchDesktopExecutionStatus,
  mapDesktopStateToRow,
} from '../lib/browserExecutionTransport';
import { pushDesktopEvent, resetDesktopTimeline } from '../lib/desktopTimeline';
import { AutoApplyDryRunPreview } from './AutoApplyDryRunPreview';
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
  const [previewBusy, setPreviewBusy] = useState(false);
  const desktopBridge = tailorBrowserBridge();
  const pollRef = useRef<number | null>(null);
  const [decision, setDecision] = useState<SubmissionDecisionView | null>(null);
  const [currentExecution, setCurrentExecution] = useState<{ executionId: string; attemptId: string; jobId: string; jobTitle: string; company: string } | null>(null);
  const [desktopUnavailable, setDesktopUnavailable] = useState(false);
  const [answerNotice, setAnswerNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<'IDLE' | 'TAILOR' | 'BROWSER' | 'FILL' | 'VERIFY' | 'SUBMIT'>('IDLE');
  const [paneVisible, setPaneVisible] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAutoApplyStatus().then((s) => { if (alive) setEnabled(s.enabled); });
    return () => { alive = false; };
  }, []);

  useEffect(() => () => { if (pollRef.current !== null) window.clearInterval(pollRef.current); }, []);

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

  if (!enabled) return null;

  const lever = isLeverJob(job) && hasHttpApplyUrl(job);
  if (!lever) return null; // Auto Apply renders ONLY where it can actually run (Lever)
  const busy = state === 'STARTING' || state === 'FILLING' || state === 'VERIFYING' || state === 'WAITING_FOR_BROWSER' || state === 'SUBMITTING';
  const succeeded = state === 'READY_FOR_REVIEW' || state === 'APPLIED';
  const attention = state === 'FAILED' || state === 'FORM_CHANGED' || state === 'USER_ACTION_REQUIRED' || state === 'NEEDS_REVIEW';

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
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
    setPreviewBusy(true);
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
      } else {
        setResult(data as AutoApplyDryRunResult);
      }
      setOpen(true);
    } catch {
      setMessage('Could not reach the Auto Apply service.');
      setOpen(true);
    } finally {
      setPreviewBusy(false);
    }
  };

  const handleAaClick = async () => {
    if (busy || !lever) return;
    // Tailor Browser (desktop transport): the REAL Chromium view does the work —
    // no extension, no session claim, no external tab.
    if (desktopBridge) { await runDesktopFlow(); return; }
    await runChromeHandoffFlow();
  };

  // ── Chrome → Tailor Browser handoff (execution: desktop) ─────────────
  // Chrome NEVER opens the ATS: no window.open, no navigation, no new tab, no
  // silent extension fallback. The backend mints a single-use token; the
  // loopback desktop bridge claims it and the REAL Chromium does the work.
  const runChromeHandoffFlow = async () => {
    stopPolling();
    setMessage(null);
    setDesktopUnavailable(false);
    setAnswerNotice(null);
    setPhase('IDLE');
    setState('STARTING');
    // ── Step 0: AA ALWAYS applies with a VERIFIED TAILORED CV ───────────────
    // The application package only carries a tailored resume when the VERIFIED
    // V2 pipeline has a job-specific version (the V1 job-record blob is never
    // used for submissions). Check the V2 store first; only when no verified
    // version exists do we run the V2 tailor before the handoff. An existing
    // verified version is never regenerated at fill time.
    let hasVerifiedTailor = false;
    try {
      const latestRes = await fetch(`/api/jobs/${job.id}/tailor-v2/latest`);
      const latest = latestRes.ok ? await latestRes.json().catch(() => null) : null;
      hasVerifiedTailor = Boolean(latest?.version);
    } catch { /* treat as missing — tailor below */ }
    if (!hasVerifiedTailor) {
      setPhase('TAILOR');
      setMessage('Tailoring your CV…');
      try {
        const controller = new AbortController();
        const tailorTimer = window.setTimeout(() => controller.abort(), 6 * 60 * 1000);
        const tail = await fetch(`/api/jobs/${job.id}/tailor-v2`, {
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
        setMessage('Verified tailored CV ready — starting Auto Apply…');
      } catch {
        setState('NEEDS_REVIEW');
        setMessage('Tailoring timed out or failed — try again.');
        setPhase('IDLE');
        return;
      }
    }
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
        setMessage('Tailor Browser startup conflict.');
        setDesktopUnavailable(true);
        return;
      }
      if (!health.available) {
        setState('USER_ACTION_REQUIRED');
        setMessage('Tailor Browser is not running.');
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
        setState('USER_ACTION_REQUIRED');
        setMessage('This job already has a session — open Tailor Browser (Action needed) or wait for it.');
        return;
      }
      if (started.busy) {
        // Concurrency limit reached: this job is QUEUED — it starts by itself
        // as soon as a slot frees (bounded retry while the tab stays open).
        setMessage('Queued — waiting for a free slot…');
        setState('WAITING_FOR_BROWSER');
        const deadline = Date.now() + 120_000; // bounded: 2 minutes, then a real error
        let activeCount = Array.isArray(started.current) ? started.current.length : 0;
        while (Date.now() < deadline) {
          await new Promise((r) => window.setTimeout(r, 5000));
          const retryToken = await createDesktopHandoff(job.id);
          if (!retryToken.ok || !retryToken.executionToken) continue;
          const retry = await startDesktopExecution(job.id, retryToken.executionToken);
          if (retry.code === 'ALREADY_ACTIVE') {
            setState('USER_ACTION_REQUIRED');
            setMessage('This job already has a session — open Tailor Browser (Action needed) or wait for it.');
            setDesktopUnavailable(false);
            return;
          }
          if (retry.busy) activeCount = Array.isArray(retry.current) ? retry.current.length : activeCount;
          if (retry.accepted && retry.attemptId) {
            setAttemptId(retry.attemptId);
            setCurrentExecution({ executionId: String(retry.desktopExecutionId || ''), attemptId: retry.attemptId, jobId: job.id, jobTitle: job.title, company: job.company });
            startDesktopStatusPolling(retry.attemptId);
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
      setMessage(view.message);
      if (view.state === 'FILLING') setPhase('FILL');
      else if (view.state === 'VERIFYING') setPhase('VERIFY');
      else if (view.state === 'SUBMITTING') setPhase('SUBMIT');
      if (view.terminal) {
        stopPolling();
        if (view.state === 'READY_FOR_REVIEW') {
          void fetchSubmissionDecision(id).then(setDecision).catch(() => {});
        }
      }
    }, AA_POLL_INTERVAL_MS);
  };

  const stopCurrentExecution = async () => {
    if (!currentExecution) return;
    await stopDesktopExecution(currentExecution.executionId);
    setCurrentExecution(null);
    stopPolling();
    setState('IDLE');
    setMessage('Stopped the Tailor Browser session.');
  };

  const runDesktopFlow = async () => {
    if (!desktopBridge) return;
    stopPolling();
    setMessage(null);
    setState('STARTING');
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
                  : result.ok
                    ? 'Submitted — waiting for confirmation.'
                    : 'Submission is blocked — see Tailor Browser.'
    );
  };

  const handleCheckStatus = async () => {
    if (!attemptId) return;
    await pollOnce(attemptId);
  };

  const handleAttentionClick = async () => {
    if (!attemptId || !currentExecution) {
      // No live session (readiness/input blocking): show EXACTLY what's remaining.
      await runDryRun();
      return;
    }
    const focused = await focusTailorBrowser(currentExecution.executionId);
    if (!focused.ok) {
      setMessage('Tailor Browser is not running.');
      setDesktopUnavailable(true);
    }
  };

  const handleAnswer = async (_providerFieldId: string, question: string, answer: string, remember: boolean) => {
    setAnswerNotice(null);
    try {
      const res = await fetch('/api/auto-apply/answer-bank/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, question, answer, remember }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setAnswerNotice((data && data.error) || 'Could not save that answer — try again.');
        return;
      }
      setAnswerNotice(remember ? 'Answer saved — re-checking…' : 'Answer used for this run — re-checking…');
    } catch {
      setAnswerNotice('Could not reach the Auto Apply service.');
      return;
    }
    await runDryRun();
  };

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
      {desktopUnavailable && (
        <>
          <button type="button" onClick={() => launchTailorBrowser()} title="Launch the Tailor Browser desktop app" className="text-[10.5px] font-bold text-[var(--color-brand)] underline whitespace-nowrap cursor-pointer">
            Launch Tailor Browser
          </button>
          <button type="button" onClick={() => void handleAaClick()} title="Check again and start execution" className="text-[10.5px] font-bold text-[var(--color-brand)] underline whitespace-nowrap cursor-pointer">
            Try again
          </button>
        </>
      )}
      {state === 'READY_FOR_REVIEW' && !desktopBridge && currentExecution && (
        <button
          type="button"
          onClick={() => void handleSubmitApplication()}
          disabled={submitBusy}
          title="One server-authorized submission through Tailor Browser — final revalidation runs first, then the real Lever submit is clicked exactly once."
          className="text-[10.5px] font-bold text-emerald-700 underline whitespace-nowrap cursor-pointer disabled:opacity-50"
        >
          Submit Application
        </button>
      )}
      {state === 'READY_FOR_REVIEW' && desktopBridge && (
        <span className="text-[10.5px] text-emerald-700 whitespace-nowrap" title="Explicit submission for Tailor Browser ships after the live fill MVP passes — submit is intentionally OFF.">
          Ready — submit disabled (MVP)
        </span>
      )}
      {state === 'READY_FOR_REVIEW' && decision && !decision.allowed && decision.blockerCodes.length > 0 && (
        <span className="text-[10.5px] text-amber-700 whitespace-nowrap" title={decision.blockerCodes.join(', ')}>
          {submissionBlockerMessage(decision.blockerCodes)}
        </span>
      )}
            {open && (
        <AutoApplyDryRunPreview
          result={result}
          error={null}
          jobTitle={job.title}
          company={job.company}
          onClose={() => setOpen(false)}
          onAnswer={handleAnswer}
          onFill={handleAaClick}
          onCheckStatus={handleCheckStatus}
          fillState={state !== 'IDLE' ? { status: state, message: (answerNotice ?? message) ?? undefined, attemptId: attemptId ?? undefined } : null}
          fillBusy={previewBusy}
        />
      )}
    </>
  );
};
