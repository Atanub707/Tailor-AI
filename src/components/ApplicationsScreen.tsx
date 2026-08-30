import React from 'react';
import { HamburgerTrigger } from '../navigation';
import ApplicationDrawer from './ApplicationDrawer';
import { STATUS_LABEL, STATUS_TONE, DEFAULT_TONE, providerLabel, timeAgo, type ApplicationRow } from './applicationUi';

// ── Applications Redesign (mockup-approved) ─────────────────────────────
// Overview strip → filter tabs + search + sort → grouped application cards
// with a color status rail, provider chip, status pill, one primary action
// per status, and a per-row kebab. Row click opens the shared drawer.

const RAIL_COLOR: Record<string, string> = {
  ACTION_REQUIRED: '#F59E0B', WAITING_FOR_YOU: '#F59E0B',
  READY_TO_SUBMIT: '#10B981', APPLIED: '#10B981',
  CHECK_SUBMISSION: '#F97316', MANUAL_REQUIRED: '#8B5CF6',
  PREPARING: '#94A3B8', APPLYING: '#94A3B8', READY: '#0EA5E9',
};

const PILL_TONE: Record<string, string> = {
  ACTION_REQUIRED: 'bg-amber-100 text-amber-900',
  WAITING_FOR_YOU: 'bg-amber-100 text-amber-900',
  APPLIED: 'bg-emerald-100 text-emerald-900',
  READY_TO_SUBMIT: 'bg-emerald-100 text-emerald-900',
  CHECK_SUBMISSION: 'bg-orange-100 text-orange-900',
  MANUAL_REQUIRED: 'bg-violet-100 text-violet-900',
  PREPARING: 'bg-slate-100 text-slate-700',
  APPLYING: 'bg-slate-100 text-slate-700',
  READY: 'bg-sky-100 text-sky-900',
};

const PROVIDER_ICON = {
  lever: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  ),
  greenhouse: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3l8 4v10l-8 4-8-4V7z" />
    </svg>
  ),
  ashby: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3l8 4v10l-8 4-8-4V7z" />
    </svg>
  ),
};

