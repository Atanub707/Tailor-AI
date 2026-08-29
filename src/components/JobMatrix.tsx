import React from 'react';
import { Job, JobState, JobSource } from '../types';
import { formatTimeAgoSemantic } from '../lib/dateUtils';
import { getValidJobUrl } from '../lib/jobUrlUtils';
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
  onReviewApplication?: (applicationId: string) => void;
  reviewNonce?: number;
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
  onReviewApplication,
  reviewNonce,
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
  onReviewApplication?: (applicationId: string) => void;
  reviewNonce?: number;
}) {
  const timeAgoStr = formatTimeAgoSemantic(job.postedDate, job.postedDateSemantics);
  const isScoreLoading = scoreMsg !== null;
  const isTailorLoading = tailorMsg !== null;
  const [fit, setFit] = React.useState<{ score: number; grade: string; strengths: string[]; gaps: string[]; blockers: string[]; unknowns: string[]; coverage?: string; fromCache?: boolean } | null>(null);
  const [fitLoading, setFitLoading] = React.useState(false);
  const [fitOpen, setFitOpen] = React.useState(false);
  const matchRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (matchRef.current && !matchRef.current.contains(t)) setFitOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Match: deterministic candidate fit — computed on demand, cached server-side.
  const openMatch = async () => {
    if (fitOpen) { setFitOpen(false); return; }
    if (fit && !fitLoading) { setFitOpen(true); return; }
    setFitLoading(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/fit`, { method: 'POST' });
      if (res.ok) {
        const d = await res.json();
        setFit({ score: d.score, grade: d.grade, strengths: d.strengths || [], gaps: d.gaps || [], blockers: d.blockers || [], unknowns: d.unknowns || [], coverage: d.coverage, fromCache: d.fromCache });
        setFitOpen(true);
      }
    } catch { /* match unavailable — leave indicator neutral */ }
    finally { setFitLoading(false); }
  };

  // Apply: orchestrate preparation in place — the job list stays put and
  // the card shows the application status inline. The detail drawer (with
  // questions/review/approve) opens on demand via Review — no redirect.
  // Final provider submission stays user-triggered.
  const [applying, setApplying] = React.useState(false);
  const [applyError, setApplyError] = React.useState('');
  const [applyStage, setApplyStage] = React.useState<'idle' | 'preparing' | 'tailoring'>('idle');
  const [tailorVersion, setTailorVersion] = React.useState<number | null>(null);
  const [tailorChecked, setTailorChecked] = React.useState(false);
  const [appRow, setAppRow] = React.useState<{ applicationId: string; userStatus: string } | null>(null);
  React.useEffect(() => {
    let alive = true;
    fetch(`/api/jobs/${job.id}/tailor-v2/latest`)
      .then((r) => (r.ok ? r.json() : { version: null }))
      .then((d) => { if (alive) { setTailorVersion(d.version ?? null); setTailorChecked(true); } })
      .catch(() => { if (alive) setTailorChecked(true); });
    return () => { alive = false; };
  }, [job.id]);
  // Refresh the inline application status whenever the drawer changes it.
  React.useEffect(() => {
    if (!appRow) return;
    let alive = true;
    fetch('/api/applications')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        const found = (d.applications || []).find((x: { applicationId: string }) => x.applicationId === appRow.applicationId);
        if (found) setAppRow({ applicationId: found.applicationId, userStatus: found.userStatus });
      })
      .catch(() => { /* keep last known status */ });
    return () => { alive = false; };
  }, [appRow?.applicationId, reviewNonce]);
  const apply = async () => {
    if (applying) return; // double-click guard
    setApplying(true);
    setApplyStage('preparing');
    setApplyError('');
    // No job-specific tailored CV yet → the server auto-generates one; show
    // the honest stage once the request is clearly past instant work.
    const slowTailorTimer = window.setTimeout(() => {
      setApplyStage((s) => (s === 'preparing' ? 'tailoring' : s));
    }, 900);
    try {
      const res = await fetch(`/api/jobs/${job.id}/application-package`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoTailor: true }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        const msg = d.error || 'Could not prepare the application.';
        if (msg.includes('description') || msg.includes('JD')) {
          // JD-less posting: show an inline notice instead of a dead-end alert.
          setApplyError(msg);
        } else {
          alert(`Could not prepare the application. ${msg}`);
        }
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (d.tailorVersion && typeof d.tailorVersion === 'number') setTailorVersion(d.tailorVersion);
      if (d.autoTailorError) {
        setApplyError(`Could not tailor a CV for this job — Master CV will be attached instead. ${d.autoTailorError}`);
      } else if (d.cvSource === 'MASTER_CV') {
        setApplyError('No tailored CV for this job yet — Master CV attached. You can tailor it later from Job Details.');
      }
      // Stay on the list — track the prepared application for the inline chip.
      const appId = d.application?.applicationId || d.package?.id;
      if (appId) {
        const listRes = await fetch('/api/applications');
        if (listRes.ok) {
          const ld = await listRes.json();
          const found = (ld.applications || []).find((x: { applicationId: string }) => x.applicationId === appId);
          if (found) setAppRow({ applicationId: found.applicationId, userStatus: found.userStatus });
          else setAppRow({ applicationId: appId, userStatus: 'PREPARING' });
        } else {
          setAppRow({ applicationId: appId, userStatus: 'PREPARING' });
        }
      }
    } catch (err: any) {
      alert(`Could not prepare the application. ${String(err?.message || 'Please try again.')}`);
    } finally {
      window.clearTimeout(slowTailorTimer);
      setApplyStage('idle');
      setApplying(false);
    }
  };
  const openReview = () => {
    if (appRow && onReviewApplication) onReviewApplication(appRow.applicationId);
  };

  const FIT_GRADE_COLOR: Record<string, string> = { Excellent: 'text-emerald-700', Strong: 'text-emerald-700', Good: 'text-amber-700', Partial: 'text-orange-700', Weak: 'text-red-700' };

  return (
    <div className={`bg-white border rounded-lg p-4 transition-all shadow-xs hover:shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 group ${
      job.state === 'applied'
        ? 'border-green-300 hover:border-green-400 border-l-4 border-l-green-500'
        : 'border-slate-200 hover:border-slate-300'
    }`}>
      {/* Details — click opens Job Details */}
      <div className="space-y-1.5 flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Source tag (external link) */}
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
          {timeAgoStr && (
            <span className="inline-flex items-center space-x-1 text-[11px] text-slate-500 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
              <Calendar className="w-3 h-3 text-slate-400" />
              <span>{timeAgoStr}</span>
            </span>
          )}
          {job.jobType && (
            <span className="text-[11px] text-slate-600 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
              {job.jobType === 'Full-time' ? 'Full-time · Not stated' : job.jobType}
            </span>
          )}
          {job.applicantCount !== undefined && (
            <span className="inline-flex items-center space-x-1 text-[11px] px-2 py-0.5 rounded border text-slate-600 bg-slate-50 border-slate-200">
              <Users className="w-3 h-3 text-slate-400" />
              <span>{applicantCountLabel(job)}</span>
            </span>
          )}
        </div>

        {/* Title (click → details) */}
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
            {job.salaryText && job.salaryText !== 'Salary not mentioned' && (
              <span className="flex items-center space-x-1 text-green-700 font-medium">
                <DollarSign className="w-3.5 h-3.5 text-green-600" />
                <span>{job.salaryText}</span>
              </span>
            )}
          </div>
          {(job.gapAnalysis?.matchingSkills?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {job.gapAnalysis.matchingSkills.slice(0, 4).map((skill) => (
                <span key={skill} className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10.5px] font-medium">
                  <CheckCircle2 className="w-2.5 h-2.5 text-blue-500 mr-1" />
                  {skill}
                </span>
              ))}
              {(job.gapAnalysis.matchingSkills.length ?? 0) > 4 && (
                <span className="text-[10.5px] text-slate-400 font-medium">+{(job.gapAnalysis.matchingSkills.length ?? 0) - 4} more</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right: Match · View · Apply · overflow */}
      <div className="flex flex-wrap items-center justify-between md:justify-end gap-2.5 border-t md:border-t-0 md:border-l border-slate-100 pt-3 md:pt-0 md:pl-4 shrink-0">
        <div className="relative" ref={matchRef}>
          <button
            onClick={() => void openMatch()}
            disabled={fitLoading}
            aria-label="Check candidate match for this job"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border transition-colors cursor-pointer disabled:opacity-60 bg-white border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)]"
          >
            {fitLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {fit ? (
              <>
                <span className={`${FIT_GRADE_COLOR[fit.grade] || 'text-slate-700'}`}>{fit.score}% Match</span>
                <span className="text-[9px] uppercase tracking-wide text-[var(--color-faint)]">{fit.grade}</span>
              </>
            ) : (
              <span>Check match</span>
            )}
          </button>
          {fitOpen && fit && (
            <div className="absolute right-0 top-11 z-40 w-80 rounded-xl border border-[var(--color-border)] bg-white shadow-lg p-4 text-left max-h-96 overflow-y-auto">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-bold text-[var(--color-ink)]">{fit.score}% Match</span>
                <span className={`text-xs font-black ${FIT_GRADE_COLOR[fit.grade] || 'text-slate-700'}`}>{fit.grade}</span>
              </div>
              {fit.coverage && <div className="text-[11px] text-[var(--color-faint)]">Coverage: {fit.coverage}</div>}
              {fit.strengths.length > 0 && (
                <div className="mt-2"><div className="text-[10px] font-bold uppercase tracking-widest text-emerald-700">Strengths</div>
                  {fit.strengths.slice(0, 5).map((s, i) => <div key={i} className="text-xs text-[var(--color-ink)]">• {s}</div>)}
                </div>
              )}
              {fit.gaps.length > 0 && (
                <div className="mt-2"><div className="text-[10px] font-bold uppercase tracking-widest text-amber-700">Gaps</div>
                  {fit.gaps.slice(0, 5).map((s, i) => <div key={i} className="text-xs text-amber-800">• {s}</div>)}
                </div>
              )}
              {fit.blockers.length > 0 && (
                <div className="mt-2"><div className="text-[10px] font-bold uppercase tracking-widest text-red-700">Blockers</div>
                  {fit.blockers.slice(0, 3).map((s, i) => <div key={i} className="text-xs text-red-800">• {s}</div>)}
                </div>
              )}
              {fit.unknowns.length > 0 && (
                <div className="mt-2 text-[11px] text-[var(--color-faint)]">{fit.unknowns.length} unknown factor{fit.unknowns.length > 1 ? 's' : ''}</div>
              )}
            </div>
          )}
        </div>

        {/* View */}
        <button
          onClick={() => onSelectJob(job)}
          className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-white hover:bg-[var(--color-brand-soft)] border border-[var(--color-hairline)] text-[var(--color-muted)] transition-colors cursor-pointer min-h-[38px]"
        >
          View
        </button>

        {applyError && (
          <div className="mt-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-[520px]" role="status">
            {applyError}
          </div>
        )}

        {/* Apply — primary. Stays on the list; status shows inline. */}
        <button
          type="button"
          onClick={() => void apply()}
          disabled={applying}
          className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--color-cta)] hover:bg-[#047857] transition-colors cursor-pointer disabled:opacity-60 min-h-[38px]"
        >
          {applying
            ? applyStage === 'tailoring' ? 'Tailoring CV…' : 'Preparing…'
            : tailorVersion ? `Apply (Tailored CV v${tailorVersion})` : 'Apply'}
        </button>

        {/* Review — opens the application detail drawer on this page */}
        {appRow && onReviewApplication && (
          <button
            type="button"
            onClick={openReview}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-[var(--color-brand)] hover:opacity-90 transition-colors cursor-pointer min-h-[38px]"
          >
            Review
          </button>
        )}

        {/* Inline application status chip */}
        {appRow && (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${(appRow.userStatus === 'ACTION_REQUIRED' ? 'bg-amber-50 text-amber-800 border-amber-200' : appRow.userStatus === 'APPLIED' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : appRow.userStatus === 'PREPARING' ? 'bg-slate-50 text-slate-700 border-slate-200' : 'bg-sky-50 text-sky-800 border-sky-200')}`} data-qa="inline-app-status">
            {appRow.userStatus === 'ACTION_REQUIRED' ? '⚠ ' : ''}{appRow.userStatus === 'PREPARING' ? 'Preparing' : appRow.userStatus === 'READY' ? 'Ready' : appRow.userStatus === 'APPLIED' ? '✓ Applied' : appRow.userStatus === 'WAITING_FOR_YOU' ? 'Waiting for you' : appRow.userStatus === 'READY_TO_SUBMIT' ? 'Ready to submit' : appRow.userStatus === 'MANUAL_REQUIRED' ? 'Manual' : appRow.userStatus === 'CHECK_SUBMISSION' ? 'Check submission' : appRow.userStatus}
          </span>
        )}

        {/* Mark as applied */}
        <button
          onClick={() => onUpdateStatus(job.id, job.state === 'applied' ? 'pending' : 'applied')}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white hover:bg-[var(--color-brand-soft)] border border-[var(--color-hairline)] text-[var(--color-muted)] transition-colors cursor-pointer min-h-[38px]"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> {job.state === 'applied' ? 'Unmark applied' : 'Mark as applied'}
        </button>

        {/* Remove job — no confirmation */}
        <button
          onClick={() => onDeleteJob(job.id)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors cursor-pointer min-h-[38px]"
        >
          <Trash2 className="w-3.5 h-3.5" /> Remove
        </button>
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
  onReviewApplication,
  reviewNonce,
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
                onReviewApplication={onReviewApplication}
                reviewNonce={reviewNonce}
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
