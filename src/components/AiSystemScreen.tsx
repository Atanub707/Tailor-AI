import React, { useState, useEffect } from 'react';
import { ArrowRight, ChatCircleText, CheckCircle, Clock, ListChecks, Target, SuitcaseSimple, Briefcase, X, ClockCounterClockwise } from '@phosphor-icons/react';

interface RoleOption { label: string; count: number }
interface JobOption { id: string; title: string; company: string }
interface Question { question: string; jobTitle: string; company: string; questionIndex: number; total: number }
interface ScorecardRow { question: string; jobTitle: string; score: number; feedback: string }
interface Scorecard { overall: number; verdict: string; perQuestion: ScorecardRow[] }
interface StoredInterview {
  id: string;
  role: string;
  total: number;
  overall: number;
  verdict: string;
  perQuestion: ScorecardRow[];
  createdAt: string;
}

type IvStep = 'intro' | 'qa' | 'scorecard';
const DIM_LABELS: Record<string, string> = { accuracy: 'Acc', depth: 'Dep', structure: 'Str', examples: 'Ex' };

export const AiSystemScreen: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [ivStep, setIvStep] = useState<IvStep>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // setup state
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [customRole, setCustomRole] = useState('');
  const [experience, setExperience] = useState('');
  const [jobOptions, setJobOptions] = useState<JobOption[]>([]);
  const [selectedJobs, setSelectedJobs] = useState<string[]>([]);

  // session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState('');
  const [lastResult, setLastResult] = useState<{ score: number; feedback: string; dims?: { accuracy: number; depth: number; structure: number; examples: number } } | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);

  // history panel
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<StoredInterview[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const role = (selectedRole || customRole.trim());
  const answerWords = answer.trim() ? answer.trim().split(/\s+/).length : 0;
  const allSelected = jobOptions.length > 0 && selectedJobs.length === jobOptions.length;

  useEffect(() => {
    if (roles.length === 0) {
      fetch('/api/interview/roles')
        .then((r) => r.json())
        .then((d) => {
          const list = d.roles || [];
          setRoles(list);
          // Auto-select the top role so the posting list shows immediately.
          if (list.length > 0) setSelectedRole(list[0].label);
        })
        .catch(() => setError('Could not load roles from your dashboard.'));
    }
  }, [roles.length]);

  // load real postings for the picked role (question bank)
  useEffect(() => {
    if (!role || ivStep !== 'intro') return;
    setJobOptions([]);
    setSelectedJobs([]);
    fetch(`/api/interview/jobs?role=${encodeURIComponent(role)}`)
      .then((r) => r.json())
      .then((d) => setJobOptions(d.jobs || []))
      .catch(() => setJobOptions([]));
  }, [role, ivStep]);

  const openHistory = () => {
    setHistoryOpen(true);
    if (history === null) {
      fetch('/api/interview/history')
        .then((r) => r.json())
        .then((d) => setHistory(d.sessions || []))
        .catch(() => setHistory([]));
    }
  };

  const toggleJob = (id: string) => {
    setSelectedJobs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleAll = () => {
    setSelectedJobs(allSelected ? [] : jobOptions.map((j) => j.id));
  };

  const beginInterview = async () => {
    if (!role || busy) return;
    setBusy(true);
    setError(null);
    setLastResult(null);
    setScorecard(null);
    try {
      const res = await fetch('/api/interview/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, experienceYears: experience || 'not specified', jobIds: selectedJobs }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || 'Could not start the interview.');
      setSessionId(d.sessionId);
      setQuestion({ question: d.question, jobTitle: d.jobTitle, company: d.company, questionIndex: d.questionIndex, total: d.total });
      setIvStep('qa');
    } catch (e: any) {
      setError(e?.message || 'Could not start the interview.');
    } finally {
      setBusy(false);
    }
  };

  const submitAnswer = async () => {
    if (!sessionId || !answer.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/interview/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, answer }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || 'Could not evaluate your answer.');
      setAnswer('');
      if (d.done) {
        setScorecard(d.scorecard);
        setIvStep('scorecard');
      } else {
        setLastResult({ score: d.score, feedback: d.feedback, dims: d.dims });
        setQuestion({ question: d.question, jobTitle: d.jobTitle, company: d.company, questionIndex: d.questionIndex, total: d.total });
      }
    } catch (e: any) {
      setError(e?.message || 'Could not evaluate your answer.');
    } finally {
      setBusy(false);
    }
  };

  const resetInterview = () => {
    setSessionId(null);
    setQuestion(null);
    setAnswer('');
    setLastResult(null);
    setScorecard(null);
    setIvStep('intro');
  };

  return (
    <div className="ai-screen">
      <header className="ai-hdr">
        <div className="ai-hdr-logo"><span className="orb orb-sm orb-idle" aria-hidden="true"></span></div>
        <div className="ai-hdr-divider" aria-hidden="true"></div>
        <div className="ai-hdr-ttl">
          <b>AI Interview</b>
          <span>Mock interview grounded in your real job descriptions</span>
        </div>
        <div className="ai-spacer" />
        <button className="ai-hbtn" onClick={openHistory} aria-label="Open interview history">
          <ClockCounterClockwise size={15} weight="bold" /> History {history && <span className="ai-hcnt">{history.length}</span>}
        </button>
        <button className="ai-x" onClick={onClose} aria-label="Close"><X size={18} weight="bold" /></button>
      </header>

      {/* ── Setup — the entry (no landing) ── */}
      {ivStep === 'intro' && (
        <div className="ai-iv">
          <div className="ai-iv-col">
            <div className="ai-panel">
              <div className="ai-panel-head">
                <span className="ai-panel-ico"><SuitcaseSimple size={19} weight="duotone" /></span>
                <div>
                  <h3>Before we begin</h3>
                  <p>The interviewer asks you 3 quick questions to personalize the session.</p>
                </div>
              </div>
              <div className="ai-stepper">
                <span className="on"><i></i> Role</span>
                <span><i></i> Experience</span>
                <span><i></i> Posting</span>
              </div>
              <div className="ai-panel-body">
                {roles.length === 0 && (
                  <div className="ai-nodata">
                    <span className="ai-nodata-ico"><Briefcase size={20} weight="duotone" /></span>
                    <div><b>Your dashboard has no jobs yet</b><p>Search &amp; scrape jobs first (Search bar → Search Jobs), then come back — the interviewer works from your real postings.</p></div>
                  </div>
                )}
                <div className="ai-field">
                  <label className="ai-flabel"><span className="ai-step-n">1</span> Which role from your dashboard?</label>
                  <div className="ai-rolechips">
                    {roles.map((r) => (
                      <button key={r.label} className={`ai-chip ${selectedRole === r.label ? 'on' : ''}`} onClick={() => { setSelectedRole(r.label); setCustomRole(''); }}>
                        <span className="ai-chip-check"><CheckCircle size={12} weight="bold" /></span>
                        <span className="ai-chip-label">{r.label}</span>
                        <span className="ai-chip-cnt">{r.count} jobs</span>
                      </button>
                    ))}
                  </div>
                  <div className="ai-inputwrap"><input placeholder="Or type another role…" value={customRole} onChange={(e) => { setCustomRole(e.target.value); setSelectedRole(null); }} /></div>
                </div>

                <div className="ai-field">
                  <label className="ai-flabel"><span className="ai-step-n">2</span> Years of experience in this role</label>
                  <div className="ai-inputwrap"><input placeholder="e.g. 4+ years" value={experience} onChange={(e) => setExperience(e.target.value)} /></div>
                </div>

                <div className="ai-field">
                  <label className="ai-flabel"><span className="ai-step-n">3</span> Pick a real posting from your list <span className="ai-opt">optional</span> <span className="ai-selcount">{selectedJobs.length} selected</span></label>
                  <div className="ai-postings">
                    <div className="ai-postings-all">
                      <button className={`ai-allrow ${allSelected ? 'on' : ''}`} onClick={toggleAll} disabled={!jobOptions.length}>
                        <span className="ai-check"><CheckCircle size={12} weight="bold" /></span>
                        <b>Select all postings</b>
                        <span className="ai-allcnt">{jobOptions.length} jobs in this list</span>
                      </button>
                    </div>
                    <div className="ai-postings-list">
                      {jobOptions.length === 0 && (
                        <div className="ai-postings-empty">{role ? `No postings found for “${role}” yet — scrape more jobs first.` : 'Pick a role above to see its postings.'}</div>
                      )}
                      {jobOptions.map((j) => (
                        <button key={j.id} className={`ai-posting ${selectedJobs.includes(j.id) ? 'on' : ''}`} onClick={() => toggleJob(j.id)}>
                          <span className="ai-check"><CheckCircle size={11} weight="bold" /></span>
                          <span className="ai-pt"><b>{j.title}</b><span>{j.company}</span></span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="ai-pfield-hint">The interviewer generates every question from the postings you pick — select the ones you want to be quizzed on.</p>
                </div>

                {error && <div className="ai-error">{error}</div>}
                <div className="ai-actions">
                  <button className="ai-btn primary" onClick={beginInterview} disabled={busy || !role}>
                    {busy ? 'Setting up…' : 'Begin interview'} {!busy && <ArrowRight size={15} weight="bold" />}
                  </button>
                  <span className="ai-hint"><Clock size={12} weight="bold" /> 7 questions · scored per answer · final verdict</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Q&A ── */}
      {ivStep === 'qa' && question && (
        <div className="ai-iv">
          <div className="ai-iv-col">
            <div className="ai-qa-top">
              <span className="ai-qa-progress">Question <b>{question.questionIndex}</b> of {question.total}</span>
              <div className="ai-qa-dots">
                {Array.from({ length: question.total }, (_, i) => <i key={i} className={i < question.questionIndex ? 'done' : i === question.questionIndex - 1 ? 'now' : ''}></i>)}
              </div>
            </div>
            <div className="ai-q">
              <span className="ai-qtag"><ChatCircleText size={11} weight="fill" /> Interviewer</span>
              <p className="ai-qtext">{question.question}</p>
              <div className="ai-qsrc">
                <Briefcase size={12} weight="bold" /> From this JD:
                <span className="ai-src-chip">{question.jobTitle}</span>
                {question.company && <span className="ai-src-chip">{question.company}</span>}
              </div>
            </div>
            <div className="ai-answer-wrap">
              <textarea className="ai-answer" placeholder="Type your answer…" value={answer} onChange={(e) => setAnswer(e.target.value)} />
              <div className="ai-answer-meta">
                <span>{answerWords > 0 ? `${answerWords} words` : 'Be specific — depth and examples count'}</span>
                <span className={answerWords < 12 && answerWords > 0 ? 'warn' : ''}>{answerWords > 0 && answerWords < 12 ? 'Add more detail' : ''}</span>
              </div>
            </div>
            <div className="ai-iv-actions">
              <button className="ai-btn primary" onClick={submitAnswer} disabled={busy || !answer.trim()}>
                {busy ? 'Scoring…' : 'Submit answer'} {!busy && <ArrowRight size={14} weight="bold" />}
              </button>
              <a className="ai-btn wispr" href="https://ref.wisprflow.ai/atanu-biswas" target="_blank" rel="noreferrer" title="Stop texting, start speaking — dictate your answers with Wispr Flow">
                <span className="ai-w-logo">W</span> Stop texting, start speaking.
              </a>
              {lastResult && (
                <span className="ai-score-pill">
                  <b>{lastResult.score}/10</b>
                  {lastResult.dims && (
                    <span className="ai-dims">
                      {Object.entries(lastResult.dims).map(([k, v]) => <em key={k}><b>{DIM_LABELS[k]}</b> {v}</em>)}
                    </span>
                  )}
                  <span className="ai-pill-fb">— {lastResult.feedback}</span>
                </span>
              )}
            </div>
            {error && <div className="ai-error">{error}</div>}
          </div>
        </div>
      )}

      {/* ── Scorecard ── */}
      {ivStep === 'scorecard' && scorecard && (
        <div className="ai-iv">
          <div className="ai-iv-col">
            <div className="ai-sc">
              <div className="ai-sc-head">
                <div className="ai-sc-ring" style={{ '--p': `${scorecard.overall * 10}%` } as React.CSSProperties}><b>{scorecard.overall}</b><span>overall</span></div>
                <div className="ai-sc-head-txt">
                  <span className="ai-sc-role"><Target size={12} weight="fill" /> {role}</span>
                  <h3>Interview complete</h3>
                  <p>{scorecard.verdict}</p>
                </div>
              </div>
              <div className="ai-sc-list-head"><ListChecks size={13} weight="duotone" /> Question breakdown</div>
              {scorecard.perQuestion.map((row, i) => (
                <div className="ai-sc-row" key={i}>
                  <span className="ai-sc-q"><i>{i + 1}</i> {row.question}</span>
                  <span className={`ai-sc-score ${row.score < 7 ? 'low' : ''}`}>{row.score}/10</span>
                </div>
              ))}
              <div className="ai-actions" style={{ marginTop: 22 }}>
                <button className="ai-btn primary" onClick={resetInterview}>Done <CheckCircle size={14} weight="bold" /></button>
                <button className="ai-btn ghost" onClick={resetInterview}>Take another interview</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── History slide-in panel (Manual JD pattern) ── */}
      <div className={`ai-overlay ${historyOpen ? 'open' : ''}`} onClick={() => setHistoryOpen(false)}></div>
      <aside className={`ai-hpanel ${historyOpen ? 'open' : ''}`} aria-label="Interview history">
        <div className="ai-hpanel-head">
          <span className="ai-hpanel-ico"><ClockCounterClockwise size={16} weight="duotone" /></span>
          <b>Interview history</b>
          {history && <span className="ai-hpanel-cnt">{history.length} session{history.length === 1 ? '' : 's'}</span>}
          <button className="ai-hpanel-x" onClick={() => setHistoryOpen(false)} aria-label="Close history"><X size={17} weight="bold" /></button>
        </div>
        <div className="ai-hpanel-body">
          {history === null && <div className="ai-h-empty">Loading…</div>}
          {history !== null && history.length === 0 && (
            <div className="ai-h-empty"><b>No interviews yet</b><p>Your completed sessions will appear here with scores, verdicts and full answers.</p></div>
          )}
          {history !== null && history.map((h) => (
            <div key={h.id} className={`ai-hrow ${expandedId === h.id ? 'open' : ''}`}>
              <button className="ai-hrow-main" onClick={() => setExpandedId(expandedId === h.id ? null : h.id)}>
                <span className="ai-hring" style={{ '--p': `${h.overall * 10}%` } as React.CSSProperties}><b>{h.overall}</b></span>
                <span className="ai-hmeta">
                  <b>{h.role}</b>
                  <span><Clock size={11} weight="bold" /> {new Date(h.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · {new Date(h.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · {h.total} questions</span>
                </span>
                <span className={`ai-hchev ${expandedId === h.id ? 'open' : ''}`}><ArrowRight size={13} weight="bold" /></span>
              </button>
              {expandedId === h.id && (
                <div className="ai-hdetail">
                  <div className="ai-hdetail-head">Questions &amp; scores</div>
                  {h.perQuestion.map((q, i) => (
                    <div className="ai-hq" key={i}>
                      <span className="ai-hq-text">{i + 1}. {q.question}</span>
                      <span className={`ai-hscore ${q.score < 7 ? 'low' : ''}`}>{q.score}/10</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      <style>{`
        .ai-screen{--ink:#0F172A; --muted:#475569; --faint:#64748B; --hairline:#E2E8F0; --hairline2:#CBD5E1;
          --brand:#2563EB; --brand-strong:#1D4ED8; --brand-line:#BFDBFE; --brand-soft:#EFF6FF;
          --emerald:#059669; --emerald-soft:#ECFDF5; --emerald-line:#A7F3D0;
          --amber:#D97706; --amber-soft:#FFFBEB; --amber-line:#FDE68A;
          --sh-sm:0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06);
          --sh-md:0 4px 14px -6px rgba(15,23,42,.09), 0 2px 6px -3px rgba(15,23,42,.06);
          --sh-lg:0 24px 55px -20px rgba(15,23,42,.25);
          position:relative; height:calc(100vh - 74px); background:#F7F8FA; color:var(--ink);
          display:flex; flex-direction:column; font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;}
        :focus-visible{outline:2.5px solid var(--brand); outline-offset:2px; border-radius:8px;}
        *{box-sizing:border-box;}

        .ai-hdr{display:flex; align-items:center; gap:13px; padding:0 28px; height:64px; border-bottom:1px solid var(--hairline);
          background:rgba(255,255,255,.82); backdrop-filter:blur(12px); flex-shrink:0; position:relative; z-index:5;}
        .ai-hdr-logo{display:inline-flex;}
        .ai-hdr-divider{width:1px; height:26px; background:var(--hairline);}
        .ai-hdr-ttl b{font-size:15px; font-weight:800; display:block; line-height:1.2; letter-spacing:-.01em;}
        .ai-hdr-ttl span{font-size:11px; color:var(--faint); font-weight:500;}
        .ai-spacer{flex:1;}
        .ai-hbtn{display:inline-flex; align-items:center; gap:7px; padding:10px 16px; border-radius:11px; font-size:12.5px; font-weight:800;
          color:var(--muted); background:#fff; border:1.5px solid var(--hairline2); box-shadow:var(--sh-sm); cursor:pointer; transition:all .2s ease;}
        .ai-hbtn:hover{border-color:var(--brand); color:var(--brand); background:var(--brand-soft);}
        .ai-hcnt{font-size:10px; font-weight:800; color:var(--brand); background:var(--brand-soft); border:1px solid var(--brand-line); border-radius:999px; padding:2px 8px;}
        .ai-x{border:0; background:none; color:var(--faint); cursor:pointer; padding:8px; border-radius:10px; display:inline-flex; transition:all .2s ease;}
        .ai-x:hover{background:#F1F5F9; color:var(--ink);}

        .orb{position:relative; border-radius:50%; flex-shrink:0;
          background:radial-gradient(circle at 32% 28%, #fff 0%, #DBEAFE 9%, var(--brand) 42%, #1D4ED8 68%, #1E3A8A 100%);
          box-shadow:inset -14px -12px 26px rgba(30,58,138,.5), inset 8px 8px 18px rgba(255,255,255,.55), 0 22px 55px -14px rgba(37,99,235,.6);}
        .orb::before{content:''; position:absolute; top:9%; left:16%; width:36%; height:24%; border-radius:50%;
          background:radial-gradient(circle, rgba(255,255,255,.9), rgba(255,255,255,0) 70%); transform:rotate(-20deg);}
        .orb::after{content:''; position:absolute; inset:0; border-radius:50%;
          background:radial-gradient(circle at 50% 115%, rgba(37,99,235,.5), transparent 55%);}
        .orb-sm{width:30px; height:30px; margin:0; box-shadow:inset -6px -5px 10px rgba(30,58,138,.45), inset 4px 4px 8px rgba(255,255,255,.5), 0 6px 16px -6px rgba(37,99,235,.5);}
        .orb-idle{animation:orbFloat 3.6s ease-in-out infinite;}
        @keyframes orbFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}

        .ai-iv{flex:1; overflow-y:auto; padding:32px 30px 52px;}
        .ai-iv-col{max-width:700px; margin:0 auto; display:flex; flex-direction:column; gap:16px; animation:aiRise .28s ease;}
        @keyframes aiRise{from{opacity:0; transform:translateY(8px)} to{opacity:1; transform:none}}

        .ai-panel{background:#fff; border:1px solid var(--hairline); border-radius:20px; box-shadow:var(--sh-md); overflow:hidden;}
        .ai-panel-head{display:flex; align-items:center; gap:14px; padding:22px 28px; border-bottom:1px solid #F1F5F9;}
        .ai-panel-ico{width:42px; height:42px; border-radius:13px; background:var(--brand-soft); color:var(--brand); border:1px solid var(--brand-line); display:inline-flex; align-items:center; justify-content:center;}
        .ai-panel-head h3{font-size:16.5px; font-weight:800; letter-spacing:-.01em;}
        .ai-panel-head p{font-size:12px; color:var(--faint); margin-top:2px; line-height:1.5;}
        .ai-stepper{display:flex; gap:26px; padding:20px 28px 0;}
        .ai-stepper span{display:flex; align-items:center; gap:8px; font-size:10.5px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--faint);}
        .ai-stepper i{width:24px; height:4px; border-radius:999px; background:var(--hairline2); transition:background .3s ease;}
        .ai-stepper span.on{color:var(--brand);}
        .ai-stepper span.on i{background:var(--brand);}
        .ai-panel-body{padding:24px 28px 28px;}
        .ai-field{margin-bottom:24px; padding-bottom:22px; border-bottom:1px solid #F1F5F9;}
        .ai-field:last-of-type{border-bottom:0; margin-bottom:0; padding-bottom:0;}
        .ai-flabel{display:flex; align-items:center; gap:9px; font-size:11px; font-weight:800; color:var(--faint); text-transform:uppercase; letter-spacing:.09em; margin-bottom:12px; flex-wrap:wrap;}
        .ai-step-n{width:20px; height:20px; border-radius:7px; background:var(--brand); color:#fff; font-size:10.5px; display:inline-flex; align-items:center; justify-content:center;}
        .ai-opt{font-size:9.5px; font-weight:700; color:var(--faint); background:#F1F5F9; border-radius:999px; padding:3px 9px; letter-spacing:.04em; text-transform:none;}
        .ai-selcount{font-size:9.5px; font-weight:800; color:var(--brand); background:var(--brand-soft); border:1px solid var(--brand-line); border-radius:999px; padding:3px 10px; text-transform:none; letter-spacing:.02em;}
        .ai-rolechips{display:flex; flex-direction:column; gap:9px;}
        .ai-chip{display:flex; align-items:center; gap:11px; width:100%; padding:13px 16px; font-size:13px; font-weight:700; color:var(--muted);
          background:#FAFAF9; border:1.5px solid var(--hairline); border-radius:13px; cursor:pointer; transition:all .18s ease; font-family:inherit; text-align:left; box-shadow:var(--sh-sm);}
        .ai-chip:hover{border-color:var(--brand); color:var(--brand); background:#F0F7FF;}
        .ai-chip.on{border-color:var(--brand); background:var(--brand-soft); color:var(--brand); box-shadow:0 0 0 3px rgba(37,99,235,.08);}
        .ai-chip-check{width:22px; height:22px; border-radius:8px; background:#F1F5F9; color:transparent; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; transition:all .18s ease;}
        .ai-chip.on .ai-chip-check{background:var(--brand); color:#fff;}
        .ai-chip-label{flex:1;}
        .ai-chip-cnt{font-size:10.5px; color:var(--faint); font-weight:700; background:#fff; border:1px solid var(--hairline); border-radius:999px; padding:3px 10px;}
        .ai-chip.on .ai-chip-cnt{color:var(--brand); border-color:var(--brand-line);}
        .ai-inputwrap input{width:100%; padding:13px 15px; font-size:13px; color:var(--ink); background:#fff; border:1.5px solid var(--hairline2);
          border-radius:12px; outline:none; transition:border-color .2s ease, box-shadow .2s ease; margin-top:10px;}
        .ai-inputwrap input:focus{border-color:var(--brand); box-shadow:0 0 0 4px rgba(37,99,235,.1);}

        .ai-postings{background:#FAFAF9; border:1.5px solid var(--hairline); border-radius:13px; overflow:hidden;}
        .ai-postings-all{border-bottom:1px solid var(--hairline); background:#fff;}
        .ai-allrow{display:flex; align-items:center; gap:10px; width:100%; padding:12px 14px; border:0; background:none; cursor:pointer; font-family:inherit; text-align:left; transition:background .18s ease;}
        .ai-allrow:hover:not(:disabled){background:var(--brand-soft);}
        .ai-allrow:disabled{opacity:.55; cursor:not-allowed;}
        .ai-check{width:20px; height:20px; border-radius:7px; background:#F1F5F9; color:transparent; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; transition:all .18s ease;}
        .ai-allrow.on .ai-check{background:var(--brand); color:#fff;}
        .ai-allrow b{font-size:12.5px; font-weight:800; color:var(--ink); flex:1;}
        .ai-allcnt{font-size:10.5px; font-weight:700; color:var(--faint); background:#F1F5F9; border-radius:999px; padding:3px 10px;}
        .ai-postings-list{max-height:210px; overflow-y:auto;}
        .ai-posting{display:flex; align-items:center; gap:10px; width:100%; padding:10px 14px; border:0; border-bottom:1px solid #F1F5F9; background:none; cursor:pointer; font-family:inherit; text-align:left; transition:background .18s ease;}
        .ai-posting:last-child{border-bottom:0;}
        .ai-posting:hover{background:#F0F7FF;}
        .ai-posting .ai-check{width:18px; height:18px; border-radius:6px; background:#fff; border:1.5px solid var(--hairline2);}
        .ai-posting.on .ai-check{background:var(--brand); border-color:var(--brand); color:#fff;}
        .ai-pt{flex:1; min-width:0;}
        .ai-pt b{display:block; font-size:12px; font-weight:700; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
        .ai-pt span{font-size:10.5px; color:var(--faint); font-weight:600;}
        .ai-postings-empty{font-size:12px; color:var(--faint); padding:18px; text-align:center;}
        .ai-pfield-hint{font-size:10.5px; color:var(--faint); margin-top:8px; line-height:1.5;}
        .ai-nodata{display:flex; align-items:center; gap:13px; background:#FFF7ED; border:1px solid #FED7AA; border-radius:13px; padding:14px 16px; margin-bottom:22px;}
        .ai-nodata-ico{width:40px; height:40px; border-radius:12px; background:#FFFBEB; color:#D97706; border:1px solid #FDE68A; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;}
        .ai-nodata b{display:block; font-size:13px; font-weight:800; color:#92400E;}
        .ai-nodata p{font-size:11.5px; color:#B45309; line-height:1.55; margin-top:2px;}
        .ai-error{align-self:center; font-size:12px; font-weight:700; color:#DC2626; background:#FEF2F2; border:1px solid #FECACA; border-radius:10px; padding:10px 15px;}
        .ai-actions{display:flex; align-items:center; gap:14px; margin-top:22px; flex-wrap:wrap;}
        .ai-hint{font-size:11.5px; color:var(--faint); display:inline-flex; align-items:center; gap:6px; font-weight:600;}

        .ai-btn{display:inline-flex; align-items:center; justify-content:center; gap:9px; border:0; border-radius:13px; padding:14px 26px; font-size:13.5px; font-weight:800;
          cursor:pointer; font-family:inherit; transition:filter .2s ease, transform .16s ease, box-shadow .22s ease;}
        .ai-btn:hover{filter:brightness(1.07);}
        .ai-btn:active{transform:scale(.98);}
        .ai-btn.primary{background:linear-gradient(135deg,var(--brand),var(--brand-strong)); color:#fff; box-shadow:0 14px 30px -10px rgba(37,99,235,.55);}
        .ai-btn.ghost{background:#fff; color:var(--muted); border:1.5px solid var(--hairline2); box-shadow:var(--sh-sm);}
        .ai-btn.ghost:hover{border-color:var(--brand); color:var(--brand); filter:none;}
        .ai-btn:disabled{opacity:.55; cursor:not-allowed;}
        .ai-btn.wispr{background:#0F172A; color:#fff; text-decoration:none; box-shadow:0 10px 24px -12px rgba(15,23,42,.6);}
        .ai-btn.wispr:hover{background:#1E293B; filter:none;}
        .ai-w-logo{width:22px; height:22px; border-radius:7px; background:rgba(255,255,255,.16); color:#fff; font-size:10px; font-weight:800; display:inline-flex; align-items:center; justify-content:center; box-shadow:inset 0 1px 0 rgba(255,255,255,.2);}

        .ai-qa-top{display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; padding:0 4px;}
        .ai-qa-progress{font-size:12px; font-weight:800; color:var(--faint);}
        .ai-qa-progress b{color:var(--brand); font-size:14px;}
        .ai-qa-dots{display:flex; gap:5px;}
        .ai-qa-dots i{width:24px; height:5px; border-radius:999px; background:var(--hairline2); transition:background .3s ease;}
        .ai-qa-dots i.now{background:var(--brand);}
        .ai-qa-dots i.done{background:var(--brand-line);}
        .ai-q{background:#fff; border:1.5px solid var(--brand-line); border-left:5px solid var(--brand); border-radius:14px; padding:22px 24px; box-shadow:var(--sh-md);}
        .ai-qtag{display:inline-flex; align-items:center; gap:6px; font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--brand); background:var(--brand-soft); border:1px solid var(--brand-line); border-radius:999px; padding:5px 13px; margin-bottom:14px;}
        .ai-qtext{font-size:15.5px; font-weight:700; line-height:1.7; letter-spacing:-.005em;}
        .ai-qsrc{margin-top:16px; padding-top:14px; border-top:1px dashed #DBEAFE; font-size:11px; color:var(--faint); display:flex; align-items:center; gap:7px; flex-wrap:wrap;}
        .ai-qsrc svg{color:var(--brand);}
        .ai-src-chip{background:#F1F5F9; border:1px solid var(--hairline); border-radius:7px; padding:3px 9px; font-weight:700; color:var(--muted); font-size:10.5px;}
        .ai-answer-wrap{position:relative;}
        .ai-answer{width:100%; min-height:120px; padding:17px 19px 32px; font-size:13.5px; line-height:1.7; color:var(--ink); background:#fff;
          border:1.5px solid var(--hairline2); border-radius:14px; resize:vertical; outline:none; transition:border-color .2s ease, box-shadow .2s ease; box-shadow:var(--sh-sm); font-family:inherit;}
        .ai-answer:focus{border-color:var(--brand); box-shadow:0 0 0 4px rgba(37,99,235,.08);}
        .ai-answer-meta{position:absolute; bottom:9px; left:18px; right:18px; display:flex; justify-content:space-between; font-size:10.5px; color:var(--faint); font-weight:600; pointer-events:none;}
        .ai-answer-meta .warn{color:var(--amber); font-weight:800;}
        .ai-iv-actions{display:flex; align-items:center; gap:12px; flex-wrap:wrap;}
        .ai-score-pill{display:inline-flex; align-items:center; gap:9px; flex-wrap:wrap; font-size:12px; font-weight:700; color:#047857; background:var(--emerald-soft);
          border:1px solid var(--emerald-line); border-radius:13px; padding:11px 15px; box-shadow:var(--sh-sm); animation:aiRise .3s ease; max-width:100%;}
        .ai-score-pill > b{font-size:16px;}
        .ai-dims{display:inline-flex; gap:5px; flex-wrap:wrap;}
        .ai-dims em{font-style:normal; font-size:10px; font-weight:700; color:#047857; background:rgba(255,255,255,.75); border:1px solid var(--emerald-line); border-radius:999px; padding:3px 9px;}
        .ai-dims em b{color:#065F46;}
        .ai-pill-fb{font-size:11.5px; color:#065F46; font-weight:600; line-height:1.5;}

        .ai-sc{background:#fff; border:1px solid var(--hairline); border-radius:20px; box-shadow:var(--sh-lg); padding:34px 34px 30px;}
        .ai-sc-head{display:flex; align-items:center; gap:22px; padding-bottom:24px; border-bottom:1px solid var(--hairline); margin-bottom:22px;}
        .ai-sc-ring{position:relative; width:92px; height:92px; border-radius:50%; background:conic-gradient(var(--emerald) var(--p), var(--hairline2) 0); display:flex; flex-direction:column; align-items:center; justify-content:center; flex-shrink:0;}
        .ai-sc-ring::after{content:''; position:absolute; width:72px; height:72px; border-radius:50%; background:#fff;}
        .ai-sc-ring b{position:relative; z-index:1; font-size:22px; font-weight:800; color:#047857; line-height:1;}
        .ai-sc-ring span{position:relative; z-index:1; font-size:9px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); margin-top:3px;}
        .ai-sc-head-txt{flex:1; min-width:0;}
        .ai-sc-role{display:inline-flex; align-items:center; gap:6px; font-size:10.5px; font-weight:800; color:var(--brand); background:var(--brand-soft); border:1px solid var(--brand-line); border-radius:999px; padding:5px 12px; margin-bottom:9px;}
        .ai-sc-head-txt h3{font-size:18px; font-weight:800; letter-spacing:-.015em;}
        .ai-sc-head-txt p{font-size:12px; color:var(--muted); margin-top:6px; line-height:1.7;}
        .ai-sc-list-head{display:flex; align-items:center; gap:8px; font-size:10.5px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); margin-bottom:7px;}
        .ai-sc-list-head svg{color:var(--brand);}
        .ai-sc-row{display:flex; align-items:flex-start; gap:13px; padding:14px 2px; border-bottom:1px solid #F1F5F9; transition:background .18s ease;}
        .ai-sc-row:hover{background:#FBFCFE;}
        .ai-sc-row:last-child{border-bottom:0;}
        .ai-sc-q{flex:1; font-size:12.5px; font-weight:600; color:var(--ink); line-height:1.6; display:flex; gap:10px;}
        .ai-sc-q i{width:23px; height:23px; border-radius:8px; background:#F1F5F9; color:var(--faint); font-size:10.5px; font-weight:800; font-style:normal; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px;}
        .ai-sc-score{font-size:12px; font-weight:800; color:#047857; background:var(--emerald-soft); border:1px solid var(--emerald-line); border-radius:999px; padding:5px 12px; flex-shrink:0;}
        .ai-sc-score.low{color:var(--amber); background:var(--amber-soft); border-color:var(--amber-line);}

        .ai-overlay{position:fixed; inset:0; background:rgba(15,23,42,.32); opacity:0; pointer-events:none; transition:opacity .25s ease; z-index:80;}
        .ai-overlay.open{opacity:1; pointer-events:auto;}
        .ai-hpanel{position:fixed; top:0; right:0; bottom:0; width:440px; max-width:92vw; background:#fff; z-index:81; display:flex; flex-direction:column;
          transform:translateX(102%); transition:transform .3s cubic-bezier(.22,.68,0,1); box-shadow:-18px 0 50px -18px rgba(15,23,42,.3);}
        .ai-hpanel.open{transform:translateX(0);}
        .ai-hpanel-head{display:flex; align-items:center; gap:10px; padding:18px 20px; border-bottom:1px solid var(--hairline);}
        .ai-hpanel-ico{width:34px; height:34px; border-radius:11px; background:var(--brand-soft); color:var(--brand); border:1px solid var(--brand-line); display:inline-flex; align-items:center; justify-content:center;}
        .ai-hpanel-head b{font-size:14.5px; font-weight:800; flex:1;}
        .ai-hpanel-cnt{font-size:10.5px; font-weight:800; color:var(--brand); background:var(--brand-soft); border:1px solid var(--brand-line); border-radius:999px; padding:3px 10px;}
        .ai-hpanel-x{width:34px; height:34px; border-radius:10px; border:0; background:none; color:var(--faint); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:all .2s ease;}
        .ai-hpanel-x:hover{background:#F1F5F9; color:var(--ink);}
        .ai-hpanel-body{flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:9px;}
        .ai-h-empty{text-align:center; padding:44px 20px; color:var(--faint); font-size:12px; line-height:1.6;}
        .ai-h-empty b{display:block; font-size:13.5px; color:var(--muted); margin-bottom:4px;}
        .ai-hrow{background:#fff; border:1px solid var(--hairline); border-radius:13px; padding:0; box-shadow:var(--sh-sm); transition:border-color .2s ease, box-shadow .2s ease;}
        .ai-hrow:hover{border-color:var(--brand-line); box-shadow:var(--sh-md);}
        .ai-hrow.open{border-color:var(--brand-line); box-shadow:var(--sh-md);}
        .ai-hrow-main{display:flex; align-items:center; gap:12px; width:100%; padding:13px 14px; border:0; background:none; cursor:pointer; text-align:left; font-family:inherit; transition:background .18s ease;}
        .ai-hrow-main:hover{background:#FBFCFE;}
        .ai-hring{position:relative; width:44px; height:44px; border-radius:50%; background:conic-gradient(var(--emerald) var(--p), var(--hairline2) 0); display:flex; align-items:center; justify-content:center; flex-shrink:0;}
        .ai-hring::after{content:''; position:absolute; width:33px; height:33px; border-radius:50%; background:#fff;}
        .ai-hring b{position:relative; z-index:1; font-size:12.5px; font-weight:800; color:#047857;}
        .ai-hmeta{flex:1; min-width:0;}
        .ai-hmeta b{display:block; font-size:13px; font-weight:800; margin-bottom:2px;}
        .ai-hmeta span{font-size:10.5px; color:var(--faint); display:inline-flex; align-items:center; gap:4px;}
        .ai-hchev{color:var(--faint); transition:transform .22s ease;}
        .ai-hchev.open{transform:rotate(90deg); color:var(--brand);}
        .ai-hdetail{display:none; padding:4px 14px 14px; border-top:1px solid #F1F5F9;}
        .ai-hrow.open .ai-hdetail{display:block;}
        .ai-hdetail-head{font-size:9.5px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); margin:10px 0 4px;}
        .ai-hq{display:flex; align-items:flex-start; gap:10px; padding:8px 0; border-bottom:1px solid #F8FAFC;}
        .ai-hq:last-child{border-bottom:0;}
        .ai-hq-text{flex:1; font-size:11.5px; font-weight:600; color:var(--muted); line-height:1.5;}
        .ai-hscore{font-size:11px; font-weight:800; color:#047857; background:var(--emerald-soft); border:1px solid var(--emerald-line); border-radius:999px; padding:3px 10px; flex-shrink:0;}
        .ai-hscore.low{color:var(--amber); background:var(--amber-soft); border-color:var(--amber-line);}

        @media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none !important; transition:none !important;}}
      `}</style>
    </div>
  );
};
