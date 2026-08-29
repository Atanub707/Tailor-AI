// Applicant Profile v1 — structured local profile editor.
// Sections: Personal · Professional Links · Location & Relocation · Work
// Authorization · Work Preferences · Experience · Education · Skills ·
// Certifications · Application Defaults · Sensitive (collapsed).
// Explicit Save with saving/success/error states. Import from Master CV
// fills ONLY empty fields (never silently overwrites).

import React, { useEffect, useRef, useState } from 'react';
import type { ApplicantProfile } from '../types';

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
    <div className="h-[calc(100vh-74px)] overflow-y-auto bg-[var(--color-canvas)]">
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-canvas)]/95 backdrop-blur">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-4">
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
        <Section title="Personal" hint="Contact basics — never auto-inferred.">
          <div className="grid grid-cols-2 gap-4">
            <Field label="First name" value={p.personal.firstName} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, firstName: v } }))} />
            <Field label="Middle name" value={p.personal.middleName} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, middleName: v } }))} />
            <Field label="Last name" value={p.personal.lastName} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, lastName: v } }))} />
            <Field label="Preferred name" value={p.personal.preferredName} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, preferredName: v } }))} />
            <Field label="Email" type="email" value={p.personal.email} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, email: v } }))} />
            <Field label="Phone" value={p.personal.phone} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, phone: v } }))} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="City" value={p.contact.city} onChange={(v) => update((x) => ({ ...x, contact: { ...x.contact, city: v } }))} />
            <Field label="State / region" value={p.contact.state} onChange={(v) => update((x) => ({ ...x, contact: { ...x.contact, state: v } }))} />
            <Field label="Country" value={p.contact.country} onChange={(v) => update((x) => ({ ...x, contact: { ...x.contact, country: v } }))} />
            <Field label="Postal code" value={p.contact.postalCode} onChange={(v) => update((x) => ({ ...x, contact: { ...x.contact, postalCode: v } }))} />
          </div>
        </Section>

        <Section title="Professional Links">
          <div className="grid grid-cols-2 gap-4">
            <Field label="LinkedIn URL" value={p.links.linkedin} onChange={(v) => update((x) => ({ ...x, links: { ...x.links, linkedin: v } }))} />
            <Field label="GitHub URL" value={p.links.github} onChange={(v) => update((x) => ({ ...x, links: { ...x.links, github: v } }))} />
            <Field label="Portfolio URL" value={p.links.portfolio} onChange={(v) => update((x) => ({ ...x, links: { ...x.links, portfolio: v } }))} />
            <Field label="Website URL" value={p.links.website} onChange={(v) => update((x) => ({ ...x, links: { ...x.links, website: v } }))} />
          </div>
        </Section>

        <Section title="Location & Relocation">
          <div className="grid grid-cols-3 gap-4">
            <Field label="Current city" value={p.locationPrefs.currentCity} onChange={(v) => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, currentCity: v } }))} />
            <Field label="Current state" value={p.locationPrefs.currentState} onChange={(v) => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, currentState: v } }))} />
            <Field label="Current country" value={p.locationPrefs.currentCountry} onChange={(v) => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, currentCountry: v } }))} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Willing to relocate</label>
              <select className={inputCls} value={p.locationPrefs.willingToRelocate ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, willingToRelocate: e.target.value as any } }))}>
                <option value="unknown">Unknown</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
                <option value="depends">Depends</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Remote preference</label>
              <select className={inputCls} value={p.locationPrefs.remotePreference ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, remotePreference: e.target.value as any } }))}>
                <option value="unknown">Unknown</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="onsite">On-site</option>
                <option value="flexible">Flexible</option>
              </select>
            </div>
          </div>
        </Section>

        <Section title="Work Authorization" hint="Explicit only — never inferred from nationality or location.">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Country" value={p.workAuthorization.country} onChange={(v) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, country: v } }))} />
            <Field label="Visa / work permit type (optional)" value={p.workAuthorization.visaType} onChange={(v) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, visaType: v } }))} />
            <div>
              <label className={labelCls}>Authorized to work</label>
              <select className={inputCls} value={p.workAuthorization.authorizedToWork ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, authorizedToWork: e.target.value as any } }))}>
                <option value="unknown">Unknown</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Requires sponsorship</label>
              <select className={inputCls} value={p.workAuthorization.requiresSponsorship ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, requiresSponsorship: e.target.value as any } }))}>
                <option value="unknown">Unknown</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <Field label="Valid until (YYYY-MM-DD)" value={p.workAuthorization.validUntil} onChange={(v) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, validUntil: v } }))} />
          </div>
        </Section>

        <Section title="Work Preferences" hint="Future Auto-Apply guardrails.">
          <Field label="Desired titles (comma separated)" value={(p.preferences.desiredTitles || []).join(', ')} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, desiredTitles: v.split(',').map((s) => s.trim()).filter(Boolean) } }))} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Minimum salary" type="number" value={p.preferences.minimumSalary !== undefined ? String(p.preferences.minimumSalary) : ''} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, minimumSalary: v === '' ? undefined : Number(v) } }))} />
            <Field label="Target salary" type="number" value={p.preferences.targetSalary !== undefined ? String(p.preferences.targetSalary) : ''} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, targetSalary: v === '' ? undefined : Number(v) } }))} />
            <Field label="Salary currency" value={p.preferences.salaryCurrency} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, salaryCurrency: v } }))} />
            <Field label="Notice period" value={p.preferences.noticePeriod} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, noticePeriod: v } }))} />
            <Field label="Current salary" type="number" value={p.preferences.currentSalary !== undefined ? String(p.preferences.currentSalary) : ''} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, currentSalary: v === '' ? undefined : Number(v) } }))} />
            <Field label="Earliest start date (YYYY-MM-DD)" value={p.preferences.earliestStartDate} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, earliestStartDate: v } }))} />
          </div>
        </Section>

        <Section title="Experience">
          {p.experience.map((e, i) => (
            <div key={i} className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Company" value={e.company} onChange={(v) => update((x) => { const exp = [...x.experience]; exp[i] = { ...exp[i], company: v }; return { ...x, experience: exp }; })} />
                <Field label="Title" value={e.title} onChange={(v) => update((x) => { const exp = [...x.experience]; exp[i] = { ...exp[i], title: v }; return { ...x, experience: exp }; })} />
                <Field label="Start (YYYY-MM)" value={e.startDate} onChange={(v) => update((x) => { const exp = [...x.experience]; exp[i] = { ...exp[i], startDate: v }; return { ...x, experience: exp }; })} />
                <Field label="End (YYYY-MM)" value={e.endDate} onChange={(v) => update((x) => { const exp = [...x.experience]; exp[i] = { ...exp[i], endDate: v }; return { ...x, experience: exp }; })} />
              </div>
              <button
                type="button"
                className="text-xs font-semibold text-red-600"
                onClick={() => update((x) => ({ ...x, experience: x.experience.filter((_, j) => j !== i) }))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-xs font-bold px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-white"
            onClick={() => update((x) => ({ ...x, experience: [...x.experience, { company: '', title: '', source: 'manual' }] }))}
          >
            + Add experience
          </button>
        </Section>

        <Section title="Education">
          {p.education.map((e, i) => (
            <div key={i} className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Institution" value={e.institution} onChange={(v) => update((x) => { const edu = [...x.education]; edu[i] = { ...edu[i], institution: v }; return { ...x, education: edu }; })} />
                <Field label="Degree" value={e.degree} onChange={(v) => update((x) => { const edu = [...x.education]; edu[i] = { ...edu[i], degree: v }; return { ...x, education: edu }; })} />
              </div>
              <button type="button" className="text-xs font-semibold text-red-600" onClick={() => update((x) => ({ ...x, education: x.education.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          ))}
          <button type="button" className="text-xs font-bold px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-white" onClick={() => update((x) => ({ ...x, education: [...x.education, { institution: '' }] }))}>+ Add education</button>
        </Section>

        <Section title="Skills">
          <div className="space-y-2">
            {p.skills.map((s, i) => (
              <div key={i} className="flex items-center gap-3">
                <input className={inputCls} value={s.name} onChange={(v) => update((x) => { const sk = [...x.skills]; sk[i] = { ...sk[i], name: v.target.value }; return { ...x, skills: sk }; })} />
                <input className={inputCls} placeholder="Category (optional)" value={s.category ?? ''} onChange={(v) => update((x) => { const sk = [...x.skills]; sk[i] = { ...sk[i], category: v.target.value }; return { ...x, skills: sk }; })} />
                <button type="button" className="text-xs font-semibold text-red-600" onClick={() => update((x) => ({ ...x, skills: x.skills.filter((_, j) => j !== i) }))}>Remove</button>
              </div>
            ))}
          </div>
          <button type="button" className="text-xs font-bold px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-white" onClick={() => update((x) => ({ ...x, skills: [...x.skills, { name: '', source: 'manual' }] }))}>+ Add skill</button>
        </Section>

        <Section title="Certifications">
          {p.certifications.map((c, i) => (
            <div key={i} className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--color-border)] p-4">
              <Field label="Name" value={c.name} onChange={(v) => update((x) => { const certs = [...x.certifications]; certs[i] = { ...certs[i], name: v }; return { ...x, certifications: certs }; })} />
              <Field label="Issuer" value={c.issuer} onChange={(v) => update((x) => { const certs = [...x.certifications]; certs[i] = { ...certs[i], issuer: v }; return { ...x, certifications: certs }; })} />
            </div>
          ))}
          <button type="button" className="text-xs font-bold px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-white" onClick={() => update((x) => ({ ...x, certifications: [...x.certifications, { name: '' }] }))}>+ Add certification</button>
        </Section>

        <Section title="Application Defaults" hint="Reusable answers only — structured facts live in their canonical section.">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Reason for change" value={p.applicationDefaults.reasonForChange} onChange={(v) => update((x) => ({ ...x, applicationDefaults: { ...x.applicationDefaults, reasonForChange: v } }))} />
            <Field label="Generic why interested" value={p.applicationDefaults.whyInterestedDefault} onChange={(v) => update((x) => ({ ...x, applicationDefaults: { ...x.applicationDefaults, whyInterestedDefault: v } }))} />
            <Field label="Preferred contact method" value={p.applicationDefaults.preferredContactMethod} onChange={(v) => update((x) => ({ ...x, applicationDefaults: { ...x.applicationDefaults, preferredContactMethod: v } }))} />
          </div>
        </Section>

        <Section title="Sensitive (optional)" collapsed hint="Disabled by default. Never inferred. Future Apply will only answer these when you explicitly enable them.">
          <div className="flex items-center gap-3">
            <input id="sens-enabled" type="checkbox" checked={p.optionalSensitive.enabled === true} onChange={(e) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, enabled: e.target.checked } }))} />
            <label htmlFor="sens-enabled" className="text-sm text-[var(--color-ink)]">Enable optional sensitive fields (voluntary self-identification)</label>
          </div>
          {p.optionalSensitive.enabled && (
            <div className="grid grid-cols-2 gap-4 mt-4">
              <Field label="Gender" value={p.optionalSensitive.gender} onChange={(v) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, gender: v } }))} />
              <Field label="Race / ethnicity" value={p.optionalSensitive.raceEthnicity} onChange={(v) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, raceEthnicity: v } }))} />
              <Field label="Veteran status" value={p.optionalSensitive.veteranStatus} onChange={(v) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, veteranStatus: v } }))} />
              <Field label="Disability status" value={p.optionalSensitive.disabilityStatus} onChange={(v) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, disabilityStatus: v } }))} />
            </div>
          )}
        </Section>
      </div>
    </div>
  );
};