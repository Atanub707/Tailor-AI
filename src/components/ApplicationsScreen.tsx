import React from 'react';
import { HamburgerTrigger } from '../navigation';

interface Checkpoint { type: string; reasonCode: string; title: string; description: string; provider: string }
interface ApplicationRow {
  applicationId: string; planId?: string; attemptId?: string; jobId: string; jobUrl?: string;
  jobTitle: string; company: string; provider: string;
  userStatus: string; checkpoint: Checkpoint | null;
  availableActions: string[]; updatedAt: string;
}
interface Details {
  resume?: { artifactHash: string; downloadUrl: string } | null;
  userConfirmed?: { confirmedAt: string; source: string };
  answeredFields: Array<{ label: string; value: string }>;
  optionalOmittedCount: number;
  consentReviewCount: number;
  events?: Array<{ eventType: string; createdAt: string }>;
  planId?: string;
  requiredQuestions?: Array<{ providerFieldId: string; label: string; required: boolean; type: string; options: string[]; reason: string }>;
  consentFields?: Array<{ providerFieldId: string; label: string; classification: string }>;
  reviewGroups?: Array<{ title: string; items: Array<{ label: string; value: string; source: string }> }>;
  needsApproval?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  PREPARING: 'Preparing', READY: 'Ready', APPLYING: 'Applying',
  ACTION_REQUIRED: 'Action Required', WAITING_FOR_YOU: 'Waiting for You',
  READY_TO_SUBMIT: 'Ready to Submit', APPLIED: 'Applied',
  CHECK_SUBMISSION: 'Check Submission', MANUAL_REQUIRED: 'Manual application required', FAILED: 'Failed',
};
const STATUS_TONE: Record<string, string> = {
  ACTION_REQUIRED: 'bg-amber-50 text-amber-800 border-amber-200',
  WAITING_FOR_YOU: 'bg-amber-50 text-amber-800 border-amber-200',
  APPLIED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  FAILED: 'bg-red-50 text-red-800 border-red-200',
  CHECK_SUBMISSION: 'bg-orange-50 text-orange-800 border-orange-200',
  MANUAL_REQUIRED: 'bg-slate-50 text-slate-700 border-slate-200',
  PREPARING: 'bg-slate-50 text-slate-700 border-slate-200',
  READY: 'bg-sky-50 text-sky-800 border-sky-200',
  APPLYING: 'bg-slate-50 text-slate-700 border-slate-200',
  READY_TO_SUBMIT: 'bg-emerald-50 text-emerald-800 border-emerald-200',
};
const DEFAULT_TONE = 'bg-slate-50 text-slate-700 border-slate-200';
const EVENT_LABEL: Record<string, string> = {
  APPLICATION_STARTED: 'Application started',
  PROVIDER_HANDOFF: 'Opened the application form',
  USER_CONFIRMED_SUBMITTED: 'Marked as applied',
  SUBMISSION_CONFIRMED: 'Submission confirmed',
  SUBMISSION_UNCONFIRMED: 'Submission unconfirmed',
  SESSION_OPENED: 'Browser assist session opened',
  RESUME_ATTACHED: 'Resume attached',
  CHECKPOINT_DETECTED: 'Checkpoint detected',
  READY_TO_SUBMIT: 'Ready to submit',
};

const providerLabel = (p: string) => (p === 'lever' ? 'Lever' : p === 'greenhouse' ? 'Greenhouse' : p === 'ashby' ? 'Ashby' : 'the employer site');

