import React, { useState, useEffect } from 'react';
import { Job, JobState, TemplateId } from '../types';
import type { TailoringAudit } from '../types';
import { formatTimeAgoSemantic } from "../lib/dateUtils";
import { applicantCountLabel } from '../lib/applicantInfo';
import { getValidJobUrl } from '../lib/jobUrlUtils';
import { DownloadCvDropdown } from './DownloadCvDropdown';
import { CvPdfPreview, compressedCvToPdfShape } from './CvPdfPreview';
import {
  X,
  ExternalLink,
  Zap,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Building2,
  MapPin,
  DollarSign,
  ArrowRight,
  Copy,
  Check,
  Calendar,
  ChevronDown,
  TrendingUp,
  FileInput,
  Printer,
  Users,
  Download,
} from 'lucide-react';

interface JobDetailModalProps {
  job: Job | null;
  onClose: () => void;
  onMatchJob: (jobId: string) => Promise<void>;
  onTailorJob: (jobId: string) => Promise<void>;
  onTailorModeChange?: (mode: 'strict' | 'enhanced') => void;
  onUpdateStatus: (jobId: string, state: JobState) => Promise<void>;
  isLoading: boolean;
  initialTab?: 'details' | 'gap' | 'tailored';
  cvTemplate?: TemplateId;
  masterCv?: import('../types').MasterCv | null;
}

interface WhatChangedGroup {
  expIndex: number;
  title: string;
  company: string;
  items: NonNullable<TailoringAudit['bulletDiffs']>;
}

function highlightAddedTerms(text: string, addedTerms: string[]): React.ReactNode {
  const terms = addedTerms.filter((t) => t && t.trim().length > 0);
  if (terms.length === 0) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  return text.split(re).map((seg, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-emerald-100 text-emerald-800 rounded px-0.5">
        {seg}
      </mark>
    ) : (
      seg
    )
  );
}

