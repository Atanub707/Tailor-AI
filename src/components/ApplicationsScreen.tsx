import React from 'react';

interface Checkpoint { type: string; reasonCode: string; title: string; description: string; provider: string }
interface ApplicationRow {
  applicationId: string; planId?: string; attemptId?: string; jobId: string;
  jobTitle: string; company: string; provider: string;
  userStatus: string; checkpoint: Checkpoint | null;
  availableActions: string[]; updatedAt: string;
}
interface Details {
  applicationId: string; jobTitle: string; company: string; provider: string;
  userConfirmed?: { confirmedAt: string; source: string };
  answeredFields: Array<{ label: string; value: string }>;
  optionalOmittedCount: number; consentReviewCount: number;
  resume: { artifactHash: string; downloadUrl: string } | null;
  lastUpdated: string;
}

const STATUS_LABEL: Record<string, string> = {
  PREPARING: 'Preparing', READY: 'Ready', APPLYING: 'Applying',
  ACTION_REQUIRED: 'Action Required', WAITING_FOR_YOU: 'Waiting for You',
  APPLIED: 'Applied', CHECK_SUBMISSION: 'Check Submission', FAILED: 'Failed',
};
const STATUS_TONE: Record<string, string> = {
  ACTION_REQUIRED: 'bg-amber-50 text-amber-800 border-amber-200',
  WAITING_FOR_YOU: 'bg-amber-50 text-amber-800 border-amber-200',
  APPLIED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  FAILED: 'bg-red-50 text-red-800 border-red-200',
  CHECK_SUBMISSION: 'bg-orange-50 text-orange-800 border-orange-200',
  PREPARING: 'bg-slate-50 text-slate-700 border-slate-200',
  READY: 'bg-sky-50 text-sky-800 border-sky-200',
  APPLYING: 'bg-slate-50 text-slate-700 border-slate-200',
};
const DEFAULT_TONE = 'bg-slate-50 text-slate-700 border-slate-200';

const timeAgo = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export default function ApplicationsScreen({ onBackToJobs }: { onBackToJobs?: () => void }) {
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
      const res = await fetch(`/api/applications/${row.applicationId}/start`, { method: 'POST' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not start the application.'); }
      const d = await res.json();
      setSelected(d.application);
      if (d.application.userStatus === 'ACTION_REQUIRED') {
        setToast('Your application needs your attention.');
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
    if (row.availableActions.includes('CONTINUE_PROVIDER')) {
      if (companionPaired === true) {
        return <button onClick={() => void continueInBrowser(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">Continue in Browser</button>;
      }
      return <button onClick={() => void continueOnLever(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">Continue on Lever</button>;
    }
    if (row.availableActions.includes('REOPEN_PROVIDER')) {
      return <button onClick={() => void continueOnLever(row)} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-50">Open Lever Again</button>;
    }
    return <button onClick={() => void openDetails(row)} className="px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)]">View</button>;
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto w-full">
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
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal="true" aria-label="Application details">
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
              <p className="text-[11px] text-[var(--color-faint)]">Your application will open on Lever.</p>
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
  );
}