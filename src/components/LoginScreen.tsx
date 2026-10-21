import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, ArrowLeft, KeyRound, User, Users, Lock, Search, Sparkles, Inbox, ShieldCheck, CheckCircle2, Zap } from 'lucide-react';
import { RECOVERY_QUESTIONS } from '../constants/recoveryQuestions';
import { BrandMark } from './BrandMark';
interface LoginScreenProps {
  onLogin: (email: string, password: string) => Promise<{ error?: string } | null>;
  onRegister: (name: string, email: string, password: string, recovery: { q1: string; a1: string; q2: string; a2: string }) => Promise<{ error?: string } | null>;
  onGuestLogin: (name: string) => Promise<{ error?: string } | null>;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, onRegister, onGuestLogin }) => {
  const [mode, setMode] = useState<'login' | 'register' | 'guest'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [guests, setGuests] = useState<{ id: string; name: string }[]>([]);

  // Recovery questions (registration + forgot-password)
  const [recoveryQ1, setRecoveryQ1] = useState(RECOVERY_QUESTIONS[0]);
  const [recoveryA1, setRecoveryA1] = useState('');
  const [recoveryQ2, setRecoveryQ2] = useState(RECOVERY_QUESTIONS[1]);
  const [recoveryA2, setRecoveryA2] = useState('');

  // Forgot-password: step 1 = email, step 2 = questions, step 3 = new password
  const [forgotActive, setForgotActive] = useState(false);
  const [forgotStep, setForgotStep] = useState(1);
  const [forgotQuestions, setForgotQuestions] = useState<{ q1: string; q2: string } | null>(null);
  const [forgotAnswer1, setForgotAnswer1] = useState('');
  const [forgotAnswer2, setForgotAnswer2] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [forgotDone, setForgotDone] = useState('');

  useEffect(() => {
    if (mode === 'guest') {
      fetch('/api/auth/guests')
        .then((r) => r.json())
        .then((d) => setGuests(d.guests || []))
        .catch(() => setGuests([]));
    }
  }, [mode]);

  const startForgot = () => {
    setMode('login');
    setError('');
    setForgotActive(true);
    setForgotStep(1);
    setForgotDone('');
    setForgotQuestions(null);
    setForgotAnswer1('');
    setForgotAnswer2('');
    setNewPassword('');
    setEmail('');
  };

  const cancelForgot = () => {
    setForgotActive(false);
    setForgotStep(1);
    setError('');
    setForgotQuestions(null);
  };

  const checkForgotEmail = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/forgot-password/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not start password reset.'); return; }
      setForgotQuestions({ q1: data.q1, q2: data.q2 });
      setForgotStep(2);
    } finally {
      setBusy(false);
    }
  };

  const submitForgotAnswers = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/forgot-password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, answer1: forgotAnswer1, answer2: forgotAnswer2, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Reset failed.'); return; }
      setForgotDone('Password reset successfully — sign in with your new password.');
      setForgotStep(1);
      setPassword('');
      setForgotAnswer1('');
      setForgotAnswer2('');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        if (!email || !password) { setError('Enter your email and password.'); setBusy(false); return; }
        const result = await onLogin(email, password);
        if (result?.error) setError(result.error);
      } else if (mode === 'register') {
        if (!name.trim() || !email || !password) { setError('Fill in name, email, and password.'); setBusy(false); return; }
        if (recoveryA1.trim().length < 3 || recoveryA2.trim().length < 3) { setError('Recovery answers must be at least 3 characters.'); setBusy(false); return; }
        const result = await onRegister(name.trim(), email, password, {
          q1: recoveryQ1,
          a1: recoveryA1,
          q2: recoveryQ2,
          a2: recoveryA2,
        });
        if (result?.error) setError(result.error);
      } else {
        if (!name.trim()) { setError('Enter a guest name.'); setBusy(false); return; }
        const result = await onGuestLogin(name.trim());
        if (result?.error) setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const busyLabel = busy
    ? mode === 'login' ? 'Signing in...' : mode === 'register' ? 'Creating account...' : 'Signing in...'
    : mode === 'login' ? 'Sign In' : mode === 'register' ? 'Create Account' : 'Continue as Guest';

  const renderQuestionSelect = (value: string, onChange: (v: string) => void, autoFocus?: boolean) => (
    <div className="form-group">
      <label className="form-label">Security question</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="form-input" autoFocus={autoFocus}>
        {RECOVERY_QUESTIONS.map((q) => (
          <option key={q} value={q}>{q}</option>
        ))}
      </select>
    </div>
  );

  return (
    <main className="login-page">
      {/* ═══════════ LEFT — BRANDING ═══════════ */}
      <section className="brand-panel">
        <div className="blob b1"></div><div className="blob b2"></div><div className="blob b3"></div>

        <div className="brand-content">
          <div className="brand-badge">
            <span className="badge-dot"></span>
            AI-POWERED CV TAILORING
          </div>

          <div className="logo-row">
            <BrandMark size={46} />
            <div>
              <div className="brand-name">Tailor AI</div>
              <div className="created-by">
                CREATED BY
                <span className="signature">Atanu</span>
              </div>
            </div>
          </div>

          <h2 className="headline">
            Build a stronger CV.
            <span>Get noticed faster.</span>
          </h2>

          <p className="description">
            AI-powered CV tailoring designed to align your experience with the roles you want —
            helping you present your strongest professional story.
          </p>

          {/* ═══════════ ANIMATED SCENE ═══════════ */}
          <div className="login-scene">
            <div className="scene-bg">
              <img src="https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=900&q=80" alt="Team working together in a modern office" />
              <div className="scene-veil"></div>
            </div>

            <span className="chip-float c1"><CheckCircle2 size={12} /> 97% ATS fit</span>
            <span className="chip-float c2"><Zap size={12} /> +41 boost</span>
            <span className="chip-float c3"><Sparkles size={12} /> Tailored in 1 click</span>
            <span className="chip-float c4"><Inbox size={12} /> 5 recruiters found</span>

            <div className="cv-card">
              <div className="cv-row1">
                <div><div className="cv-name">Atanu Biswas</div><div className="cv-role">Senior DevSecOps Engineer</div></div>
                <div className="cv-ring">
                  <svg width="44" height="44" viewBox="0 0 44 44">
                    <circle className="ring-track" cx="22" cy="22" r="20"></circle>
                    <circle className="ring-bar" cx="22" cy="22" r="20"></circle>
                  </svg>
                  <div className="ring-num">97%</div>
                </div>
              </div>
              <div><span className="skill-ok">Kubernetes</span><span className="skill-ok">Terraform</span><span className="skill-ok">CI/CD</span><span className="skill-add">Helm</span><span className="skill-add">ArgoCD</span></div>
            </div>

            <div className="chat-card">
              <div className="chat-peeps">
                <span className="chat-av">NA</span>
                <div><b>Nicole Ávila</b><span>Recruiter · IOON</span></div>
              </div>
              <div className="chat-bubble left">Hi Atanu — your profile is a strong fit for our Kubernetes Platform role. 🎯</div>
              <div className="chat-bubble right b2">Wow — <b>97% ATS match</b> already. When can you start?</div>
              <div className="chat-bubble left b3">Let's talk this week. 👋</div>
              <div className="chat-typing"><i></i><i></i><i></i></div>
            </div>
          </div>

          <div className="login-feats">
            <div className="feature-item"><span className="feat-ico blue"><Search size={15} /></span> Live jobs from 19 sources, scored against your CV</div>
            <div className="feature-item"><span className="feat-ico violet"><Sparkles size={15} /></span> One-click tailored CVs with verified keywords</div>
            <div className="feature-item"><span className="feat-ico emerald"><Inbox size={15} /></span> Recruiters found &amp; cold-emailed from your own mailbox</div>
            <div className="feature-item"><span className="feat-ico amber"><ShieldCheck size={15} /></span> Your data stays on your machine — bring your own keys</div>
          </div>
        </div>

        <div className="brand-footer">© 2026 Tailor AI · Created by Atanu</div>
      </section>

      {/* ═══════════ RIGHT — LOGIN ═══════════ */}
      <section className="form-panel">
        <div className="form-container">

          {forgotDone ? (
            <div>
              <div className="form-header">
                <h1>Password reset</h1>
                <p className="success-note">{forgotDone}</p>
              </div>
              <button type="button" className="submit-button" onClick={cancelForgot}>
                Back to Sign In
              </button>
            </div>
          ) : forgotActive && forgotStep === 1 ? (
            <div>
              <div className="form-header">
                <h1>Reset your password</h1>
                <p>Enter your account email — we'll verify your identity with your security questions (everything stays local).</p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="forgot-email">Account email</label>
                <input id="forgot-email" className="form-input" type="email" autoComplete="email"
                  placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              </div>
              {error && <div className="error-box">{error}</div>}
              <button type="button" className="submit-button" onClick={checkForgotEmail} disabled={busy || !email.trim()}>
                {busy ? <><span className="spinner"></span> Checking...</> : 'Continue'}
              </button>
              <button type="button" className="back-link" onClick={cancelForgot}>
                <ArrowLeft size={13} /> Back to Sign In
              </button>
            </div>
          ) : forgotActive && forgotStep === 2 ? (
            <div>
              <div className="form-header">
                <h1>Verify your identity</h1>
                <p>Answer your recovery questions and choose a new password.</p>
              </div>
              <div className="form-group">
                <label className="form-label">{forgotQuestions?.q1}</label>
                <input className="form-input" type="text" placeholder="Your answer" value={forgotAnswer1}
                  onChange={(e) => setForgotAnswer1(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">{forgotQuestions?.q2}</label>
                <input className="form-input" type="text" placeholder="Your answer" value={forgotAnswer2}
                  onChange={(e) => setForgotAnswer2(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="new-password">New password</label>
                <div className="input-wrapper">
                  <input id="new-password" className="form-input password-input" type="password" autoComplete="new-password"
                    placeholder="Min 6 characters" value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)} />
                </div>
              </div>
              {error && <div className="error-box">{error}</div>}
              <button type="button" className="submit-button" onClick={submitForgotAnswers}
                disabled={busy || !forgotAnswer1 || !forgotAnswer2 || newPassword.length < 6}>
                {busy ? <><span className="spinner"></span> Resetting...</> : 'Reset Password'}
              </button>
              <button type="button" className="back-link" onClick={() => { setForgotStep(1); setError(''); }}>
                <ArrowLeft size={13} /> Back
              </button>
            </div>
          ) : (
            <div>
              <div className="form-header">
                <h1>Welcome back</h1>
                <p>Sign in to continue to your Tailor CV workspace.</p>
              </div>

              {mode !== 'login' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="auth-name">
                    {mode === 'guest' ? 'Guest name' : 'Your name'}
                  </label>
                  <div className="input-wrapper">
                    <span className="lead-icon"><User size={15} /></span>
                    <input id="auth-name" className="form-input lead-input" type="text" autoComplete="name"
                      placeholder={mode === 'guest' ? 'e.g. Guest 1' : 'Your full name'}
                      value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                  </div>
                </div>
              )}

              {mode !== 'guest' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="auth-email">Email address</label>
                  <div className="input-wrapper">
                    <span className="lead-icon"><KeyRound size={15} /></span>
                    <input id="auth-email" className="form-input lead-input" type="email" autoComplete="email"
                      placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </div>
                </div>
              )}

              {mode !== 'guest' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="auth-password">Password</label>
                  <div className="input-wrapper">
                    <span className="lead-icon"><Lock size={15} /></span>
                    <input id="auth-password" className="form-input lead-input password-input" type={showPass ? 'text' : 'password'}
                      autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                      placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && submit()} />
                    <button type="button" className="password-toggle" aria-label={showPass ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPass((v) => !v)}>
                      {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              )}

              {mode === 'register' && (
                <>
                  {renderQuestionSelect(recoveryQ1, setRecoveryQ1)}
                  <div className="form-group">
                    <label className="form-label">Answer 1 (min 3 characters)</label>
                    <input className="form-input" type="text" value={recoveryA1} onChange={(e) => setRecoveryA1(e.target.value)} />
                  </div>
                  {renderQuestionSelect(recoveryQ2, setRecoveryQ2)}
                  <div className="form-group">
                    <label className="form-label">Answer 2 (min 3 characters)</label>
                    <input className="form-input" type="text" value={recoveryA2} onChange={(e) => setRecoveryA2(e.target.value)} />
                  </div>
                </>
              )}

              {mode === 'guest' && guests.length > 0 && (
                <div className="guest-list">
                  <div className="guest-list-title"><Users size={12} /> Existing guests — click to sign in</div>
                  <div className="guest-chips">
                    {guests.map((g) => (
                      <button key={g.id} type="button" disabled={busy} className="guest-chip"
                        onClick={async () => {
                          setBusy(true);
                          const result = await onGuestLogin(g.name);
                          setBusy(false);
                          if (result?.error) setError(result.error);
                        }}>
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="form-options">
                {mode === 'login' && (
                  <button type="button" className="text-link" onClick={startForgot}>Forgot password?</button>
                )}
              </div>

              {error && <div className="error-box">{error}</div>}

              <button type="button" className="submit-button" onClick={submit} disabled={busy}>
                {busy ? <><span className="spinner"></span> {busyLabel}</> : <>{busyLabel} <span className="btn-arrow">→</span></>}
              </button>

              <div className="register-text">
                {mode === 'login' ? (
                  <>Don't have an account? <button type="button" className="text-link" onClick={() => { setMode('register'); setError(''); }}>Create an account</button></>
                ) : mode === 'register' ? (
                  <>Already have an account? <button type="button" className="text-link" onClick={() => { setMode('login'); setError(''); }}>Sign in</button></>
                ) : (
                  <>Want a full account? <button type="button" className="text-link" onClick={() => { setMode('login'); setError(''); }}>Sign in</button></>
                )}
                {mode !== 'guest' && (
                  <>
                    {' '}· <button type="button" className="text-link" onClick={() => { setMode('guest'); setError(''); }}>Continue as guest</button>
                  </>
                )}
              </div>
            </div>
          )}

        </div>

        <div className="form-footer">© 2026 Tailor AI · Created by Atanu</div>
      </section>

      <style>{`
  .login-page { min-height: 100vh; display: grid; grid-template-columns: 1.05fr 1fr; background: #F8FAFC; }
  .brand-panel { background: #FFFFFF; border-right: 1px solid #E2E8F0; padding: 26px 48px; display: flex; flex-direction: column; position: relative; overflow: hidden; }
  .brand-content { display: flex; flex-direction: column; position: relative; z-index: 1; flex: 1; }
  .blob { position: absolute; border-radius: 50%; filter: blur(60px); opacity: .55; pointer-events: none; z-index: 0; }
  .blob.b1 { width: 320px; height: 320px; right: -90px; top: 8%; background: rgba(37,99,235,.12); }
  .blob.b2 { width: 280px; height: 280px; left: -110px; bottom: 12%; background: rgba(5,150,105,.10); }
  .blob.b3 { width: 240px; height: 240px; left: 38%; top: -90px; background: rgba(124,58,237,.08); }
  .brand-badge { display: inline-flex; align-items: center; gap: 8px; font-size: 10.5px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; background: #EFF6FF; color: #2563EB; border: 1px solid #BFDBFE; border-radius: 999px; padding: 7px 14px; width: fit-content; }
  .badge-dot { width: 7px; height: 7px; border-radius: 50%; background: #2563EB; }
  .logo-row { display: flex; align-items: center; gap: 13px; margin-top: 12px; }
  .brand-name { font-size: 17px; font-weight: 800; letter-spacing: -.01em; color: #0F172A; }
  .created-by { display: flex; align-items: baseline; gap: 7px; font-size: 9.5px; font-weight: 700; letter-spacing: .16em; color: #94A3B8; text-transform: uppercase; margin-top: 2px; }
  .signature { font-size: 21px; font-weight: 600; color: #0F172A; text-transform: none; letter-spacing: 0; font-family: "Snell Roundhand", "Brush Script MT", "Apple Chancery", cursive; }
  .headline { font-size: 26px; font-weight: 800; letter-spacing: -.03em; line-height: 1.15; color: #0F172A; margin-top: 16px; }
  .headline span { display: block; }
  .description { font-size: 13px; color: #64748B; margin-top: 8px; max-width: 420px; line-height: 1.6; }
  .login-scene { position: relative; flex: 1; min-height: 230px; margin: 16px 0 8px; }
  .scene-bg { position: absolute; inset: 0; border-radius: 18px; overflow: hidden; border: 1px solid #E2E8F0; }
  .scene-bg img { width: 100%; height: 100%; object-fit: cover; transform: scale(1.08); animation: kenburns 22s ease-in-out infinite alternate; }
  @keyframes kenburns { from { transform: scale(1.06) translateX(-1.5%); } to { transform: scale(1.14) translateX(1.5%); } }
  .scene-veil { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(249,250,251,.28) 55%, rgba(249,250,251,.92)); }
  .cv-card { position: absolute; left: 20px; top: 20px; width: 204px; background: rgba(255,255,255,.97); border: 1px solid #E2E8F0; border-radius: 14px; padding: 12px 13px; box-shadow: 0 18px 40px -12px rgba(15,23,42,.22); animation: float 5.5s ease-in-out infinite; z-index: 3; }
  .cv-row1 { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }
  .cv-name { font-size: 12.5px; font-weight: 800; color: #0F172A; }
  .cv-role { font-size: 9px; color: #64748B; font-weight: 600; }
  .cv-ring { position: relative; width: 44px; height: 44px; flex-shrink: 0; }
  .cv-ring svg { transform: rotate(-90deg); }
  .ring-track { fill: none; stroke: #BFDBFE; stroke-width: 5; }
  .ring-bar { fill: none; stroke: #2563EB; stroke-width: 5; stroke-linecap: round; stroke-dasharray: 126; stroke-dashoffset: 126; animation: fillring 2.4s .5s ease-out forwards; }
  @keyframes fillring { to { stroke-dashoffset: 4; } }
  .ring-num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 800; color: #2563EB; }
  .cv-card .skill-ok, .cv-card .skill-add { display: inline-flex; align-items: center; gap: 4px; font-size: 8.5px; font-weight: 700; padding: 3px 7px; border-radius: 999px; margin: 0 3px 4px 0; }
  .cv-card .skill-ok { background: #ECFDF5; color: #059669; border: 1px solid #A7F3D0; }
  .cv-card .skill-add { background: #EFF6FF; color: #2563EB; border: 1px solid #BFDBFE; }
  @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
  .chat-card { position: absolute; right: 18px; bottom: 18px; width: 220px; background: rgba(255,255,255,.97); border: 1px solid #E2E8F0; border-radius: 14px; padding: 10px 12px; box-shadow: 0 18px 40px -12px rgba(15,23,42,.20); animation: float 6s .6s ease-in-out infinite; z-index: 3; }
  .chat-peeps { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .chat-av { width: 26px; height: 26px; border-radius: 50%; color: #fff; font-size: 9px; font-weight: 800; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #2563EB, #7C3AED); }
  .chat-peeps b { font-size: 10px; font-weight: 700; color: #0F172A; display: block; }
  .chat-peeps span { font-size: 8.5px; color: #94A3B8; }
  .chat-bubble { font-size: 10px; line-height: 1.4; padding: 7px 10px; border-radius: 12px; margin-bottom: 5px; max-width: 85%; animation: bubbleIn .5s ease-out both; }
  .chat-bubble.left { background: #F1F5F9; color: #475569; border-bottom-left-radius: 4px; }
  .chat-bubble.right { margin-left: auto; background: #EFF6FF; color: #0F172A; border-bottom-right-radius: 4px; font-weight: 600; }
  .chat-bubble.right b { color: #2563EB; }
  .chat-bubble.b2 { animation-delay: 1.1s; }
  .chat-bubble.b3 { animation-delay: 2s; }
  @keyframes bubbleIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .chat-typing { display: inline-flex; gap: 3px; padding: 7px 10px; background: #F1F5F9; border-radius: 12px; border-bottom-left-radius: 4px; }
  .chat-typing i { width: 5px; height: 5px; border-radius: 50%; background: #94A3B8; animation: typing 1.2s ease-in-out infinite; }
  .chat-typing i:nth-child(2) { animation-delay: .18s; }
  .chat-typing i:nth-child(3) { animation-delay: .36s; }
  @keyframes typing { 0%, 100% { opacity: .25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-3px); } }
  .chip-float { position: absolute; display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; padding: 6px 11px; border-radius: 999px; background: rgba(255,255,255,.96); border: 1px solid #E2E8F0; box-shadow: 0 8px 20px -8px rgba(15,23,42,.16); z-index: 4; }
  .chip-float svg { width: 11px; height: 11px; flex-shrink: 0; }
  .chip-float.c1 { left: 44%; top: 14px; color: #059669; animation: float 4.2s .2s ease-in-out infinite; }
  .chip-float.c2 { right: 34%; top: 56px; color: #D97706; animation: float 4.8s .9s ease-in-out infinite; }
  .chip-float.c3 { left: 8%; bottom: 40px; color: #7C3AED; animation: float 5.2s .4s ease-in-out infinite; }
  .chip-float.c4 { right: 8%; top: 40%; color: #2563EB; animation: float 4.6s 1.2s ease-in-out infinite; }
  .login-feats { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .feature-item { display: flex; align-items: center; gap: 9px; font-size: 12px; font-weight: 600; color: #475569; background: #FAFAF9; border: 1px solid #E2E8F0; border-radius: 11px; padding: 9px 11px; }
  .feature-item .feat-ico { width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .feature-item svg { width: 13px; height: 13px; flex-shrink: 0; }
  .feat-ico.blue { background: #EFF6FF; color: #2563EB; }
  .feat-ico.violet { background: #F5F3FF; color: #7C3AED; }
  .feat-ico.emerald { background: #ECFDF5; color: #059669; }
  .feat-ico.amber { background: #FFFBEB; color: #D97706; }
  .brand-footer { margin-top: auto; font-size: 11px; color: #94A3B8; position: relative; z-index: 1; }
  .form-panel { display: flex; align-items: center; justify-content: center; padding: 32px 48px; background: #F8FAFC; position: relative; }
  .form-container { width: 100%; max-width: 380px; }
  .form-header h1 { font-size: 22px; font-weight: 800; letter-spacing: -.02em; color: #0F172A; }
  .form-header p { font-size: 13px; color: #64748B; margin: 6px 0 24px; line-height: 1.5; }
  .success-note { font-size: 12.5px; font-weight: 700; color: #059669; background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; }
  .form-group { margin-bottom: 15px; }
  .form-label { display: block; font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 7px; }
  .form-input { width: 100%; border: 1.5px solid #CBD5E1; border-radius: 10px; padding: 11px 14px; font-size: 13px; color: #0F172A; background: #fff; outline: none; transition: border-color .15s ease, box-shadow .15s ease; font-family: inherit; }
  .form-input:hover { border-color: #93C5FD; }
  .form-input:focus { border-color: #2563EB; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
  .input-wrapper { position: relative; }
  .lead-icon { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: #94A3B8; display: flex; pointer-events: none; }
  .lead-input { padding-left: 38px; }
  .password-input { padding-right: 40px; }
  .password-toggle { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; color: #94A3B8; display: flex; padding: 4px; cursor: pointer; }
  .password-toggle:hover { color: #2563EB; }
  .submit-button { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; border-radius: 10px; font-size: 13.5px; font-weight: 800; color: #fff; border: none; cursor: pointer; background: #2563EB; transition: background .15s ease; font-family: inherit; }
  .submit-button:hover { background: #1D4ED8; }
  .submit-button:disabled { opacity: .6; cursor: not-allowed; }
  .btn-arrow { font-size: 14px; }
  .back-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 14px; font-size: 12px; font-weight: 700; color: #64748B; background: none; border: none; cursor: pointer; font-family: inherit; }
  .back-link:hover { color: #2563EB; }
  .error-box { font-size: 12px; font-weight: 700; color: #DC2626; background: #FEF2F2; border: 1px solid #FECACA; border-radius: 10px; padding: 10px 14px; margin: 4px 0 12px; }
  .form-options { display: flex; justify-content: flex-end; margin: 2px 0 16px; }
  .text-link { font-size: 12px; font-weight: 700; color: #2563EB; background: none; border: none; padding: 0; cursor: pointer; font-family: inherit; }
  .text-link:hover { text-decoration: underline; }
  .register-text { text-align: center; margin-top: 18px; font-size: 12.5px; color: #64748B; }
  .guest-list { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; }
  .guest-list-title { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: #64748B; margin-bottom: 9px; }
  .guest-chips { display: flex; flex-wrap: wrap; gap: 7px; }
  .guest-chip { padding: 7px 13px; border-radius: 999px; border: 1.5px solid #E2E8F0; background: #fff; font-size: 12px; font-weight: 600; color: #475569; cursor: pointer; transition: all .15s ease; font-family: inherit; }
  .guest-chip:hover { border-color: #BFDBFE; color: #2563EB; background: #EFF6FF; }
  .spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%; animation: lgn-spin .8s linear infinite; display: inline-block; }
  @keyframes lgn-spin { to { transform: rotate(360deg); } }
  .form-footer { position: absolute; bottom: 20px; font-size: 11px; color: #94A3B8; }
  @media (max-width: 1000px) { .login-page { grid-template-columns: 1fr; } .brand-panel { display: none; } .form-panel { padding: 32px 20px; } }
  @media (max-height: 700px) {
    .brand-panel { padding: 18px 40px; }
    .logo-row { margin-top: 10px; }
    .headline { font-size: 23px; margin-top: 12px; }
    .description { font-size: 12.5px; margin-top: 7px; line-height: 1.5; }
    .login-scene { min-height: 185px; margin: 12px 0 6px; }
    .cv-card { width: 192px; padding: 10px 12px; top: 14px; left: 16px; }
    .chat-card { width: 200px; padding: 8px 10px; bottom: 10px; right: 14px; }
    .chat-peeps { margin-bottom: 5px; }
    .chat-av { width: 22px; height: 22px; font-size: 8.5px; }
    .chat-peeps b { font-size: 9px; }
    .chat-peeps span { font-size: 7.5px; }
    .chat-bubble { font-size: 8.5px; line-height: 1.35; padding: 5px 8px; margin-bottom: 4px; }
    .chat-typing { padding: 6px 9px; }
    .chat-typing i { width: 4px; height: 4px; }
    .chip-float { font-size: 8.5px; padding: 4px 9px; }
    .login-feats { gap: 7px; margin-top: 10px; }
    .feature-item { font-size: 11px; padding: 7px 9px; gap: 7px; }
    .feature-item .feat-ico { width: 23px; height: 23px; border-radius: 7px; }
    .form-panel { padding: 16px 32px; }
    .form-footer { bottom: 10px; }
  }
  @media (prefers-reduced-motion: reduce) { .scene-bg img, .cv-card, .chat-card, .chip-float, .badge-dot, .chat-typing i { animation: none; } .ring-bar { stroke-dashoffset: 4; } }
`}</style>
    </main>
  );
};