const timeAgo = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export default function ApplicationsScreen({ onBackToJobs, initialApplicationId }: { onBackToJobs?: () => void; initialApplicationId?: string }) {
  const [rows, setRows] = React.useState<ApplicationRow[]>([]);
  const [counts, setCounts] = React.useState({ all: 0, action: 0, applied: 0 });
  const [filter, setFilter] = React.useState<'all' | 'action' | 'applied'>('all');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [selected, setSelected] = React.useState<ApplicationRow | null>(null);
  const [details, setDetails] = React.useState<Details | null>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [toast, setToast] = React.useState('');
  const [companionPaired, setCompanionPaired] = React.useState<boolean | null>(null);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [answerState, setAnswerState] = React.useState<'idle' | 'saving'>('idle');
  const [approving, setApproving] = React.useState(false);
  const [startingId, setStartingId] = React.useState<string | null>(null);

  const fetchRows = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/applications?filter=${filter}`);
      if (!res.ok) throw new Error('Could not load applications.');
      const d = await res.json();
      setRows(d.applications);
      setCounts(d.counts);
    } catch (e: any) {
      setError(String(e?.message || 'Could not load applications.'));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  React.useEffect(() => {
    void fetchRows();
    // Presence handshake — ask the extension bridge once, no spam.
    const t = setTimeout(() => {
      window.postMessage({ type: 'TAILOR_PING' }, '*');
      const onPong = (e: MessageEvent) => {
        if (e.data?.type !== 'TAILOR_PONG') return;
        setCompanionPaired(e.data.paired === true);
        window.removeEventListener('message', onPong);
      };
      window.addEventListener('message', onPong);
    }, 400);
    return () => clearTimeout(t);
  }, [fetchRows]);

  // Canonical route /applications/:applicationId — open that application's
  // detail drawer from persisted state (refresh/restart recovery).
  React.useEffect(() => {
    if (!initialApplicationId || !rows.length) return;
    const row = rows.find((r) => r.applicationId === initialApplicationId);
    if (row) void openDetails(row);
  }, [initialApplicationId, rows]);

  const openDetails = async (row: ApplicationRow) => {
    setSelected(row);
    setDetailsOpen(true);
    setDetails(null);
    try {
      const res = await fetch(`/api/applications/${row.applicationId}/details`);
      if (res.ok) setDetails(await res.json().then((d) => d.details));
    } catch { /* details are optional */ }
  };

  const continueInBrowser = async (row: ApplicationRow) => {
    if (!row.attemptId) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/browser-companion/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attemptId: row.attemptId }) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not start browser assist.'); }
      const d = await res.json();
      const started = await new Promise<boolean>((resolve) => {
        const handler = (e: MessageEvent) => {
          if (e.data?.type !== 'TAILOR_ASSIST_STARTED') return;
          window.removeEventListener('message', handler);
          resolve(e.data.ok === true);
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: 'TAILOR_START_ASSIST', sessionId: d.sessionId }, '*');
      });
      if (!started) throw new Error('The extension could not start browser assist. Use Continue on Lever instead.');
      setToast('Application opened in the browser.');
      await fetchRows();
    } catch (e: any) {
      setError(String(e?.message || 'Could not start browser assist.'));
    } finally {
      setBusy(false);
    }
  };

  const continueOnLever = async (row: ApplicationRow) => {
    if (!row.attemptId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/applications/${row.attemptId}/handoff`, { method: 'POST' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not open the provider page.'); }
      const d = await res.json();
      window.open(d.url, '_blank', 'noopener,noreferrer');
      setSelected(d.application);
      setToast('Application opened on the provider. Complete the required step, then return here.');
      await fetchRows();
    } catch (e: any) {
      setError(String(e?.message || 'Could not open the provider page.'));
    } finally {
      setBusy(false);
    }
  };

  const markAppliedManually = async (row: ApplicationRow) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/applications/${row.applicationId}/mark-applied`, { method: 'POST' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not mark as applied.'); }
      const d = await res.json();
      setSelected(d.application);
      setToast('Marked as applied — a manual record was kept.');
      await fetchRows();
    } catch (e: any) {
      setError(String(e?.message || 'Could not mark as applied.'));
    } finally { setBusy(false); }
  };

  const saveAnswer = async (row: ApplicationRow, field: { providerFieldId: string }) => {
    if (!details?.planId) return;
    setAnswerState('saving');
    setError('');
    try {
      const res = await fetch(`/api/submission-plans/${details.planId}/answers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerFieldId: field.providerFieldId, value: (answers[field.providerFieldId] ?? '').trim() || null }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not save the answer.'); }
      setToast('Answer saved.');
      await refreshDetails(row);
    } catch (e: any) {
      setError(String(e?.message || 'Could not save the answer.'));
    } finally { setAnswerState('idle'); }
  };

  const saveAllAndContinue = async (row: ApplicationRow) => {
    if (!details?.planId) return;
    setAnswerState('saving'); setError('');
    try {
      // Clear previously resolved answers first per-field via PATCH (value null resets),
      // then apply all entered values in order.
      for (const q of details.requiredQuestions ?? []) {
        const val = answers[q.providerFieldId]?.trim();
        if (val === undefined || val === '') continue;
        const res = await fetch(`/api/submission-plans/${details.planId}/answers`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerFieldId: q.providerFieldId, value: val }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not save an answer.'); }
      }
      setToast('Answers saved.');
      await refreshDetails(row);
    } catch (e: any) {
      setError(String(e?.message || 'Could not save the answers.'));
    } finally { setAnswerState('idle'); }
  };

  const refreshDetails = async (row: ApplicationRow) => {
    try {
      const res = await fetch(`/api/applications/${row.applicationId}/details`);
      if (res.ok) setDetails(await res.json().then((d) => d.details));
      await fetchRows();
    } catch { /* details are optional */ }
  };

  const approveAndContinue = async (row: ApplicationRow) => {
    if (!details?.planId) return;
    setApproving(true); setError('');
    try {
      const res = await fetch(`/api/submission-plans/${details.planId}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consents: [] }) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Approval failed.'); }
      setToast('Approved ready — continuing the application.');
      await refreshDetails(row);
      // proceed with the existing start flow now approved
      const started = await fetch(`/api/applications/${row.applicationId}/start`, { method: 'POST' });
      const sd = await started.json().catch(() => ({}));
      if (sd.application) setSelected(sd.application);
      await refreshDetails(row);
    } catch (e: any) {
      setError(String(e?.message || 'Approval failed.'));
    } finally { setApproving(false); }
  };

  const openOriginalApplication = (row: ApplicationRow) => {
    const url = row.jobUrl;
    if (!url) { setError('The original application link is not available for this job.'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const confirmSubmitted = async () => {
    if (!selected?.attemptId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/applications/${selected.attemptId}/confirm-submitted`, { method: 'POST' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not confirm.'); }
      const d = await res.json();
      setConfirmOpen(false);
      setSelected(d.application);
      setToast('Marked as applied. We keep a record that you confirmed this manually.');
      await fetchRows();
    } catch (e: any) {
      setError(String(e?.message || 'Could not confirm.'));
    } finally {
      setBusy(false);
    }
  };

  const showRow = rows.filter((r) => {
    if (filter === 'action') return r.userStatus === 'ACTION_REQUIRED' || r.userStatus === 'WAITING_FOR_YOU';
    if (filter === 'applied') return r.userStatus === 'APPLIED';
    return true;
  });

  const startApplication = async (row: ApplicationRow) => {
    setBusy(true);
    setStartingId(row.applicationId);
    setError('');
    try {
      // 1) Ensure the application plan exists (creates or reuses; read-only
      //    inspection — never mutates the provider form). Unsupported
      //    providers produce a manual-required plan instead of failing.
      const planRes = await fetch(`/api/application-packages/${row.applicationId}/plan`, { method: 'POST' });
      if (!planRes.ok) {
        const d = await planRes.json().catch(() => ({}));
        const gateMsg: Record<string, string> = {
          PACKAGE_NOT_READY: 'Some required application information is still missing (for example your Applicant Profile or a resume). Complete it, then try again.',
          RESUME_ARTIFACT_MISSING: 'No resume is available for this application. Add your Master CV or tailor a resume, then try again.',
          PACKAGE_STALE: 'The prepared application is out of date. Prepare it again, then retry.',
          PACKAGE_NOT_FOUND: 'The application was not found. It may have been removed.',
        };
        if (d?.code && gateMsg[d.code]) {
          setError(gateMsg[d.code]);
        } else if (d?.gate && d.gate.ok === false) {
          setError(`The application cannot be prepared yet: ${d.gate.reason || 'a required item is missing.'}`);
        } else {
          throw new Error(d.error || 'Could not prepare the application plan.');
        }
        return;
      }
      // 2) Start the application (respects gates: unknown questions, consent,
      //    CAPTCHA and other checkpoints stay Action Required).
      const res = await fetch(`/api/applications/${row.applicationId}/start`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (d.code === 'NEEDS_PREPARATION') { await fetchRows(); return; }
        throw new Error(d.error || 'Could not start the application.');
      }
      const d = await res.json();
      setSelected(d.application);
      if (d.application.userStatus === 'ACTION_REQUIRED') {
        setToast('Your application needs your attention.');
      } else if (d.application.userStatus === 'MANUAL_REQUIRED') {
        setToast('This provider needs a manual application — open the original form and complete it.');
      } else {
        setToast('Application started.');
      }
      await fetchRows();
    } catch (e: any) {
      setError(String(e?.message || 'Could not start the application.'));
    } finally {
      setBusy(false);
      setStartingId(null);
    }
  };

  const primaryAction = (row: ApplicationRow) => {
    if (row.availableActions.includes('START_APPLICATION')) {
      return <button onClick={() => void startApplication(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">
        {startingId === row.applicationId ? 'Preparing application…' : 'Start Application'}
      </button>;
    }
    if (row.availableActions.includes('REVIEW_AND_SUBMIT')) {
      return <button onClick={() => void continueOnLever(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:opacity-90 disabled:opacity-50">{`Review & Submit on ${providerLabel(row.provider)}`}</button>;
    }
    if (row.availableActions.includes('CONTINUE_PROVIDER')) {
      if (companionPaired === true) {
        return <button onClick={() => void continueInBrowser(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">Continue in Browser</button>;
      }
      return <button onClick={() => void continueOnLever(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">{`Continue on ${providerLabel(row.provider)}`}</button>;
    }
    if (row.availableActions.includes('REOPEN_PROVIDER')) {
      return <button onClick={() => void continueOnLever(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">{`Open ${providerLabel(row.provider)} Again`}</button>;
    }
    if (row.availableActions.includes('MARK_APPLIED')) {
      return <button onClick={() => void markAppliedManually(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] disabled:opacity-50">Mark as applied</button>;
    }
    return <button onClick={() => void openDetails(row)} className="px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)]">View</button>;
  };

  return (
    <div className="h-screen flex flex-col">
      <div className="flex items-center gap-3 px-4 sm:px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-hairline)', background: '#fff' }}>
        <HamburgerTrigger />
        <h1 className="text-[15px] font-bold" style={{ color: 'var(--color-ink)' }}>Applications</h1>
        {onBackToJobs && (
          <button onClick={onBackToJobs} className="ml-auto text-xs font-semibold underline" style={{ color: 'var(--color-muted)' }}>← Back to jobs</button>
        )}
      </div>
      <div className="p-4 md:p-6 max-w-5xl mx-auto w-full flex-1 overflow-y-auto">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h1 className="text-xl font-black text-[var(--color-ink)]">Applications</h1>
        {onBackToJobs && (
          <button onClick={onBackToJobs} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-brand)] underline">← Back to jobs</button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Application filters">
        {([['all', 'All'], ['action', 'Action Required'], ['applied', 'Applied']] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={filter === key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${filter === key ? 'bg-[var(--color-brand)] text-white border-[var(--color-brand)]' : 'bg-white text-[var(--color-muted)] border-[var(--color-hairline)] hover:bg-[var(--color-brand-soft)]'}`}
          >
            {label} {key === 'action' && counts.action > 0 ? `(${counts.action})` : ''}
          </button>
        ))}
      </div>

      {error && <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">{error}</div>}
      {toast && <div className="mt-4 rounded-lg bg-sky-50 border border-sky-200 p-3 text-xs text-sky-800">{toast}</div>}

      <div className="mt-4 space-y-2">
        {loading && <div className="text-sm text-[var(--color-faint)]">Loading applications…</div>}
        {!loading && showRow.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--color-hairline)] p-8 text-center text-sm text-[var(--color-faint)]">
            {filter === 'action' ? 'Nothing needs your attention.'
              : filter === 'applied' ? 'No completed applications yet.'
              : 'Applications you prepare will appear here.'}
          </div>
        )}
        {showRow.map((row) => (
          <button
            key={row.applicationId}
            onClick={() => void openDetails(row)}
            className="w-full text-left rounded-xl border border-[var(--color-hairline)] bg-white p-4 hover:border-[var(--color-brand-line)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-bold text-[var(--color-ink)] truncate">{row.jobTitle}</div>
                <div className="text-xs text-[var(--color-muted)]">{row.company} • {row.provider}</div>
                <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_TONE[row.userStatus] || DEFAULT_TONE}`}>
                    {row.userStatus === 'ACTION_REQUIRED' ? '⚠ ' : row.userStatus === 'APPLIED' ? '✓ ' : ''}{STATUS_LABEL[row.userStatus] || row.userStatus}
                  </span>
                  {row.checkpoint && <span className="text-xs text-[var(--color-muted)]">{row.checkpoint.title}</span>}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-[11px] text-[var(--color-faint)]">{timeAgo(row.updatedAt)}</span>
                <span onClick={(e) => e.stopPropagation()}>{primaryAction(row)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {detailsOpen && selected && (
        <div className="fixed inset-x-0 top-[65px] bottom-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal="true" aria-label="Application details">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDetailsOpen(false)} aria-hidden="true" />
          <div className="relative w-full md:max-w-lg max-h-[85vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-white shadow-xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-black text-[var(--color-ink)] truncate">{selected.jobTitle}</h2>
                <div className="text-xs text-[var(--color-muted)]">{selected.company} • {selected.provider}</div>
                <span className={`mt-2 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_TONE[selected.userStatus] || DEFAULT_TONE}`}>{STATUS_LABEL[selected.userStatus] || selected.userStatus}</span>
              </div>
              <button onClick={() => setDetailsOpen(false)} className="text-[var(--color-faint)] hover:text-[var(--color-ink)] text-lg leading-none" aria-label="Close">×</button>
            </div>

            {selected.checkpoint && (
              <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
                <div className="text-sm font-bold text-amber-900">{selected.checkpoint.title}</div>
                <p className="mt-1 text-xs text-amber-800">{selected.checkpoint.description}</p>
                <p className="mt-1 text-[11px] text-amber-700">Your tailored resume and application information are ready.</p>
              </div>
            )}

            {/* ── Questions to Answer ── */}
            {details && details.requiredQuestions && details.requiredQuestions.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-3.5" data-qa="questions-panel">
                <div className="text-sm font-black text-[var(--color-ink)]">Questions to Answer</div>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {details.requiredQuestions.length} answer{details.requiredQuestions.length > 1 ? 's' : ''} needed before Tailor AI can continue. Only questions we could not answer from your profile appear here.
                </p>
                <div className="mt-3 space-y-3">
                  {details.requiredQuestions.map((q) => (
                    <div key={q.providerFieldId}>
                      <label className="block text-[12px] font-bold text-[var(--color-ink)] mb-1">
                        {q.label}
                        {!q.required ? <span className="font-medium text-[var(--color-faint)]"> (optional)</span> : null}
                      </label>
                      {q.type === 'TEXTAREA' ? (
                        <textarea
                          className="w-full rounded-lg border border-[var(--color-hairline2)] px-3 py-2 text-sm bg-white"
                          rows={3}
                          placeholder="Your answer"
                          value={answers[q.providerFieldId] ?? ''}
                          onChange={(e) => setAnswers((a) => ({ ...a, [q.providerFieldId]: e.target.value }))}
                        />
                      ) : q.type === 'SINGLE_SELECT' ? (
                        <select
                          className="w-full rounded-lg border border-[var(--color-hairline2)] px-3 py-2 text-sm bg-white"
                          value={answers[q.providerFieldId] ?? ''}
                          onChange={(e) => setAnswers((a) => ({ ...a, [q.providerFieldId]: e.target.value }))}
                        >
                          <option value="">Select…</option>
                          {(q.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : q.type === 'MULTI_SELECT' ? (
                        <div className="flex flex-wrap gap-1.5">
                          {(q.options || []).map((o) => {
                            const sel = (answers[q.providerFieldId] || '').split(',').filter(Boolean);
                            return (
                              <button
                                key={o}
                                type="button"
                                onClick={() => {
                                  const cur = sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o];
                                  setAnswers((a) => ({ ...a, [q.providerFieldId]: cur.join(',') }));
                                }}
                                className={`px-2.5 py-1 rounded-full text-[11.5px] font-bold border transition-colors ${sel.includes(o) ? 'bg-[var(--color-brand)] text-white border-[var(--color-brand)]' : 'bg-white text-[var(--color-muted)] border-[var(--color-hairline)] hover:bg-[var(--color-brand-soft)]'}`}
                              >
                                {o}
                              </button>
                            );
                          })}
                        </div>
                      ) : q.type === 'BOOLEAN' ? (
                        <div className="flex gap-1.5">
                          {['Yes', 'No'].map((o) => (
                            <button
                              key={o}
                              type="button"
                              onClick={() => setAnswers((a) => ({ ...a, [q.providerFieldId]: o }))}
                              className={`px-3 py-1.5 rounded-full text-[11.5px] font-bold border transition-colors ${answers[q.providerFieldId] === o ? 'bg-[var(--color-brand)] text-white border-[var(--color-brand)]' : 'bg-white text-[var(--color-muted)] border-[var(--color-hairline)]'}`}
                            >
                              {o}
                            </button>
                          ))}
                        </div>
                      ) : q.type === 'DATE' ? (
                        <input
                          type="date"
                          className="w-full rounded-lg border border-[var(--color-hairline2)] px-3 py-2 text-sm bg-white"
                          value={answers[q.providerFieldId] ?? ''}
                          onChange={(e) => setAnswers((a) => ({ ...a, [q.providerFieldId]: e.target.value }))}
                        />
                      ) : (
                        <input
                          type={q.type === 'NUMBER' ? 'number' : q.type === 'EMAIL' ? 'email' : 'text'}
                          className="w-full rounded-lg border border-[var(--color-hairline2)] px-3 py-2 text-sm bg-white"
                          placeholder="Your answer"
                          value={answers[q.providerFieldId] ?? ''}
                          onChange={(e) => setAnswers((a) => ({ ...a, [q.providerFieldId]: e.target.value }))}
                        />
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => void saveAllAndContinue(selected)}
                    disabled={answerState === 'saving'}
                    className="px-3.5 py-2 rounded-lg text-sm font-bold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {answerState === 'saving' ? 'Saving…' : 'Save & Continue'}
                  </button>
                  {answerState === 'saving' && <span className="text-xs text-[var(--color-faint)]">Save &amp; Continue re-checks the application</span>}
                </div>
              </div>
            )}

            {/* ── Review & Approve ── */}
            {details?.needsApproval && !(details.requiredQuestions && details.requiredQuestions.length > 0) && (
              <div className="mt-4 rounded-xl border border-[var(--color-brand-line)] bg-[var(--color-brand-soft)] p-3.5" data-qa="review-panel">
                <div className="text-sm font-black text-[var(--color-ink)]">Review before continuing</div>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">This is what Tailor AI will use to fill the application. Nothing is submitted automatically.</p>
                {(details.reviewGroups || []).map((grp) => (
                  <div key={grp.title} className="mt-2">
                    <div className="text-[10.5px] font-bold uppercase tracking-widest text-[var(--color-faint)]">{grp.title}</div>
                    <div className="mt-1 space-y-1">
                      {grp.items.map((it, i) => (
                        <div key={i} className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5 text-xs">
                          <span className="text-[var(--color-muted)] truncate">{it.label}</span>
                          <span className="text-[var(--color-ink)] font-semibold truncate max-w-[60%]">{it.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {details.resume && (
                  <div className="mt-2 rounded-md bg-white px-2.5 py-1.5 text-xs flex items-center justify-between">
                    <span className="text-[var(--color-muted)]">Resume</span>
                    <a className="text-[var(--color-brand)] font-semibold underline" href={details.resume.downloadUrl} target="_blank" rel="noopener noreferrer">View exact resume</a>
                  </div>
                )}
                {(details.consentFields || []).length > 0 && (
                  <div className="mt-2 text-[11px] text-[var(--color-muted)]">
                    {details.consentFields.length} required acknowledgement{details.consentFields.length > 1 ? 's' : ''} remain — read them on the provider form before submitting.
                  </div>
                )}
                <button
                  onClick={() => void approveAndContinue(selected)}
                  disabled={approving}
                  className="mt-3 w-full px-3 py-2.5 rounded-lg text-sm font-bold bg-[var(--color-cta)] text-white hover:opacity-90 disabled:opacity-50"
                >
                  {approving ? 'Approving…' : 'Approve & Continue'}
                </button>
                <p className="mt-1.5 text-[10.5px] text-[var(--color-faint)]">Approve means you reviewed these values. It does not submit your application.</p>
              </div>
            )}

            <div className="mt-4 space-y-2">
              {selected.userStatus === 'WAITING_FOR_YOU' && (
                <div className="rounded-lg bg-sky-50 border border-sky-200 p-3 text-xs text-sky-800">
                  Complete the required step on {selected.provider}, then return here.
                </div>
              )}
              {selected.availableActions.includes('START_APPLICATION') && (
                <button onClick={() => void startApplication(selected)} disabled={busy} className="w-full px-3 py-2.5 rounded-lg text-sm font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">
                  {startingId === selected.applicationId ? 'Preparing application…' : 'Start Application'}
                </button>
              )}
              {selected.availableActions.includes('REVIEW_AND_SUBMIT') && (
                <button onClick={() => void continueOnLever(selected)} disabled={busy} className="w-full px-3 py-2.5 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:opacity-90 disabled:opacity-50">
                  Review &amp; Submit on Lever
                </button>
              )}
              {selected.availableActions.includes('CONTINUE_PROVIDER') && (
                <button onClick={() => void continueOnLever(selected)} disabled={busy} className="w-full px-3 py-2.5 rounded-lg text-sm font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">
                  Continue on Lever
                </button>
              )}
              {selected.availableActions.includes('REOPEN_PROVIDER') && (
                <button onClick={() => void continueOnLever(selected)} disabled={busy} className="w-full px-3 py-2.5 rounded-lg text-sm font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">
                  Open Lever Again
                </button>
              )}
              {selected.availableActions.includes('CONFIRM_SUBMITTED') && (
                <button onClick={() => setConfirmOpen(true)} disabled={busy} className="w-full px-3 py-2.5 rounded-lg text-sm font-medium bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)]">
                  I Submitted It
                </button>
              )}
              {selected.availableActions.includes('OPEN_ORIGINAL') && (
                <button onClick={() => openOriginalApplication(selected)} className="w-full px-3 py-2.5 rounded-lg text-sm font-semibold bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)]">
                  Open original application
                </button>
              )}
              {selected.availableActions.includes('MARK_APPLIED') && (
                <button onClick={() => void markAppliedManually(selected)} disabled={busy} className="w-full px-3 py-2.5 rounded-lg text-sm font-medium bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] disabled:opacity-50">
                  Mark as applied
                </button>
              )}
              {selected.userStatus === 'MANUAL_REQUIRED' && (
                <div className="rounded-lg bg-slate-50 border border-[var(--color-hairline)] p-3 text-xs text-[var(--color-muted)]">
                  This provider does not support automated assistance yet. Open the original application and complete it yourself — Tailor AI keeps your tracking record.
                </div>
              )}
              <p className="text-[11px] text-[var(--color-faint)]">{selected.userStatus === 'MANUAL_REQUIRED' ? 'Application tracking continues here.' : `Your application will open on ${providerLabel(selected.provider)}.`}</p>
            </div>

            {details && (
              <div className="mt-4 border-t border-[var(--color-hairline)] pt-3">
                <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-faint)]">Application details</div>
                {details.resume && (
                  <a href={details.resume.downloadUrl} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-brand)] underline" target="_blank" rel="noopener noreferrer">
                    Download exact resume (PDF)
                  </a>
                )}
                {details.userConfirmed && (
                  <div className="mt-2 text-[11px] text-emerald-700">Confirmed applied by you · {new Date(details.userConfirmed.confirmedAt).toLocaleString()}</div>
                )}
                {details.answeredFields.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {details.answeredFields.map((f, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-brand-soft)] px-2 py-1.5">
                        <span className="text-xs text-[var(--color-muted)] truncate">{f.label}</span>
                        <span className="text-xs text-[var(--color-ink)] truncate max-w-[55%]">{f.value}</span>
                        <button
                          onClick={() => { void navigator.clipboard?.writeText(f.value).catch(() => {}); setToast(`Copied: ${f.label}`); }}
                          className="text-[11px] font-semibold text-[var(--color-brand)] underline shrink-0"
                        >
                          Copy
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {details.events && details.events.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-faint)]">Recent activity</div>
                    <div className="mt-1.5 space-y-1">
                      {details.events.slice(0, 6).map((ev, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-brand)] shrink-0" />
                          <span>{EVENT_LABEL[ev.eventType] || ev.eventType}</span>
                          <span className="text-[var(--color-faint)] ml-auto">{new Date(ev.createdAt).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(details.optionalOmittedCount > 0 || details.consentReviewCount > 0) && (
                  <div className="mt-2 text-[11px] text-[var(--color-faint)]">
                    {details.optionalOmittedCount > 0 ? `${details.optionalOmittedCount} optional question${details.optionalOmittedCount > 1 ? 's' : ''} left unanswered · ` : ''}
                    {details.consentReviewCount > 0 ? `${details.consentReviewCount} consent item${details.consentReviewCount > 1 ? 's' : ''} requires review · ` : ''}
                    <span className="text-[var(--color-muted)]">Tailor AI prepares your answers; the provider page is completed by you.</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {confirmOpen && selected && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Confirm submission">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmOpen(false)} aria-hidden="true" />
          <div className="relative w-full max-w-sm rounded-2xl bg-white shadow-xl p-5 mx-4">
            <h3 className="text-sm font-black text-[var(--color-ink)]">Did you successfully submit this application on {selected.provider}?</h3>
            <div className="mt-4 flex gap-2">
              <button onClick={() => void confirmSubmitted()} disabled={busy} className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:opacity-90 disabled:opacity-50">
                Yes, mark as applied
              </button>
              <button onClick={() => setConfirmOpen(false)} className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)]">
                Not yet
              </button>
            </div>
            <p className="mt-2 text-[11px] text-[var(--color-faint)]">We keep a manual-confirmation record — not a provider receipt.</p>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}