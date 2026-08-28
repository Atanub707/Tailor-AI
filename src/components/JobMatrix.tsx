import React from 'react';
import { Job, JobState, JobSource } from '../types';
import { formatTimeAgoSemantic } from '../lib/dateUtils';
import { getValidJobUrl } from '../lib/jobUrlUtils';
import { DownloadCvDropdown } from './DownloadCvDropdown';
import { applicantCountLabel } from '../lib/applicantInfo';
import {
  Briefcase,
  Zap,
  Sparkles,
  Search,
  ChevronRight,
  ChevronLeft,
  Trash2,
  CheckCircle2,
  Clock,
  Building2,
  MapPin,
  DollarSign,
  Loader2,
  TrendingUp,
  User,
  Calendar,
  ExternalLink,
  Users,
} from 'lucide-react';

interface JobMatrixProps {
  jobs: Job[];
  totalJobs: number;
  stats: { total: number; pending: number; matched: number; tailored: number; applied: number; scoredCount: number; avgScore: number; byState: Record<string, number> };
  activeStateTab: 'all' | JobState;
  onStateTabChange: (tab: 'all' | JobState) => void;
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  sourceFilter: 'all' | JobSource;
  setSourceFilter: (v: 'all' | JobSource) => void;
  sortBy: 'createdAt' | 'postedDate' | 'matchScore' | 'salaryMax';
  setSortBy: (v: 'createdAt' | 'postedDate' | 'matchScore' | 'salaryMax') => void;
  page: number;
  setPage: (v: number) => void;
  pageSize: number;
  setPageSize: (v: number) => void;
  onSelectJob: (job: Job) => void;
  onOpenRecruiter?: (job: Job) => void;
  onSelectTailoredReview: (job: Job) => void;
  onMatchJob: (jobId: string) => Promise<void>;
  onTailorJob: (jobId: string) => Promise<void>;
  onDeleteJob: (jobId: string) => Promise<void>;
  onUpdateStatus: (jobId: string, state: JobState) => Promise<void>;
  onClearAll: () => Promise<void>;
  loadingJobIds: Set<string>;
  scoreMessages: Record<string, string[]>;
  tailorMessages: Record<string, string[]>;
}


// ── Fit Engine V1 — deterministic applicant ↔ job fit (self-contained) ──
interface FitView {
  score: number;
  grade: string;
  strengths: string[];
  gaps: string[];
  blockers: string[];
  unknowns: string[];
  coverage?: string;
  fromCache?: boolean;
}

const FIT_GRADE_COLOR: Record<string, string> = {
  Excellent: 'text-emerald-600',
  Strong: 'text-emerald-600',
  Good: 'text-amber-600',
  Partial: 'text-orange-600',
  Weak: 'text-red-600',
};

