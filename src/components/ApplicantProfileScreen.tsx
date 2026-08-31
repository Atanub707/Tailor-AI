// Applicant Profile v1 — structured local profile editor.
// Sections: Personal · Professional Links · Location & Relocation · Work
// Authorization · Work Preferences · Experience · Education · Skills ·
// Certifications · Application Defaults · Sensitive (collapsed).
// Explicit Save with saving/success/error states. Import from Master CV
// fills ONLY empty fields (never silently overwrites).

import React, { useEffect, useRef, useState } from 'react';
import { ProfileSections } from './ProfileSections';
import type { ApplicantProfile } from '../types';
import { HamburgerTrigger } from '../navigation';

interface ApplicantProfileScreenProps {
  isOpen: boolean;
  onClose: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const inputCls =
  'w-full bg-white border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-ink)] placeholder-[var(--color-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent';
const labelCls = 'block text-[11px] font-bold uppercase tracking-widest text-[var(--color-faint)] mb-1';
const sectionCls = 'rounded-xl border border-[var(--color-border)] bg-white p-5';

function Section({ title, hint, children, collapsed = false }: { title: string; hint?: string; children: React.ReactNode; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className={sectionCls}>
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setOpen(!open)}>
        <div>
          <h3 className="text-sm font-bold text-[var(--color-ink)]">{title}</h3>
          {hint && <p className="text-xs text-[var(--color-faint)] mt-0.5">{hint}</p>}
        </div>
        <span className="text-[var(--color-faint)]">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-4 space-y-4">{children}</div>}
    </section>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string | undefined; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        className={inputCls}
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export const ApplicantProfileScreen: React.FC<ApplicantProfileScreenProps> = ({ isOpen, onClose }) => {
  const [profile, setProfile] = useState<ApplicantProfile | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [importNote, setImportNote] = useState('');
  const [loadedAt, setLoadedAt] = useState(0);
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/applicant-profile')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((p) => {
        setProfile(p);
        setLoadedAt(Date.now());
        loadedOnce.current = true;
      })
      .catch((e) => {
        setSaveState('error');
        setErrorMsg(String(e?.message || 'Failed to load profile.'));
      });
  }, [isOpen]);

  const update = (fn: (p: ApplicantProfile) => ApplicantProfile) => {
    setProfile((prev) => (prev ? fn(prev) : prev));
    setSaveState('idle');
  };

  const handleSave = async () => {
    if (!profile) return;
    setSaveState('saving');
    setErrorMsg('');
    try {
      const res = await fetch('/api/applicant-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Save failed.');
      }
      const data = await res.json();
      setProfile(data.profile);
      setSaveState('saved');
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2500);
    } catch (e: any) {
      setSaveState('error');
      setErrorMsg(String(e?.message || 'Save failed.'));
    }
  };

  const handleImport = async () => {
    if (!confirmingImport) {
      setConfirmingImport(true);
      setImportNote('Import fills only empty profile fields from your Master CV. Existing values are kept. Continue?');
      return;
    }
    setSaveState('saving');
    setErrorMsg('');
    try {
      const res = await fetch('/api/applicant-profile/import-master-cv', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Import failed.');
      }
      const data = await res.json();
      setProfile(data.profile);
      setSaveState('saved');
      setConfirmingImport(false);
      setImportNote('Import complete — only empty fields were filled.');
    } catch (e: any) {
      setSaveState('error');
      setErrorMsg(String(e?.message || 'Import failed.'));
    }
  };

  const handleExport = async () => {
    const res = await fetch('/api/applicant-profile/export');
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'applicant-profile.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen || !profile) return null;
  const p = profile;

  return (
    <div className="h-screen overflow-y-auto bg-[var(--color-canvas)]">
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-canvas)]/95 backdrop-blur">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-4">
          <HamburgerTrigger />
          <div className="flex-1">
            <h1 className="text-lg font-bold text-[var(--color-ink)] leading-tight">Applicant Profile</h1>
            <p className="text-xs text-[var(--color-faint)]">Canonical structured facts — local only. Future Fit, Tailor &amp; Apply use this.</p>
          </div>
          <button onClick={handleImport} className="text-xs font-semibold px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-white">
            {confirmingImport ? 'Confirm import' : 'Import from Master CV'}
          </button>
          <button onClick={handleExport} className="text-xs font-semibold px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-white">
            Export JSON
          </button>
          <button
            onClick={handleSave}
            disabled={saveState === 'saving'}
            className="text-xs font-bold px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50"
          >
            {saveState === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
        {importNote && <div className="max-w-3xl mx-auto px-6 pb-3 text-xs text-[var(--color-faint)]">{importNote}</div>}
        {saveState === 'saved' && <div className="max-w-3xl mx-auto px-6 pb-3 text-xs font-semibold text-green-600">Saved.</div>}
        {saveState === 'error' && <div className="max-w-3xl mx-auto px-6 pb-3 text-xs font-semibold text-red-600">{errorMsg}</div>}
      </div>

            <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">
        {profile ? (
          <ProfileSections profile={profile} update={update} />
        ) : (
          <div className="text-sm text-[var(--color-faint)]">Loading profile…</div>
        )}
      </div>
    </div>
  );
};