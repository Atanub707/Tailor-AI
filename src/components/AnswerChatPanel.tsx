// Auto Apply — the "Needs you" panel (right-side drawer, same slot as preview).
//
// ONE consolidated surface for everything a run is waiting on (market-grade
// pattern from the HITL research):
//   - answerable questions  → inline chat (one at a time, saved immediately)
//   - browser-only steps    → named items with "Open in browser" (deep-focus)
//   - outcome reviews       → "the site didn't confirm…" with the page escape
// No dry-run wall of text — only what actually needs the human.

import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ExternalLink, X } from 'lucide-react';

export interface AnswerChatQuestion {
  providerFieldId: string;
  label: string;
  options?: string[];
}

export interface AnswerChatBrowserItem {
  label: string;
  reason?: string;
  ref?: string;
  name?: string;
}

interface Props {
  jobTitle: string;
  company: string;
  questions: AnswerChatQuestion[];
  onSaveAnswer: (question: string, answer: string, remember: boolean) => Promise<{ ok: boolean; error?: string }>;
  onSubmit: () => void | Promise<void>;
  onClose: () => void;
  /** Mid-run mode: the loop resumes by itself, so the final button is Continue. */
  submitLabel?: string;
  footnote?: string;
  /** Browser-only steps (consent, widget fixes) — resolved in the live window. */
  browserItems?: AnswerChatBrowserItem[];
  /** Outcome review (unconfirmed/rejected submission) — verify on the page. */
  reviewNote?: string | null;
  /** Deep-focus + open the live window on a specific item. */
  onOpenBrowser?: (item?: AnswerChatBrowserItem) => void;
  /** How long the agent holds this pause (epoch ms). */
  waitUntil?: number | null;
}

interface ChatMessage {
  id: number;
  role: 'assistant' | 'user' | 'error';
  text: string;
}

