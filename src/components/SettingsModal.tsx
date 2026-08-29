import React, { useState, useEffect } from 'react';
import { HamburgerTrigger } from '../navigation';
import { CandidateProfilePanel } from './CandidateProfilePanel';
import { AppConfig, LlmProvider } from '../types';
import { ArrowLeft, User, UserCircle, LockKey, PlugsConnected, Brain, RocketLaunch, EnvelopeSimple, ShieldCheck, Key, Database, CheckCircle, CaretRight, Warning, Pulse, Check, Eye, EyeSlash, ArrowSquareOut, Info, GlobeSimple } from '@phosphor-icons/react';
import { RECOVERY_QUESTIONS } from '../constants/recoveryQuestions';
import { PROVIDER_BASE_URLS as LLM_PRESETS } from '../constants/llmPresets';
import { APIFY_SOURCES } from '../constants/sources';
import { searchLocations } from '../lib/locations';
import { codes as currencyCodes, code as currencyCodeInfo } from 'currency-codes';
import languagesData from 'languages/languages.json';
import pkg from '../../package.json';

// All ISO 4217 currencies (179) — no hardcoded list.
const ALL_CURRENCIES = currencyCodes()
  .map((c) => ({ code: c, name: currencyCodeInfo(c)?.currency || '' }))
  .sort((a, b) => a.code.localeCompare(b.code));

// All ISO 639-1 languages (183) for the language chip autocomplete —
// { code: [name, nativeName] } straight from the package's data file.
const ALL_LANGUAGE_NAMES = (Object.values(languagesData.lang) as [string, string][])
  .map((v) => v[0])
  .filter(Boolean);

interface CandidateProfile {
  workModes: string[];
  preferredLocations: string[];
  noticePeriod: string;
  availableFrom: string;
  employmentTypes: string[];
  yearsExperience: string;
  currentRole: string;
  currentCompany: string;
  currentSalary: string;
  expectedSalaryMin: string;
  expectedSalaryMax: string;
  salaryCurrency: string;
  jobSearchStatus: string;
  willingToRelocate: 'yes' | 'no' | 'certain-cities';
  willingToTravelPct: string;
  workAuthorization: string;
  needsSponsorship: boolean;
  languages: string[];
  preferredCompanySize: string;
  recruiterNote: string;
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  onSaveConfig: (updated: AppConfig) => Promise<void>;
  user?: { id: string; email: string; name: string; isGuest: boolean } | null;
  onOpenMasterCv?: () => void;
}

const OPENCODE_REFERRAL_URL = 'https://opencode.ai/go?ref=TTETM6S7H5';
const APIFY_REFERRAL_URL = 'https://console.apify.com/sign-up?fpr=xu9hcp';

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  'opencode-go': 'OpenCode Go',
  'openrouter': 'OpenRouter',
  'openai': 'OpenAI',
  'gemini': 'Gemini',
  'anthropic': 'Anthropic',
  'nvidia': 'NVIDIA',
};

const PROVIDER_TAG: Record<LlmProvider, string> = {
  'opencode-go': 'Fast & cheap',
  'openrouter': '100+ models',
  'openai': 'GPT models',
  'gemini': 'Google AI',
  'anthropic': 'Claude',
  'nvidia': 'GPU models',
};

