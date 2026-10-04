// Auto Apply — Application Answer Bank screen.
//
// User-managed, user-scoped saved answers. Disabled (and explained) when the
// experimental Answer Bank flag is off. No answers are ever shared or sent
// anywhere except the local backend.

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, Trash2, RefreshCw } from 'lucide-react';

interface BankAnswer {
  id: string;
  canonicalQuestion: string;
  questionCategory?: string;
  answerType: string;
  answerValue: string | number | boolean | string[] | null;
  verificationStatus: 'VERIFIED' | 'REVIEW_REQUIRED' | 'STALE';
  sensitivity: string;
  reusable: boolean;
  usageCount: number;
  source?: string;
  options?: string[];
  updatedAt: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const displayValue = (v: BankAnswer['answerValue']): string => {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

const statusChip = (status: BankAnswer['verificationStatus']) => {
  const map = {
    VERIFIED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    REVIEW_REQUIRED: 'bg-amber-50 text-amber-700 border-amber-200',
    STALE: 'bg-orange-50 text-orange-700 border-orange-200',
  } as const;
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${map[status]}`}>{status.replace('_', ' ')}</span>;
};

export const AnswerBankScreen: React.FC<Props> = ({ isOpen, onClose }) => {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [answers, setAnswers] = useState<BankAnswer[]>([]);
  const [pending, setPending] = useState<BankAnswer[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<Record<string, string>>({});
  const [autoSubmit, setAutoSubmit] = useState(false);
  const [autoSubmitNote, setAutoSubmitNote] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswer, setNewAnswer] = useState('');
  const [newReusable, setNewReusable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const bankRes = await fetch('/api/auto-apply/answer-bank');
      if (bankRes.ok) {
        const data = await bankRes.json();
        setEnabled(data.enabled === true);
        setAnswers(data.answers || []);
        setPending(data.pending || []);
      } else {
        setEnabled(false);
      }
      const prefRes = await fetch('/api/auto-apply/preferences');
      if (prefRes.ok) {
        const p = await prefRes.json();
        setAutoSubmit(p?.preferences?.autoSubmitEnabled === true);
      }
    } catch {
      setEnabled(false);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (isOpen && !loaded) void load();
  }, [isOpen, loaded, load]);

  if (!isOpen) return null;

  const saveNew = async () => {
    if (!newQuestion.trim() || !newAnswer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auto-apply/answer-bank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonicalQuestion: newQuestion.trim(), answer: newAnswer.trim(), answerType: 'TEXTAREA', reusable: newReusable }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save.');
      setNewQuestion('');
      setNewAnswer('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/auto-apply/answer-bank/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: editValue, verificationStatus: 'VERIFIED' }),
      });
      if (!res.ok) throw new Error('Could not update.');
      setEditingId(null);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Could not update.');
    } finally {
      setBusy(false);
    }
  };

  const savePending = async (p: BankAnswer) => {
    const value = (pendingDrafts[p.id] || '').trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auto-apply/answer-bank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonicalQuestion: p.canonicalQuestion, answer: value, answerType: p.answerType, sensitivity: p.sensitivity, reusable: true }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save.');
      setPendingDrafts((prev) => ({ ...prev, [p.id]: '' }));
      await load();
    } catch (e: any) {
      setError(e?.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoSubmit = async () => {
    const next = !autoSubmit;
    setAutoSubmit(next);
    setAutoSubmitNote(null);
    try {
      const res = await fetch('/api/auto-apply/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSubmitEnabled: next, mode: next ? 'explicit_approval' : 'manual_review' }),
      });
      if (!res.ok) throw new Error('save failed');
      setAutoSubmitNote(next ? 'Auto-submit is ON — verified applications submit automatically.' : 'Auto-submit is OFF — you click Submit Application.');
    } catch {
      setAutoSubmit(!next);
      setAutoSubmitNote('Could not save that setting — try again.');
    }
  };

  const toggleReusable = async (a: BankAnswer) => {
    await fetch(`/api/auto-apply/answer-bank/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reusable: !a.reusable }),
    }).catch(() => {});
    await load();
  };

  const remove = async (id: string) => {
    await fetch(`/api/auto-apply/answer-bank/${id}`, { method: 'DELETE' }).catch(() => {});
    await load();
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <button onClick={onClose} className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--color-muted)] hover:text-[var(--color-ink)] cursor-pointer mb-2">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <h1 className="text-xl font-black text-[var(--color-ink)]">Application Answer Bank</h1>
            <p className="text-xs text-[var(--color-faint)] mt-1">
              Answers you save here are reused for similar application questions — stored locally, scoped to your account.
            </p>
          </div>
          <button onClick={() => void load()} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--color-hairline)] bg-white text-xs font-bold text-[var(--color-muted)] hover:bg-slate-50 cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {!enabled ? (
          <div className="p-5 bg-amber-50 border border-amber-200 rounded-xl text-[12px] text-amber-800">
            The Application Answer Bank is an experimental feature and is currently disabled.
            Enable <code className="font-mono">AUTO_APPLY_ANSWER_BANK_ENABLED=true</code> (with Auto Apply enabled) to use it.
          </div>
        ) : (
          <>
            {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-[11.5px] text-red-800">{error}</div>}

            {/* Waiting for your answer — questions collected from real runs */}
            {pending.length > 0 && (
              <div className="mb-6 bg-white border border-amber-200 rounded-xl p-4">
                <h2 className="text-[12px] font-extrabold uppercase tracking-wider text-amber-700 mb-1">
                  Waiting for your answer ({pending.length})
                </h2>
                <p className="text-[11px] text-[var(--color-faint)] mb-3">
                  These questions came from your Auto Apply runs. Answer once — it is reused for every job that asks the same thing.
                </p>
                <div className="grid gap-3">
                  {pending.map((p) => (
                    <div key={p.id} className="grid gap-1.5">
                      <div className="text-[11.5px] font-bold text-[var(--color-ink)]">{p.canonicalQuestion}</div>
                      <div className="flex gap-2">
                        {p.options && p.options.length > 0 ? (
                          <select
                            value={pendingDrafts[p.id] || ''}
                            onChange={(e) => setPendingDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                            aria-label={`Answer for ${p.canonicalQuestion}`}
                            className="flex-1 h-9 px-3 text-[12px] border border-[var(--color-hairline)] rounded-lg focus:border-[var(--color-brand)] outline-none bg-white"
                          >
                            <option value="">Select…</option>
                            {p.options.map((o) => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={pendingDrafts[p.id] || ''}
                            onChange={(e) => setPendingDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                            placeholder="Your answer"
                            aria-label={`Answer for ${p.canonicalQuestion}`}
                            className="flex-1 h-9 px-3 text-[12px] border border-[var(--color-hairline)] rounded-lg focus:border-[var(--color-brand)] outline-none"
                          />
                        )}
                        <button
                          onClick={() => void savePending(p)}
                          disabled={busy || !(pendingDrafts[p.id] || '').trim()}
                          className="h-9 px-3 rounded-lg bg-[var(--color-brand)] text-white text-[11.5px] font-extrabold hover:bg-[var(--color-brand-strong)] disabled:opacity-50 cursor-pointer"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => void remove(p.id)}
                          className="h-9 px-3 rounded-lg border border-[var(--color-hairline)] text-[11.5px] font-bold text-[var(--color-muted)] hover:bg-slate-50 cursor-pointer"
                        >
                          Skip
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Auto-submit preference (explicit opt-in, default OFF) */}
            <div className="mb-6 bg-white border border-[var(--color-hairline)] rounded-xl p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[12.5px] font-extrabold text-[var(--color-ink)]">Auto-submit verified applications</div>
                  <p className="text-[11px] text-[var(--color-faint)] mt-0.5 max-w-[560px]">
                    Tailor AI submits only after full verification: exact job, every required field checked, resume verified,
                    no pending CAPTCHA/OTP/MFA, one server-authorized click, then it confirms the provider's success.
                    CAPTCHA/OTP/MFA still require you.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoSubmit}
                  aria-label="Auto-submit verified applications"
                  onClick={() => void toggleAutoSubmit()}
                  className={`relative h-6 w-11 rounded-full transition-colors cursor-pointer shrink-0 ${autoSubmit ? 'bg-emerald-600' : 'bg-slate-300'}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${autoSubmit ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
              </div>
              {autoSubmitNote && <div className="text-[10.5px] text-[var(--color-muted)] mt-2">{autoSubmitNote}</div>}
            </div>

            {/* Add new */}
            <div className="bg-white border border-[var(--color-hairline)] rounded-xl p-4 mb-6">
              <h2 className="text-[12px] font-extrabold uppercase tracking-wider text-[var(--color-faint)] mb-3 flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add an answer
              </h2>
              <div className="grid gap-2">
                <input
                  value={newQuestion}
                  onChange={(e) => setNewQuestion(e.target.value)}
                  placeholder="Question (e.g. What is your notice period?)"
                  className="w-full h-9 px-3 text-[12px] border border-[var(--color-hairline)] rounded-lg focus:border-[var(--color-brand)] outline-none"
                />
                <textarea
                  value={newAnswer}
                  onChange={(e) => setNewAnswer(e.target.value)}
                  placeholder="Your answer"
                  className="w-full min-h-[64px] p-3 text-[12px] border border-[var(--color-hairline)] rounded-lg focus:border-[var(--color-brand)] outline-none"
                />
                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-2 text-[11.5px] text-[var(--color-muted)]">
                    <input type="checkbox" checked={newReusable} onChange={(e) => setNewReusable(e.target.checked)} />
                    Reuse for similar questions
                  </label>
                  <button
                    onClick={() => void saveNew()}
                    disabled={busy || !newQuestion.trim() || !newAnswer.trim()}
                    className="h-9 px-4 rounded-lg bg-[var(--color-brand)] text-white text-xs font-extrabold hover:bg-[var(--color-brand-strong)] disabled:opacity-50 cursor-pointer"
                  >
                    Save answer
                  </button>
                </div>
              </div>
            </div>

            {/* Stored answers */}
            <div className="bg-white border border-[var(--color-hairline)] rounded-xl overflow-hidden">
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="bg-[#FAFAF9] text-[9px] uppercase tracking-wide text-[var(--color-faint)]">
                    <th className="text-left font-bold px-3 py-2">Question</th>
                    <th className="text-left font-bold px-3 py-2">Saved answer</th>
                    <th className="text-left font-bold px-3 py-2">Status</th>
                    <th className="text-left font-bold px-3 py-2">Used</th>
                    <th className="text-left font-bold px-3 py-2">Reusable</th>
                    <th className="text-right font-bold px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {answers.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-[var(--color-faint)]">No saved answers yet.</td></tr>
                  )}
                  {answers.filter((a) => !(a.source === 'AUTO_COLLECTED' && a.verificationStatus === 'REVIEW_REQUIRED')).map((a) => (
                    <tr key={a.id} className="border-t border-[var(--color-hairline)] align-top">
                      <td className="px-3 py-2 font-semibold text-[var(--color-ink)] max-w-[220px]">{a.canonicalQuestion}</td>
                      <td className="px-3 py-2 text-[var(--color-muted)] max-w-[260px]">
                        {editingId === a.id ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              className="w-full h-8 px-2 text-[11.5px] border border-[var(--color-hairline)] rounded-md outline-none focus:border-[var(--color-brand)]"
                            />
                            <button onClick={() => void saveEdit(a.id)} disabled={busy} className="text-[10px] font-bold text-[var(--color-brand)] cursor-pointer">Save</button>
                            <button onClick={() => setEditingId(null)} className="text-[10px] font-bold text-[var(--color-faint)] cursor-pointer">Cancel</button>
                          </div>
                        ) : (
                          <span className="break-words">{displayValue(a.answerValue)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{statusChip(a.verificationStatus)}</td>
                      <td className="px-3 py-2 text-[var(--color-faint)]">{a.usageCount}×</td>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={a.reusable} onChange={() => void toggleReusable(a)} aria-label={`Reusable: ${a.canonicalQuestion}`} />
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => { setEditingId(a.id); setEditValue(displayValue(a.answerValue)); }}
                          className="text-[10px] font-bold text-[var(--color-brand)] mr-2 cursor-pointer"
                        >
                          Edit
                        </button>
                        <button onClick={() => void remove(a.id)} aria-label={`Delete ${a.canonicalQuestion}`} className="text-red-600 hover:text-red-700 cursor-pointer align-middle">
                          <Trash2 className="w-3.5 h-3.5 inline" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[10.5px] text-[var(--color-faint)] mt-3">
              Stale or sensitive answers are never reused silently — Tailor AI always asks you to confirm them during an application.
            </p>
          </>
        )}
      </div>
    </div>
  );
};