export default function ApplicationsScreen({ onBackToJobs, initialApplicationId }: { onBackToJobs?: () => void; initialApplicationId?: string }) {
  const [rows, setRows] = React.useState<ApplicationRow[]>([]);
  const [counts, setCounts] = React.useState({ all: 0, action: 0, applied: 0 });
  const [filter, setFilter] = React.useState<'all' | 'action' | 'applied'>('all');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [selectedAppId, setSelectedAppId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [startingId, setStartingId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [sortBy, setSortBy] = React.useState<'updated' | 'title' | 'company'>('updated');

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

  // ── Filters + sort (client-side over the fetched rows) ────────────────
  const filtered = React.useMemo(() => {
    let list = rows;
    if (filter === 'action') list = list.filter((r) => r.userStatus === 'ACTION_REQUIRED' || r.userStatus === 'WAITING_FOR_YOU');
    if (filter === 'applied') list = list.filter((r) => r.userStatus === 'APPLIED');
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((r) => `${r.jobTitle} ${r.company}`.toLowerCase().includes(q));
    const sorted = [...list];
    if (sortBy === 'title') sorted.sort((a, b) => a.jobTitle.localeCompare(b.jobTitle));
    else if (sortBy === 'company') sorted.sort((a, b) => a.company.localeCompare(b.company));
    else sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return sorted;
  }, [rows, filter, query, sortBy]);

  const needsAttention = filtered.filter((r) => r.userStatus === 'ACTION_REQUIRED' || r.userStatus === 'WAITING_FOR_YOU');
  const appliedSection = filtered.filter((r) => r.userStatus === 'APPLIED');
  const otherSection = filtered.filter((r) => !['ACTION_REQUIRED', 'WAITING_FOR_YOU', 'APPLIED'].includes(r.userStatus));

  const startApplication = async (row: ApplicationRow) => {
    setBusy(true);
    setStartingId(row.applicationId);
    setError('');
    try {
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

  const PRIMARY_LABEL: Record<string, string> = {
    START_APPLICATION: 'Start Application',
    REVIEW_AND_SUBMIT: 'Review & Submit',
    CONTINUE_PROVIDER: 'Continue',
    REOPEN_PROVIDER: 'Open Again',
    MARK_APPLIED: 'Mark as applied',
  };

  const primaryAction = (row: ApplicationRow) => {
    if (row.availableActions.includes('START_APPLICATION')) {
      return (
        <button onClick={() => void startApplication(row)} disabled={busy} className="btn primary"
          style={{ height: 38, padding: '0 14px', borderRadius: 9, fontSize: 12, fontWeight: 800, fontFamily: 'inherit', border: 0, background: 'var(--color-brand)', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          {startingId === row.applicationId ? 'Preparing…' : 'Start Application'}
        </button>
      );
    }
    const label = Object.keys(PRIMARY_LABEL).find((k) => row.availableActions.includes(k));
    return (
      <button onClick={() => setSelectedAppId(row.applicationId)} className="btn"
        style={{ height: 38, padding: '0 14px', borderRadius: 9, fontSize: 12, fontWeight: 700, fontFamily: 'inherit', background: '#fff', border: '1px solid var(--color-hairline)', color: 'var(--color-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {label ? PRIMARY_LABEL[label] : 'View'}
      </button>
    );
  };

  const statusPill = (row: ApplicationRow) => {
    const tone = PILL_TONE[row.userStatus] || 'bg-slate-100 text-slate-700';
    return (
      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10.5px] font-bold ${tone}`}>
        {row.userStatus === 'ACTION_REQUIRED' ? '⚠' : row.userStatus === 'APPLIED' ? '✓' : row.userStatus === 'WAITING_FOR_YOU' ? '⚠' : ''}
        {STATUS_LABEL[row.userStatus] || row.userStatus}
      </span>
    );
  };

  const Card = ({ row, key }: { row: ApplicationRow; key: string }) => (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setSelectedAppId(row.applicationId)}
      onKeyDown={(e) => { if (e.key === 'Enter') setSelectedAppId(row.applicationId); }}
      className="flex w-full text-left rounded-xl border border-[var(--color-hairline)] bg-white overflow-hidden hover:border-[var(--color-brand-line)] hover:shadow-sm transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
    >
      <div style={{ width: 5, flex: 'none', background: RAIL_COLOR[row.userStatus] || '#94A3B8' }} aria-hidden="true" />
      <div className="flex-1 min-w-0 py-3.5 pl-4 pr-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-[var(--color-faint)]">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-hairline)] bg-slate-50 px-2 py-0.5 text-[10.5px] font-bold text-[var(--color-muted)]">
            {PROVIDER_ICON[row.provider as keyof typeof PROVIDER_ICON] ?? null}
            {providerLabel(row.provider)}
          </span>
          <span>{timeAgo(row.updatedAt)}</span>
        </div>
        <div className="mt-1.5 text-[13.5px] font-extrabold tracking-[-0.01em] text-[var(--color-ink)] truncate">{row.jobTitle}</div>
        <div className="mt-0.5 text-[11.5px] font-semibold text-[var(--color-muted)]">{row.company}</div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {statusPill(row)}
          {row.checkpoint && <span className="text-[11.5px] text-[var(--color-muted)]">{row.checkpoint.title}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 px-4 shrink-0" onClick={(e) => e.stopPropagation()}>
        {primaryAction(row)}
        <button
          aria-label="Application options"
          className="w-[38px] h-[38px] rounded-lg border border-[var(--color-hairline)] bg-white flex items-center justify-center text-[var(--color-faint)] hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-ink)] transition-colors cursor-pointer"
          onClick={() => setSelectedAppId(row.applicationId)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
        </button>
      </div>
    </div>
  );

  const Section = ({ title, items }: { title: string; items: ApplicationRow[] }) => (
    items.length > 0 ? (
      <>
        <div className="mt-5 mb-2 px-1 text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-[var(--color-faint)]">{title}</div>
        <div className="space-y-2.5">
          {items.map((row) => <Card key={row.applicationId} row={row} />)}
        </div>
      </>
    ) : null
  );

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
        <h1 className="text-[19px] font-extrabold tracking-[-0.02em] text-[var(--color-ink)]">Applications</h1>
        <p className="mt-0.5 text-[12px] text-[var(--color-faint)]">Job applications tracked from discovery to submitted.</p>

        {/* Overview strip */}
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2.5" role="tablist" aria-label="Application overview">
          {([['all', 'All', counts.all], ['action', 'Action Required', counts.all - counts.applied], ['waiting', 'Waiting for you', counts.action], ['applied', 'Applied', counts.applied]] as const).map(([key, label, n]) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key === 'waiting' ? 'action' : key)}
              className={`rounded-xl border p-3 text-left cursor-pointer transition-colors ${filter === key || (key === 'waiting' && filter === 'action') ? 'border-[var(--color-brand-line)] bg-[var(--color-brand-soft)]' : 'border-[var(--color-hairline)] bg-white hover:border-[var(--color-brand-line)]'}`}
            >
              <div className="text-[20px] font-extrabold tracking-[-0.02em] text-[var(--color-ink)]">{n}</div>
              <div className="mt-0.5 text-[9.5px] font-bold uppercase tracking-[0.06em] text-[var(--color-faint)]">{label}</div>
            </button>
          ))}
        </div>

        {/* Filters + search + sort */}
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <div className="inline-flex rounded-full border border-[var(--color-hairline)] bg-white p-0.5" role="tablist" aria-label="Application filters">
            {([['all', 'All'], ['action', 'Action Required'], ['applied', 'Applied']] as const).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
                className={`rounded-full px-3.5 py-1.5 text-[11.5px] font-bold transition-colors cursor-pointer ${filter === key ? 'bg-[var(--color-ink)] text-white' : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'}`}
              >
                {label}{key === 'action' && counts.action > 0 ? ` (${counts.action})` : ''}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-[200px] flex items-center gap-2 rounded-[10px] border border-[var(--color-hairline)] bg-white px-3 py-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-faint)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search job title or company…"
              className="w-full bg-transparent border-none outline-none text-[12px] font-semibold text-[var(--color-ink)] placeholder:text-[var(--color-faint)]" aria-label="Search applications" />
          </div>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} aria-label="Sort applications"
            className="rounded-[10px] border border-[var(--color-hairline)] bg-white px-3 py-2 text-[11.5px] font-bold text-[var(--color-muted)] cursor-pointer outline-none">
            <option value="updated">Sort: Recently updated</option>
            <option value="title">Sort: Job title A–Z</option>
            <option value="company">Sort: Company A–Z</option>
          </select>
        </div>

        {error && <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">{error}</div>}

        {loading ? (
          <div className="mt-6 text-sm text-[var(--color-faint)]">Loading applications…</div>
        ) : filtered.length === 0 ? (
          <div className="mt-6 rounded-2xl border-2 border-dashed border-[var(--color-hairline2)] py-10 text-center">
            <div className="text-sm font-extrabold text-[var(--color-ink)]">
              {filter === 'action' ? 'Nothing needs your attention' : filter === 'applied' ? 'No completed applications yet' : 'No applications here yet'}
            </div>
            <div className="mt-1.5 text-xs text-[var(--color-faint)]">Find a job, tailor your CV and press <b>Apply</b> — it will appear here with its own tracker.</div>
            {onBackToJobs && (
              <button onClick={onBackToJobs} className="mt-4 inline-flex items-center h-[38px] px-4 rounded-lg text-[12px] font-extrabold text-white cursor-pointer"
                style={{ background: 'var(--color-cta)', border: 0, fontFamily: 'inherit' }}>
                Go to Job Search
              </button>
            )}
          </div>
        ) : (
          <>
            <Section title="Needs your attention" items={needsAttention} />
            <Section title={filter === 'applied' ? 'Applied' : 'In progress'} items={otherSection} />
            <Section title="Applied" items={appliedSection} />
            <div className="mt-4 flex items-center gap-2 text-[11px] font-semibold text-[var(--color-faint)]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {filtered.length} application{filtered.length > 1 ? 's' : ''} · tracked locally
            </div>
          </>
        )}

        <ApplicationDrawer
          applicationId={selectedAppId}
          onClose={() => setSelectedAppId(null)}
          onChanged={() => void fetchRows()}
        />
      </div>
    </div>
  );
}