const PROVIDER_MODELS: Record<LlmProvider, string[]> = {
  'opencode-go': [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'kimi-k3',
    'kimi-k2.7-code',
    'kimi-k2.6',
    'qwen3.7-max',
    'qwen3.7-plus',
    'qwen3.6-plus',
    'grok-4.5',
    'glm-5.2',
    'glm-5.1',
    'mimo-v2.5-pro',
    'mimo-v2.5',
    'minimax-m3',
    'minimax-m2.7',
    'hy3',
  ],
  'openrouter': ['Custom (type below)'],
  'openai': ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini', 'Custom (type below)'],
  'gemini': ['gemini-3.6-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'Custom (type below)'],
  'anthropic': ['claude-sonnet-4-20250514', 'claude-3.5-haiku', 'claude-opus-4', 'Custom (type below)'],
  'nvidia': ['deepseek-ai/deepseek-v4-flash', 'deepseek-ai/deepseek-v4-pro', 'meta/llama-3.3-70b-instruct', 'mistralai/mistral-large', 'Custom (type below)'],
};

const PROVIDER_BASE_URLS = LLM_PRESETS;

const PROVIDER_LOGO: Record<LlmProvider, { bg: string; text: string }> = {
  'opencode-go': { bg: 'linear-gradient(135deg,#3B82F6,#2563EB)', text: 'OG' },
  'openrouter': { bg: 'linear-gradient(135deg,#8B5CF6,#6D28D9)', text: 'OR' },
  'openai': { bg: 'linear-gradient(135deg,#38BDF8,#0EA5E9)', text: 'OA' },
  'gemini': { bg: 'linear-gradient(135deg,#FBBF24,#F59E0B)', text: 'G' },
  'anthropic': { bg: 'linear-gradient(135deg,#F59E0B,#D97706)', text: 'AN' },
  'nvidia': { bg: 'linear-gradient(135deg,#34D399,#10B981)', text: 'NV' },
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaveConfig,
  user,
  onOpenMasterCv,
}) => {
  if (!isOpen) return null;

  const [formData, setFormData] = useState<AppConfig>(config);
  const [dirty, setDirty] = useState(false);
  const setFormDataTouched = (v: AppConfig) => { setDirty(true); setFormData(v); };
  const [isSaving, setIsSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showApify, setShowApify] = useState(false);
  const [showLiAt, setShowLiAt] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [savedToast, setSavedToast] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<'candidate' | 'security' | 'integration'>('candidate');
  const [activeItab, setActiveItab] = useState<'llm' | 'apify' | 'email'>('llm');
  const [companionPaired, setCompanionPaired] = useState<boolean | null>(null);
  const [appPasswordConfigured, setAppPasswordConfigured] = useState(false);
  const [appPasswordStatus, setAppPasswordStatus] = useState('');
  const [gmailConnected, setGmailConnected] = useState(false);
  const [msConnected, setMsConnected] = useState(false);
  useEffect(() => {
    fetch('/api/credentials/application-password/status').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setAppPasswordConfigured(d.configured === true); }).catch(() => {});
    fetch('/api/mail/status').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d?.connections) {
        setGmailConnected(d.connections.some((c: any) => c.connector === 'gmail' && c.status !== 'disconnected'));
        setMsConnected(d.connections.some((c: any) => c.connector === 'microsoft' && c.status !== 'disconnected'));
      }
    }).catch(() => {});
  }, []);
  const generateAppPassword = async () => {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const password = [...bytes].map((b) => charset[b % charset.length]).join('');
    const res = await fetch('/api/credentials/application-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (res.ok) { setAppPasswordConfigured(true); setAppPasswordStatus('Generated and saved. Existing ATS accounts keep their old passwords.'); }
    else setAppPasswordStatus('Could not save.');
  };
  const setOwnAppPassword = async () => {
    const value = window.prompt('Set your own application password (min 12 chars). Do not reuse your email or banking password.');
    if (!value) return;
    if (value.length < 12) { setAppPasswordStatus('Minimum 12 characters.'); return; }
    const res = await fetch('/api/credentials/application-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: value }) });
    setAppPasswordStatus(res.ok ? 'Saved.' : 'Could not save.');
    if (res.ok) setAppPasswordConfigured(true);
  };
  const removeAppPassword = async () => {
    await fetch('/api/credentials/application-password', { method: 'DELETE' });
    setAppPasswordConfigured(false);
    setAppPasswordStatus('Removed.');
  };
  const connectMail = async (connector: string) => {
    const res = await fetch('/api/mail/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connector }) });
    if (res.ok) { if (connector === 'gmail') setGmailConnected(true); else setMsConnected(true); }
  };
  const disconnectMail = async (connector: string) => {
    const res = await fetch('/api/mail/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connector }) });
    void res;
    if (connector === 'gmail') setGmailConnected(false); else setMsConnected(false);
  };
  const syncMail = async (connector: string) => {
    const res = await fetch('/api/mail/sync-now', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    setAppPasswordStatus(d.error ? 'Sync unavailable (mailbox not authorized).' : `Synced: ${d.scanned ?? 0} scanned.`);
  };
  const [pairingCode, setPairingCode] = useState('');
  const [companionBusy, setCompanionBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      window.postMessage({ type: 'TAILOR_PING' }, '*');
      const onPong = (e: MessageEvent) => {
        if (e.data?.type !== 'TAILOR_PONG') return;
        setCompanionPaired(e.data.paired === true);
        window.removeEventListener('message', onPong);
      };
      window.addEventListener('message', onPong);
    }, 300);
    return () => clearTimeout(t);
  }, []);
  const generatePairCode = async () => {
    setCompanionBusy(true);
    try {
      const res = await fetch('/api/browser-companion/pairing-code', { method: 'POST' });
      if (!res.ok) throw new Error('Could not generate a pairing code.');
      const d = await res.json();
      setPairingCode(d.code);
    } catch { setPairingCode(''); }
    finally { setCompanionBusy(false); }
  };
  const unpairCompanion = async () => {
    setCompanionBusy(true);
    try {
      await fetch('/api/browser-companion/unpair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingId: 'any' }) });
    } catch {}
    setCompanionPaired(false);
    setPairingCode('');
    setCompanionBusy(false);
  };

  // Job preferences (candidate profile)
  const [candidateProfile, setCandidateProfile] = useState<CandidateProfile | null>(null);
  const [profileLocOptions, setProfileLocOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/profile').then((r) => r.json()).then((d) => setCandidateProfile(d.profile || null)).catch(() => setCandidateProfile(null));
  }, [isOpen]);

  // Saves the job preferences with the main "Save changes" flow — the
  // cleaned profile rides along with the config save.
  const saveCandidateProfileWithConfig = async (): Promise<boolean> => {
    if (!candidateProfile) return true;
    const clean = {
      ...candidateProfile,
      preferredLocations: candidateProfile.preferredLocations.map((s) => s.trim()).filter(Boolean),
      languages: candidateProfile.languages.map((s) => s.trim()).filter(Boolean),
    };
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: clean }),
    });
    return res.ok;
  };

  const [profileLocDraft, setProfileLocDraft] = useState('');

  const onProfileLocationInput = (v: string) => {
    setProfileLocDraft(v);
    if (v.trim().length >= 1) {
      searchLocations(v.trim(), 8).then((list) => setProfileLocOptions(list.map((l) => l.label)));
    } else {
      setProfileLocOptions([]);
    }
  };

  const addPreferredLocation = (raw: string) => {
    const loc = raw.trim();
    if (!loc) return;
    setCandidateProfile((p) => p && {
      ...p,
      preferredLocations: p.preferredLocations.includes(loc) ? p.preferredLocations : [...p.preferredLocations, loc],
    });
    setProfileLocDraft('');
    setProfileLocOptions([]);
  };

  const removePreferredLocation = (loc: string) => {
    setCandidateProfile((p) => p && { ...p, preferredLocations: p.preferredLocations.filter((x) => x !== loc) });
  };

  const [profileLangDraft, setProfileLangDraft] = useState('');
  const [profileLangOptions, setProfileLangOptions] = useState<string[]>([]);

  const onProfileLanguageInput = (v: string) => {
    setProfileLangDraft(v);
    const q = v.trim().toLowerCase();
    if (q.length >= 1) {
      const hits = ALL_LANGUAGE_NAMES
        .filter((n) => n.toLowerCase().startsWith(q) || n.toLowerCase().includes(q))
        .slice(0, 8);
      setProfileLangOptions(hits);
    } else {
      setProfileLangOptions([]);
    }
  };

  const addPreferredLanguage = (raw: string) => {
    const lang = raw.trim();
    if (!lang) return;
    setCandidateProfile((p) => p && {
      ...p,
      languages: p.languages.includes(lang) ? p.languages : [...p.languages, lang],
    });
    setProfileLangDraft('');
    setProfileLangOptions([]);
  };

  const removePreferredLanguage = (lang: string) => {
    setCandidateProfile((p) => p && { ...p, languages: p.languages.filter((x) => x !== lang) });
  };

  // Recovery questions (password accounts only)
  const [recCurrentPassword, setRecCurrentPassword] = useState('');
  const [recQ1, setRecQ1] = useState(RECOVERY_QUESTIONS[0]);
  const [recA1, setRecA1] = useState('');
  const [recQ2, setRecQ2] = useState(RECOVERY_QUESTIONS[1]);
  const [recA2, setRecA2] = useState('');
  const [recMsg, setRecMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [recSaving, setRecSaving] = useState(false);

  const handleSaveRecovery = async () => {
    setRecMsg(null);
    if (!recCurrentPassword || recA1.trim().length < 3 || recA2.trim().length < 3) {
      setRecMsg({ ok: false, text: 'Enter your current password and answers of at least 3 characters.' });
      return;
    }
    setRecSaving(true);
    try {
      const res = await fetch('/api/auth/recovery-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: recCurrentPassword, recoveryQ1: recQ1, recoveryA1: recA1, recoveryQ2: recQ2, recoveryA2: recA2 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRecMsg({ ok: false, text: data.error || 'Failed to save recovery questions.' });
      } else {
        setRecMsg({ ok: true, text: 'Recovery questions saved.' });
        setRecCurrentPassword(''); setRecA1(''); setRecA2('');
      }
    } catch (e: any) {
      setRecMsg({ ok: false, text: e.message || 'Failed to save recovery questions.' });
    } finally {
      setRecSaving(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSaveConfig(formData);
      const profileOk = await saveCandidateProfileWithConfig();
      if (!profileOk) throw new Error('Could not save job preferences.');
      setDirty(false);
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 2400);
    } catch (err: any) {
      setSaveError(err?.message || 'Could not save changes.');
    } finally {
      setIsSaving(false);
    }
  };

  const selectProvider = (p: LlmProvider) => {
    const defaults = PROVIDER_MODELS[p];
    const defaultModel = defaults[0];
    setFormDataTouched({
      ...formData,
      llm: {
        ...formData.llm,
        provider: p,
        model: defaultModel === 'Custom (type below)' ? formData.llm.model : defaultModel,
        baseUrl: PROVIDER_BASE_URLS[p],
      },
    });
  };

  const testConnection = async () => {
    setTestState('testing'); setTestMsg('');
    try {
      const res = await fetch('/api/settings/test-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData.llm),
      });
      const data = await res.json();
      if (data.ok) {
        setTestState('ok'); setTestMsg(`${data.latencyMs}ms`);
      } else {
        setTestState('error'); setTestMsg(data.error || 'Connection failed.');
      }
    } catch (e: any) {
      setTestState('error'); setTestMsg(e.message || 'Connection failed.');
    }
  };

  const provider = formData.llm.provider || 'opencode-go';
  const models = PROVIDER_MODELS[provider] || PROVIDER_MODELS['opencode-go'];
  const showCustomModel = !models.includes(formData.llm.model);

  const [emailTestState, setEmailTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [emailTestMsg, setEmailTestMsg] = useState('');

  const testEmailConnection = async () => {
    setEmailTestState('testing'); setEmailTestMsg('');
    try {
      const res = await fetch('/api/emails/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData.email),
      });
      const data = await res.json();
      if (data.ok) {
        setEmailTestState('ok');
        setEmailTestMsg(data.note || 'SMTP connected');
      } else {
        setEmailTestState('error'); setEmailTestMsg(data.error || 'Connection failed.');
      }
    } catch (e: any) {
      setEmailTestState('error'); setEmailTestMsg(e.message || 'Connection failed.');
    }
  };

  const initials = (user?.name || 'U').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
  const isGuest = !!user?.isGuest;

  const panels = [
    { id: 'candidate' as const, label: 'Candidate Profile', icon: UserCircle },
    { id: 'security' as const, label: 'Security', icon: LockKey },
    { id: 'integration' as const, label: 'Integrations', icon: PlugsConnected, count: 3 },
  ];

  const itabs = [
    { id: 'llm' as const, label: 'LLM & AI', icon: Brain },
    { id: 'apify' as const, label: 'Apify', icon: RocketLaunch },
    { id: 'email' as const, label: 'Email (SMTP)', icon: EnvelopeSimple },
  ];

  const inputCls = 'st-inp';
  const monoCls = 'st-inp st-mono';
  const smallCls = 'st-inp st-sm';

  return (
    <div className="st-screen">
      {/* ── Header ── */}
      <header className="st-hdr">
        <HamburgerTrigger />
        <div className="st-ttl">Settings <small>Tailor CV workspace</small></div>
        <div className="st-spacer" />
        <span className={`st-status ${dirty ? 'warn' : ''}`}>
          {dirty ? <><Info size={13} weight="bold" /> Unsaved changes</> : <><CheckCircle size={13} weight="bold" /> All saved</>}
        </span>
      </header>

      {/* ── Layout ── */}
      <div className="st-layout">
        {/* Sidebar */}
        <aside className="st-side" aria-label="Settings sections">
          {panels.map((p) => (
            <button key={p.id} className={`st-side-item ${activePanel === p.id ? 'on' : ''}`}
              aria-current={activePanel === p.id ? 'page' : undefined}
              onClick={() => setActivePanel(p.id)}>
              <span className="st-side-ic"><p.icon size={16} weight="duotone" /></span>
              {p.label}
              {p.count && <span className="st-side-cnt">{p.count}</span>}
            </button>
          ))}
          <div className="st-side-note">
            Tailor CV v{pkg.version} — created by <b>Atanu Biswas</b><br />© 2026 Atanu Biswas · All rights reserved.
          </div>
        </aside>

        {/* Content */}
        <main className="st-content">

          {/* ═══ ACCOUNT ═══ */}
          {activePanel === 'candidate' && (
            <CandidateProfilePanel user={user} />
          )}

          {activePanel === 'security' && (
            <section className="st-panel" aria-label="Security settings">
              <div className="st-phead"><h2>Security</h2><p>Recovery options and privacy for your local account.</p></div>

              <div className="st-card">
                <div className="st-card-head">
                  <div className="st-card-ico green"><Key size={17} weight="duotone" /></div>
                  <div className="st-t"><b>Recovery questions</b><span className="st-d">Used to reset your password if you forget it.</span></div>
                  <div className="st-spacer" />
                  <span className="st-tag green"><CheckCircle size={12} weight="bold" /> Set</span>
                </div>
                <div className="st-card-body">
                  <label className="st-flabel" htmlFor="st-recpw">Current password</label>
                  <div className="st-row">
                    <div className="st-lbl"><label htmlFor="st-recpw"><b>Confirm your password</b><span>Required before updating recovery answers.</span></label></div>
                    <input className={monoCls} id="st-recpw" type="password" value={recCurrentPassword} onChange={(e) => setRecCurrentPassword(e.target.value)} />
                  </div>
                  <label className="st-flabel" htmlFor="st-recq1">Question 1</label>
                  <div className="st-row">
                    <div className="st-lbl"><label htmlFor="st-recq1"><b>Recovery question</b><span>Pick a question only you know.</span></label></div>
                    <select className={inputCls} id="st-recq1" value={recQ1} onChange={(e) => setRecQ1(e.target.value)}>
                      {RECOVERY_QUESTIONS.map((q) => <option key={q} value={q}>{q}</option>)}
                    </select>
                  </div>
                  <div className="st-row">
                    <div className="st-lbl"><label htmlFor="st-reca1"><b>Answer</b><span>Stored locally, hashed.</span></label></div>
                    <input className={monoCls} id="st-reca1" type="password" value={recA1} onChange={(e) => setRecA1(e.target.value)} />
                  </div>
                  <label className="st-flabel" htmlFor="st-recq2">Question 2</label>
                  <div className="st-row">
                    <div className="st-lbl"><label htmlFor="st-recq2"><b>Recovery question</b></label></div>
                    <select className={inputCls} id="st-recq2" value={recQ2} onChange={(e) => setRecQ2(e.target.value)}>
                      {RECOVERY_QUESTIONS.map((q) => <option key={q} value={q}>{q}</option>)}
                    </select>
                  </div>
                  <div className="st-row">
                    <div className="st-lbl"><label htmlFor="st-reca2"><b>Answer</b></label></div>
                    <input className={monoCls} id="st-reca2" type="password" value={recA2} onChange={(e) => setRecA2(e.target.value)} />
                  </div>
                  <div className="st-row">
                    <div className="st-lbl"><b>Sign out</b><span>Available from the account menu in the header — not here.</span></div>
                    <span className="st-tag indigo"><CaretRight size={12} weight="bold" /> In navbar</span>
                  </div>
                  {recMsg && <p className={`st-recm ${recMsg.ok ? 'ok' : 'err'}`}>{recMsg.text}</p>}
                  <div className="st-test-row">
                    <button className="st-btn sm" onClick={handleSaveRecovery} disabled={recSaving}>
                      {recSaving ? <><span className="st-spin" /> Saving…</> : <><Check size={14} weight="bold" /> Save recovery answers</>}
                    </button>
                  </div>
                </div>
              </div>

              <div className="st-card">
                <div className="st-card-head">
                  <div className="st-card-ico red"><ShieldCheck size={17} weight="duotone" /></div>
                  <div className="st-t"><b>Data &amp; privacy</b><span className="st-d">Everything stays on this machine.</span></div>
                </div>
                <div className="st-card-body">
                  <div className="st-row">
                    <div className="st-lbl"><b>Local SQLite database</b><span>Jobs, CVs and contacts never leave your device.</span></div>
                    <span className="st-tag green"><Database size={12} weight="bold" /> Local only</span>
                  </div>
                  <div className="st-row">
                    <div className="st-lbl"><b>API keys</b><span>Stored only in your local config.ini — never committed or logged.</span></div>
                    <span className="st-tag green"><LockKey size={12} weight="bold" /> Local only</span>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ═══ INTEGRATIONS ═══ */}
          {activePanel === 'integration' && (
            <>
            <section className="st-panel" aria-label="Browser Companion settings">
              <div className="st-phead"><h2>Browser Companion</h2><p>Local browser assistant that fills approved applications on the real Lever page. Never submits, never solves CAPTCHAs, never touches your resume.</p></div>
              <div className="st-card">
                <div className="st-card-head">
                  <div className="st-card-ico violet"><GlobeSimple size={17} weight="duotone" /></div>
                  <div className="st-t"><b>Status</b>
                    <span className="st-d">{companionPaired === true ? 'Paired — continue in the browser from the Applications dashboard.' : companionPaired === false ? 'Not paired.' : 'Checking…'}</span>
                  </div>
                  <div className="st-spacer" />
                  <span className={`st-tag ${companionPaired === true ? 'green' : 'red'}`}>
                    {companionPaired === true ? 'Paired' : 'Not paired'}
                  </span>
                </div>
                {pairingCode && (
                  <div className="st-card-sub">
                    <div style={{ fontSize: 12, marginTop: 8 }}>
                      One-time pairing code (10 minutes, single use): <b style={{ fontFamily: 'monospace', letterSpacing: 2 }}>{pairingCode}</b>
                      <br />
                      <span style={{ color: 'var(--st-faint, #64748B)' }}>Open the extension options and paste this code to pair this browser.</span>
                    </div>
                  </div>
                )}
                <div className="st-card-actions" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="st-btn primary" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: 'var(--st-cta, #2563eb)', color: '#fff', border: 0 }} onClick={generatePairCode} disabled={companionBusy}>
                    {companionBusy ? '…' : pairingCode ? 'Regenerate code' : 'Pair Extension'}
                  </button>
                  <button className="st-btn" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#e2e8f0', color: '#334155', border: 0 }} onClick={unpairCompanion} disabled={companionBusy || companionPaired !== true}>
                    Unpair
                  </button>
                  <span style={{ fontSize: 11, alignSelf: 'center', color: 'var(--st-faint, #64748B)' }}>Protocol v1</span>
                </div>
              </div>
            </section>

            <section className="st-panel" aria-label="Integrations settings">
              <div className="st-phead"><h2>Integrations</h2><p>Bring-your-own keys — powers scoring, scraping and outreach.</p></div>

              <div className="st-itabs" role="tablist" aria-label="Integration types">
                {itabs.map((t) => (
                  <button key={t.id} role="tab" aria-selected={activeItab === t.id}
                    className={`st-itab ${activeItab === t.id ? 'on' : ''}`} onClick={() => setActiveItab(t.id)}>
                    <t.icon size={15} weight="bold" /> {t.label}
                  </button>
                ))}
              </div>

              {/* LLM */}
              {activeItab === 'llm' && (
                <div className="st-igroup" role="tabpanel">
                  <div className="st-card">
                    <div className="st-card-head">
                      <div className="st-card-ico violet"><Brain size={17} weight="duotone" /></div>
                      <div className="st-t"><b>LLM &amp; AI</b><span className="st-d">Your key powers scoring, analysis and tailoring.</span></div>
                      <div className="st-spacer" />
                      <span className="st-tag green">{testState === 'ok' ? <><CheckCircle size={12} weight="bold" /> Connected</> : <><Warning size={12} weight="bold" /> {testState === 'error' ? 'Failed' : 'Idle'}</>}</span>
                    </div>
                    <div className="st-card-body">
                      <span className="st-flabel">Provider</span>
                      <div className="st-providers">
                        {(Object.keys(PROVIDER_LABELS) as LlmProvider[]).map((p) => (
                          <button key={p} className={`st-provider ${provider === p ? 'on' : ''}`}
                            aria-pressed={provider === p} onClick={() => selectProvider(p)}>
                            <span className="st-plogo" style={{ background: PROVIDER_LOGO[p].bg }}>{PROVIDER_LOGO[p].text}</span>
                            <span style={{ minWidth: 0 }}>
                              <b>{PROVIDER_LABELS[p]}</b>
                              <span>{PROVIDER_TAG[p]}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                      <div className="st-referral">
                        <div className="st-referral-txt">
                          <b>New to OpenCode Go? Get your API key here</b>
                        </div>
                        <a className="st-referral-btn" href={OPENCODE_REFERRAL_URL} target="_blank" rel="noreferrer">
                          Get API key <ArrowSquareOut size={13} />
                        </a>
                      </div>
                      <span className="st-flabel" htmlFor="st-llmkey">API key</span>
                      <div className="st-row">
                        <div className="st-lbl"><label htmlFor="st-llmkey"><b>Key</b><span>Stored locally in config.ini — never committed.</span></label></div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input className={monoCls} id="st-llmkey" type={showKey ? 'text' : 'password'} value={formData.llm.apiKey}
                            onChange={(e) => setFormDataTouched({ ...formData, llm: { ...formData.llm, apiKey: e.target.value } })}
                            placeholder={provider === 'gemini' ? 'Leave blank to use GEMINI_API_KEY env var' : 'sk-…'} />
                          <button className="st-eye" type="button" onClick={() => setShowKey((v) => !v)} title="Show / hide">
                            {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                      </div>
                      <span className="st-flabel" htmlFor="st-llmmodel">Model</span>
                      <div className="st-row">
                        <div className="st-lbl"><label htmlFor="st-llmmodel"><b>Model name</b><span>Pick from the provider or type a custom one.</span></label></div>
                        <select className={inputCls} id="st-llmmodel" value={models.includes(formData.llm.model) ? formData.llm.model : 'Custom (type below)'}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val !== 'Custom (type below)') setFormDataTouched({ ...formData, llm: { ...formData.llm, model: val } });
                          }}>
                          {models.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                      {showCustomModel && (
                        <div className="st-row">
                          <div className="st-lbl"><label htmlFor="st-llmcustom"><b>Custom model</b></label></div>
                          <input className={monoCls} id="st-llmcustom" type="text" value={formData.llm.model}
                            onChange={(e) => setFormDataTouched({ ...formData, llm: { ...formData.llm, model: e.target.value } })} />
                        </div>
                      )}
                      <span className="st-flabel">Base URL <span className="st-hint">— auto-filled per provider</span></span>
                      <div className="st-row">
                        <div className="st-lbl"><label htmlFor="st-llmbase"><b>Base URL</b><span id="st-base-note">{PROVIDER_BASE_URLS[provider] ? 'Auto-filled from the provider preset — change only for custom gateways.' : 'Not required — the SDK connects automatically.'}</span></label></div>
                        <input className={monoCls} id="st-llmbase" type="text" value={formData.llm.baseUrl}
                          onChange={(e) => setFormDataTouched({ ...formData, llm: { ...formData.llm, baseUrl: e.target.value } })}
                          placeholder={PROVIDER_BASE_URLS[provider] || 'Not required for this provider'} />
                      </div>
                      <div className="st-test-row">
                        <button className="st-btn primary sm" onClick={testConnection} disabled={testState === 'testing'}>
                          {testState === 'testing' ? <><span className="st-spin" /> Testing…</> : <><Pulse size={14} weight="bold" /> Test connection</>}
                        </button>
                        {testState === 'ok' && <span className="st-test-ok"><CheckCircle size={14} weight="bold" /> Connected · {testMsg}</span>}
                        {testState === 'error' && <span className="st-test-err"><Warning size={14} weight="bold" /> {testMsg}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* APIFY */}
              {activeItab === 'apify' && (
                <div className="st-igroup" role="tabpanel">
                  <div className="st-card">
                    <div className="st-card-head">
                      <div className="st-card-ico violet"><RocketLaunch size={17} weight="duotone" /></div>
                      <div className="st-t"><b>Apify</b><span className="st-d">LinkedIn, Indeed, Naukri, Glassdoor &amp; Upwork scraping.</span></div>
                      <div className="st-spacer" />
                      <span className="st-tag green"><CheckCircle size={12} weight="bold" /> {formData.apify.enabled && formData.apify.token ? 'Configured' : 'Off'}</span>
                    </div>
                    <div className="st-card-body">
                      <div className="st-row">
                        <div className="st-lbl"><b>Use Apify sources</b><span>No more "No results found" blocks — falls back automatically.</span></div>
                        <button className={`st-sw ${formData.apify.enabled ? 'on' : ''}`} role="switch" aria-checked={formData.apify.enabled} aria-label="Toggle Apify sources"
                          onClick={() => setFormDataTouched({ ...formData, apify: { ...formData.apify, enabled: !formData.apify.enabled } })} />
                      </div>
                      {formData.apify.enabled && (
                        <>
                          <span className="st-flabel" htmlFor="st-apifytoken">API token</span>
                          <div className="st-row">
                            <div className="st-lbl"><label htmlFor="st-apifytoken"><b>Token</b><span>console.apify.com → Settings → Integrations.</span></label></div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <input className={monoCls} id="st-apifytoken" type={showApify ? 'text' : 'password'} value={formData.apify.token}
                                onChange={(e) => setFormDataTouched({ ...formData, apify: { ...formData.apify, token: e.target.value } })} placeholder="apify_api_…" />
                              <button className="st-eye" type="button" onClick={() => setShowApify((v) => !v)} title="Show / hide">
                                {showApify ? <EyeSlash size={16} /> : <Eye size={16} />}
                              </button>
                            </div>
                          </div>
                          <span className="st-flabel" htmlFor="st-liat">LinkedIn session cookie (no longer required)</span>
                          <div className="st-row">
                            <div className="st-lbl"><label htmlFor="st-liat"><b>li_at cookie</b><span>The LinkedIn Posts scraper now works WITHOUT a cookie (harvestapi actor). This field is kept for future use — you can leave it empty.</span></label></div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <input className={monoCls} id="st-liat" type={showLiAt ? 'text' : 'password'} value={formData.linkedin?.liAt || ''}
                                onChange={(e) => setFormDataTouched({ ...formData, linkedin: { ...(formData.linkedin || { liAt: '' }), liAt: e.target.value } })} placeholder="AQED…" />
                              <button className="st-eye" type="button" onClick={() => setShowLiAt((v) => !v)} title="Show / hide">
                                {showLiAt ? <EyeSlash size={16} /> : <Eye size={16} />}
                              </button>
                            </div>
                          </div>
                          <span className="st-flabel">Powered by your Apify key</span>
                          <div className="st-chips">
                            {APIFY_SOURCES.map((s) => (
                              <span key={s.id} className="st-chip">{s.label} {s.locked ? <span className="st-chip-p">· 🔒 locked</span> : <span className="st-chip-p">· {s.pricePer1K}/1K</span>}</span>
                            ))}
                          </div>
                          <div className="st-referral">
                            <div className="st-referral-txt">
                              <b>New to Apify? Get your API token here</b>
                              <span>Sign up in a minute — this link supports development, same price for you.</span>
                            </div>
                            <a className="st-referral-btn" href={formData.apify.referralUrl || APIFY_REFERRAL_URL} target="_blank" rel="noopener noreferrer">
                              Get token <ArrowSquareOut size={13} />
                            </a>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* EMAIL */}
              {activeItab === 'email' && (
                <div className="st-igroup" role="tabpanel">
                  <div className="st-card">
                    <div className="st-card-head">
                      <div className="st-card-ico pink"><EnvelopeSimple size={17} weight="duotone" /></div>
                      <div className="st-t"><b>Email (SMTP)</b><span className="st-d">Send cold emails to recruiters from your own mailbox.</span></div>
                      <div className="st-spacer" />
                      <span className={`st-tag ${formData.email.host ? 'green' : 'amber'}`}>
                        {formData.email.host ? <><CheckCircle size={12} weight="bold" /> Configured</> : <><Warning size={12} weight="bold" /> Not configured</>}
                      </span>
                    </div>
                    <div className="st-card-body">
                      <span className="st-flabel" htmlFor="st-emailhost">Server</span>
                      <div className="st-row">
                        <div className="st-lbl"><label htmlFor="st-emailhost"><b>SMTP host</b></label></div>
                        <input className={monoCls} id="st-emailhost" type="text" value={formData.email.host}
                          onChange={(e) => setFormDataTouched({ ...formData, email: { ...formData.email, host: e.target.value } })} placeholder="smtp.gmail.com" />
                      </div>
                      <div className="st-row">
                        <div className="st-lbl"><label htmlFor="st-emailport"><b>Port</b><span>465 = SSL · 587 = STARTTLS — the toggle sets itself.</span></label></div>
                        <input className={smallCls} id="st-emailport" type="text" value={formData.email.port}
                          onChange={(e) => {
                            const port = Number(e.target.value) || 0;
                            const secure = port === 465 ? true : port === 587 || port === 25 ? false : formData.email.secure;
                            setFormDataTouched({ ...formData, email: { ...formData.email, port, secure } });
                          }} />
                        <button className={`st-sw ${formData.email.secure ? 'on' : ''}`} role="switch" aria-checked={formData.email.secure} aria-label="SSL/TLS"
                          onClick={() => setFormDataTouched({ ...formData, email: { ...formData.email, secure: !formData.email.secure } })} />
                        <span className="st-sw-label">SSL/TLS</span>
                      </div>
                      <span className="st-flabel">Credentials</span>
                      <div className="st-row">
                        <div className="st-lbl"><label htmlFor="st-emailuser"><b>Username</b><span>Your full email address.</span></label></div>
                        <input className={inputCls} id="st-emailuser" type="text" value={formData.email.user}
                          onChange={(e) => setFormDataTouched({ ...formData, email: { ...formData.email, user: e.target.value } })} />
                      </div>
                      <div className="st-row">
                        <div className="st-lbl"><label htmlFor="st-emailpass"><b>App password</b><span>Gmail needs an App Password, not your normal password.</span></label></div>
                        <input className={monoCls} id="st-emailpass" type="password" value={formData.email.password}
                          onChange={(e) => setFormDataTouched({ ...formData, email: { ...formData.email, password: e.target.value } })} placeholder="•••• •••• •••• ••••" />
                      </div>
                      <div className="st-row">
                        <div className="st-lbl"><label htmlFor="st-emailfrom"><b>From name</b><span>Shown as the sender.</span></label></div>
                        <input className={inputCls} id="st-emailfrom" type="text" value={formData.email.fromName}
                          onChange={(e) => setFormDataTouched({ ...formData, email: { ...formData.email, fromName: e.target.value } })} />
                      </div>
                      <div className="st-test-row">
                        <button className="st-btn primary sm" onClick={testEmailConnection} disabled={emailTestState === 'testing'}>
                          {emailTestState === 'testing' ? <><span className="st-spin" /> Testing…</> : <><Pulse size={14} weight="bold" /> Test connection</>}
                        </button>
                        {emailTestState === 'ok' && <span className="st-test-ok"><CheckCircle size={14} weight="bold" /> {emailTestMsg}</span>}
                        {emailTestState === 'error' && <span className="st-test-err"><Warning size={14} weight="bold" /> {emailTestMsg}</span>}
                      </div>
                      <details className="st-details">
                        <summary><CaretRight size={14} /> How to set up SMTP — step by step</summary>
                        <div className="st-guide">
                          <div className="st-gh">Gmail (free, recommended)</div>
                          <ol>
                            <li>Turn on <b>2-Step Verification</b>: myaccount.google.com → Security.</li>
                            <li>Search "Google App passwords" → create one for <b>Mail</b>.</li>
                            <li>Host <b>smtp.gmail.com</b> · Port <b>587</b> · SSL off (auto) · username = your Gmail.</li>
                          </ol>
                          <div className="st-gh">Outlook / Microsoft 365</div>
                          <ol><li>Host <b>smtp.office365.com</b> · Port <b>587</b> · SSL off (auto) · app password if 2FA.</li></ol>
                          <div className="st-gh">Any provider</div>
                          <ol><li>Port <b>465</b> = SSL on · <b>587</b> = SSL off (STARTTLS) — the toggle follows the port; Test auto-corrects.</li></ol>
                        </div>
                      </details>
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="st-panel" aria-label="Application Accounts settings">
              <div className="st-phead"><h2>Application Accounts</h2><p>Used only when an employer's application system requires creating a new account. Never your email or banking password.</p></div>
              <div className="st-card">
                <div className="st-card-head">
                  <div className="st-card-ico violet"><Key size={17} weight="duotone" /></div>
                  <div className="st-t"><b>Application Password</b><span className="st-d">{appPasswordConfigured ? 'Configured — used for new ATS account creation only.' : 'Not configured — generate or set your own.'}</span></div>
                  <div className="st-spacer" />
                  <span className={`st-tag ${appPasswordConfigured ? 'green' : 'red'}`}>{appPasswordConfigured ? 'Configured' : 'Not configured'}</span>
                </div>
                <div className="st-card-body" style={{ fontSize: 12, color: 'var(--st-muted, #475569)' }}>
                  <p style={{ marginTop: 4 }}>
                    Minimum 12 characters. Existing ATS accounts keep their old passwords if you regenerate — the new password applies to future accounts only.
                  </p>
                  <div className="st-card-actions" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className="st-btn primary sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: 'var(--st-cta, #059669)', color: '#fff', border: 0 }} onClick={generateAppPassword}>Generate strong password</button>
                    <button className="st-btn sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#e2e8f0', color: '#334155', border: 0 }} onClick={setOwnAppPassword}>Set my own</button>
                    <button className="st-btn sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#fee2e2', color: '#b91c1c', border: 0 }} onClick={removeAppPassword} disabled={!appPasswordConfigured}>Remove</button>
                  </div>
                  {appPasswordStatus && <p style={{ marginTop: 8, fontSize: 12 }}>{appPasswordStatus}</p>}
                </div>
              </div>
            </section>

            <section className="st-panel" aria-label="Email Connections settings">
              <div className="st-phead"><h2>Email Connections</h2><p>Optional — link your mailbox so Tailor AI can update application status from employer emails. Read-only classification; nothing is forwarded or stored beyond evidence.</p></div>
              <div className="st-card">
                <div className="st-card-head">
                  <div className="st-card-ico violet"><EnvelopeSimple size={17} weight="duotone" /></div>
                  <div className="st-t"><b>Gmail</b><span className="st-d">OAuth connector — polling while the app runs.</span></div>
                  <div className="st-spacer" />
                  <span className={`st-tag ${gmailConnected ? 'green' : 'red'}`}>{gmailConnected ? 'Configured' : 'Not connected'}</span>
                </div>
                <div className="st-card-body" style={{ fontSize: 12, color: 'var(--st-muted, #475569)' }}>
                  <p style={{ marginTop: 4 }}>Mailbox read permission may allow broader inbox access — Tailor AI only classifies job-related messages locally.</p>
                  <div className="st-card-actions" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className="st-btn primary sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: 'var(--st-cta, #059669)', color: '#fff', border: 0 }} onClick={() => connectMail('gmail')}>{gmailConnected ? 'Reconfigure' : 'Connect Gmail'}</button>
                    <button className="st-btn sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#e2e8f0', color: '#334155', border: 0 }} onClick={() => syncMail('gmail')} disabled={!gmailConnected}>Sync now</button>
                    <button className="st-btn sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#fee2e2', color: '#b91c1c', border: 0 }} onClick={() => disconnectMail('gmail')} disabled={!gmailConnected}>Disconnect</button>
                  </div>
                </div>
              </div>
              <div className="st-card">
                <div className="st-card-head">
                  <div className="st-card-ico violet"><EnvelopeSimple size={17} weight="duotone" /></div>
                  <div className="st-t"><b>Microsoft</b><span className="st-d">Microsoft Graph OAuth connector.</span></div>
                  <div className="st-spacer" />
                  <span className={`st-tag ${msConnected ? 'green' : 'red'}`}>{msConnected ? 'Configured' : 'Not connected'}</span>
                </div>
                <div className="st-card-body" style={{ fontSize: 12, color: 'var(--st-muted, #475569)' }}>
                  <div className="st-card-actions" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className="st-btn primary sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: 'var(--st-cta, #059669)', color: '#fff', border: 0 }} onClick={() => connectMail('microsoft')}>{msConnected ? 'Reconfigure' : 'Connect Microsoft'}</button>
                    <button className="st-btn sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#e2e8f0', color: '#334155', border: 0 }} onClick={() => syncMail('microsoft')} disabled={!msConnected}>Sync now</button>
                    <button className="st-btn sm" style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: '#fee2e2', color: '#b91c1c', border: 0 }} onClick={() => disconnectMail('microsoft')} disabled={!msConnected}>Disconnect</button>
                  </div>
                </div>
              </div>
            </section>
            </>
          )}

          {/* Save bar */}
          <div className="st-savebar">
            {saveError && <span className="stp-save-error">{saveError}</span>}
            <div className="st-spacer" />
            <button className="st-btn sm">Reset</button>
            <button className="st-btn primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <><span className="st-spin" /> Saving…</> : <><Check size={14} weight="bold" /> Save changes</>}
            </button>
          </div>
          <div className="st-about">
            Tailor CV v{pkg.version} — created by <b>Atanu Biswas</b> · © 2026 Atanu Biswas. All rights reserved. Personal use only — redistribution or white-labeling is prohibited (see LICENSE).
          </div>
        </main>
      </div>

      {/* Toast */}
      <div className={`st-toast ${savedToast ? 'show' : ''}`}><CheckCircle size={15} weight="bold" /> Changes saved</div>

      <style>{`
        .st-screen{position:relative; height:100vh; background:var(--st-bg,#F8FAFC); color:var(--st-ink,#0F172A); display:flex; flex-direction:column; font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; --st-bg:#F9FAFB; --st-surface:#FFFFFF; --st-line:#E2E8F0; --st-line2:#CBD5E1; --st-ink:#0F172A; --st-muted:#475569; --st-faint:#64748B; --st-primary:#2563EB; --st-primary-strong:#1D4ED8; --st-primary-soft:#EFF6FF; --st-primary-line:#BFDBFE; --st-cta:#059669; --st-cta-soft:#ECFDF5; --st-cta-line:#A7F3D0; --st-danger:#DC2626; --st-danger-soft:#FEF2F2;}
        .st-hdr{display:flex; align-items:center; gap:16px; padding:16px 28px; background:var(--st-surface); border-bottom:1px solid var(--st-line); flex-shrink:0;}
        .st-hbtn{display:inline-flex; align-items:center; gap:8px; padding:9px 15px; border-radius:10px; font-size:13px; font-weight:600; color:var(--st-muted); background:var(--st-surface); border:1px solid var(--st-line); cursor:pointer; transition:background .15s ease,color .15s ease,border-color .15s ease;}
        .st-hbtn:hover{background:var(--st-primary-soft); color:var(--st-primary); border-color:var(--st-primary-line);}
        .st-hbtn:focus-visible,.st-side-item:focus-visible,.st-itab:focus-visible,.st-provider:focus-visible,.st-btn:focus-visible,.st-sw:focus-visible,.st-eye:focus-visible{outline:2px solid var(--st-primary); outline-offset:2px;}
        .st-ttl{font-size:15px; font-weight:800; letter-spacing:-.01em;}
        .st-ttl small{font-size:11px; color:var(--st-faint); font-weight:500; margin-left:6px;}
        .st-spacer{flex:1;}
        .st-status{display:inline-flex; align-items:center; gap:7px; font-size:11.5px; font-weight:700; padding:6px 13px; border-radius:999px; background:var(--st-primary-soft); color:var(--st-primary); border:1px solid var(--st-primary-line);}
        .st-status.warn{background:#FFF7ED; color:#C2410C; border-color:#FED7AA;}
        .st-layout{flex:1; display:flex; min-height:0; padding:24px 28px; gap:22px;}
        .st-side{width:252px; background:var(--st-surface); border:1px solid var(--st-line); border-radius:14px; padding:12px; flex-shrink:0; display:flex; flex-direction:column; gap:2px;}
        .st-side-item{display:flex; align-items:center; gap:12px; width:100%; padding:12px 14px; border-radius:10px; font-size:13px; font-weight:600; color:var(--st-muted); cursor:pointer; background:transparent; border:1px solid transparent; text-align:left; font-family:inherit; transition:background .15s ease,color .15s ease,border-color .15s ease;}
        .st-side-item:hover{background:#FAFAF9; color:var(--st-ink);}
        .st-side-item.on{background:var(--st-primary-soft); color:var(--st-primary); border-color:var(--st-primary-line);}
        .st-side-ic{width:32px; height:32px; border-radius:9px; display:flex; align-items:center; justify-content:center; background:#F5F3FF; color:var(--st-muted); flex-shrink:0; transition:background .15s ease,color .15s ease;}
        .st-side-item.on .st-side-ic{background:var(--st-surface); color:var(--st-primary); border:1px solid var(--st-primary-line);}
        .st-side-cnt{margin-left:auto; font-size:10px; font-weight:800; background:#F5F3FF; color:var(--st-faint); border-radius:999px; padding:2px 8px;}
        .st-side-item.on .st-side-cnt{background:var(--st-surface); color:var(--st-primary);}
        .st-side-note{margin-top:auto; padding:13px 14px 4px; font-size:10.5px; color:var(--st-faint); line-height:1.65; border-top:1px solid var(--st-line);}
        .st-side-note b{color:var(--st-muted); font-weight:700;}
        .st-content{flex:1; min-width:0; overflow-y:auto; padding-right:6px;}
        .st-panel{animation:st-rise .22s ease;}
        @keyframes st-rise{from{opacity:0; transform:translateY(5px)} to{opacity:1; transform:none}}
        .st-phead{margin-bottom:18px;}
        .st-phead h2{font-size:18px; font-weight:800; letter-spacing:-.02em;}
        .st-phead p{font-size:12.5px; color:var(--st-muted); margin-top:3px;}
        .st-card{background:var(--st-surface); border:1px solid var(--st-line); border-radius:14px; margin-bottom:16px;}
        .st-card-head{display:flex; align-items:center; gap:13px; padding:16px 20px; border-bottom:1px solid var(--st-line);}
        .st-card-ico{width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; flex-shrink:0;}
        .st-card-ico.indigo{background:#EEF2FF; color:#4F46E5;}
        .st-card-ico.violet{background:#F5F3FF; color:#7C3AED;}
        .st-card-ico.teal{background:#F0FDFA; color:#0F766E;}
        .st-card-ico.green{background:var(--st-cta-soft); color:var(--st-cta);}
        .st-card-ico.red{background:var(--st-danger-soft); color:var(--st-danger);}
        .st-card-ico.pink{background:#FDF2F8; color:#DB2777;}
        .st-t b{font-size:14px; font-weight:700; letter-spacing:-.01em;}
        .st-t .st-d{display:block; font-size:11.5px; color:var(--st-faint); font-weight:500; margin-top:1px;}
        .st-tag{display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:700; padding:4px 10px; border-radius:999px; white-space:nowrap;}
        .st-tag.green{background:var(--st-cta-soft); color:var(--st-cta); border:1px solid var(--st-cta-line);}
        .st-tag.indigo{background:var(--st-primary-soft); color:var(--st-primary); border:1px solid var(--st-primary-line);}
        .st-tag.amber{background:#FFF7ED; color:#C2410C; border:1px solid #FED7AA;}
        .st-card-body{padding:6px 20px 18px;}
        .st-flabel{display:block; font-size:10.5px; font-weight:800; color:var(--st-faint); margin:18px 0 8px; text-transform:uppercase; letter-spacing:.09em;}
        .st-flabel .st-hint{text-transform:none; font-weight:500; letter-spacing:0;}
        .st-row{display:flex; align-items:center; gap:16px; padding:13px 0; border-bottom:1px solid #F2F1FB;}
        .st-row:last-child{border-bottom:none;}
        .st-lbl{flex:1; min-width:0;}
        .st-lbl b{display:block; font-size:13px; font-weight:600; letter-spacing:-.01em;}
        .st-lbl span{display:block; font-size:11.5px; color:var(--st-faint); margin-top:2px;}
        .st-lbl label{cursor:pointer;}
        .st-inp{width:240px; border:1.5px solid var(--st-line2); border-radius:10px; padding:10px 13px; font-size:13px; color:var(--st-ink); background:var(--st-surface); outline:none; font-family:inherit; transition:border-color .15s ease,box-shadow .15s ease;}
        .st-inp:hover{border-color:var(--st-primary-line);}
        .st-inp:focus{border-color:var(--st-primary); box-shadow:0 0 0 3px rgba(99,102,241,.12);}
        .st-inp[disabled]{background:#FAFAF9; color:var(--st-faint); cursor:not-allowed;}
        .st-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;}
        .st-sm{width:84px; text-align:center;}
        .st-sw{width:40px; height:23px; border-radius:999px; background:#C9C7E2; position:relative; cursor:pointer; transition:background .18s ease; flex-shrink:0; border:none; padding:0;}
        .st-sw::after{content:''; position:absolute; top:2.5px; left:2.5px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .18s ease; box-shadow:0 1px 2px rgba(30,27,75,.18);}
        .st-sw.on{background:var(--st-primary);}
        .st-sw.on::after{left:19.5px;}
        .st-sw-label{font-size:11.5px; color:var(--st-muted); font-weight:600;}
        .st-providers{display:grid; grid-template-columns:repeat(3,1fr); gap:9px;}
        .st-provider{border:1.5px solid var(--st-line); border-radius:11px; padding:11px 12px; display:flex; align-items:center; gap:10px; cursor:pointer; background:var(--st-surface); transition:border-color .15s ease,background .15s ease; text-align:left; font-family:inherit;}
        .st-provider:hover{border-color:var(--st-primary-line); background:#FAFAF9;}
        .st-provider.on{border-color:var(--st-primary); background:var(--st-primary-soft);}
        .st-plogo{width:27px; height:27px; border-radius:8px; color:#fff; font-size:9px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0;}
        .st-provider b{font-size:12px; display:block; line-height:1.25; font-weight:700;}
        .st-provider span:not(.st-plogo){font-size:9.5px; color:var(--st-faint); display:block; margin-top:1px;}
        .st-referral{display:flex; align-items:center; gap:12px; background:linear-gradient(135deg,var(--st-primary-soft),#F5F3FF); border:1px dashed var(--st-primary-line); border-radius:12px; padding:10px 14px; margin:12px 0 4px;}
        .st-referral-txt{flex:1; min-width:0;}
        .st-referral-txt b{display:block; font-size:12px; font-weight:800; color:var(--st-ink);}
        .st-referral-txt span{font-size:11px; color:var(--st-faint);}
        .st-referral-btn{display:inline-flex; align-items:center; gap:6px; flex-shrink:0; padding:8px 14px; border-radius:9px; background:linear-gradient(135deg,var(--st-primary),var(--st-primary-strong,var(--st-primary))); color:#fff; font-size:12px; font-weight:800; text-decoration:none;}
        .st-referral-btn:hover{filter:brightness(1.07);}
        .st-btn{display:inline-flex; align-items:center; gap:8px; padding:10px 17px; border-radius:10px; font-size:12.5px; font-weight:700; border:1.5px solid var(--st-line); background:var(--st-surface); color:var(--st-muted); cursor:pointer; transition:background .15s ease,color .15s ease,border-color .15s ease; font-family:inherit;}
        .st-btn:hover{background:#FAFAF9; border-color:var(--st-primary-line); color:var(--st-ink);}
        .st-btn:disabled{opacity:.5; cursor:not-allowed;}
        .st-btn.primary{background:var(--st-primary); border-color:var(--st-primary); color:#fff;}
        .st-btn.primary:hover{background:var(--st-primary-strong); border-color:var(--st-primary-strong); color:#fff;}
        .st-btn.sm{padding:7px 13px; font-size:12px; border-radius:9px;}
        .st-spin{width:12px; height:12px; border:2px solid rgba(255,255,255,.45); border-top-color:#fff; border-radius:50%; animation:st-rot .8s linear infinite; display:inline-block;}
        @keyframes st-rot{to{transform:rotate(360deg)}}
        .st-eye{width:32px; height:32px; border-radius:9px; border:1.5px solid var(--st-line); background:var(--st-surface); color:var(--st-faint); display:flex; align-items:center; justify-content:center; cursor:pointer; transition:color .15s ease,border-color .15s ease; flex-shrink:0;}
        .st-eye:hover{color:var(--st-primary); border-color:var(--st-primary-line);}
        .st-test-ok{font-size:12px; font-weight:700; color:var(--st-cta); display:inline-flex; align-items:center; gap:6px;}
        .st-test-err{font-size:12px; font-weight:700; color:var(--st-danger); display:inline-flex; align-items:center; gap:6px;}
        .st-test-row{display:flex; align-items:center; gap:12px; margin-top:16px; flex-wrap:wrap;}
        .st-itabs{display:flex; gap:6px; margin-bottom:18px; background:var(--st-surface); border:1px solid var(--st-line); border-radius:12px; padding:6px; width:fit-content;}
        .st-itab{padding:9px 16px; border-radius:9px; font-size:12.5px; font-weight:700; color:var(--st-muted); cursor:pointer; transition:background .15s ease,color .15s ease; display:flex; align-items:center; gap:8px; background:transparent; border:none; font-family:inherit;}
        .st-itab:hover{color:var(--st-ink); background:#FAFAF9;}
        .st-itab.on{background:var(--st-ink); color:#fff;}
        .st-igroup{animation:st-rise .22s ease;}
        .st-chips{display:flex; flex-wrap:wrap; gap:7px; margin-top:12px;}
        .st-chip{font-size:11px; font-weight:600; padding:5px 11px; border-radius:999px; background:var(--st-primary-soft); color:var(--st-primary); border:1px solid var(--st-primary-line);}
        .st-chip-p{font-weight:500; color:var(--st-faint);}
        .st-referral{display:flex; align-items:center; gap:14px; background:#FDF4FF; border:1px solid #F5D0FE; border-radius:12px; padding:13px 15px; margin-top:16px;}
        .st-referral b{font-size:12.5px; display:block; font-weight:700;}
        .st-referral span{font-size:11px; color:#86198F; display:block; margin-top:2px;}
        .st-referral a{white-space:nowrap; font-size:11.5px; font-weight:700; color:#A21CAF; background:#FAE8FF; border:1px solid #F0ABFC; border-radius:9px; padding:8px 13px; text-decoration:none; display:inline-flex; align-items:center; gap:6px; transition:background .15s ease;}
        .st-referral a:hover{background:#F5D0FE;}
        .st-details{margin-top:14px; border:1px solid var(--st-line); border-radius:11px; background:#FAFAF9;}
        .st-details summary{cursor:pointer; font-size:12px; font-weight:700; color:var(--st-primary); padding:11px 14px; user-select:none; list-style:none; display:flex; align-items:center; gap:8px;}
        .st-details summary::-webkit-details-marker{display:none;}
        .st-details summary svg{transition:transform .18s ease;}
        .st-details[open] summary svg{transform:rotate(90deg);}
        .st-guide{padding:2px 15px 14px; font-size:11.5px; color:var(--st-muted); line-height:1.75;}
        .st-guide b{color:var(--st-ink);}
        .st-gh{font-size:10px; font-weight:800; color:var(--st-ink); text-transform:uppercase; letter-spacing:.08em; margin:9px 0 3px;}
        .st-guide ol{margin-left:17px;}
        .st-avatar{width:58px; height:58px; border-radius:14px; background:var(--st-primary); color:#fff; font-size:21px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0;}
        .st-recm{font-size:12px; font-weight:700; margin-top:10px;}
        .st-recm.ok{color:var(--st-cta);} .st-recm.err{color:var(--st-danger);}
        .st-savebar{display:flex; align-items:center; gap:10px; padding:16px 0 6px; position:sticky; bottom:0; background:linear-gradient(transparent, var(--st-bg) 35%);}
        .st-about{font-size:10.5px; color:var(--st-faint); text-align:center; padding:4px 0 2px; line-height:1.7;}
        .st-about b{color:var(--st-muted);}
        .st-toast{position:fixed; bottom:26px; left:50%; transform:translateX(-50%) translateY(16px); background:var(--st-ink); color:#fff; font-size:12.5px; font-weight:700; padding:12px 22px; border-radius:12px; opacity:0; pointer-events:none; transition:opacity .2s ease,transform .2s ease; z-index:60; display:flex; align-items:center; gap:8px;}
        .st-toast.show{opacity:1; transform:translateX(-50%) translateY(0);}
        .st-toast svg{color:#34D399;}
        @media (max-width: 900px){
          .st-layout{flex-direction:column; padding:16px;}
          .st-side{width:100%; flex-direction:row; overflow-x:auto;}
          .st-side-note{display:none;}
          .st-providers{grid-template-columns:repeat(2,1fr);}
          .st-inp{width:180px;}
        }
        .stp-card { background: var(--st-card, #fff); border: 1px solid var(--st-border, #E2E8F0); border-radius: 14px; padding: 18px; }
        .stp-card-title { font-size: 13px; font-weight: 800; color: var(--st-ink, #0F172A); }
        .stp-card-sub { font-size: 11.5px; color: var(--st-faint, #64748B); margin-top: 3px; line-height: 1.55; }
        .stp-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; margin-top: 14px; }
        .stp-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        .stp-field.stp-check { justify-content: flex-end; }
        .stp-label { font-size: 11px; font-weight: 700; color: var(--st-muted, #475569); }
        .stp-input { width: 100%; border: 1.5px solid var(--st-hairline2, #CBD5E1); border-radius: 9px; padding: 8px 11px; font-size: 12.5px; color: var(--st-ink, #0F172A); background: var(--st-card, #fff); outline: none; font-family: inherit; }
        select.stp-input { appearance: none; -webkit-appearance: none; height: 38px; line-height: normal; padding-right: 30px; background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748B' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; background-size: 12px; }
        .stp-input:focus { border-color: var(--color-brand, #2563EB); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
        .stp-locbox { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border: 1.5px solid var(--st-hairline2, #CBD5E1); border-radius: 9px; padding: 6px 8px; background: var(--st-card, #fff); min-height: 38px; }
        .stp-locbox:focus-within { border-color: var(--color-brand, #2563EB); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
        .stp-loc-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; background: var(--color-brand-soft, #EFF6FF); color: var(--color-brand, #2563EB); border: 1px solid var(--color-brand-line, #BFDBFE); border-radius: 999px; padding: 4px 8px 4px 11px; }
        .stp-loc-x { border: 0; background: none; color: inherit; opacity: .55; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
        .stp-loc-x:hover { opacity: 1; }
        .stp-loc-input { flex: 1; min-width: 150px; border: 0; outline: none; background: none; font-size: 12.5px; font-family: inherit; color: var(--st-ink, #0F172A); }
        .stp-loc-input::placeholder { color: var(--st-faint, #64748B); font-weight: 400; }
        .stp-inline { display: flex; gap: 8px; }
        .stp-inline .stp-input { flex: 1; }
        .stp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .stp-chip { font-size: 11px; font-weight: 700; border: 1.5px solid var(--st-hairline2, #CBD5E1); background: #fff; color: var(--st-muted, #475569); border-radius: 999px; padding: 5px 12px; cursor: pointer; font-family: inherit; transition: all .15s ease; }
        .stp-chip.on { background: var(--color-brand-soft, #EFF6FF); border-color: var(--color-brand-line, #BFDBFE); color: var(--color-brand, #2563EB); }
        .stp-section-title { font-size: 10.5px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--st-faint, #64748B); }
        .stp-check-label { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--st-muted, #475569); cursor: pointer; }
        .stp-check-label input { accent-color: var(--color-brand, #2563EB); width: 15px; height: 15px; }
        .stp-hint { font-size: 11px; color: var(--st-faint, #64748B); margin-top: 14px; line-height: 1.5; }
        .stp-save-error { font-size: 12px; font-weight: 700; color: var(--st-danger, #DC2626); }
        @media (max-width: 720px) { .stp-grid2 { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
};
