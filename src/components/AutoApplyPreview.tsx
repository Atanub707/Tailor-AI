import React from 'react';
import { X, CheckCircle2, AlertTriangle, FileText, ExternalLink, Eye } from 'lucide-react';

interface PreviewField {
  label: string;
  value: string;
  source: 'profile' | 'llm' | 'needs_review';
  confidence: number;
}

interface Layer1Props {
  isOpen: boolean;
  onClose: () => void;
  job: { title: string; company: string; url: string } | null;
  ats: string | null;
  fields: PreviewField[];
  resumeName: string;
  onOpenBrowser: () => void;
  onSubmit: () => void;
}

export const AutoApplyPreview: React.FC<Layer1Props> = ({
  isOpen,
  onClose,
  job,
  ats,
  fields,
  resumeName,
  onOpenBrowser,
  onSubmit,
}) => {
  if (!isOpen || !job) return null;

  const mapped = fields.filter((f) => f.source !== 'needs_review');
  const needsReview = fields.filter((f) => f.source === 'needs_review');
  const canSubmit = needsReview.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-[480px] bg-white h-full flex flex-col shadow-xl border-l border-[var(--color-hairline)]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--color-hairline)] flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-[13px] font-bold text-[var(--color-ink)]">Application Preview</h2>
            <p className="text-[11px] text-[var(--color-faint)]">
              ATS: <span className="font-bold text-[var(--color-brand)]">{ats || 'Detecting...'}</span> · Review before submit
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-[var(--color-faint)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Job header */}
        <div className="px-5 py-3 bg-[#FAFAF9] border-b border-[var(--color-hairline)] shrink-0">
          <div className="text-[12px] font-bold text-[var(--color-ink)]">{job.title}</div>
          <div className="text-[11px] text-[var(--color-faint)]">{job.company}</div>
          <a href={job.url} target="_blank" rel="noreferrer" className="text-[11px] text-[var(--color-brand)] flex items-center gap-1 mt-1">
            <ExternalLink className="w-3 h-3" /> Open original
          </a>
        </div>

        {/* Fields */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Resume */}
          <div className="flex items-center gap-2 p-2.5 bg-[var(--color-brand-soft)] border border-[var(--color-brand-line)] rounded-lg">
            <FileText className="w-4 h-4 text-[var(--color-brand)]" />
            <span className="text-[11.5px] font-semibold text-[var(--color-ink)] truncate">{resumeName}</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 ml-auto" />
          </div>

          {/* Mapped fields */}
          <div>
            <h3 className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--color-faint)] mb-2">
              Auto-filled from your profile · {mapped.length}/{fields.length}
            </h3>
            <div className="space-y-2">
              {mapped.map((f) => (
                <div key={f.label} className="flex items-center justify-between p-2.5 bg-white border border-[var(--color-hairline)] rounded-lg">
                  <div className="min-w-0">
                    <div className="text-[11.5px] font-semibold text-[var(--color-ink)]">{f.label}</div>
                    <div className="text-[11px] text-[var(--color-faint)] truncate">{f.value || '—'}</div>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ml-2 ${f.source === 'profile' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                    {f.source === 'profile' ? 'Profile' : 'AI'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Needs review */}
          {needsReview.length > 0 && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
              <h3 className="text-[11px] font-extrabold uppercase tracking-wider text-amber-800 mb-2 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Needs review · {needsReview.length}
              </h3>
              <div className="space-y-2">
                {needsReview.map((f) => (
                  <div key={f.label} className="p-2.5 bg-white border border-amber-200 rounded-lg">
                    <div className="text-[11.5px] font-semibold text-[var(--color-ink)]">{f.label}</div>
                    <textarea
                      placeholder="Answer manually — will be saved for next time"
                      className="mt-1.5 w-full min-h-[60px] p-2 text-[11.5px] border border-[var(--color-hairline)] rounded-lg focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]/20 outline-none"
                      defaultValue={f.value}
                    />
                  </div>
                ))}
              </div>
              <p className="text-[10.5px] text-amber-700 mt-2">These answers will be saved locally and auto-filled next time the same question appears.</p>
            </div>
          )}

          {canSubmit && (
            <div className="flex items-center gap-2 p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-[11.5px] font-semibold text-emerald-800">
              <CheckCircle2 className="w-4 h-4" /> All fields ready — you can submit
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[var(--color-hairline)] bg-white shrink-0 flex gap-2">
          <button
            onClick={onOpenBrowser}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-[var(--color-hairline)] bg-white text-[12px] font-bold text-[var(--color-ink)] hover:bg-slate-50"
          >
            <Eye className="w-3.5 h-3.5" /> Open filled form
          </button>
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--color-brand)] text-white text-[12px] font-bold hover:bg-[var(--color-brand-strong)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {canSubmit ? 'Submit Application' : `${needsReview.length} to review`}
          </button>
        </div>
      </div>
    </div>
  );
};