function JobFit({ jobId }: { jobId: string }) {
  const [fit, setFit] = React.useState<FitView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState('');

  const run = async () => {
    if (fit && !loading) { setOpen(!open); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/jobs/${jobId}/fit`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Fit failed.');
      }
      const data = await res.json();
      setFit({ score: data.score, grade: data.grade, strengths: data.strengths || [], gaps: data.gaps || [], blockers: data.blockers || [], unknowns: data.unknowns || [], coverage: data.assessmentCoverage?.confidence, fromCache: data.fromCache });
      setOpen(true);
    } catch (e: any) {
      setError(String(e?.message || 'Fit failed.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={run}
        disabled={loading}
        className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-white hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)] text-[var(--color-muted)] border-[1.5px] border-[var(--color-hairline)] transition-colors disabled:opacity-50"
        title="Deterministic candidate–job fit score"
      >
        {loading ? 'Fit…' : fit ? `Fit ${fit.score}%` : 'Fit'}
      </button>
      {error && <span className="text-[10px] text-red-600 block">{error}</span>}
      {fit && open && (
        <div className="absolute right-0 top-10 z-30 w-72 rounded-xl border border-[var(--color-border)] bg-white shadow-lg p-4 text-left">
          <div className="flex items-baseline justify-between">
            <span className="text-lg font-black text-[var(--color-ink)]">{fit.score}<span className="text-xs font-bold text-slate-400">/100</span></span>
            <span className={`text-xs font-black ${FIT_GRADE_COLOR[fit.grade] || 'text-slate-500'}`}>{fit.grade} Fit</span>
          </div>
          {fit.coverage && (
            <div className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">Assessment coverage: {fit.coverage}</div>
          )}
          {fit.blockers.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-red-600">Potential blocker</div>
              {fit.blockers.slice(0, 3).map((b, i) => <div key={i} className="text-xs text-red-700">• {b}</div>)}
            </div>
          )}
          {fit.strengths.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-600">Strengths</div>
              {fit.strengths.slice(0, 5).map((s2, i) => <div key={i} className="text-xs text-[var(--color-ink)] truncate" title={s2}>• {s2}</div>)}
            </div>
          )}
          {fit.gaps.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-orange-600">Gaps</div>
              {fit.gaps.slice(0, 5).map((g, i) => <div key={i} className="text-xs text-[var(--color-ink)] truncate" title={g}>• {g}</div>)}
            </div>
          )}
          {fit.unknowns.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Unknown</div>
              {fit.unknowns.slice(0, 3).map((u, i) => <div key={i} className="text-xs text-slate-500 truncate" title={u}>• {u}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ── Tailor V2 — grounded tailoring with fact verification (self-contained) ──
function JobTailorV2({ jobId }: { jobId: string }) {
  const [state, setState] = React.useState<'idle' | 'tailoring' | 'verifying' | 'ready' | 'error'>('idle');
  const [summary, setSummary] = React.useState('');
  const [error, setError] = React.useState('');

  const run = async () => {
    setState('tailoring');
    setError('');
    try {
      const res = await fetch(`/api/jobs/${jobId}/tailor-v2`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Tailor V2 failed.');
      }
      const data = await res.json();
      setState('verifying');
      await new Promise((r) => setTimeout(r, 50));
      if (!data.verification?.passed) throw new Error('Tailoring failed factual verification.');
      setState('ready');
      const v = data.verification;
      setSummary(`Verification Passed · Supported JD coverage ${v.supportedJdTermsAfter}/${v.supportedJdTermsAfter + v.unsupportedInserted || 0} · Unsupported claims: ${v.unsupportedInserted} · v${data.version}`);
    } catch (e: any) {
      setState('error');
      setError(String(e?.message || 'Tailor V2 failed.'));
    }
  };

  return (
    <div className="relative">
      <button
        onClick={run}
        disabled={state === 'tailoring' || state === 'verifying'}
        className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-[var(--color-brand-soft)] hover:bg-white hover:border-[var(--color-brand-line)] text-[var(--color-ink)] border-[1.5px] border-[var(--color-brand-line)] transition-colors disabled:opacity-50"
        title="Tailor V2 — grounded resume tailoring with factual verification"
      >
        {state === 'tailoring' ? 'Tailoring…' : state === 'verifying' ? 'Verifying…' : state === 'ready' ? 'Re-Tailor V2' : 'Tailor V2'}
      </button>
      {state === 'ready' && (
        <div className="absolute right-0 top-10 z-30 w-72 rounded-xl border border-[var(--color-border)] bg-white shadow-lg p-4 text-left">
          <div className="text-xs font-bold text-emerald-600">Tailored Resume · Verification Passed</div>
          <div className="text-[10px] text-[var(--color-faint)] mt-1">{summary}</div>
          <a href={`/api/jobs/${jobId}/tailor-v2/pdf`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-bold px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90">
            Download PDF
          </a>
        </div>
      )}
      {state === 'error' && <span className="text-[10px] text-red-600 block">{error}</span>}
    </div>
  );
}


// ── Application Package V1 — prepare-only review surface (no submission) ──
function JobApplyPackage({ jobId }: { jobId: string }) {
  const [state, setState] = React.useState<'idle' | 'preparing' | 'done' | 'error'>('idle');
  const [pkg, setPkg] = React.useState<any>(null);
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState('');
  const [input, setInput] = React.useState<Record<string, string>>({});

  const prepare = async () => {
    setState('preparing');
    setError('');
    try {
      const res = await fetch(`/api/jobs/${jobId}/application-package`, { method: 'POST' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Preparation failed.'); }
      const d = await res.json();
      setPkg(d.package);
      setState('done');
      setOpen(true);
    } catch (e: any) {
      setState('error');
      setError(String(e?.message || 'Preparation failed.'));
    }
  };

  const supply = async (key: string, value: string) => {
    if (!pkg) return;
    const res = await fetch(`/api/application-packages/${pkg.id}/answers`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }),
    });
    if (res.ok) {
      const d = await res.json();
      setPkg(d.package);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || 'Failed to save answer.');
    }
  };

  const statusColor: Record<string, string> = { READY: 'text-emerald-600', NEEDS_INPUT: 'text-amber-600', STALE: 'text-orange-600', DRAFT: 'text-slate-500' };
  const statusLabel: Record<string, string> = { READY: 'Ready to Apply', NEEDS_INPUT: 'Needs your input', STALE: 'Application package is out of date', DRAFT: 'Application preparation incomplete' };

  return (
    <div className="relative">
      <button
        onClick={prepare}
        disabled={state === 'preparing'}
        className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-white hover:bg-[var(--color-brand-soft)] border-[1.5px] border-[var(--color-brand-line)] text-[var(--color-muted)] disabled:opacity-50"
        title="Prepare an immutable application package (no submission)"
      >
        {state === 'preparing' ? 'Preparing…' : 'Prepare Application'}
      </button>
      {error && <span className="text-[10px] text-red-600 block">{error}</span>}
      {pkg && open && (
        <div className="absolute right-0 top-10 z-40 w-80 rounded-xl border border-[var(--color-border)] bg-white shadow-lg p-4 text-left max-h-[28rem] overflow-y-auto">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-bold text-[var(--color-ink)]">{pkg.jobSnapshot.title}</span>
            <span className={`text-xs font-black ${statusColor[pkg.status] || ''}`}>{statusLabel[pkg.status] || pkg.status}</span>
          </div>
          <div className="text-xs text-[var(--color-faint)]">{pkg.jobSnapshot.company} · v{pkg.version} · Fit {pkg.fitSnapshot?.score}% ({pkg.fitSnapshot?.grade})</div>
          {pkg.resumeSnapshot && (
            <div className="mt-2 text-xs text-emerald-700">Tailored Resume v{pkg.resumeSnapshot.version} · Verification Passed</div>
          )}
          {!pkg.resumeSnapshot && <div className="mt-2 text-xs text-slate-500">No verified tailored resume — run Tailor V2 first.</div>}
          <div className="mt-2 text-xs text-[var(--color-ink)]">
            Answers: {pkg.answers.filter((a: any) => a.status === 'RESOLVED').length} resolved · {pkg.answers.filter((a: any) => a.status !== 'RESOLVED').length} missing
          </div>
          {pkg.validation.missingPrerequisites.length > 0 && (
            <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 p-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Preparation</div>
              {pkg.validation.missingPrerequisites.slice(0, 4).map((p2: string, i: number) => (
                <div key={i} className="text-xs text-slate-600">• {p2}</div>
              ))}
            </div>
          )}
          {pkg.validation.needsInput.length > 0 && (
            <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-amber-700">Needs your input</div>
              {pkg.validation.needsInput.slice(0, 4).map((n: string, i: number) => (
                <div key={i} className="mt-1 text-xs text-amber-800">{n}</div>
              ))}
            </div>
          )}
          {pkg.validation.blockers.length > 0 && (
            <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 p-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Blockers</div>
              {pkg.validation.blockers.slice(0, 3).map((b: string, i: number) => (
                <div key={i} className="text-xs text-slate-600">• {b}</div>
              ))}
            </div>
          )}
          {pkg.answers.filter((a: any) => a.status === 'MISSING' && ['authorizedToWork', 'requiresSponsorship'].includes(a.key)).length > 0 && (
            <div className="mt-2 space-y-2">
              {pkg.answers.filter((a: any) => a.status === 'MISSING' && ['authorizedToWork', 'requiresSponsorship'].includes(a.key)).map((a: any) => (
                <div key={a.key} className="flex items-center gap-2">
                  <input
                    className="w-full text-xs border border-[var(--color-border)] rounded px-2 py-1"
                    placeholder={a.label}
                    value={input[a.key] || ''}
                    onChange={(e) => setInput((p) => ({ ...p, [a.key]: e.target.value }))}
                  />
                  <button onClick={() => supply(a.key, input[a.key] || '')} className="text-xs font-bold px-2 py-1 rounded bg-[var(--color-accent)] text-white">Save</button>
                </div>
              ))}
            </div>
          )}
          {pkg.generatedContent?.coverLetter && <div className="mt-2 text-xs text-[var(--color-ink)]">Cover letter: {pkg.generatedContent.coverLetter.verified ? 'verified' : 'not verified'}</div>}
        </div>
      )}
    </div>
  );
}


// ── Application Engine V1 — Prepare for Application (dry-run, no submission) ──
function JobPrepareApplication({ jobId, packageId, packageStatus }: { jobId: string; packageId?: string; packageStatus?: string }) {
  const [state, setState] = React.useState<'idle' | 'preparing' | 'done' | 'error'>('idle');
  const [plan, setPlan] = React.useState<any>(null);
  const [preview, setPreview] = React.useState<any>(null);
  const [error, setError] = React.useState('');

  const prepare = async () => {
    setState('preparing');
    setError('');
    try {
      let pid = packageId;
      if (!pid) {
        const pkgRes = await fetch(`/api/jobs/${jobId}/application-package`);
        if (!pkgRes.ok) throw new Error('Create an Application Package first.');
        const pkgData = await pkgRes.json();
        pid = pkgData.package?.id;
        if (!pid) throw new Error('Create an Application Package first.');
      }
      const res = await fetch(`/api/application-packages/${pid}/plan`, { method: 'POST' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Preparation failed.'); }
      const d = await res.json();
      setPlan(d.plan);
      const pv = await fetch(`/api/submission-plans/${d.plan.id}/preview`).then((r) => r.json());
      setPreview(pv.preview);
      setState('done');
    } catch (e: any) {
      setState('error');
      setError(String(e?.message || 'Preparation failed.'));
    }
  };

  const statusLabel: Record<string, string> = { NEEDS_INPUT: 'Needs Input', NEEDS_REVIEW: 'Needs Review', READY_TO_SUBMIT: 'Ready for Submission', UNSUPPORTED: 'Unsupported' };
  const jobApplyUrlHref = preview?.inspection?.url || undefined;
  const inspectionErrorText = (msg: string) => {
    const k = msg.toLowerCase();
    if (k.includes('challenge')) return 'Lever temporarily blocked form inspection. Try again later or open the application manually.';
    if (k.includes('rate')) return 'Lever is limiting requests. Try again later.';
    if (k.includes('not implemented')) return 'Provider inspection is not implemented yet. Open the application manually.';
    if (k.includes('timeout') || k.includes('did not respond')) return 'Lever did not respond in time. Try again later.';
    if (k.includes('form') || k.includes('understood') || k.includes('parse')) return 'This Lever application form could not be understood safely.';
    return String(msg).slice(0, 160);
  };
  const statusColor: Record<string, string> = { NEEDS_INPUT: 'text-amber-600', NEEDS_REVIEW: 'text-orange-600', READY_TO_SUBMIT: 'text-emerald-600', UNSUPPORTED: 'text-slate-500' };

  return (
    <div className="relative">
      <button
        onClick={prepare}
        disabled={state === 'preparing' || packageStatus !== 'READY'}
        className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-white hover:bg-[var(--color-brand-soft)] border-[1.5px] border-[var(--color-brand-line)] text-[var(--color-muted)] disabled:opacity-50"
        title="Prepare for Application — read-only inspection + dry-run (no submission)"
      >
        {state === 'preparing' ? 'Preparing application…' : 'Prepare for Application'}
      </button>
      {error && (
        <div className="mt-1 w-64 rounded-lg bg-red-50 border border-red-200 p-2 text-[10px] text-red-700">
          <div>{inspectionErrorText(error)}</div>
          <a href={jobApplyUrlHref ?? undefined} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[10px] font-bold text-red-800 underline">
            Open application on Lever
          </a>
        </div>
      )}
      {preview && (
        <div className="absolute right-0 top-10 z-50 w-96 rounded-xl border border-[var(--color-border)] bg-white shadow-lg p-4 text-left max-h-[30rem] overflow-y-auto">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-bold text-[var(--color-ink)]">Application Preview</span>
            <span className={`text-xs font-black ${statusColor[preview.status] || ''}`}>{statusLabel[preview.status] || preview.status}</span>
          </div>
          <div className="text-xs text-[var(--color-faint)]">{preview.company} · {preview.role} · Provider: {preview.provider}</div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-muted)]">
            <span>Fields: {preview.fieldCount}</span>
            <span>Required: {preview.requiredCount}</span>
            <span>Mapped: {preview.mappedFields.length}</span>
            <span>Needs input: {preview.requiredUnresolvedCount}</span>
            <span>Optional: {preview.optionalUnresolvedCount}</span>
            <span>Needs review: {preview.consent.length + preview.eeoManual.length}</span>
            <span>Resume: {preview.resumeRequired ? 'Required' : 'Optional'}</span>
            <span>EEO: {preview.eeoPresent ? 'Present' : 'Not detected'}</span>
            <span>Consent: {preview.consentPresent ? 'Present' : 'Not detected'}</span>
          </div>
          {preview.inspection && (
            <div className="mt-1 text-[10px] text-[var(--color-faint)]">
              Inspection: {preview.inspection.adapter.includes('Lever') ? 'Live / Read-only' : 'Fixture'} · {preview.inspection.version} · {new Date(preview.inspection.inspectedAt).toLocaleString()}
            </div>
          )}
          {preview.resume && <div className="mt-1 text-xs text-emerald-700">Resume artifact: {preview.resume.artifactHash?.slice(0, 12)}…</div>}
          <div className="mt-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-faint)]">Mapped ({preview.mappedFields.length})</div>
          <div className="text-xs text-[var(--color-ink)]">
            {preview.mappedFields.slice(0, 6).map((m: any, i: number) => (
              <div key={i} className="truncate">• {m.label} → {String(m.value ?? '').slice(0, 40)} <span className="text-[var(--color-faint)]">({m.mappingMethod})</span></div>
            ))}
          </div>
          {preview.unresolved.length > 0 && (
            <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-amber-700">Needs Input ({preview.unresolved.length})</div>
              {preview.unresolved.slice(0, 4).map((u: any, i: number) => <div key={i} className="text-xs text-amber-800">• {u.label}</div>)}
            </div>
          )}
          {preview.consent.length > 0 && (
            <div className="mt-2 rounded-lg bg-orange-50 border border-orange-200 p-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-orange-700">Consent — Requires Review</div>
              {preview.consent.slice(0, 3).map((c: any, i: number) => <div key={i} className="text-xs text-orange-800">• {c.label}</div>)}
            </div>
          )}
          {preview.eeoManual.length > 0 && (
            <div className="mt-2 rounded-lg bg-orange-50 border border-orange-200 p-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-orange-700">Manual / EEO — Requires Review</div>
              {preview.eeoManual.slice(0, 3).map((m: any, i: number) => <div key={i} className="text-xs text-orange-800">• {m.label}</div>)}
            </div>
          )}
          {preview.status === 'READY_TO_SUBMIT' && (
            <div className="mt-2 text-[10px] text-[var(--color-faint)]">Submission will be enabled after provider adapter validation.</div>
          )}
        </div>
      )}
    </div>
  );
}

const JobCard = React.memo(function JobCard({
  job,
  scoreMsg,
  tailorMsg,
  onSelectJob,
  onOpenRecruiter,
  onSelectTailoredReview,
  onMatchJob,
  onTailorJob,
  onDeleteJob,
  onUpdateStatus,
}: {
  job: Job;
  scoreMsg: string[] | null;
  tailorMsg: string[] | null;
  onSelectJob: (job: Job) => void;
  onOpenRecruiter?: (job: Job) => void;
  onSelectTailoredReview: (job: Job) => void;
  onMatchJob: (jobId: string) => Promise<void>;
  onTailorJob: (jobId: string) => Promise<void>;
  onDeleteJob: (jobId: string) => Promise<void>;
  onUpdateStatus: (jobId: string, state: JobState) => Promise<void>;
}) {
  const score = job.matchScore;
  const timeAgoStr = formatTimeAgoSemantic(job.postedDate, job.postedDateSemantics);
  const isScoreLoading = scoreMsg !== null;
  const isTailorLoading = tailorMsg !== null;

  return (
    <div className={`bg-white border rounded-lg p-4 transition-all shadow-xs hover:shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 group ${
      job.state === 'applied'
        ? 'border-green-300 hover:border-green-400 border-l-4 border-l-green-500'
        : 'border-slate-200 hover:border-slate-300'
    }`}>
      {/* Left Section: Details */}
      <div className="space-y-1.5 flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Source Tag (Clickable direct link) */}
          <a
            href={getValidJobUrl(job)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`Open ${job.source} job post in new tab`}
            className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all cursor-pointer hover:underline ${
              job.source === 'LinkedIn'
                ? 'bg-[var(--color-tint-blue)] hover:bg-[#DBEAFE] text-[var(--color-brand)] border border-[var(--color-brand-line)]'
                : job.source === 'LinkedInPosts'
                ? 'bg-[#F5F3FF] hover:bg-[#EDE9FE] text-[#7C3AED] border border-[#E9D5FF]'
                : job.source === 'Glassdoor'
                ? 'bg-[var(--color-tint-emerald)] hover:bg-[#D1FAE5] text-[#047857] border border-[var(--color-cta-line)]'
                : job.source === 'Indeed'
                ? 'bg-[var(--color-tint-sky)] hover:bg-[#E0F2FE] text-[#0284C7] border border-[#BAE6FD]'
                : job.source === 'Naukri'
                ? 'bg-[var(--color-tint-amber)] hover:bg-[#FEF3C7] text-[#B45309] border border-[#FDE68A]'
                : job.source === 'Upwork'
                ? 'bg-[var(--color-tint-teal)] hover:bg-[#CCFBF1] text-[#0F766E] border border-[#99F6E4]'
                : job.source === 'Arbeitnow'
                ? 'bg-[var(--color-tint-orange)] hover:bg-[#FFEDD5] text-[#C2410C] border border-[#FED7AA]'
                : 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[var(--color-muted)] border border-[var(--color-hairline)]'
            }`}
          >
            <span>{job.source}</span>
            <ExternalLink className="w-2.5 h-2.5 text-blue-500 ml-0.5" />
          </a>
          {/* Posted Relative Time — hidden when the real posting time is unknown */}
          {timeAgoStr && (
            <span className="inline-flex items-center space-x-1 text-[11px] text-slate-500 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
              <Calendar className="w-3 h-3 text-slate-400" />
              <span>{timeAgoStr}</span>
            </span>
          )}

          {/* Job Type */}
          {job.jobType && (
            <span
              className="text-[11px] text-slate-600 bg-slate-50 px-2 py-0.5 rounded border border-slate-200"
              title={job.jobType === 'Full-time' ? 'Work mode not stated on the original posting' : undefined}
            >
              {job.jobType === 'Full-time' ? 'Full-time · Not stated' : job.jobType}
            </span>
          )}

          {/* Applicant Count */}
          {(job.applicantCount !== undefined || job.applicantCaption) && (
            <span
              className="inline-flex items-center space-x-1 text-[11px] px-2 py-0.5 rounded border text-slate-600 bg-slate-50 border-slate-200"
              title={job.lowCompetition
                ? "LinkedIn hides exact counts for low-competition jobs — the true count is lower than shown"
                : "Applicants shown as on LinkedIn’s public page — logged-in view may show more"}
            >
              <Users className="w-3 h-3 text-slate-400" />
              <span>{applicantCountLabel(job)}</span>
            </span>
          )}
        </div>

        {/* Title & Company */}
        <div>
          <h3
            onClick={() => onSelectJob(job)}
            className="text-sm font-bold text-slate-900 group-hover:text-[var(--color-brand)] transition-colors cursor-pointer flex items-center space-x-1.5"
          >
            <span className="truncate">{job.title}</span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </h3>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 mt-1">
            <span className="flex items-center space-x-1 font-medium text-slate-800">
              <Building2 className="w-3.5 h-3.5 text-slate-400" />
              <span>{job.company}</span>
            </span>

            <span className="flex items-center space-x-1">
              <MapPin className="w-3.5 h-3.5 text-slate-400" />
              <span>{job.location}</span>
            </span>

            {(job.recruiterName || job.recruiterUrl) && onOpenRecruiter && (
              <button
                onClick={(e) => { e.stopPropagation(); onOpenRecruiter(job); }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--color-brand-soft)] text-[var(--color-brand)] border border-[var(--color-brand-line)] text-[10px] font-bold hover:bg-[#E3E6FD] transition-colors cursor-pointer"
                title="View recruiter details"
              >
                <User className="w-2.5 h-2.5" /> Recruiter
              </button>
            )}

            {(job.salaryText && job.salaryText !== 'Salary not mentioned') && (
              <span className="flex items-center space-x-1 text-green-700 font-medium">
                <DollarSign className="w-3.5 h-3.5 text-green-600" />
                <span>{job.salaryText}</span>
              </span>
            )}
          </div>

          {/* Skills chips (matched skills from the last score/tailoring audit) */}
          {(job.gapAnalysis?.matchingSkills?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {job.gapAnalysis.matchingSkills.slice(0, 4).map((skill) => (
                <span
                  key={skill}
                  className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10.5px] font-medium"
                >
                  <CheckCircle2 className="w-2.5 h-2.5 text-blue-500 mr-1" />
                  {skill}
                </span>
              ))}
              {(job.gapAnalysis.matchingSkills.length ?? 0) > 4 && (
                <span className="text-[10.5px] text-slate-400 font-medium">
                  +{(job.gapAnalysis.matchingSkills.length ?? 0) - 4} more
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Section: Match Score & Action Buttons */}
      <div className="flex items-center justify-between md:justify-end space-x-4 border-t md:border-t-0 md:border-l border-slate-100 pt-3 md:pt-0 md:pl-4 shrink-0">
        {/* Score Pill - clickable to open audit */}
        <div className="text-center min-w-[85px] cursor-pointer" onClick={() => onSelectTailoredReview(job)} title="View tailoring audit">
          <span className="text-[10px] uppercase font-bold text-slate-400 block">
            {job.tailoredCv ? 'Tailored ATS' : 'ATS Score'}
          </span>
          {job.tailoredCv ? (
            (() => {
              const beforeS = job.tailoredCv.audit?.beforeScore ?? score ?? 68;
              const afterS = job.tailoredCv.audit?.afterScore ?? Math.min(98, Math.max(beforeS + 18, 92));
              const boost = afterS - beforeS;
              return (
                <div className="flex flex-col items-center">
                  <div className="flex items-center space-x-1">
                    <span className="text-xs text-slate-400 line-through font-semibold">
                      {beforeS}%
                    </span>
                    <span className="text-base font-black text-emerald-600">
                      {afterS}%
                    </span>
                  </div>
                  <span className="text-[9px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200 inline-flex items-center space-x-0.5">
                    <TrendingUp className="w-2.5 h-2.5 text-emerald-600" />
                    <span>+{boost}%</span>
                  </span>
                </div>
              );
            })()
          ) : score !== undefined ? (
            <span
              className={`text-lg font-extrabold ${
                score >= 80
                  ? 'text-green-600'
                  : score >= 60
                  ? 'text-blue-600'
                  : score >= 40
                  ? 'text-amber-600'
                  : 'text-slate-400'
              }`}
            >
              {score}%
            </span>
          ) : (
            <span className="text-xs text-slate-400 font-medium">--</span>
          )}
        </div>

        {/* Action Button Controls */}
        <div className="flex items-center space-x-1.5">
          {/* Run Match */}
          <div className="relative group">
            <button
              onClick={() => onMatchJob(job.id)}
              disabled={isScoreLoading}
              className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-white hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)] text-[var(--color-muted)] border-[1.5px] border-[var(--color-hairline)] transition-colors flex items-center space-x-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isScoreLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-600" />
              ) : (
                <Zap className="w-3.5 h-3.5" style={{ color: "var(--color-brand)" }} />
              )}
              <span>{score !== undefined ? 'Re-Score' : 'Score'}</span>
            </button>
            {isScoreLoading && scoreMsg && (
              <div className="absolute bottom-full left-0 mb-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-slate-900 text-white shadow-lg pointer-events-none z-10 opacity-0 group-hover:opacity-100 transition-opacity min-w-[180px]">
                <div className="space-y-0.5">
                  {scoreMsg.map((msg, i) => (
                    <div key={i} className={`flex items-center gap-1.5 ${i === scoreMsg.length - 1 ? 'text-white' : 'text-slate-400'}`}>
                      <span>{i === scoreMsg.length - 1 ? '⟳' : '✓'}</span>
                      <span>{msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Fit Engine — deterministic fit score */}
          <JobFit jobId={job.id} />
          <JobTailorV2 jobId={job.id} />
          <JobApplyPackage jobId={job.id} />
          <JobPrepareApplication jobId={job.id} />

          {/* Tailor CV */}
          <div className="relative group">
            <button
              onClick={() => onTailorJob(job.id)}
              disabled={isTailorLoading}
              className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-white hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)] text-[var(--color-muted)] border-[1.5px] border-[var(--color-hairline)] transition-colors flex items-center space-x-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isTailorLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              )}
              <span>{job.tailoredCv ? 'Re-Tailor' : 'Tailor'}</span>
            </button>
            {isTailorLoading && tailorMsg && (
              <div className="absolute bottom-full left-0 mb-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-slate-900 text-white shadow-lg pointer-events-none z-10 opacity-0 group-hover:opacity-100 transition-opacity min-w-[200px]">
                <div className="space-y-0.5">
                  {tailorMsg.map((msg, i) => (
                    <div key={i} className={`flex items-center gap-1.5 ${i === tailorMsg.length - 1 ? 'text-white' : 'text-slate-400'}`}>
                      <span>{i === tailorMsg.length - 1 ? '⟳' : '✓'}</span>
                      <span>{msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Single ATS Download CV Dropdown */}
          {job.tailoredCv && (
            <DownloadCvDropdown jobId={job.id} buttonText="Download CV" size="sm" />
          )}

          {/* Applied Toggle */}
          <button
            onClick={() => onUpdateStatus(job.id, job.state === 'applied' ? 'pending' : 'applied')}
            className={`px-2 py-1.5 rounded-md text-xs font-semibold border transition-colors flex items-center space-x-1 cursor-pointer ${
              job.state === 'applied'
                ? 'bg-green-50 text-green-700 border-green-300'
                : 'bg-white text-slate-500 border-slate-200 hover:border-green-300 hover:text-green-600'
            }`}
            title={job.state === 'applied' ? 'Mark as not applied' : 'Mark as applied'}
          >
            <span>{job.state === 'applied' ? <CheckCircle2 className="w-3.5 h-3.5" /> : '○'}</span>
            <span>{job.state === 'applied' ? 'Applied' : 'Mark Applied'}</span>
          </button>

          {/* Apply Button */}
          <a
            href={getValidJobUrl(job)}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-md text-xs font-semibold text-white bg-[var(--color-cta)] hover:bg-[#059669] transition-colors cursor-pointer"
            title="Open original job posting to apply"
          >
            Apply
          </a>

          {/* Delete */}
          <button
            onClick={() => onDeleteJob(job.id)}
            className="px-2 py-1.5 rounded-md text-xs text-slate-400 hover:text-red-600 hover:bg-red-50 cursor-pointer transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}, (prev, next) => prev.job === next.job && prev.scoreMsg === next.scoreMsg && prev.tailorMsg === next.tailorMsg && prev.onUpdateStatus === next.onUpdateStatus && prev.onSelectTailoredReview === next.onSelectTailoredReview);

export const JobMatrix: React.FC<JobMatrixProps> = ({
  jobs,
  totalJobs,
  stats,
  activeStateTab,
  onStateTabChange,
  searchTerm,
  setSearchTerm,
  sourceFilter,
  setSourceFilter,
  page,
  setPage,
  pageSize,
  setPageSize,
  onSelectJob,
  onOpenRecruiter,
  onSelectTailoredReview,
  onMatchJob,
  onTailorJob,
  onDeleteJob,
  onUpdateStatus,
  onClearAll,
  scoreMessages,
  tailorMessages,
}) => {
  const pendingCount = stats.pending;
  const tailoredCount = stats.tailored;
  const appliedCount = stats.applied;
  const scoredJobsCount = stats.scoredCount;
  const avgScore = stats.avgScore;

  const totalPages = Math.max(1, Math.ceil(totalJobs / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedJobs = jobs;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="bg-[var(--color-tint-blue)] border border-[var(--color-brand-line)] rounded-[14px] p-4">
          <div className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--color-faint)' }}>
            <span>Total Jobs</span>
            <span className="w-7 h-7 rounded-lg bg-white text-[var(--color-brand)] flex items-center justify-center border border-[var(--color-brand-line)]"><Briefcase className="w-3.5 h-3.5" /></span>
          </div>
          <div className="text-[26px] font-extrabold mt-2" style={{ color: 'var(--color-ink)' }}>{stats.total}</div>
          <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--color-faint)' }}>Scraped across sources</p>
        </div>
        <div className="bg-[var(--color-tint-violet)] border border-[#E4E0F5] rounded-[14px] p-4">
          <div className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--color-faint)' }}>
            <span>Avg Match</span>
            <span className="w-7 h-7 rounded-lg bg-white text-[#7C3AED] flex items-center justify-center border border-[#E4E0F5]"><TrendingUp className="w-3.5 h-3.5" /></span>
          </div>
          <div className="text-[26px] font-extrabold mt-2" style={{ color: 'var(--color-ink)' }}>{avgScore}%</div>
          <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--color-faint)' }}>{scoredJobsCount} scored with AI</p>
        </div>
        <div className="bg-[var(--color-tint-emerald)] border border-[var(--color-cta-line)] rounded-[14px] p-4">
          <div className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--color-faint)' }}>
            <span>Tailored CVs</span>
            <span className="w-7 h-7 rounded-lg bg-white text-[var(--color-cta)] flex items-center justify-center border border-[var(--color-cta-line)]"><Sparkles className="w-3.5 h-3.5" /></span>
          </div>
          <div className="text-[26px] font-extrabold mt-2" style={{ color: 'var(--color-ink)' }}>{tailoredCount}</div>
          <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--color-faint)' }}>Ready to download as PDF</p>
        </div>
        <div className="bg-[var(--color-tint-amber)] border border-[#FDE68A] rounded-[14px] p-4">
          <div className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--color-faint)' }}>
            <span>Pending</span>
            <span className="w-7 h-7 rounded-lg bg-white text-[#D97706] flex items-center justify-center border border-[#FDE68A]"><Clock className="w-3.5 h-3.5" /></span>
          </div>
          <div className="text-[26px] font-extrabold mt-2" style={{ color: 'var(--color-ink)' }}>{pendingCount}</div>
          <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--color-faint)' }}>Awaiting batch analysis</p>
        </div>
        <div className="bg-[var(--color-tint-sky)] border border-[#BAE6FD] rounded-[14px] p-4">
          <div className="flex items-center justify-between text-xs font-medium" style={{ color: 'var(--color-faint)' }}>
            <span>Applied</span>
            <span className="w-7 h-7 rounded-lg bg-white text-[#0284C7] flex items-center justify-center border border-[#BAE6FD]"><CheckCircle2 className="w-3.5 h-3.5" /></span>
          </div>
          <div className="text-[26px] font-extrabold mt-2" style={{ color: 'var(--color-ink)' }}>{appliedCount}</div>
          <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--color-faint)' }}>Jobs you applied to</p>
        </div>
      </div>

      {/* Tabs & Batch Actions Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-white border border-[var(--color-hairline)] p-2.5 rounded-[12px]">
        {/* State Filter Tabs */}
        <div className="flex flex-wrap items-center gap-1">
          {(['all', 'pending', 'tailored', 'ready', 'applied'] as const).map((tab) => {
            const count = tab === 'all' ? stats.total : (stats.byState[tab] || 0);
            const labels = {
              all: 'All Jobs',
              pending: 'Pending',
              tailored: 'Tailored',
              ready: 'Ready',
              applied: 'Applied',
            };

            return (
              <button
                key={tab}
                onClick={() => onStateTabChange(tab)}
                className={`px-3.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer flex items-center space-x-1.5 ${
                  activeStateTab === tab
                    ? 'bg-[var(--color-ink)] text-white font-semibold'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-brand)] hover:bg-[var(--color-brand-soft)]'
                }`}
              >
                <span>{labels[tab]}</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                    activeStateTab === tab ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Batch Operations */}
        <div className="flex items-center space-x-3 w-full sm:w-auto justify-end">
          <div className="flex items-center space-x-1.5">
            <span className="text-slate-500 font-medium">Source:</span>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as any)}
              className="bg-white border-[1.5px] border-[var(--color-hairline2)] rounded-[9px] px-2.5 py-1.5 font-semibold cursor-pointer focus:outline-none focus:border-[var(--color-brand)]"
            >
              <option value="all">All Sources</option>
              <option value="LinkedIn">LinkedIn</option>
              <option value="Arbeitnow">Arbeitnow</option>
              <option value="SimplyHired">SimplyHired</option>
              <option value="Dice">Dice</option>
              <option value="MyCareersFuture">MyCareersFuture</option>
              <option value="Cutshort">Cutshort</option>
              <option value="Gupy">Gupy</option>
              <option value="JobsCh">JobsCh</option>
              <option value="Daijob">Daijob</option>
              <option value="MyJobMag">MyJobMag</option>
              <option value="Glassdoor">Glassdoor</option>
              <option value="Custom">Custom</option>
            </select>
          </div>
          <button
            type="button"
            onClick={onClearAll}
            className="px-3 py-2 rounded-lg text-xs font-semibold text-red-600 bg-white hover:bg-red-50 border border-red-200 transition-colors cursor-pointer"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Search & Sort Filter */}
      <div className="bg-white p-2.5 rounded-lg border border-slate-200 text-xs shadow-xs space-y-2">
        <datalist id="matrix-search-suggestions">
          <option value="Frontend" />
          <option value="Full Stack" />
          <option value="DevSecOps" />
          <option value="Software Engineer" />
          <option value="Remote" />
          <option value="Singapore" />
          <option value="Human Managed" />
        </datalist>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              list="matrix-search-suggestions"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search role, company, location..."
              className="w-full bg-[#FAFAF9] border-[1.5px] border-[var(--color-hairline2)] rounded-[9px] pl-8 pr-3 py-1.5 text-xs focus:bg-white focus:outline-none focus:border-[var(--color-brand)]"
            />
          </div>

        </div>

        {/* Quick Matrix Filter Chips */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-100 text-[11px]">
          <span className="text-slate-400 font-medium">Quick Filter:</span>
          {['Frontend', 'Full Stack', 'DevSecOps', 'Remote', 'Singapore'].map((chip) => (
            <button
              type="button"
              key={chip}
              onClick={() => setSearchTerm(searchTerm === chip ? '' : chip)}
              className={`px-2 py-0.5 rounded border transition-all cursor-pointer ${
                searchTerm === chip
                  ? 'bg-[var(--color-brand)] text-white border-[var(--color-brand)] font-semibold'
                  : 'bg-white hover:bg-[var(--color-brand-soft)] text-[var(--color-muted)] border-[var(--color-hairline)]'
              }`}
            >
              {chip}
            </button>
          ))}
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              className="text-slate-400 hover:text-slate-600 font-medium ml-auto cursor-pointer underline"
            >
              Clear filter
            </button>
          )}
        </div>


      </div>

      {/* Job Card List */}
      {paginatedJobs.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-[14px] border border-dashed border-[var(--color-hairline2)]">
          <Briefcase className="w-8 h-8 text-slate-400 mx-auto mb-2" />
          <p className="text-xs font-semibold text-slate-700">No postings match your filter</p>
          <p className="text-[11px] text-slate-400 mt-1 max-w-sm mx-auto">
            Use the scraper above to search for live job listings.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {paginatedJobs.map((job, index) => {
            const itemKey = job.id && job.id !== 'linkedin-undefined' ? job.id : `job-${index}-${job.title}`;
            return (
              <JobCard
                key={itemKey}
                job={job}
                scoreMsg={scoreMessages[job.id] || null}
                tailorMsg={tailorMessages[job.id] || null}
                onSelectJob={onSelectJob}
                onOpenRecruiter={onOpenRecruiter}
                onSelectTailoredReview={onSelectTailoredReview}
                onMatchJob={onMatchJob}
                onTailorJob={onTailorJob}
                onDeleteJob={onDeleteJob}
                onUpdateStatus={onUpdateStatus}
              />
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {paginatedJobs.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white border border-slate-200 rounded-lg px-4 py-3 shadow-xs text-xs">
          <div className="flex items-center space-x-3 text-slate-600">
            <span className="font-medium">{totalJobs} jobs</span>
            <span className="text-slate-300">|</span>
            <div className="flex items-center space-x-1.5">
              <span className="text-slate-500">Show</span>
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-800 font-medium focus:outline-none focus:ring-1 focus:ring-slate-900 cursor-pointer"
              >
                {[5, 10, 25, 50].map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
              <span className="text-slate-500">per page</span>
            </div>
            <span className="text-slate-300">|</span>
            <span className="text-slate-600">
              Page {safePage} of {totalPages}
            </span>
          </div>

          <div className="flex items-center space-x-1">
            <button
              onClick={() => setPage(safePage - 1)}
              disabled={safePage <= 1}
              className="px-2.5 py-1.5 rounded border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>

            {(() => {
              const pages: (number | string)[] = [];
              const range = 2;
              for (let i = 1; i <= totalPages; i++) {
                if (i === 1 || i === totalPages || (i >= safePage - range && i <= safePage + range)) {
                  pages.push(i);
                } else if (pages[pages.length - 1] !== '...') {
                  pages.push('...');
                }
              }
              return pages.map((p, i) =>
                typeof p === 'number' ? (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`px-2.5 py-1.5 rounded border text-xs font-medium transition-colors cursor-pointer ${
                      p === safePage
                        ? 'bg-[var(--color-ink)] text-white border-[var(--color-ink)]'
                        : 'border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)]'
                    }`}
                  >
                    {p}
                  </button>
                ) : (
                  <span key={`ellipsis-${i}`} className="px-1.5 text-slate-400 select-none">...</span>
                )
              );
            })()}

            <button
              onClick={() => setPage(safePage + 1)}
              disabled={safePage >= totalPages}
              className="px-2.5 py-1.5 rounded border border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
