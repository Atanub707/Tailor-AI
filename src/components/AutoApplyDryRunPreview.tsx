// Auto Apply (Experimental) — dry-run preview.
//
// Presentation ONLY. Shows exactly what WOULD be filled from the existing
// Application Engine plan. There is deliberately NO submit button and no
// browser-fill action — submission transport does not exist.

import React from 'react';
import { X, FileText, ExternalLink, AlertTriangle, ShieldAlert, CircleHelp, EyeOff, Sparkles } from 'lucide-react';
import type { AutoApplyDryRunResult } from '../../server/autoApply/autoApplyTypes';

interface Props {
  result: AutoApplyDryRunResult | null;
  error: string | null;
  jobTitle: string;
  company: string;
  onClose: () => void;
  /** Question-learning: save missing answers (optionally remembered). */
  onAnswer?: (providerFieldId: string, question: string, answer: string, remember: boolean) => Promise<void>;
  /** Fill-only execution (never submits). */
  onFill?: () => Promise<void> | void;
  /** Poll the fill status API for the read-back verification summary. */
  onCheckStatus?: () => Promise<void> | void;
  fillState?: { status: string; message?: string; attemptId?: string } | null;
  fillBusy?: boolean;
}

/** Display-only review policy: answers that are sensitive enough that the
 *  user should look at them before any future fill. NEVER changes behavior. */
const REVIEW_KEYS = new Set([
  'authorizedToWork', 'requiresSponsorship', 'targetSalary', 'currentSalary',
  'minimumSalary', 'noticePeriod', 'willingToRelocate', 'earliestStartDate',
  'hasReferralsAtCompany', 'onsiteAvailability',
]);

