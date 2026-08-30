import React from 'react';
import { Job, JobState, JobSource } from '../types';
import { formatTimeAgoSemantic } from '../lib/dateUtils';
import { getValidJobUrl } from '../lib/jobUrlUtils';
import { applicantCountLabel } from '../lib/applicantInfo';
import { DownloadCvDropdown } from './DownloadCvDropdown';
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
  const [scoreOpen, setScoreOpen] = React.useState(false);
  const scoreRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (scoreRef.current && !scoreRef.current.contains(t)) setScoreOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Score: LLM resume↔JD comparison — click to score, click again for the
  // analysis. Already-scored jobs open instantly (score is cached on the job).
  const openScore = () => {
    if (isScoreLoading) return;
    if (job.matchScore !== undefined && job.gapAnalysis) { setScoreOpen((o) => !o); return; }
    void onMatchJob(job.id);
  };

  // Apply (paused auto-apply): the button links directly to the job post —
  // people complete the application manually on the employer's site.
  // "Applied" keeps the tracking record.
  const SCORE_TONE = (score: number) => (score >= 80 ? 'text-emerald-700' : score >= 60 ? 'text-amber-700' : 'text-red-700');

  return (
    <div className={`bg-white border rounded-lg p-4 transition-all shadow-xs hover:shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 group ${
      job.state === 'applied'
        ? 'border-green-300 hover:border-green-400 border-l-4 border-l-green-500'
        : job.tailoredCv
        ? 'border-emerald-200 hover:border-emerald-300'
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
          {job.state === 'tailored' || job.state === 'matched' || job.state === 'applied' ? (
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-semibold border ${
              job.state === 'tailored' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : job.state === 'matched' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-green-50 text-green-700 border-green-200'
            }`}>
              {job.state === 'tailored' ? 'CV Tailored' : job.state === 'matched' ? 'Matched' : 'Applied'}
            </span>
          ) : null}
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

      {/* Right: ATS score pill · actions */}
      <div className="flex flex-row flex-wrap items-center justify-between md:justify-end gap-3 shrink-0 md:border-l border-slate-100 md:pl-4 md:pr-0 border-t md:border-t-0 pt-3 md:pt-0">

        {/* ATS Score Pill — classic card: '--' → colored % → Tailored ATS
            (before strikethrough → after green + boost badge) */}
        <div className="text-center min-w-[85px]" data-qa="ats-pill">
          <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wide">
            {job.tailoredCv ? 'Tailored ATS' : 'ATS Score'}
          </span>
          {job.tailoredCv ? (
            (() => {
              const beforeS = job.tailoredCv.audit?.beforeScore ?? job.matchScore ?? 68;
              const afterS = job.tailoredCv.audit?.afterScore ?? Math.min(98, Math.max(beforeS + 18, 92));
              const boost = afterS - beforeS;
              return (
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400 line-through font-semibold">{beforeS}%</span>
                    <span className="text-lg font-black text-emerald-600">{afterS}%</span>
                  </div>
                  <span className="text-[9px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 inline-flex items-center gap-0.5">
                    <TrendingUp className="w-2.5 h-2.5 text-emerald-600" />
                    <span>+{boost}%</span>
                  </span>
                </div>
              );
            })()
          ) : job.matchScore !== undefined ? (
            <span className={`text-lg font-extrabold ${SCORE_TONE(job.matchScore)}`}>{job.matchScore}%</span>
          ) : (
            <span className="text-xs text-slate-400 font-medium">--</span>
          )}
        </div>

        <div className="relative group" ref={scoreRef}>
          <button
            onClick={openScore}
            disabled={isScoreLoading}
            aria-label="Score this job against your CV"
            className="inline-flex items-center justify-center gap-1.5 h-[38px] px-3.5 rounded-lg text-xs font-extrabold border transition-colors cursor-pointer disabled:opacity-60 bg-white border-[var(--color-hairline)] text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)]"
          >
            {isScoreLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-[var(--color-brand)]" />}
            <span>{job.matchScore !== undefined ? 'Re-Score' : isScoreLoading ? 'Scoring…' : 'Score'}</span>
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
          {scoreOpen && job.gapAnalysis && (
            <div className="absolute right-0 top-11 z-40 w-80 rounded-xl border border-[var(--color-border)] bg-white shadow-lg p-4 text-left max-h-96 overflow-y-auto">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-bold text-[var(--color-ink)]">{job.gapAnalysis.matchScore ?? job.matchScore}% Match</span>
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-faint)]">AI Score</span>
              </div>
              {job.gapAnalysis.summaryAnalysis && (
                <p className="mt-2 text-xs text-[var(--color-muted)] leading-relaxed">{job.gapAnalysis.summaryAnalysis.slice(0, 300)}{job.gapAnalysis.summaryAnalysis.length > 300 ? '…' : ''}</p>
              )}
              {job.gapAnalysis.salaryFit && job.gapAnalysis.salaryFit !== 'unknown' && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-sky-50 text-sky-800 border border-sky-200">Salary: {job.gapAnalysis.salaryFit}</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-violet-50 text-violet-800 border border-violet-200">Experience: {job.gapAnalysis.experienceFit}</span>
                </div>
              )}
              {(job.gapAnalysis.matchingSkills?.length ?? 0) > 0 && (
                <div className="mt-2"><div className="text-[10px] font-bold uppercase tracking-widest text-emerald-700">Strengths</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {job.gapAnalysis.matchingSkills.slice(0, 8).map((s, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-100 text-[10.5px] font-semibold">{s}</span>)}
                  </div>
                </div>
              )}
              {(job.gapAnalysis.missingSkills?.length ?? 0) > 0 && (
                <div className="mt-2"><div className="text-[10px] font-bold uppercase tracking-widest text-amber-700">Gaps</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {job.gapAnalysis.missingSkills.slice(0, 8).map((s, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-100 text-[10.5px] font-semibold">{s}</span>)}
                  </div>
                </div>
              )}
              {(job.gapAnalysis.keyRecommendations?.length ?? 0) > 0 && (
                <div className="mt-2"><div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-faint)]">Recommendations</div>
                  {job.gapAnalysis.keyRecommendations.slice(0, 3).map((r, i) => <div key={i} className="text-xs text-[var(--color-ink)] mt-0.5">• {r}</div>)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tailor CV — Tailor V1: generates the actual tailored CV via the
            standard template pipeline; Download appears once tailored. */}
        <div className="relative group">
        <button
          type="button"
          onClick={() => onTailorJob(job.id)}
          disabled={isTailorLoading}
          aria-label="Tailor candidate CV for this job"
          title="Tailor candidate CV for this job"
          className="inline-flex items-center justify-center gap-1.5 h-[38px] px-3.5 rounded-lg text-xs font-extrabold bg-slate-900 hover:bg-slate-800 text-white transition-colors cursor-pointer disabled:opacity-60"
        >
          {isTailorLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-emerald-400" />}
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

        {/* Apply — direct link to the job post (auto-apply paused); the
            application is completed manually on the employer's site. */}
        <a
          href={getValidJobUrl(job)}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${job.source} job posting to apply`}
          aria-label={`Apply for ${job.title}`}
          className="inline-flex items-center justify-center h-[38px] px-3.5 rounded-lg text-xs font-extrabold text-white bg-[var(--color-cta)] hover:bg-[#047857] transition-colors cursor-pointer"
        >
          Apply
        </a>

        {/* Applied — always the same label; turns green once applied (click toggles) */}
        <button
          onClick={() => onUpdateStatus(job.id, job.state === 'applied' ? 'pending' : 'applied')}
          title={job.state === 'applied' ? 'Mark as not applied' : 'Mark as applied'}
          aria-pressed={job.state === 'applied'}
          className={`inline-flex items-center justify-center gap-1.5 h-[38px] px-3.5 rounded-lg text-xs font-extrabold border transition-colors cursor-pointer ${
            job.state === 'applied'
              ? 'bg-green-50 text-green-700 border-green-300'
              : 'bg-white text-[var(--color-muted)] border-[var(--color-hairline)] hover:border-green-300 hover:text-green-600'
          }`}
        >
          {job.state === 'applied' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <span className="w-3.5 h-3.5 rounded-full border border-current opacity-60" />}
          <span>Applied</span>
        </button>

        {/* Remove job — no confirmation */}
        <button
          onClick={() => onDeleteJob(job.id)}
          aria-label="Remove job"
          title="Remove job"
          className="inline-flex items-center justify-center h-[38px] w-[38px] rounded-lg text-xs font-extrabold text-red-600 hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors cursor-pointer shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
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
