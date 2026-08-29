import React from 'react';
import { HamburgerTrigger } from '../navigation';
import ApplicationDrawer from './ApplicationDrawer';
import { STATUS_LABEL, STATUS_TONE, DEFAULT_TONE, providerLabel, timeAgo, type ApplicationRow } from './applicationUi';

export default function ApplicationsScreen({ onBackToJobs, initialApplicationId }: { onBackToJobs?: () => void; initialApplicationId?: string }) {
  const [rows, setRows] = React.useState<ApplicationRow[]>([]);
  const [counts, setCounts] = React.useState({ all: 0, action: 0, applied: 0 });
  const [filter, setFilter] = React.useState<'all' | 'action' | 'applied'>('all');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [selectedAppId, setSelectedAppId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
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
  }, [fetchRows]);

  // Canonical route /applications/:applicationId — open that application's
  // detail drawer from persisted state (refresh/restart recovery).
  React.useEffect(() => {
    if (!initialApplicationId || !rows.length) return;
    const row = rows.find((r) => r.applicationId === initialApplicationId);
    if (row) setSelectedAppId(row.applicationId);
  }, [initialApplicationId, rows]);

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
      if (d.application?.userStatus === 'ACTION_REQUIRED') {
        setError('Your application needs your attention — open it to review.');
      } else if (d.application?.userStatus === 'MANUAL_REQUIRED') {
        setError('This provider needs a manual application — open it for the original form.');
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
    return <button onClick={() => setSelectedAppId(row.applicationId)} className="px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)]">View</button>;
  };

  const showRow = rows.filter((r) => {
    if (filter === 'action') return r.userStatus === 'ACTION_REQUIRED' || r.userStatus === 'WAITING_FOR_YOU';
    if (filter === 'applied') return r.userStatus === 'APPLIED';
    return true;
  });

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
            onClick={() => setSelectedAppId(row.applicationId)}
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

      <ApplicationDrawer
        applicationId={selectedAppId}
        onClose={() => setSelectedAppId(null)}
        onChanged={() => void fetchRows()}
      />
      </div>
    </div>
  );
}