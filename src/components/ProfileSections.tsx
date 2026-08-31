import React from 'react';
import type { ApplicantProfile } from '../types';

// Shared Applicant Profile sections — used by the Settings → Profile tab AND
// the (legacy) full-screen editor. ONE markup, ONE backend model.
const labelCls = 'block text-[11px] font-bold uppercase tracking-widest text-[var(--color-faint)] mb-1';
const inputCls = 'w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-ink)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]/30';
const sectionCls = 'rounded-xl border border-[var(--color-border)] bg-white p-5';

function Section({ title, hint, collapsed = false, children }: { title: string; hint?: string; collapsed?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(!collapsed);
  return (
    <div className={`${sectionCls} mb-4`}>
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setOpen(!open)}>
        <h3 className="text-sm font-bold text-[var(--color-ink)]">{title}</h3>
        {hint && <span className="text-xs text-[var(--color-faint)]">{hint}</span>}
      </div>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string | undefined; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input className={inputCls} type={type} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function ProfileSections({ profile, update }: { profile: ApplicantProfile; update: (fn: (p: ApplicantProfile) => ApplicantProfile) => void }) {
  const p = profile;
  return (
    <>
      <Section title="Personal" hint="Contact basics — never auto-inferred.">
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name" value={p.personal.firstName} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, firstName: v } }))} />
          <Field label="Middle name" value={p.personal.middleName} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, middleName: v } }))} />
          <Field label="Last name" value={p.personal.lastName} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, lastName: v } }))} />
          <Field label="Preferred name" value={p.personal.preferredName} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, preferredName: v } }))} />
          <Field label="Email" type="email" value={p.personal.email} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, email: v } }))} />
          <Field label="Phone" value={p.personal.phone} onChange={(v) => update((x) => ({ ...x, personal: { ...x.personal, phone: v } }))} />
        </div>
        <div className="grid grid-cols-2 gap-4 mt-4">
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
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <label className={labelCls}>Willing to relocate</label>
            <select className={inputCls} value={p.locationPrefs.willingToRelocate ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, willingToRelocate: e.target.value as any } }))}>
              <option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option><option value="depends">Depends</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Remote preference</label>
            <select className={inputCls} value={p.locationPrefs.remotePreference ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, locationPrefs: { ...x.locationPrefs, remotePreference: e.target.value as any } }))}>
              <option value="unknown">Unknown</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option><option value="flexible">Flexible</option>
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
              <option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Requires sponsorship</label>
            <select className={inputCls} value={p.workAuthorization.requiresSponsorship ?? 'unknown'} onChange={(e) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, requiresSponsorship: e.target.value as any } }))}>
              <option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </div>
          <Field label="Valid until (YYYY-MM-DD)" value={p.workAuthorization.validUntil} onChange={(v) => update((x) => ({ ...x, workAuthorization: { ...x.workAuthorization, validUntil: v } }))} />
        </div>
      </Section>

      <Section title="Work Preferences" hint="Reusable application guardrails.">
        <Field label="Desired titles (comma separated)" value={(p.preferences.desiredTitles || []).join(', ')} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, desiredTitles: v.split(',').map((s) => s.trim()).filter(Boolean) } }))} />
        <div className="grid grid-cols-2 gap-4 mt-4">
          <Field label="Minimum salary" type="number" value={p.preferences.minimumSalary !== undefined ? String(p.preferences.minimumSalary) : ''} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, minimumSalary: v === '' ? undefined : Number(v) } }))} />
          <Field label="Target salary" type="number" value={p.preferences.targetSalary !== undefined ? String(p.preferences.targetSalary) : ''} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, targetSalary: v === '' ? undefined : Number(v) } }))} />
          <Field label="Salary currency" value={p.preferences.salaryCurrency} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, salaryCurrency: v } }))} />
          <Field label="Notice period" value={p.preferences.noticePeriod} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, noticePeriod: v } }))} />
          <Field label="Current salary" type="number" value={p.preferences.currentSalary !== undefined ? String(p.preferences.currentSalary) : ''} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, currentSalary: v === '' ? undefined : Number(v) } }))} />
          <Field label="Earliest start date (YYYY-MM-DD)" value={p.preferences.earliestStartDate} onChange={(v) => update((x) => ({ ...x, preferences: { ...x.preferences, earliestStartDate: v } }))} />
        </div>
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
    </>
  );
}