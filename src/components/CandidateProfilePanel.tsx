import React from 'react';
import type { ApplicantProfile } from '../types';

// Unified Candidate Profile panel — ONE user-facing profile in the existing
// Job Preferences design language (stp-* classes), backed by the canonical
// applicant_profile model. Legacy CandidateProfile is migrated lazily by the
// server (GET /api/profile) and never independently edited here.
interface Props {
  user?: { id: string; email: string; name: string; isGuest: boolean } | null;
  onSaved?: () => void;
}

const WORK_MODES = [
  { value: 'remote' as const, label: 'Remote' },
  { value: 'hybrid' as const, label: 'Hybrid' },
  { value: 'onsite' as const, label: 'On-site' },
  { value: 'flexible' as const, label: 'Flexible' },
];
const EMPLOYMENT_TYPES = ['full-time', 'part-time', 'contract', 'freelance', 'internship', 'temporary'];
const RELOCATE = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'depends', label: 'Depends' },
  { value: 'certain-cities', label: 'Certain cities' },
];

export function CandidateProfilePanel({ user, onSaved }: Props) {
  const [profile, setProfile] = React.useState<ApplicantProfile | null>(null);
  const [conflicts, setConflicts] = React.useState<Record<string, string>>({});
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = React.useState('');
  const [locValue, setLocValue] = React.useState('');

  React.useEffect(() => {
    fetch('/api/profile')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((d) => { setProfile(d.profile); setConflicts(d.conflicts || {}); })
      .catch((e) => { setSaveState('error'); setErrorMsg(String(e?.message || 'Failed to load profile.')); });
  }, []);

  const update = (fn: (p: ApplicantProfile) => ApplicantProfile) => {
    setProfile((prev) => (prev ? fn(prev) : prev));
    setSaveState('idle');
  };

  // Manual save — explicit user action only.

  const save = async () => {
    if (!profile) return;
    setSaveState('saving'); setErrorMsg('');
    try {
      const res = await fetch('/api/applicant-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed.'); }
      const d = await res.json();
      setProfile(d.profile);
      setSaveState('saved');
      setConflicts({});
      setTimeout(() => setSaveState((s2) => (s2 === 'saved' ? 'idle' : s2)), 2500);
      onSaved?.();
    } catch (e: any) {
      setSaveState('error'); setErrorMsg(String(e?.message || 'Save failed.'));
    }
  };

  if (!profile) {
    return <section className="st-panel" aria-label="Candidate Profile"><div className="st-phead"><h2>Candidate Profile</h2><p>Your reusable identity, application information and job-search preferences — one source of truth.</p></div><div className="text-sm" style={{ color: 'var(--st-faint)' }}>Loading profile…</div></section>;
  }

  const p = profile;
  const prefs = p.preferences || {};
  const loc = p.locationPrefs || {};
  const wa = p.workAuthorization || {};
  const links = p.links || {};
  const personal = p.personal || {};
  const contact = p.contact || {};

  const chip = (v: string, active: boolean) => `stp-chip${active ? ' on' : ''}`;
  const LOC_LABEL: Record<string, string> = { noticePeriod: 'Notice period', earliestStartDate: 'Available from', requiresSponsorship: 'Visa sponsorship', willingToRelocate: 'Willing to relocate', minimumSalary: 'Expected salary min', targetSalary: 'Expected salary max', salaryCurrency: 'Currency' };
  const resolve = (key: string) => {
    const legacy = conflicts[key];
    if (!legacy) return;
    setConflicts((c) => { const n = { ...c }; delete n[key]; return n; });
    update((x) => {
      if (key === 'requiresSponsorship') return { ...x, workAuthorization: { ...x.workAuthorization, requiresSponsorship: legacy === 'yes' ? 'yes' : legacy === 'no' ? 'no' : x.workAuthorization.requiresSponsorship } };
      if (key === 'willingToRelocate') return { ...x, locationPrefs: { ...x.locationPrefs, willingToRelocate: legacy as any } };
      if (key === 'earliestStartDate') return { ...x, preferences: { ...x.preferences, earliestStartDate: legacy } };
      if (key === 'noticePeriod') return { ...x, preferences: { ...x.preferences, noticePeriod: legacy } };
      return x;
    });
  };

  const conflictKeys = Object.keys(conflicts);

  return (
    <section className="st-panel" aria-label="Candidate Profile">
      <div className="st-phead">
        <h2>Candidate Profile</h2>
        <p>Your reusable application identity, application information and job-search preferences — one source of truth for Auto-Apply, Tailor and Applications. Master CV remains the source for your professional history.</p>
      </div>

      {conflictKeys.length > 0 && (
        <div className="st-note-box" style={{ marginBottom: 14 }}>
          <b>One-time migration:</b> your old Job Preferences had different values for some facts. Choose which value Tailor AI should use.
          {conflictKeys.map((k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <span style={{ fontSize: 12.5 }}>{LOC_LABEL[k] || k}</span>
              <span style={{ color: 'var(--st-faint)', fontSize: 12 }}>(current: profile value)</span>
              <button type="button" onClick={() => resolve(k)} className="stp-chip" style={{ marginLeft: 'auto' }}>
                Use legacy value: {conflicts[k]}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* PERSONAL DETAILS */}
      <div className="stp-card" style={{ marginTop: 4 }}>
        <div className="stp-card-head">
          <div>
            <div className="stp-card-title">Personal Details</div>
            <p className="stp-card-sub">Reusable application identity. Nothing is inferred.</p>
          </div>
          <span className="stp-status-tag">{personal.firstName && personal.lastName && personal.email ? 'Complete' : 'Incomplete'}</span>
        </div>
        <div className="stp-grid">
          <div className="stp-field"><label className="stp-label">First name</label><input className="stp-input has-value" value={personal.firstName ?? ''} onChange={(e) => update((x) => ({ ...x, personal: { ...x.personal, firstName: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Middle name <span className="stp-opt">Optional</span></label><input className="stp-input" value={personal.middleName ?? ''} onChange={(e) => update((x) => ({ ...x, personal: { ...x.personal, middleName: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Last name</label><input className="stp-input has-value" value={personal.lastName ?? ''} onChange={(e) => update((x) => ({ ...x, personal: { ...x.personal, lastName: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Preferred name <span className="stp-opt">Optional</span></label><input className="stp-input" value={personal.preferredName ?? ''} onChange={(e) => update((x) => ({ ...x, personal: { ...x.personal, preferredName: e.target.value } }))} /></div>
        </div>
        <div className="stp-field">
          <label className="stp-label">Application Email</label>
          <input className="stp-input has-value" type="email" value={personal.email ?? ''} onChange={(e) => update((x) => ({ ...x, personal: { ...x.personal, email: e.target.value } }))} />
          <div className="stp-hint-inline">Used when applying to jobs. Different from your Tailor AI sign-in email.</div>
        </div>
        <div className="stp-grid">
          <div className="stp-field"><label className="stp-label">Phone</label><input className="stp-input has-value" value={personal.phone ?? ''} onChange={(e) => update((x) => ({ ...x, personal: { ...x.personal, phone: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">City</label><input className="stp-input has-value" value={contact.city ?? ''} onChange={(e) => update((x) => ({ ...x, contact: { ...x.contact, city: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">State / region</label><input className="stp-input" value={contact.state ?? ''} onChange={(e) => update((x) => ({ ...x, contact: { ...x.contact, state: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Country</label><input className="stp-input has-value" value={contact.country ?? ''} onChange={(e) => update((x) => ({ ...x, contact: { ...x.contact, country: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Postal code</label><input className="stp-input" value={contact.postalCode ?? ''} onChange={(e) => update((x) => ({ ...x, contact: { ...x.contact, postalCode: e.target.value } }))} /></div>
        </div>
      </div>

      {/* PROFESSIONAL LINKS */}
      <div className="stp-card">
        <div className="stp-card-head">
          <div><div className="stp-card-title">Professional Links</div></div>
          <span className="stp-status-tag muted">Optional</span>
        </div>
        <div className="stp-grid">
          <div className="stp-field"><label className="stp-label">LinkedIn URL</label><input className="stp-input has-value" value={links.linkedin ?? ''} onChange={(e) => update((x) => ({ ...x, links: { ...x.links, linkedin: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">GitHub URL</label><input className="stp-input" value={links.github ?? ''} onChange={(e) => update((x) => ({ ...x, links: { ...x.links, github: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Portfolio URL <span className="stp-opt">Optional</span></label><input className="stp-input" value={links.portfolio ?? ''} onChange={(e) => update((x) => ({ ...x, links: { ...x.links, portfolio: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Website URL <span className="stp-opt">Optional</span></label><input className="stp-input" value={links.website ?? ''} onChange={(e) => update((x) => ({ ...x, links: { ...x.links, website: e.target.value } }))} /></div>
        </div>
      </div>

      {/* JOB PREFERENCES */}
      <div className="stp-card">
        <div className="stp-card-head"><div><div className="stp-card-title">Job Preferences</div>
        <p className="stp-card-sub">Used for matching and drafting your approach — nothing here goes on your CV.</p></div>
        <span className="stp-status-tag muted">Matching only</span></div>
        <div className="stp-field">
          <label className="stp-label">Desired job titles</label>
          <input className="stp-input" placeholder="e.g. DevOps Engineer, Platform Engineer" value={(prefs.desiredTitles || []).join(', ')} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, desiredTitles: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } }))} />
        </div>
        <div className="stp-field">
          <label className="stp-label">Work mode preference</label>
          <div className="stp-chips">
            {WORK_MODES.map((m) => (
              <button key={m.value} type="button" className={chip(m.value, loc.remotePreference === m.value)} onClick={() => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, remotePreference: m.value } }))}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="stp-field">
          <label className="stp-label">Preferred locations</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(loc.preferredLocations || []).map((l) => (
              <span key={l} className="stp-loc-chip">
                {l}
                <button type="button" className="stp-loc-x" aria-label={`Remove ${l}`} onClick={() => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, preferredLocations: (x.locationPrefs.preferredLocations || []).filter((y) => y !== l) } }))}>×</button>
              </span>
            ))}
          </div>
          <div className="stp-inline" style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <input className="stp-loc-input" placeholder="Add location…" value={locValue} onChange={(e) => setLocValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && locValue.trim()) { update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, preferredLocations: [...(x.locationPrefs.preferredLocations || []), locValue.trim()] } })); setLocValue(''); } }} />
            <button type="button" className="stp-chip" onClick={() => { if (locValue.trim()) { update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, preferredLocations: [...(x.locationPrefs.preferredLocations || []), locValue.trim()] } })); setLocValue(''); } }}>Add</button>
          </div>
        </div>
        <div className="stp-field">
          <label className="stp-label">Employment type preference</label>
          <div className="stp-chips">
            {EMPLOYMENT_TYPES.map((t) => (
              <button key={t} type="button" className={chip(t, (prefs.preferredEmploymentTypes || []).includes(t))} onClick={() => update((x) => {
                const cur = x.preferences.preferredEmploymentTypes || [];
                return { ...x, preferences: { ...x.preferences, preferredEmploymentTypes: cur.includes(t) ? cur.filter((y) => y !== t) : [...cur, t] } };
              })}>{t}</button>
            ))}
          </div>
        </div>
        <div className="stp-grid">
          <div className="stp-field">
            <label className="stp-label">Job search status</label>
            <select className="stp-input" value={prefs.jobSearchStatus ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, jobSearchStatus: e.target.value } }))}>
              <option value="">—</option>
              <option>Actively looking</option><option>Open to opportunities</option><option>Passively looking</option><option>Not looking</option>
            </select>
          </div>
          <div className="stp-field">
            <label className="stp-label">Willing to relocate</label>
            <select className="stp-input" value={loc.willingToRelocate ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, willingToRelocate: e.target.value as any } }))}>
              {RELOCATE.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="stp-field"><label className="stp-label">Willing to travel (%)</label><input className="stp-input" type="number" value={prefs.travelPercentage ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, travelPercentage: e.target.value === '' ? undefined : Number(e.target.value) } }))} /></div>
          <div className="stp-field"><label className="stp-label">Preferred company size</label><input className="stp-input" value={prefs.preferredCompanySize ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, preferredCompanySize: e.target.value } }))} /></div>
        </div>
        <div className="stp-field">
          <label className="stp-label">Languages</label>
          <div className="stp-chips">
            {(prefs.languages || []).map((l) => (
              <span key={l} className="stp-loc-chip">{l}
                <button type="button" className="stp-loc-x" aria-label={`Remove ${l}`} onClick={() => update((x) => ({ ...x, preferences: { ...x.preferences, languages: (x.preferences.languages || []).filter((y) => y !== l) } }))}>×</button>
              </span>
            ))}
            <input className="stp-loc-input" style={{ minWidth: 90 }} placeholder="Add language…" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) { const v = (e.target as HTMLInputElement).value.trim(); update((x) => ({ ...x, preferences: { ...x.preferences, languages: [...(x.preferences.languages || []), v] } })); (e.target as HTMLInputElement).value = ''; } }} />
          </div>
        </div>
      </div>

      {/* WORK ELIGIBILITY */}
      <div className="stp-card">
        <div className="stp-card-head"><div><div className="stp-card-title">Work Eligibility</div>
        <p className="stp-card-sub">Explicit only — never inferred from your CV, location or nationality.</p></div>
        <span className="stp-status-tag muted">{wa.country || wa.authorizedToWork ? 'Set' : 'Unknown'}</span></div>
        <div className="stp-grid">
          <div className="stp-field"><label className="stp-label">Country</label><input className="stp-input has-value" value={wa.country ?? ''} onChange={(e) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, country: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Visa / work permit type (optional)</label><input className="stp-input" value={wa.visaType ?? ''} onChange={(e) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, visaType: e.target.value } }))} /></div>
          <div className="stp-field">
            <label className="stp-label">Authorized to work</label>
            <select className="stp-input" value={wa.authorizedToWork ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, authorizedToWork: e.target.value as any } }))}>
              <option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </div>
          <div className="stp-field">
            <label className="stp-label">I need visa sponsorship</label>
            <select className="stp-input" value={wa.requiresSponsorship ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, requiresSponsorship: e.target.value as any } }))}>
              <option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </div>
          <div className="stp-field"><label className="stp-label">Authorization valid until (YYYY-MM-DD)</label><input className="stp-input" value={wa.validUntil ?? ''} onChange={(e) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, validUntil: e.target.value } }))} /></div>
        </div>
      </div>

      {/* AVAILABILITY */}
      <div className="stp-card">
        <div className="stp-card-head"><div><div className="stp-card-title">Availability</div></div>
        <span className="stp-status-tag muted">{prefs.noticePeriod || prefs.earliestStartDate ? 'Set' : 'Not set'}</span></div>
        <div className="stp-grid">
          <div className="stp-field"><label className="stp-label">Notice period</label><input className="stp-input has-value" placeholder="e.g. 30 days" value={prefs.noticePeriod ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, noticePeriod: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Available from</label><input className="stp-input" placeholder="YYYY-MM-DD" value={prefs.earliestStartDate ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, earliestStartDate: e.target.value } }))} /></div>
        </div>
      </div>

      {/* COMPENSATION */}
      <div className="stp-card">
        <div className="stp-card-head"><div><div className="stp-card-title">Compensation</div>
        <p className="stp-card-sub">Kept private — used for matching, never placed into cold emails.</p></div>
        <span className="stp-status-tag muted">Private</span></div>
        <div className="stp-grid">
          <div className="stp-field"><label className="stp-label">Current compensation (optional)</label><input className="stp-input" type="number" value={prefs.currentSalary ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, currentSalary: e.target.value === '' ? undefined : Number(e.target.value) } }))} /></div>
          <div className="stp-field"><label className="stp-label">Expected salary — minimum</label><input className="stp-input has-value" type="number" value={prefs.minimumSalary ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, minimumSalary: e.target.value === '' ? undefined : Number(e.target.value) } }))} /></div>
          <div className="stp-field"><label className="stp-label">Expected salary — maximum</label><input className="stp-input has-value" type="number" value={prefs.targetSalary ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, targetSalary: e.target.value === '' ? undefined : Number(e.target.value) } }))} /></div>
          <div className="stp-field"><label className="stp-label">Currency</label><input className="stp-input" placeholder="e.g. USD, INR, EUR" value={prefs.salaryCurrency ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, salaryCurrency: e.target.value } }))} /></div>
        </div>
      </div>

      {/* APPLICATION DEFAULTS */}
      <div className="stp-card">
        <div className="stp-card-title">Application Defaults</div>
        <p className="stp-card-sub">Reusable free-text answers only. Company-specific questions belong to the application itself.</p>
        <div className="stp-grid">
          <div className="stp-field"><label className="stp-label">Reason for change</label><input className="stp-input" value={p.applicationDefaults?.reasonForChange ?? ''} onChange={(e) => update((x) => ({ ...x, applicationDefaults: { ...x.applicationDefaults, reasonForChange: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Generic why interested</label><input className="stp-input" value={p.applicationDefaults?.whyInterestedDefault ?? ''} onChange={(e) => update((x) => ({ ...x, applicationDefaults: { ...x.applicationDefaults, whyInterestedDefault: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Preferred contact method</label><input className="stp-input" value={p.applicationDefaults?.preferredContactMethod ?? ''} onChange={(e) => update((x) => ({ ...x, applicationDefaults: { ...x.applicationDefaults, preferredContactMethod: e.target.value } }))} /></div>
          <div className="stp-field"><label className="stp-label">Anything else a recruiter should know</label><textarea className="stp-input" style={{ minHeight: 64 }} value={prefs.recruiterNote ?? ''} onChange={(e) => update((x) => ({ ...x, preferences: { ...x.preferences, recruiterNote: e.target.value } }))} /></div>
        </div>
      </div>

      {/* SENSITIVE (optional, opt-in) */}
      <div className="stp-card" style={{ borderColor: '#FED7AA', background: '#FFF7ED' }}>
        <div className="stp-card-title" style={{ color: '#9A3412' }}>Sensitive (optional)</div>
        <div className="stp-field" style={{ marginTop: 10 }}>
          <div className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, fontWeight: 600, color: 'var(--st-ink)' }}>
            <input id="sens-enabled2" type="checkbox" checked={p.optionalSensitive?.enabled === true} onChange={(e) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, enabled: e.target.checked } }))} />
            <label htmlFor="sens-enabled2" style={{ cursor: 'pointer' }}>Enable optional sensitive fields (voluntary self-identification)</label>
          </div>
          <div className="stp-hint-inline">Disabled by default. Never inferred. ATS questions only use these when you explicitly enable them.</div>
        </div>
        {p.optionalSensitive?.enabled && (
          <div className="stp-grid2">
            <div className="stp-field"><label className="stp-label">Gender</label><input className="stp-input" value={p.optionalSensitive?.gender ?? ''} onChange={(e) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, gender: e.target.value } }))} /></div>
            <div className="stp-field"><label className="stp-label">Race / ethnicity</label><input className="stp-input" value={p.optionalSensitive?.raceEthnicity ?? ''} onChange={(e) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, raceEthnicity: e.target.value } }))} /></div>
            <div className="stp-field"><label className="stp-label">Veteran status</label><input className="stp-input" value={p.optionalSensitive?.veteranStatus ?? ''} onChange={(e) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, veteranStatus: e.target.value } }))} /></div>
            <div className="stp-field"><label className="stp-label">Disability status</label><input className="stp-input" value={p.optionalSensitive?.disabilityStatus ?? ''} onChange={(e) => update((x) => ({ ...x, optionalSensitive: { ...x.optionalSensitive, disabilityStatus: e.target.value } }))} /></div>
          </div>
        )}
      </div>

      {/* LOGIN & SECURITY (read-only) */}
      <div className="stp-card">
        <div className="stp-card-title">Login &amp; Security</div>
        <div className="stp-grid">
          <div className="stp-field">
            <label className="stp-label">Sign-in Email</label>
            <input className="stp-input" value={user?.email ?? ''} disabled />
            <div className="stp-hint-inline">Used to access Tailor AI. Different from your Application Email.</div>
          </div>
          <div className="stp-field">
            <label className="stp-label">Account Status</label>
            <input className="stp-input" value={user?.isGuest ? 'Guest' : 'Registered'} disabled />
            <div className="stp-hint-inline">Authentication stays separate from your candidate profile.</div>
          </div>
        </div>
      </div>

      {/* MASTER CV BOUNDARY */}
      <div className="st-note-box" style={{ marginBottom: 14 }}>
        <b>Professional history lives in your Master CV.</b> Your experience, employers, titles, dates, skills, education and certifications belong to the Master CV — this profile holds reusable identity, eligibility and preference facts only.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }} aria-live="polite">
        <button onClick={() => void save()} disabled={saveState === 'saving'} style={{ background: 'var(--st-primary)', color: '#fff', fontWeight: 800, padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5 }}>
          {saveState === 'saving' ? 'Saving…' : 'Save Candidate Profile'}
        </button>
        <span className="text-xs font-semibold" style={{ color: saveState === 'error' ? '#DC2626' : saveState === 'saved' ? '#059669' : 'var(--st-faint)' }}>
          {saveState === 'saved' ? 'Saved.' : saveState === 'error' ? errorMsg : ''}
        </span>
      </div>
    </section>
  );
}