export const AnswerChatPanel: React.FC<Props> = ({
  jobTitle, company, questions, onSaveAnswer, onSubmit, onClose, submitLabel, footnote,
  browserItems = [], reviewNote = null, onOpenBrowser, waitUntil = null,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: 0, role: 'assistant', text: `${jobTitle} at ${company}` },
    ...(questions[0] ? [{ id: 1, role: 'assistant' as const, text: questions[0].label }] : []),
  ]);
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(questions.length === 0);
  const [submitting, setSubmitting] = useState(false);
  const nextId = useRef(2);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, done]);

  const push = (role: ChatMessage['role'], text: string) => {
    setMessages((prev) => [...prev, { id: nextId.current++, role, text }]);
  };

  const send = async (valueOverride?: string) => {
    const value = (valueOverride ?? input).trim();
    if (!value || busy || done) return;
    const question = questions[index];
    if (!question) return;
    setBusy(true);
    const res = await onSaveAnswer(question.label, value, remember);
    setBusy(false);
    if (!res.ok) {
      push('error', res.error || 'Could not save that answer — try again.');
      return;
    }
    push('user', value);
    setInput('');
    const next = index + 1;
    setIndex(next);
    if (next < questions.length) {
      push('assistant', questions[next].label);
    } else {
      push('assistant', 'All answers saved.');
      setDone(true);
    }
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    await onSubmit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const remaining = Math.min(index + 1, questions.length);
  const hasChat = questions.length > 0;
  const hasBrowser = browserItems.length > 0;
  const hasReview = !!reviewNote;
  const anythingPending = (hasChat && !done) || hasBrowser || hasReview;
  const holdLine = waitUntil && Date.now() < waitUntil
    ? `I'll hold this until ${new Date(waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — answer anytime.`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Auto Apply needs you">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-[460px] bg-white h-full flex flex-col shadow-xl border-l border-[var(--color-hairline)]">
        <header className="px-4 py-3 border-b border-[var(--color-hairline)] flex items-center justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-[var(--color-ink)]">Auto Apply</div>
            <div className="text-[11px] text-[var(--color-faint)] truncate">
              {jobTitle} · {company}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-extrabold uppercase tracking-wide bg-sky-50 text-sky-700 border border-sky-200 rounded-full px-2 py-0.5 whitespace-nowrap">
              {hasChat && !done ? `Question ${remaining} of ${questions.length}` : 'Needs you'}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-[var(--color-faint)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
          {hasReview && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 text-[12px] leading-relaxed rounded-xl px-3.5 py-3">
              {reviewNote}
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div
                key={m.id}
                className="ml-auto max-w-[85%] bg-[var(--color-brand)] text-white text-[12.5px] leading-relaxed rounded-2xl rounded-br-md px-3.5 py-2.5 whitespace-pre-wrap"
              >
                {m.text}
              </div>
            ) : m.role === 'error' ? (
              <div key={m.id} className="max-w-[85%] bg-red-50 border border-red-200 text-red-800 text-[11.5px] rounded-xl px-3 py-2">
                {m.text}
              </div>
            ) : (
              <div
                key={m.id}
                className="max-w-[85%] bg-[#F4F4F5] text-[var(--color-ink)] text-[12.5px] leading-relaxed rounded-2xl rounded-bl-md px-3.5 py-2.5 whitespace-pre-wrap"
              >
                {m.text}
              </div>
            ),
          )}
          {busy && <div className="text-[11px] text-[var(--color-faint)]">Saving…</div>}
          {!done && (questions[index]?.options?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {questions[index]!.options!.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  disabled={busy}
                  onClick={() => void send(opt)}
                  className="px-3 py-1.5 rounded-full border border-[var(--color-brand-line)] bg-[var(--color-brand-soft)] text-[var(--color-brand)] text-[11.5px] font-bold hover:bg-[var(--color-brand)] hover:text-white disabled:opacity-50 cursor-pointer"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}

          {hasBrowser && (
            <div className="pt-2 space-y-2">
              <div className="text-[10.5px] font-extrabold uppercase tracking-wide text-[var(--color-faint)]">
                Do this in Tailor Browser
              </div>
              {browserItems.map((item, i) => (
                <div key={`${item.label}-${i}`} className="border border-[var(--color-hairline)] rounded-xl p-3 space-y-1.5">
                  <div className="text-[12px] font-bold text-[var(--color-ink)]">{item.label}</div>
                  {item.reason && <div className="text-[11px] text-[var(--color-faint)] leading-relaxed">{item.reason}</div>}
                  <button
                    type="button"
                    onClick={() => onOpenBrowser?.(item)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-extrabold text-[var(--color-brand)] cursor-pointer"
                  >
                    <ExternalLink className="w-3 h-3" /> Open in browser
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--color-hairline)] p-3 space-y-2 shrink-0">
          {!done ? (
            <>
              <label className="flex items-center gap-1.5 text-[10.5px] text-[var(--color-faint)] cursor-pointer">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Remember for similar applications
              </label>
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Type your answer…"
                  aria-label="Your answer"
                  rows={2}
                  className="flex-1 resize-none p-2.5 text-[12.5px] bg-white border border-[var(--color-hairline)] rounded-xl focus:border-[var(--color-brand)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={busy || !input.trim()}
                  aria-label="Send answer"
                  className="w-9 h-9 shrink-0 rounded-full bg-[var(--color-brand)] text-white flex items-center justify-center disabled:opacity-40 cursor-pointer"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting}
                className="w-full h-10 inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-brand)] text-white text-[12.5px] font-extrabold disabled:opacity-50 cursor-pointer"
              >
                {submitting ? 'Starting…' : (<><Check className="w-4 h-4" /> {submitLabel ?? 'Submit application'}</>)}
              </button>
              <p className="text-[10.5px] text-[var(--color-faint)] text-center">
                {anythingPending ? (holdLine || footnote || 'The run continues by itself — you can close this.') : (footnote ?? "I'll tailor your CV with these answers, fill the form, and submit.")}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