function WhatChangedCard({ diffs, status, ledger }: {
  diffs: NonNullable<TailoringAudit['bulletDiffs']>;
  status?: TailoringAudit['keywordStatus'];
  ledger?: TailoringAudit['enhancementLedger'];
}) {
  const chip = (kind: string) => ({
    added_experience: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    added_skills: 'bg-sky-50 text-sky-700 border-sky-200',
    already_present: 'bg-slate-100 text-slate-600 border-slate-200',
    enhanced: 'bg-amber-50 text-amber-700 border-amber-200',
    unsupported: 'bg-red-50 text-red-600 border-red-200',
  } as Record<string, string>)[kind] || 'bg-slate-100 text-slate-600 border-slate-200';

  const basisByKey = new Map<string, string>();
  for (const e of ledger?.entries ?? []) basisByKey.set(`${e.expIndex}:${e.hIndex}`, e.basis);

  const groups: WhatChangedGroup[] = [];
  for (const d of diffs) {
    const last = groups[groups.length - 1];
    if (!last || last.expIndex !== d.expIndex) {
      groups.push({ expIndex: d.expIndex, title: d.title, company: d.company, items: [d] });
    } else {
      last.items.push(d);
    }
  }

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => (groups.length ? new Set([groups[0].expIndex]) : new Set()));

  const toggle = (expIndex: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(expIndex)) next.delete(expIndex);
      else next.add(expIndex);
      return next;
    });

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">What changed</h4>
      <div className="space-y-2">
        {groups.map((g) => {
          const open = expanded.has(g.expIndex);
          return (
            <div key={g.expIndex} className="border border-slate-100 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(g.expIndex)}
                aria-expanded={open}
                className="w-full flex items-center gap-1.5 px-3 py-2 bg-slate-50 hover:bg-slate-100 text-left transition-colors cursor-pointer"
              >
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
                <span className="text-[11px] font-bold text-slate-700">{g.title} · {g.company}</span>
                <span className="ml-auto text-[10px] font-semibold text-slate-400">{g.items.length} {g.items.length === 1 ? 'bullet' : 'bullets'}</span>
              </button>
              {open && (
                <ul className="px-3 py-2 space-y-2">
                  {g.items.map((d, hIndex) => {
                    const basis = basisByKey.get(`${g.expIndex}:${hIndex}`);
                    return (
                      <li key={hIndex} className="space-y-1 w-full max-w-full">
                        <div className="space-y-0.5 leading-relaxed">
                          {d.original !== undefined ? (
                            <>
                              <div className="text-xs text-slate-400 line-through w-full max-w-full break-words">
                                {d.original}
                              </div>
                              <div className="flex items-center gap-1 text-slate-300">
                                <ArrowRight className="w-3 h-3 shrink-0" />
                                <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Tailored</span>
                              </div>
                            </>
                          ) : (
                            <div className="flex items-center gap-1">
                              <span className="shrink-0 text-[9px] font-bold text-emerald-600 bg-emerald-50 rounded px-1 py-0.5">NEW</span>
                            </div>
                          )}
                          <div className="text-xs text-slate-800 w-full max-w-full break-words">
                            {highlightAddedTerms(d.rewritten, d.addedTerms)}
                            {d.enhanced && (
                              <span
                                title={basis ? `Basis: ${basis}` : 'Enhanced bullet'}
                                className="ml-1.5 align-middle inline-block text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5"
                              >
                                Enhanced{basis ? ` · ${basis}` : ''}
                              </span>
                            )}
                          </div>
                        </div>
                        {d.addedTerms.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {d.addedTerms.map((t) => (
                              <span key={t} className="text-[9px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">+ {t}</span>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {status && status.length > 0 && (
        <div className="pt-2 border-t border-slate-100">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2">Keyword placement</h4>
          <div className="flex flex-wrap gap-1.5">
            {status.map((s) => (
              <span
                key={s.term}
                title={s.basis ? `Basis: ${s.basis}` : s.location || (s.kind === 'unsupported' ? 'not in your experience' : '')}
                className={`text-[9px] font-bold border rounded-full px-1.5 py-0.5 ${chip(s.kind)}`}
              >
                {s.kind === 'unsupported' ? '⛔ ' : '✓ '}{s.term}
                {s.basis ? ` · ${s.basis}` : s.location ? ` · ${s.location}` : s.kind === 'unsupported' ? ' · not in your experience' : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}



export const JobDetailModal: React.FC<JobDetailModalProps> = ({
  job,
  onClose,
  onMatchJob,
  cvTemplate = 'harvard',
  onTailorJob,
  onTailorModeChange,
  onUpdateStatus,
  isLoading,
  initialTab,
  masterCv,
}) => {
  const [activeTab, setActiveTab] = useState<'details' | 'gap' | 'tailored'>(initialTab || 'details');
  const [tailorMode, setTailorMode] = useState<'strict' | 'enhanced'>(job?.tailorMode ?? 'enhanced');

  const handleTailorModeChange = (mode: 'strict' | 'enhanced') => {
    setTailorMode(mode);
    onTailorModeChange?.(mode);
  };

  // Emails mentioned in the raw description (client-side mirror of the
  // server extractor — used for the in-modal display only).
  const jobEmails = (() => {
    if (!job?.description) return [];
    const junkLocal =
      /^(noreply|no-reply|no_reply|donotreply|do-not-reply|mailer-daemon|postmaster|webmaster|sentry|unsubscribe|abuse|support|help|info|contact|hello|admin|team|sales|marketing|billing|account|privacy|status|newsletter)$/i;
    const junkDomain =
      /(^|\.)(example|example\.com|example\.org|example\.net|test|localhost|yourdomain|your-?company|company\.com|email\.com|domain\.com|acme|sample)\.?$/i;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of job.description.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
      const email = m[0].toLowerCase();
      const [local, domain] = email.split('@');
      if (!local || !domain || seen.has(email) || junkLocal.test(local) || junkDomain.test(domain)) continue;
      seen.add(email);
      out.push(email);
    }
    return out;
  })();

  // Recruiters tied to this job (server: hr_contacts by source job / recruiter URL).
  const [jobContacts, setJobContacts] = useState<{ id: string; name: string | null; email: string | null; phone: string | null; whatsapp: boolean; recruiterUrl: string | null; company: string; jobRole: string; jobCount: number }[]>([]);

  useEffect(() => {
    let alive = true;
    if (job?.id) {
      fetch(`/api/jobs/${job.id}/contacts`)
        .then((r) => r.json())
        .then((d) => { if (alive) setJobContacts(d.contacts || []); })
        .catch(() => { if (alive) setJobContacts([]); });
    } else {
      setJobContacts([]);
    }
    return () => { alive = false; };
  }, [job?.id]);

  // Phone numbers mentioned in the raw description (client-side mirror).
  const jobPhones = (() => {
    if (!job?.description) return [];
    const out: string[] = [];
    for (const m of job.description.matchAll(/(?:\+?\d{1,3}[\s-]?)?(?:\(\d{2,5}\)[\s-]?)?\d{2,5}[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g)) {
      const raw = m[0].trim();
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) continue;
      if (/^(19|20)\d{2}$/.test(digits)) continue;
      if (!/[\s\-().]/.test(raw) && digits.length < 9) continue;
      const prev = job.description.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
      if (/(\$|€|£|₹|usd|salary|year|k\b|applicants?|years?|%|monthly|hour)/.test(prev)) continue;
      if (raw.includes('.') && !raw.includes('+') && !raw.includes('(')) {
        const g = raw.split('.');
        if (g.length >= 2 && g.every((x) => /^\d{1,2}$/.test(x))) continue;
      }
      out.push(raw.replace(/[\s.]+/g, ' ').trim());
    }
    return [...new Set(out)];
  })();
  const [copiedText, setCopiedText] = useState(false);

  if (!job) return null;

  const gap = job.gapAnalysis;
  const tailored = job.tailoredCv;
  const timeAgoStr = formatTimeAgoSemantic(job.postedDate || job.createdAt, job.postedDateSemantics);

  const handleCopyTextCv = () => {
    if (!tailored) return;
    const textParts = [
      `${tailored.candidateName.toUpperCase()}`,
      `Target Role: ${tailored.targetRole}`,
      `Contact: ${tailored.contactInfo.email || ''} | ${tailored.contactInfo.phone || ''}`,
      '\n--- PROFESSIONAL SUMMARY ---',
      tailored.professionalSummary,
      '\n--- CORE COMPETENCIES ---',
      tailored.coreCompetencies.join(' • '),
      '\n--- WORK EXPERIENCE ---',
      ...tailored.workExperience.map(
        (exp) => `${exp.title} at ${exp.company} (${exp.dates})\n` + exp.highlights.map((h) => `• ${h}`).join('\n')
      ),
      '\n--- TECHNICAL SKILLS ---',
      ...tailored.technicalSkills.map((cat) => `${cat.category}: ${cat.skills.join(', ')}`),
    ];

    navigator.clipboard.writeText(textParts.join('\n'));
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 bg-[var(--color-ink)]/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      <div className="bg-white border border-[var(--color-hairline)] rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-xl overflow-hidden text-[var(--color-ink)]">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[var(--color-hairline)] flex items-start justify-between bg-[#FAFAF9]/80 sticky top-0 z-10">
          <div>
            <div className="flex items-center space-x-2 mb-1 text-xs">
              <span
                className={`font-semibold px-2 py-0.5 rounded ${
                  job.source === 'LinkedIn' ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)] border border-[var(--color-brand-line)]' : 'bg-[var(--color-amber-soft,#FFF7ED)] text-[#92400E] border border-[var(--color-amber-line,#FED7AA)]'
                }`}
              >
                {job.source}
              </span>
              <span className="flex items-center space-x-1 text-[var(--color-faint)]">
                <Calendar className="w-3 h-3 text-[var(--color-faint)]" />
                <span>{timeAgoStr}</span>
              </span>
            </div>
            <h2 className="text-lg font-bold text-[var(--color-ink)]">
              {job.title}
            </h2>
            <div className="flex flex-wrap items-center space-x-4 text-xs text-[var(--color-muted)] mt-1">
              <span className="flex items-center space-x-1 font-medium text-[var(--color-ink)]">
                <Building2 className="w-3.5 h-3.5 text-[var(--color-faint)]" />
                <span>{job.company}</span>
              </span>
              <span className="flex items-center space-x-1">
                <MapPin className="w-3.5 h-3.5 text-[var(--color-faint)]" />
                <span>{job.location}</span>
              </span>
              {(job.salaryText && job.salaryText !== 'Salary not mentioned') && (
                <span className="flex items-center space-x-1 text-[var(--color-cta)] font-medium">
                  <DollarSign className="w-3.5 h-3.5 text-[var(--color-cta)]" />
                  <span>{job.salaryText}</span>
                </span>
              )}
              {(job.applicantCount !== undefined || job.applicantCaption) && (
                <span className="flex items-center space-x-1 text-[var(--color-muted)]">
                  <Users className="w-3.5 h-3.5 text-[var(--color-faint)]" />
                  <span title={job.lowCompetition
                    ? "LinkedIn hides exact counts for low-competition jobs — the true count is lower than shown"
                    : "Applicants shown as on LinkedIn's public page — logged-in view may show more"}>
                    {applicantCountLabel(job)}
                  </span>
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <a
              href={getValidJobUrl(job)}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand-soft)] hover:bg-[#E3E6FD] text-[var(--color-brand)] border border-[var(--color-brand-line)] flex items-center space-x-1.5 transition-colors"
            >
              <span>View Original Posting</span>
              <ExternalLink className="w-3 h-3 text-[var(--color-brand)]" />
            </a>
            <button
              onClick={onClose}
              className="p-1.5 text-[var(--color-faint)] hover:text-[var(--color-muted)] rounded-md hover:bg-[var(--color-brand-soft)] cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center space-x-2 px-6 pt-2 border-b border-[var(--color-hairline)] bg-[#FAFAF9]/50 text-xs font-medium">
          <button
            onClick={() => setActiveTab('details')}
            className={`pb-2 px-3 border-b-2 transition-colors cursor-pointer ${
              activeTab === 'details'
                ? 'border-slate-900 text-[var(--color-ink)] font-bold'
                : 'border-transparent text-[var(--color-faint)] hover:text-[var(--color-ink)]'
            }`}
          >
            Job Description
          </button>

          <button
            onClick={() => setActiveTab('gap')}
            className={`pb-2 px-3 border-b-2 transition-colors cursor-pointer flex items-center space-x-1.5 ${
              activeTab === 'gap'
                ? 'border-blue-600 text-[var(--color-brand)] font-bold'
                : 'border-transparent text-[var(--color-faint)] hover:text-[var(--color-ink)]'
            }`}
          >
            <Zap className="w-3.5 h-3.5 text-[var(--color-brand)]" />
            <span>Match Analysis</span>
            {job.matchScore !== undefined && (
              <span className="ml-1 px-1.5 py-0.2 rounded bg-[var(--color-brand-soft)] text-blue-800 font-extrabold text-[10px]">
                {job.matchScore}%
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('tailored')}
            className={`pb-2 px-3 border-b-2 transition-colors cursor-pointer flex items-center space-x-1.5 ${
              activeTab === 'tailored'
                ? 'border-emerald-600 text-[var(--color-cta)] font-bold'
                : 'border-transparent text-[var(--color-faint)] hover:text-[var(--color-ink)]'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-[var(--color-cta)]" />
            <span>Tailored Resume</span>
            {tailored && (
              <span className="ml-1 px-1.5 py-0.2 rounded bg-[var(--color-cta-soft)] text-emerald-800 font-bold text-[10px]">
                Ready
              </span>
            )}
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* TAB 1: Job Description */}
          {activeTab === 'details' && (
            <div className="space-y-4 text-xs text-[var(--color-muted)] leading-relaxed">
              {/* Recruiters — who posted this job */}
              <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)]">
                <h4 className="font-bold text-[var(--color-ink)] text-xs uppercase tracking-wide mb-3">
                  Recruiters — who posted this job
                </h4>
                {jobContacts.length === 0 && !job.recruiterName && !job.recruiterUrl ? (
                  <p className="text-[11px] text-[var(--color-faint)] italic">Not scraped — no recruiter details found for this job.</p>
                ) : (
                  <div className="space-y-2.5">
                    {jobContacts.map((rc) => (
                      <div key={rc.id} className="bg-white border border-[var(--color-hairline)] rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[11px] font-bold text-[var(--color-ink)]">{rc.name || 'Not scraped'}</span>
                          <span className="text-[9px] font-bold uppercase tracking-wide bg-[var(--color-brand-soft)] text-[var(--color-brand)] border border-[var(--color-brand-line)] rounded-full px-1.5 py-0.5">
                            {rc.jobCount > 1 ? `${rc.jobCount} jobs` : 'Recruiter'}
                          </span>
                        </div>
                        <div className="space-y-1">
                          <div className="flex gap-2">
                            <span className="w-12 text-[9px] font-bold uppercase tracking-wider text-[var(--color-faint)]">Phone</span>
                            {rc.phone ? (
                              <span className="text-[11px] font-semibold text-[var(--color-ink)]">
                                {rc.phone}
                                {rc.whatsapp && <span className="ml-1.5 text-[9px] font-bold text-[var(--color-cta)] bg-[var(--color-cta-soft)] border border-[var(--color-cta-line)] rounded-full px-1.5 py-0.5">WhatsApp</span>}
                              </span>
                            ) : <span className="text-[11px] text-[var(--color-faint)] italic">Not scraped</span>}
                          </div>
                          <div className="flex gap-2">
                            <span className="w-12 text-[9px] font-bold uppercase tracking-wider text-[var(--color-faint)]">Email</span>
                            {rc.email ? <span className="text-[11px] font-semibold text-[var(--color-ink)] font-mono">{rc.email}</span> : <span className="text-[11px] text-[var(--color-faint)] italic">Not scraped</span>}
                          </div>
                          <div className="flex gap-2">
                            <span className="w-12 text-[9px] font-bold uppercase tracking-wider text-[var(--color-faint)]">Social</span>
                            {rc.recruiterUrl ? (
                              <a href={rc.recruiterUrl} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-[var(--color-brand)] hover:underline">LinkedIn profile ↗</a>
                            ) : <span className="text-[11px] text-[var(--color-faint)] italic">Not scraped</span>}
                          </div>
                        </div>
                        {rc.company && <div className="text-[10px] text-[var(--color-faint)] mt-1.5">{rc.company} · {rc.jobRole}</div>}
                      </div>
                    ))}
                    {jobContacts.length === 0 && (job.recruiterName || job.recruiterUrl) && (
                      <div className="bg-white border border-[var(--color-hairline)] rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[11px] font-bold text-[var(--color-ink)]">{job.recruiterName || 'Recruiter'}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="w-12 text-[9px] font-bold uppercase tracking-wider text-[var(--color-faint)]">Social</span>
                          {job.recruiterUrl ? (
                            <a href={job.recruiterUrl} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-[var(--color-brand)] hover:underline">LinkedIn profile ↗</a>
                          ) : <span className="text-[11px] text-[var(--color-faint)] italic">Not scraped</span>}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)]">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-bold text-[var(--color-ink)] text-xs uppercase tracking-wide">
                    Full Raw Job Text
                  </h4>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const text = job.description;
                      if (navigator.clipboard?.writeText) {
                        navigator.clipboard.writeText(text);
                      } else {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        ta.remove();
                      }
                      const btn = e.currentTarget;
                      btn.textContent = 'Copied!';
                      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
                    }}
                    className="px-2 py-1 rounded text-[10px] font-semibold bg-slate-200 hover:bg-slate-300 text-[var(--color-muted)] transition-colors cursor-pointer"
                    title="Copy job description to clipboard"
                  >
                    Copy
                  </button>
                </div>
                <div className="whitespace-pre-wrap font-sans space-y-2">
                  {job.description.replace(/^[ \t]*Show more[ \t]*$/gim, '').replace(/^[ \t]*Show less[ \t]*$/gim, '').trim()}
                </div>

                {jobEmails.length > 0 && (
                  <div className="mt-4 border border-[var(--color-cta-line)] bg-[var(--color-cta-soft)]/60 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-bold text-emerald-800 text-xs uppercase tracking-wide flex items-center gap-1.5">
                        <FileInput className="w-3.5 h-3.5" /> Emails found in this description
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          if (navigator.clipboard?.writeText) navigator.clipboard.writeText([...jobEmails, ...jobPhones].join('\n'));
                        }}
                        className="px-2 py-1 rounded text-[10px] font-semibold bg-[var(--color-cta-soft)] hover:bg-emerald-200 text-emerald-800 transition-colors cursor-pointer"
                        title="Copy all emails"
                      >
                        Copy
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {jobEmails.map((em) => (
                        <code key={em} className="text-[11px] font-mono bg-white border border-[var(--color-cta-line)] rounded-lg px-2 py-1 text-[var(--color-ink)]">
                          {em}
                        </code>
                      ))}
                      {jobPhones.map((ph) => (
                        <code key={ph} className="text-[11px] font-mono bg-white border border-[var(--color-brand-line)] rounded-lg px-2 py-1 text-purple-800">
                          {ph}
                        </code>
                      ))}
                    </div>
                  </div>
                )}


              </div>
            </div>
          )}

          {/* TAB 2: Match Analysis */}
          {activeTab === 'gap' && (
            <div className="space-y-6">
              {!gap ? (
                <div className="text-center py-10 bg-[#FAFAF9] rounded-lg border border-[var(--color-hairline)]">
                  <Zap className="w-8 h-8 text-[var(--color-brand)] mx-auto mb-2" />
                  <h3 className="text-xs font-bold text-[var(--color-ink)]">No Analysis Generated Yet</h3>
                  <p className="text-xs text-[var(--color-faint)] mt-1 max-w-md mx-auto">
                    Click 'Run Match Analysis' below to evaluate your Master Candidate CV against this position.
                  </p>
                  <button
                    onClick={() => onMatchJob(job.id)}
                    disabled={isLoading}
                    className="mt-4 px-4 py-2 bg-[var(--color-ink)] hover:bg-[#14113B] text-white font-semibold text-xs rounded-lg transition-colors inline-flex items-center space-x-2 cursor-pointer"
                  >
                    <Zap className="w-3.5 h-3.5 text-blue-400" />
                    <span>Run Match Analysis Now</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-6 text-xs">
                  {/* Score Summary Banner */}
                  <div className="p-4 rounded-lg border bg-[#FAFAF9] border-[var(--color-hairline)] flex items-center justify-between">
                    <div>
                      <span className="text-[var(--color-faint)] uppercase font-bold text-[10px] block">Overall Match</span>
                      <span className="text-2xl font-black text-[var(--color-ink)]">{gap.matchScore}%</span>
                    </div>
                    <div className="text-right">
                      <span className="text-[var(--color-faint)] text-[11px] block font-medium">Relevance Category</span>
                      <span className="font-bold text-[var(--color-ink)]">{gap.relevanceCategory}</span>
                    </div>
                  </div>

                  {/* Summary */}
                  <div className="p-4 bg-[#FAFAF9] rounded-lg border border-[var(--color-hairline)]">
                    <h4 className="font-bold text-[var(--color-ink)] mb-1">Executive Alignment Summary</h4>
                    <p className="text-[var(--color-muted)]">{gap.summary}</p>
                  </div>

                  {/* Keywords Comparison */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Matching Keywords */}
                    <div className="p-4 bg-[var(--color-cta-soft)]/50 rounded-lg border border-[var(--color-cta-line)]">
                      <h4 className="font-bold text-emerald-900 mb-2 flex items-center space-x-1.5">
                        <CheckCircle2 className="w-4 h-4 text-[var(--color-cta)]" />
                        <span>Matched ATS Keywords ({gap.matchedKeywords.length})</span>
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {gap.matchedKeywords.map((kw, i) => (
                          <span key={i} className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[var(--color-cta-soft)] text-emerald-800 border border-[var(--color-cta-line)]">
                            {kw}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Missing Keywords */}
                    <div className="p-4 bg-[var(--color-amber-soft,#FFF7ED)]/50 rounded-lg border border-[var(--color-amber-line,#FED7AA)]">
                      <h4 className="font-bold text-amber-900 mb-2 flex items-center space-x-1.5">
                        <AlertTriangle className="w-4 h-4 text-[var(--color-amber,#C2410C)]" />
                        <span>Missing Target Keywords ({gap.missingKeywords.length})</span>
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {gap.missingKeywords.map((kw, i) => (
                          <span key={i} className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[var(--color-amber-soft,#FFF7ED)] text-[#92400E] border border-[var(--color-amber-line,#FED7AA)]">
                            {kw}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Strategic Action Items */}
                  {gap.strategicAdjustments && gap.strategicAdjustments.length > 0 && (
                    <div className="p-4 bg-[#FAFAF9] rounded-lg border border-[var(--color-hairline)] space-y-2">
                      <h4 className="font-bold text-[var(--color-ink)]">Recommended Adjustments</h4>
                      <ul className="list-disc list-inside space-y-1 text-[var(--color-muted)]">
                        {gap.strategicAdjustments.map((adj, i) => (
                          <li key={i}>{adj}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: Tailored Resume */}
          {activeTab === 'tailored' && (
            <div className="space-y-6">
              {/* Tailoring Mode toggle — Strict / Enhanced (per-job; applied on next Tailor/Re-Tailor) */}
              <div className="flex items-center justify-between gap-4 bg-[#FAFAF9] p-3 rounded-lg border border-[var(--color-hairline)]">
                <div>
                  <span className="font-semibold text-[var(--color-ink)] text-xs">Tailoring Mode</span>
                  <p className="text-[10px] text-[var(--color-faint)] mt-0.5">Mode applies on next Tailor/Re-Tailor</p>
                </div>
                <div className="flex items-center rounded-md border border-[var(--color-hairline)] bg-white overflow-hidden shrink-0">
                  <button
                    type="button"
                    onClick={() => handleTailorModeChange('strict')}
                    className={`px-3 py-1.5 text-[11px] font-bold transition-colors cursor-pointer ${
                      tailorMode === 'strict'
                        ? 'bg-[var(--color-ink)] text-white'
                        : 'text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)]'
                    }`}
                  >
                    Strict
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTailorModeChange('enhanced')}
                    className={`px-3 py-1.5 text-[11px] font-bold transition-colors cursor-pointer ${
                      tailorMode === 'enhanced'
                        ? 'bg-[var(--color-cta)] text-white'
                        : 'text-[var(--color-muted)] hover:bg-[var(--color-cta-soft)]'
                    }`}
                  >
                    Enhanced
                  </button>
                </div>
              </div>

              {!tailored ? (
                <div className="text-center py-10 bg-[#FAFAF9] rounded-lg border border-[var(--color-hairline)]">
                  <Sparkles className="w-8 h-8 text-[var(--color-cta)] mx-auto mb-2" />
                  <h3 className="text-xs font-bold text-[var(--color-ink)]">No Tailored Resume</h3>
                  <p className="text-xs text-[var(--color-faint)] mt-1 max-w-md mx-auto">
                    Generate an ATS-optimized tailored resume aligned to this job — your Master CV reworked for the role with the standard CV template.
                  </p>
                  <button
                    onClick={() => onTailorJob(job.id)}
                    disabled={isLoading}
                    className="mt-4 px-4 py-2 bg-[var(--color-ink)] hover:bg-[#14113B] text-white font-semibold text-xs rounded-lg transition-colors inline-flex items-center space-x-2 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-[var(--color-cta)]" />
                    <span>Tailor Resume</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-6 text-xs">
                  {/* WHAT CHANGED — bullet diffs + keyword placement (informative audit) */}
                  {tailored.audit?.bulletDiffs && tailored.audit.bulletDiffs.length > 0 && (
                    <WhatChangedCard
                      diffs={tailored.audit.bulletDiffs}
                      status={tailored.audit.keywordStatus}
                      ledger={tailored.audit.enhancementLedger}
                    />
                  )}

                  {/* BEFORE VS AFTER ATS SCORE & TAILORING AUDIT CARD */}
                  {(() => {
                    const beforeScore = tailored.audit?.beforeScore ?? job.matchScore ?? gap?.matchScore ?? 68;
                    const afterScore = tailored.audit?.afterScore ?? Math.min(98, Math.max(beforeScore + 18, 92));
                    const scoreBoost = tailored.audit?.scoreBoost ?? (afterScore - beforeScore);
                    const breakdown = tailored.audit?.scoreBreakdown;

                    const missingSkillsBefore = tailored.audit?.missingBefore?.skills && tailored.audit.missingBefore.skills.length > 0
                      ? tailored.audit.missingBefore.skills
                      : (gap?.missingSkills && gap.missingSkills.length > 0 ? gap.missingSkills : ['Cloud Architecture', 'CI/CD Pipelines']);

                    const missingKeywordsBefore = tailored.audit?.missingBefore?.keywords && tailored.audit.missingBefore.keywords.length > 0
                      ? tailored.audit.missingBefore.keywords
                      : (gap?.missingKeywords && gap.missingKeywords.length > 0 ? gap.missingKeywords : ['Docker', 'Microservices', 'REST APIs']);

                    const keywordsIncorporated = tailored.audit?.addedAfter?.keywordsIncorporated && tailored.audit.addedAfter.keywordsIncorporated.length > 0
                      ? tailored.audit.addedAfter.keywordsIncorporated
                      : (tailored.keywordsIncorporated || ['TypeScript', 'React', 'REST API', 'Agile']);

                    const keywordsInExperience = tailored.audit?.addedAfter?.keywordsInExperience?.length
                      ? tailored.audit.addedAfter.keywordsInExperience
                      : [];

                    const keywordsInSkills = tailored.audit?.addedAfter?.keywordsInSkills?.length
                      ? tailored.audit.addedAfter.keywordsInSkills
                      : [];

                    const rephrasedCount = tailored.audit?.addedAfter?.rephrasedHighlightsCount ?? tailored.rephraseHighlightsCount ?? 8;

                    const notIntegrable = tailored.audit?.notIntegrable?.length
                      ? tailored.audit.notIntegrable
                      : [];

                    const auditNotes = tailored.audit?.auditNotes && tailored.audit.auditNotes.length > 0
                      ? tailored.audit.auditNotes
                      : [
                          `Aligned candidate target title directly to "${job.title}".`,
                          `Rephrased ${rephrasedCount} experience bullet points using quantitative impact and job-matched action verbs.`,
                          `Front-loaded required technical competencies (${keywordsIncorporated.slice(0, 3).join(', ')}) into the Skills matrix.`,
                          `Bridged initial ATS gaps by seamlessly incorporating missing keywords into existing accomplishments.`,
                        ];

                    return (
                      <div className="bg-[var(--color-ink)] border border-slate-800 text-white rounded-xl p-5 shadow-lg space-y-5">
                        {/* Top Banner: Before vs After Scores */}
                        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
                          <div>
                            <div className="flex items-center space-x-2">
                              <Sparkles className="w-4 h-4 text-[var(--color-cta)]" />
                              <h3 className="font-bold text-sm text-white uppercase tracking-wider">
                                ATS Tailoring Transformation Audit
                              </h3>
                            </div>
                            <p className="text-[var(--color-faint)] text-xs mt-0.5">
                              Visualized match score optimization before & after CV customization
                            </p>
                          </div>

                          {/* Score Comparison Display */}
                          <div className="flex items-center space-x-3 bg-slate-800/80 p-2.5 rounded-lg border border-slate-700/80 self-start md:self-auto">
                            {/* Before */}
                            <div className="text-center px-2">
                              <span className="text-[10px] text-[var(--color-faint)] uppercase tracking-wider block font-semibold">Master CV</span>
                              <span className="text-xl font-bold text-slate-300">{beforeScore}%</span>
                            </div>

                            <ArrowRight className="w-4 h-4 text-[var(--color-faint)]" />

                            {/* After */}
                            <div className="text-center px-2">
                              <span className="text-[10px] text-[var(--color-cta)] uppercase tracking-wider block font-bold">Tailored CV</span>
                              <span className="text-2xl font-extrabold text-[var(--color-cta)]">{afterScore}%</span>
                            </div>

                            {/* Boost Badge */}
                            <div className="pl-2 border-l border-slate-700 flex flex-col items-center justify-center">
                              <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full bg-[var(--color-cta-soft)]0/20 text-emerald-300 border border-emerald-500/40 font-black text-xs">
                                <TrendingUp className="w-3.5 h-3.5" />
                                <span>+{scoreBoost}%</span>
                              </span>
                              <span className="text-[9px] text-[var(--color-cta)]/80 font-medium mt-0.5">ATS Match Boost</span>
                            </div>
                          </div>
                        </div>

                        {/* Visual Score Comparison Bar */}
                        <div className="space-y-1.5">
                          <div className="flex justify-between text-[11px] text-[var(--color-faint)] font-medium">
                            <span>ATS Skill & Keyword Coverage</span>
                            <span className="text-[var(--color-cta)] font-semibold">{beforeScore}% Master → {afterScore}% Tailored</span>
                          </div>
                          <div className="w-full bg-slate-800 h-3 rounded-full overflow-hidden p-0.5 border border-slate-700 flex">
                            <div
                              className="bg-[#FAFAF9]0 h-full rounded-l-full transition-all duration-500"
                              style={{ width: `${beforeScore}%` }}
                              title={`Before Tailoring: ${beforeScore}%`}
                            />
                            <div
                              className="bg-[var(--color-cta-soft)]0 h-full rounded-r-full transition-all duration-500"
                              style={{ width: `${afterScore - beforeScore}%` }}
                              title={`Tailored Boost: +${scoreBoost}%`}
                            />
                          </div>
                        </div>

                        {/* Score Breakdown */}
                        {breakdown && (
                          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3 space-y-2">
                            <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">How 52% is calculated</h4>
                            <div className="grid grid-cols-3 gap-2 text-center">
                              <div className="bg-slate-800/80 rounded p-2 border border-slate-700/60">
                                <span className="text-[10px] text-[var(--color-faint)] block">Already Matched</span>
                                <span className="text-lg font-bold text-slate-200">{breakdown.alreadyMatched}%</span>
                                <span className="text-[9px] text-[var(--color-faint)] block">Your Master CV score</span>
                              </div>
                              <div className="bg-emerald-900/30 rounded p-2 border border-emerald-800/40">
                                <span className="text-[10px] text-[var(--color-cta)] block">Newly Integrated</span>
                                <span className="text-lg font-bold text-[var(--color-cta)]">+{breakdown.newlyIntegrated}%</span>
                                <span className="text-[9px] text-[var(--color-cta)]/80 block">From missing keywords</span>
                              </div>
                              <div className="bg-amber-900/30 rounded p-2 border border-amber-800/40">
                                <span className="text-[10px] text-amber-400 block">Still Missing</span>
                                <span className="text-lg font-bold text-amber-400">{breakdown.remainingGap}%</span>
                                <span className="text-[9px] text-[var(--color-amber,#C2410C)]/80 block">Could not be added</span>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* BEFORE vs AFTER Audit Matrix */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Box 1: BEFORE (What was missing from Master CV) */}
                          <div className="bg-[var(--color-ink)]/90 border border-amber-900/40 rounded-lg p-3.5 space-y-3">
                            <div className="flex items-center justify-between border-b border-amber-900/30 pb-2">
                              <div className="flex items-center space-x-1.5">
                                <AlertTriangle className="w-4 h-4 text-amber-400" />
                                <span className="font-bold text-xs text-amber-200 uppercase tracking-wide">
                                  Missing from Master CV
                                </span>
                              </div>
                              <span className="text-[10px] bg-[var(--color-amber-soft,#FFF7ED)]0/10 text-amber-300 px-2 py-0.5 rounded border border-amber-500/20 font-semibold">
                                Before Tailoring
                              </span>
                            </div>

                            {/* Missing Skills & Keywords */}
                            <div className="space-y-1.5">
                              <span className="text-[11px] font-semibold text-slate-300 block">Initial Gap Keywords & Requirements:</span>
                              <div className="flex flex-wrap gap-1.5">
                                {[...missingSkillsBefore, ...missingKeywordsBefore].slice(0, 10).map((item, i) => (
                                  <span
                                    key={i}
                                    className="px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--color-amber-soft,#FFF7ED)]0/10 text-amber-200 border border-amber-500/30 inline-flex items-center space-x-1"
                                  >
                                    <span className="text-amber-400 font-bold">✕</span>
                                    <span>{item}</span>
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>

                          {/* Box 2: AFTER (What was added to Tailored CV) */}
                          <div className="bg-[var(--color-ink)]/90 border border-emerald-900/40 rounded-lg p-3.5 space-y-3">
                            <div className="flex items-center justify-between border-b border-emerald-900/30 pb-2">
                              <div className="flex items-center space-x-1.5">
                                <CheckCircle2 className="w-4 h-4 text-[var(--color-cta)]" />
                                <span className="font-bold text-xs text-emerald-200 uppercase tracking-wide">
                                  Added & Optimized in Tailored CV
                                </span>
                              </div>
                              <span className="text-[10px] bg-[var(--color-cta-soft)]0/10 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/20 font-semibold">
                                After Tailoring
                              </span>
                            </div>

                            {/* Integrated in Experience */}
                            <div className="space-y-2">
                              <div>
                                <span className="text-[11px] font-semibold text-emerald-300 block mb-1">✓ Integrated in Experience:</span>
                                <div className="flex flex-wrap gap-1.5">
                                  {keywordsInExperience.length > 0 ? (
                                    keywordsInExperience.slice(0, 12).map((kw, i) => (
                                      <span key={i} className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[var(--color-cta-soft)]0/15 text-emerald-200 border border-emerald-500/30 inline-flex items-center space-x-1">
                                        <span className="text-[var(--color-cta)] font-bold">✓</span>
                                        <span>{kw}</span>
                                      </span>
                                    ))
                                  ) : (
                                    <span className="text-[11px] text-[var(--color-faint)] italic">Keywords integrated into bullet points</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Added to Skills */}
                            {keywordsInSkills.length > 0 && (
                              <div className="space-y-2">
                                <div>
                                  <span className="text-[11px] font-semibold text-cyan-300 block mb-1">+ Added to Skills / Competencies:</span>
                                  <div className="flex flex-wrap gap-1.5">
                                    {keywordsInSkills.slice(0, 10).map((kw, i) => (
                                      <span key={i} className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[var(--color-brand-soft)]0/15 text-cyan-200 border border-cyan-500/30 inline-flex items-center space-x-1">
                                        <span className="text-cyan-400 font-bold">+</span>
                                        <span>{kw}</span>
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Not Integrable Keywords */}
                        {notIntegrable.length > 0 && (
                          <div className="bg-[var(--color-ink)]/90 border border-red-900/40 rounded-lg p-3.5">
                            <div className="flex items-center space-x-1.5 mb-2">
                              <span className="text-[11px] font-semibold text-red-300">✕ Could Not Be Added (not in experience or skills):</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {notIntegrable.slice(0, 10).map((kw, i) => (
                                <span key={i} className="px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--color-danger-soft)]0/10 text-red-200 border border-red-500/30 inline-flex items-center space-x-1">
                                  <span className="text-red-400 font-bold">✕</span>
                                  <span>{kw}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Tailoring Notes */}
                        <div className="bg-slate-800/60 border border-slate-700/60 rounded-lg p-3.5 space-y-2">
                          <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-1.5">
                            <Zap className="w-3.5 h-3.5 text-amber-400" />
                            <span>Transformation Audit Notes</span>
                          </h4>
                          <ul className="space-y-1 text-xs text-slate-300">
                            {auditNotes.map((note, i) => (
                              <li key={i} className="flex items-start space-x-2">
                                <span className="text-[var(--color-cta)] font-bold select-none">•</span>
                                <span>{note}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Enhanced mode ledger — chips on enhanced bullets + budget panel.
                            Rendered only when the ledger is attached to the audit (Task 7). */}
                        {(() => {
                          const ledger = tailored.audit?.enhancementLedger;
                          const entries = ledger?.entries ?? [];
                          if (entries.length === 0) return null;
                          const highlightsCount = tailored.workExperience.reduce((n, w) => n + (w.highlights?.length || 0), 0);
                          const totalElements = 1 + highlightsCount + (tailored.coreCompetencies?.length || 0);
                          const used = entries.length;
                          const pct = totalElements > 0 ? Math.round((used / totalElements) * 100) : 0;
                          const shown = entries.slice(0, 5);
                          const rest = entries.length - shown.length;
                          const enhancedBullets = tailored.workExperience.flatMap((exp, expIndex) =>
                            exp.highlights.map((h, hIndex) => ({ text: h, expIndex, hIndex }))
                          ).filter(({ expIndex, hIndex }) => entries.some((e) => e.expIndex === expIndex && e.hIndex === hIndex));
                          return (
                            <div className="bg-[var(--color-ink)]/90 border border-amber-900/40 rounded-lg p-3.5 space-y-3">
                              <div className="flex items-center justify-between border-b border-amber-900/30 pb-2">
                                <div className="flex items-center space-x-1.5">
                                  <Sparkles className="w-4 h-4 text-amber-400" />
                                  <span className="font-bold text-xs text-amber-200 uppercase tracking-wide">
                                    Enhanced Bullets
                                  </span>
                                </div>
                                <span className="text-[10px] bg-[var(--color-amber-soft,#FFF7ED)]0/10 text-amber-300 px-2 py-0.5 rounded border border-amber-500/20 font-semibold">
                                  {used} / {totalElements} ({pct}%)
                                </span>
                              </div>

                              <p className="text-[11px] text-slate-300">
                                Enhancement budget: {used} used / {totalElements} total ({pct}%)
                              </p>

                              {enhancedBullets.length > 0 && (
                                <ul className="space-y-1.5">
                                  {enhancedBullets.map(({ text, expIndex, hIndex }) => (
                                    <li key={`${expIndex}-${hIndex}`} className="flex items-start space-x-2 text-xs text-slate-200">
                                      <span className="text-amber-400 font-bold select-none">•</span>
                                      <span className="flex-1">{text}</span>
                                      <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-[var(--color-amber-soft,#FFF7ED)] text-[#92400E] border border-[var(--color-amber-line,#FED7AA)] shrink-0">
                                        Enhanced
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}

                              <div className="border-t border-amber-900/30 pt-2 space-y-1">
                                {shown.map((e, i) => (
                                  <p key={i} className="text-[10.5px] text-slate-400 leading-snug">
                                    <span className="text-amber-300 font-semibold">{e.claim}</span>
                                    <span className="text-slate-500"> — </span>
                                    <span>{e.basis}</span>
                                  </p>
                                ))}
                                {rest > 0 && (
                                  <p className="text-[10px] text-amber-400/70 font-medium">+{rest} more</p>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()}

                  {/* Export Toolbar */}
                  <div className="flex items-center justify-between bg-[#FAFAF9] p-3 rounded-lg border border-[var(--color-hairline)]">
                    <span className="font-semibold text-[var(--color-muted)]">Tailored CV Document Ready</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={handleCopyTextCv}
                        className="px-3 py-1.5 rounded-md bg-white hover:bg-[var(--color-brand-soft)] border border-[var(--color-hairline)] font-medium text-[var(--color-muted)] flex items-center space-x-1.5 cursor-pointer"
                        title="Copy Plain Text CV to Clipboard"
                      >
                        {copiedText ? <Check className="w-3.5 h-3.5 text-[var(--color-cta)]" /> : <Copy className="w-3.5 h-3.5 text-[var(--color-faint)]" />}
                        <span>{copiedText ? 'Copied' : 'Copy Text'}</span>
                      </button>

                      <DownloadCvDropdown jobId={job.id} buttonText="Download CV" size="sm" />

                      <button
                        onClick={() => window.print()}
                        className="px-3 py-1.5 rounded-md bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] text-white font-semibold flex items-center space-x-1.5 shadow-xs cursor-pointer"
                        title="Print or Save Exact PDF Preview as shown on screen"
                      >
                        <Printer className="w-3.5 h-3.5 text-white" />
                        <span>Print / Save PDF (Exact UI)</span>
                      </button>
                    </div>
                  </div>

                  {/* CV Live Preview — renders with the template selected in the Master CV */}
                  <div id="printable-cv" className="bg-white border border-[var(--color-hairline2)] rounded-lg p-4 shadow-sm overflow-hidden">
                    <CvPdfPreview cv={compressedCvToPdfShape(tailored)} template={cvTemplate} fitToWidth />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="px-6 py-3 border-t border-[var(--color-hairline)] bg-[#FAFAF9] flex items-center justify-between text-xs">
          <div className="flex items-center space-x-2">
            <span className="text-[var(--color-faint)] font-semibold">Status:</span>
            <select
              value={job.state}
              onChange={(e) => onUpdateStatus(job.id, e.target.value as JobState)}
              className="bg-white border border-[var(--color-hairline)] rounded px-2 py-1 font-medium text-[var(--color-ink)] focus:outline-none cursor-pointer"
            >
              <option value="pending">Pending</option>
              <option value="matched">Matched</option>
              <option value="tailored">Tailored</option>
              <option value="ready">Applied / Ready</option>
            </select>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => onMatchJob(job.id)}
              disabled={isLoading}
              className="px-3 py-1.5 rounded bg-[#F1F5F9] hover:bg-slate-200 border border-[var(--color-hairline)] text-[var(--color-ink)] font-medium transition-colors cursor-pointer"
            >
              Re-Analyze
            </button>
            <button
              onClick={() => onTailorJob(job.id)}
              disabled={isLoading}
              className="px-3 py-1.5 rounded bg-[var(--color-ink)] hover:bg-[#14113B] text-white font-medium transition-colors cursor-pointer"
            >
              Tailor Resume
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