const statusChip = (label: string, tone: 'ready' | 'review' | 'needs' | 'blocked' | 'suggest') => {
  const tones = {
    ready: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    review: 'bg-amber-50 text-amber-700 border-amber-200',
    needs: 'bg-sky-50 text-sky-700 border-sky-200',
    blocked: 'bg-red-50 text-red-700 border-red-200',
    suggest: 'bg-violet-50 text-violet-700 border-violet-200',
  } as const;
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${tones[tone]}`}>
      {label}
    </span>
  );
};

const Section: React.FC<{ title: string; icon: React.ReactNode; tone: string; children: React.ReactNode }> = ({ title, icon, tone, children }) => (
  <div className={`p-3 rounded-xl border ${tone}`}>
    <h3 className="text-[11px] font-extrabold uppercase tracking-wider flex items-center gap-1.5 mb-2">
      {icon} {title}
    </h3>
    <div className="space-y-1.5">{children}</div>
  </div>
);

export const AutoApplyDryRunPreview: React.FC<Props> = ({ result, error, jobTitle, company, onClose, onAnswer, onFill, onCheckStatus, fillState, fillBusy }) => {
  const [draftAnswers, setDraftAnswers] = React.useState<Record<string, string>>({});
  const [rememberAnswers, setRememberAnswers] = React.useState(true);
  const [savingAnswers, setSavingAnswers] = React.useState(false);
  const fields = result?.fields ?? [];
  const needsInput = (result?.unresolvedFields ?? []).filter((f) => f.requiresUser);
  const optionalUnresolved = (result?.unresolvedFields ?? []).filter((f) => !f.requiresUser);
  const consents = result?.consentFields ?? [];
  const sensitive = result?.sensitiveFields ?? [];
  const warnings = result?.warnings ?? [];
  const suggestions = result?.aiSuggestions ?? [];
  const bankEnabled = result?.answerBank?.enabled === true;
  const bankRows = result?.answerBank?.matched ?? [];
  const decision = result?.decision;
  // Suggestions with a value from the existing profile catalog render in the
  // main table; blocked/no-value ones stay in a clearly advisory section.
  const suggestionRows = suggestions.filter((s) => !s.hardBlocked && s.proposedValue !== null);
  const draftedSuggestions = suggestions.filter((s) => Boolean(s.generatedDraft));
  const advisorySuggestions = suggestions.filter((s) => !s.generatedDraft && (s.hardBlocked || s.proposedValue === null));
  const pct = (c: number) => `${Math.round(c * 100)}%`;
  const fmtValue = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? '—'));

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Auto Apply dry run preview">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-[560px] bg-white h-full flex flex-col shadow-xl border-l border-[var(--color-hairline)]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--color-hairline)] flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-[13px] font-bold text-[var(--color-ink)] flex items-center gap-2">
              Auto Apply — Experimental
              <span className="text-[9px] font-extrabold uppercase tracking-wide bg-violet-50 text-violet-700 border border-violet-200 rounded-full px-2 py-0.5">
                Dry run
              </span>
            </h2>
            <p className="text-[11px] text-[var(--color-faint)]">
              {jobTitle} · {company}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close preview"
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-[var(--color-faint)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-[11.5px] text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}

          {result && result.status !== 'DRY_RUN_READY' && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-[11.5px] text-amber-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold">{result.status.replace(/_/g, ' ')}</div>
                {result.message && <div className="mt-0.5">{result.message}</div>}
              </div>
            </div>
          )}

          {result && (
            <>
              {/* Target */}
              <div className="p-3 bg-[#FAFAF9] border border-[var(--color-hairline)] rounded-xl text-[11.5px] space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--color-faint)] font-semibold">ATS</span>
                  <span className="font-bold text-[var(--color-brand)] uppercase">{result.provider}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--color-faint)] font-semibold shrink-0">Target</span>
                  {result.targetUrl ? (
                    <a href={result.targetUrl} target="_blank" rel="noreferrer" className="text-[var(--color-brand)] flex items-center gap-1 truncate">
                      <span className="truncate">{result.targetUrl}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-[var(--color-faint)]">—</span>
                  )}
                </div>
                {result.planStatus && (
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--color-faint)] font-semibold">Plan status</span>
                    <span className="font-bold">{result.planStatus}</span>
                  </div>
                )}
                {decision && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[var(--color-faint)] font-semibold shrink-0">Decision engine</span>
                    {decision.enabled ? (
                      <span className="font-bold text-violet-700">
                        Laya (local) · {decision.evaluated} evaluated · {decision.suggested} suggested
                        {decision.failed > 0 ? ` · ${decision.failed} unavailable` : ''}
                      </span>
                    ) : (
                      <span className="text-[var(--color-faint)]">Deterministic only</span>
                    )}
                  </div>
                )}
                {result.generative && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[var(--color-faint)] font-semibold shrink-0">Generative drafts</span>
                    {result.generative.enabled ? (
                      <span className="font-bold text-indigo-700">
                        {result.generative.generated} generated · {result.generative.failed} unavailable
                      </span>
                    ) : (
                      <span className="text-[var(--color-faint)]">Off</span>
                    )}
                  </div>
                )}
              </div>

              {/* Resume */}
              <div className="flex items-center gap-2 p-2.5 bg-[var(--color-brand-soft)] border border-[var(--color-brand-line)] rounded-lg">
                <FileText className="w-4 h-4 text-[var(--color-brand)] shrink-0" />
                <div className="min-w-0">
                  <div className="text-[11.5px] font-semibold text-[var(--color-ink)] truncate">
                    {result.resume.fileName || 'No resume artifact'}
                  </div>
                  <div className="text-[10px] text-[var(--color-faint)]">
                    {result.resume.source === 'TAILORED' ? 'Verified tailored resume' : result.resume.source === 'MASTER_CV' ? 'Master CV (no tailored version yet)' : 'Unavailable'}
                    {result.resume.artifactHash ? ` · ${result.resume.artifactHash.slice(0, 12)}…` : ''}
                  </div>
                </div>
              </div>

              {/* Warnings */}
              {warnings.length > 0 && (
                <Section title="Warnings" icon={<AlertTriangle className="w-3.5 h-3.5" />} tone="bg-amber-50/60 border-amber-200 text-amber-900">
                  {warnings.map((w, i) => (
                    <p key={i} className="text-[11px] leading-snug">• {w}</p>
                  ))}
                </Section>
              )}

              {/* Fields */}
              {fields.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--color-faint)] mb-2">
                    Would be filled · {fields.length}
                  </h3>
                  <div className="border border-[var(--color-hairline)] rounded-xl overflow-hidden">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="bg-[#FAFAF9] text-[9px] uppercase tracking-wide text-[var(--color-faint)]">
                          <th className="text-left font-bold px-2.5 py-1.5">Field</th>
                          <th className="text-left font-bold px-2.5 py-1.5">Proposed answer</th>
                          <th className="text-left font-bold px-2.5 py-1.5">Source</th>
                          <th className="text-left font-bold px-2.5 py-1.5">Method</th>
                          <th className="text-left font-bold px-2.5 py-1.5">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((f) => {
                          const review = f.canonicalKey ? REVIEW_KEYS.has(f.canonicalKey) : false;
                          return (
                            <tr key={f.providerFieldId} className="border-t border-[var(--color-hairline)] align-top">
                              <td className="px-2.5 py-1.5 font-semibold text-[var(--color-ink)]">{f.label}</td>
                              <td className="px-2.5 py-1.5 text-[var(--color-muted)] break-words max-w-[140px]">
                                {Array.isArray(f.proposedValue) ? f.proposedValue.join(', ') : String(f.proposedValue ?? '—')}
                              </td>
                              <td className="px-2.5 py-1.5 text-[var(--color-faint)]">{f.source}</td>
                              <td className="px-2.5 py-1.5 text-[var(--color-faint)]">{f.mappingMethod}</td>
                              <td className="px-2.5 py-1.5">{statusChip(review ? 'Review' : 'Ready', review ? 'review' : 'ready')}</td>
                            </tr>
                          );
                        })}
                        {suggestionRows.map((s) => (
                          <tr key={`ai-${s.providerFieldId}`} className="border-t border-violet-100 bg-violet-50/30 align-top">
                            <td className="px-2.5 py-1.5 font-semibold text-[var(--color-ink)]">{s.label}</td>
                            <td className="px-2.5 py-1.5 text-[var(--color-muted)] break-words max-w-[140px]">{fmtValue(s.proposedValue)}</td>
                            <td className="px-2.5 py-1.5 text-[var(--color-faint)]">{s.valueSource ?? s.answerSource ?? '—'}</td>
                            <td className="px-2.5 py-1.5">
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap bg-violet-50 text-violet-700 border-violet-200">
                                AI_SUGGESTED · {pct(s.confidence)}
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5">{statusChip(s.requiresUser ? 'Review required' : 'Laya suggestion', s.requiresUser ? 'review' : 'suggest')}</td>
                          </tr>
                        ))}
                        {bankRows.map((m) => (
                          <tr key={`bank-${m.providerFieldId}`} className="border-t border-sky-100 bg-sky-50/30 align-top">
                            <td className="px-2.5 py-1.5 font-semibold text-[var(--color-ink)]">{m.label}</td>
                            <td className="px-2.5 py-1.5 text-[var(--color-muted)] break-words max-w-[140px]">{fmtValue(m.value)}</td>
                            <td className="px-2.5 py-1.5 text-[var(--color-faint)]">ANSWER_BANK</td>
                            <td className="px-2.5 py-1.5">
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap bg-sky-50 text-sky-700 border-sky-200">
                                ANSWER_BANK · {pct(m.confidence)}
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5">{statusChip(m.requiresReview ? 'Review required' : 'Saved answer', m.requiresReview ? 'review' : 'ready')}</td>
                          </tr>
                        ))}
                        {needsInput.map((f) => (
                          <tr key={f.providerFieldId} className="border-t border-[var(--color-hairline)] align-top">
                            <td className="px-2.5 py-1.5 font-semibold text-[var(--color-ink)]">{f.label}</td>
                            <td className="px-2.5 py-1.5 text-[var(--color-faint)]">—</td>
                            <td className="px-2.5 py-1.5 text-[var(--color-faint)]">—</td>
                            <td className="px-2.5 py-1.5 text-[var(--color-faint)]">—</td>
                            <td className="px-2.5 py-1.5">{statusChip('Needs input', 'needs')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Needs input — question-learning when the Answer Bank is on */}
              {needsInput.length > 0 && (
                <Section title={`Needs your input · ${needsInput.length}`} icon={<CircleHelp className="w-3.5 h-3.5" />} tone="bg-sky-50 border-sky-200 text-sky-900">
                  {needsInput.map((f) => (
                    <div key={f.providerFieldId} className="space-y-1">
                      <div className="text-[11px]">
                        <span className="font-bold">{f.label}</span>
                        <span className="text-sky-700"> — {f.reason}. This will never be guessed.</span>
                      </div>
                      {bankEnabled && onAnswer && (
                        <textarea
                          value={draftAnswers[f.providerFieldId] || ''}
                          onChange={(e) => setDraftAnswers((prev) => ({ ...prev, [f.providerFieldId]: e.target.value }))}
                          placeholder="Your answer"
                          aria-label={`Answer for ${f.label}`}
                          className="w-full min-h-[52px] p-2 text-[11.5px] bg-white border border-sky-200 rounded-lg focus:border-[var(--color-brand)] outline-none"
                        />
                      )}
                    </div>
                  ))}
                  {bankEnabled && onAnswer && (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <label className="inline-flex items-center gap-1.5 text-[10.5px] text-sky-800">
                        <input type="checkbox" checked={rememberAnswers} onChange={(e) => setRememberAnswers(e.target.checked)} />
                        Remember for similar applications
                      </label>
                      <button
                        onClick={() => {
                          const entries = needsInput.filter((f) => (draftAnswers[f.providerFieldId] || '').trim());
                          if (!entries.length || savingAnswers) return;
                          setSavingAnswers(true);
                          void (async () => {
                            try {
                              for (const f of entries) {
                                await onAnswer(f.providerFieldId, f.label, draftAnswers[f.providerFieldId].trim(), rememberAnswers);
                              }
                            } finally {
                              setSavingAnswers(false);
                            }
                          })();
                        }}
                        disabled={savingAnswers || !needsInput.some((f) => (draftAnswers[f.providerFieldId] || '').trim())}
                        className="h-8 px-3 rounded-lg bg-[var(--color-brand)] text-white text-[11px] font-extrabold hover:bg-[var(--color-brand-strong)] disabled:opacity-50 cursor-pointer"
                      >
                        {savingAnswers ? 'Saving…' : 'Save answers & re-check'}
                      </button>
                    </div>
                  )}
                </Section>
              )}

              {/* Consent */}
              {consents.length > 0 && (
                <Section title={`Consent required · ${consents.length}`} icon={<ShieldAlert className="w-3.5 h-3.5" />} tone="bg-amber-50 border-amber-200 text-amber-900">
                  {consents.map((f) => (
                    <div key={f.providerFieldId} className="text-[11px]">
                      <span className="font-bold">{f.label}</span>
                      <span className="text-amber-700"> — {f.classification.replace(/_/g, ' ').toLowerCase()}. Always reviewed by you, never auto-accepted.</span>
                    </div>
                  ))}
                </Section>
              )}

              {/* Sensitive / EEO */}
              {sensitive.length > 0 && (
                <Section title={`Sensitive / EEO · ${sensitive.length}`} icon={<EyeOff className="w-3.5 h-3.5" />} tone="bg-slate-50 border-slate-200 text-slate-800">
                  {sensitive.map((f) => (
                    <div key={f.providerFieldId} className="text-[11px]">
                      <span className="font-bold">{f.label}</span>
                      <span className="text-slate-600"> — {f.reason}.</span>
                    </div>
                  ))}
                </Section>
              )}

              {/* Grounded generated drafts — always review-required */}
              {draftedSuggestions.length > 0 && (
                <Section
                  title={`Generated drafts — review required · ${draftedSuggestions.length}`}
                  icon={<Sparkles className="w-3.5 h-3.5" />}
                  tone="bg-indigo-50 border-indigo-200 text-indigo-900"
                >
                  {draftedSuggestions.map((s) => (
                    <div key={`draft-${s.providerFieldId}`} className="bg-white border border-indigo-200 rounded-lg p-2.5 space-y-1.5">
                      <div className="text-[11px] font-bold text-[var(--color-ink)]">{s.label}</div>
                      <blockquote className="text-[11.5px] text-[var(--color-ink)] leading-relaxed border-l-2 border-indigo-300 pl-2 whitespace-pre-wrap">
                        {s.generatedDraft!.value}
                      </blockquote>
                      <div className="flex items-center gap-2 flex-wrap text-[10px]">
                        <span className="font-semibold text-indigo-700">Generated from verified candidate facts</span>
                        <span className="text-[var(--color-faint)]">·</span>
                        {statusChip('Review required', 'review')}
                        <span className="text-[var(--color-faint)]">·</span>
                        <span className="text-[var(--color-faint)]">
                          {s.generatedDraft!.supportingFacts.length} supporting fact{s.generatedDraft!.supportingFacts.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {s.generatedDraft!.supportingFacts.length > 0 && (
                        <details className="text-[10.5px] text-[var(--color-faint)]">
                          <summary className="cursor-pointer select-none">Why this draft?</summary>
                          <ul className="mt-1 space-y-0.5">
                            {s.generatedDraft!.supportingFacts.map((f) => (
                              <li key={f.id}>• {f.id} ({f.source}): {f.summary}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  ))}
                  <p className="text-[10.5px] text-indigo-700 mt-1">
                    Drafts are suggestions only — never auto-approved, never filled into any form, never submitted.
                  </p>
                </Section>
              )}

              {/* Laya advisory suggestions without a value / hard-blocked */}
              {advisorySuggestions.length > 0 && (
                <Section
                  title={`Laya suggestions — advisory · ${advisorySuggestions.length}`}
                  icon={<Sparkles className="w-3.5 h-3.5" />}
                  tone="bg-violet-50 border-violet-200 text-violet-900"
                >
                  {advisorySuggestions.map((s) => (
                    <div key={`adv-${s.providerFieldId}`} className="text-[11px]">
                      <span className="font-bold">{s.label}</span>
                      <span className="text-violet-700">
                        {' — '}
                        {s.canonicalKey ? `${s.canonicalKey} · ` : ''}
                        {s.category.replace(/_/g, ' ').toLowerCase()}
                        {s.answerSource ? ` · ${s.answerSource}` : ''} · {pct(s.confidence)}
                        {s.hardBlocked
                          ? ' · blocked: review-only, never auto-answered'
                          : ' · no configured answer — needs your input'}
                      </span>
                    </div>
                  ))}
                  <p className="text-[10.5px] text-violet-700 mt-1">
                    Advisory only. Suggestions are never treated as deterministic answers.
                  </p>
                </Section>
              )}

              {/* Optional unresolved */}
              {optionalUnresolved.length > 0 && (
                <Section title={`Optional, unresolved · ${optionalUnresolved.length}`} icon={<CircleHelp className="w-3.5 h-3.5" />} tone="bg-slate-50 border-slate-200 text-slate-700">
                  {optionalUnresolved.map((f) => (
                    <div key={f.providerFieldId} className="text-[11px]">
                      <span className="font-semibold">{f.label}</span>
                      <span className="text-slate-500"> — {f.reason}.</span>
                    </div>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        {/* Footer — NO submit action exists in this phase. */}
        <div className="px-5 py-4 border-t border-[var(--color-hairline)] bg-[#FAFAF9] shrink-0">
          {result?.execution?.fillEnabled && result?.execution?.mode === 'fill_only' && result?.readiness?.status === 'READY' && result?.readiness?.canFill && onFill && (
            <div className="mb-3">
              <button
                onClick={() => void onFill()}
                disabled={fillBusy}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-600 text-white text-[12px] font-extrabold hover:bg-indigo-700 disabled:opacity-50 cursor-pointer"
              >
                {fillBusy ? 'Preparing fill…' : 'Fill Application (Experimental)'}
              </button>
              <p className="text-[10.5px] text-[var(--color-faint)] mt-1.5">
                The Browser Companion fills the Lever form with approved answers and attaches your exact resume.
                Tailor AI will NOT submit — you review and submit yourself.
              </p>
            </div>
          )}
          {fillState && (
            <div className="mb-3 p-2.5 bg-indigo-50 border border-indigo-200 rounded-lg text-[11px] text-indigo-900">
              <span className="font-extrabold">{fillState.status.replace(/_/g, ' ')}</span>
              {fillState.message ? ` — ${fillState.message}` : ''}
              {fillState.status === 'FILL_STARTED' && (
                <span> Open the Lever application page in your browser; the companion will fill it. Nothing is submitted.</span>
              )}
              {onCheckStatus && fillState.attemptId && (
                <button
                  onClick={() => void onCheckStatus()}
                  className="mt-1.5 text-[10.5px] font-bold text-indigo-700 underline cursor-pointer"
                >
                  Check verification
                </button>
              )}
            </div>
          )}
          <div className="text-[11.5px] font-extrabold text-[var(--color-ink)] uppercase tracking-wide">
            Dry run only
          </div>
          <p className="text-[11px] text-[var(--color-faint)] mt-0.5">
            No application has been submitted. Nothing was filled in a browser. Your job status was not changed.
            Local Laya suggestions and generated drafts are advisory only — they never replace deterministic
            answers or human review, and nothing is ever auto-filled from a draft.
          </p>
          <button
            onClick={onClose}
            className="mt-3 w-full inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-[var(--color-hairline)] bg-white text-[12px] font-bold text-[var(--color-ink)] hover:bg-slate-50 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
