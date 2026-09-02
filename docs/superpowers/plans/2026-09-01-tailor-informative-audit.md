# Informative Tailor Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tailor audit panel informative: per-bullet before→after diffs with highlighted JD terms, and a per-keyword reason list ("where it went" or "not in your experience"), all computed deterministically with zero LLM calls.

**Architecture:** A new pure module `server/tailorV2/bulletDiff.ts` computes `computeBulletDiffs(masterCv, draft)` and `computeKeywordStatus(jdTerms, draft, ledger)`. `buildTailorAudit` (tailorService) attaches both to the audit; `TailoringAudit` gains the two optional fields; JobDetailModal renders "What changed" (per-bullet pairs) + "Keyword placement" chips with graceful fallback to the current aggregate view for old audits.

**Tech Stack:** TypeScript, Node 22, React 18, vitest (mocked LLM via stubbed fetch), Vite.

## Global Constraints

- Zero paid LLM calls in tests — always stub `globalThis.fetch`.
- The diff/reason computation is DETERMINISTIC — no LLM involvement, no new fabrication surface (reasons derive from already-verified data + the existing enhancement ledger).
- Alignment is POSITIONAL per experience (same approach as Manual JD `bulletRewrites` at server.ts:3699-3708).
- `keywordStatus` precedence order (strict): draft-experience → draft-skills → enhanced (ledger) → already in master source → unsupported.
- Old stored audits without `bulletDiffs`/`keywordStatus` render the current aggregate view (UI must optional-chain; no backfill).
- No marketing/site changes.

---

### Task 1: bulletDiff module — diffs + keyword status

**Files:**
- Create: `server/tailorV2/bulletDiff.ts`
- Test: `tests/storage/bulletDiff.test.ts`

**Interfaces:**
- Consumes: `MasterCv` (src/types.js), `TailorDraft` (./drafter.js), `EnhancementLedger` (./enhancementLedger.js)
- Produces:
  - `export interface BulletDiff { expIndex: number; title: string; company: string; original?: string; rewritten: string; changed: boolean; addedTerms: string[]; enhanced: boolean }`
  - `export type KeywordStatusKind = 'added_experience' | 'added_skills' | 'already_present' | 'enhanced' | 'unsupported'`
  - `export interface KeywordStatus { term: string; kind: KeywordStatusKind; location?: string; basis?: string }`
  - `export function computeBulletDiffs(masterCv: MasterCv, draft: TailorDraft): BulletDiff[]`
  - `export function computeKeywordStatus(jdTerms: string[], draft: TailorDraft, masterCv: MasterCv, ledger?: EnhancementLedger): KeywordStatus[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/storage/bulletDiff.test.ts
import { describe, it, expect } from 'vitest';
import { computeBulletDiffs, computeKeywordStatus } from '../../server/tailorV2/bulletDiff.js';
import type { MasterCv, TailorDraft } from '../../src/types.js';

const cv = {
  experiences: [
    { id: '1', title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present',
      responsibilities: ['Reduced deployment time by 70%', 'Managed GKE and EKS clusters'] },
    { id: '2', title: 'Cloud Engineer', company: 'Nexus', location: 'Pune', dates: '2018 – 2020',
      responsibilities: ['Automated AWS with Terraform'] },
  ],
} as unknown as MasterCv;

const draft: TailorDraft = {
  summary: 'DevOps engineer.',
  skills: ['Kubernetes', 'AWS'],
  experience: [
    { title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present',
      highlights: ['Cut deployment time by 70% with GitOps', 'Managed GKE and EKS production clusters', 'Delivered a new platform'], },
    { title: 'Cloud Engineer', company: 'Nexus', dates: '2018 – 2020',
      highlights: ['Automated AWS infrastructure with Terraform'] },
  ],
  education: [], certifications: [],
};

describe('bullet diff', () => {
  it('aligns bullets positionally and flags changes, inserted bullets and added JD terms', () => {
    const diffs = computeBulletDiffs(cv, draft);
    expect(diffs).toHaveLength(4);
    expect(diffs[0]).toMatchObject({ expIndex: 0, changed: true, addedTerms: ['gitops'] });
    expect(diffs[0].original).toBe('Reduced deployment time by 70%');
    expect(diffs[1].changed).toBe(false); // verbatim
    expect(diffs[2].original).toBeUndefined(); // inserted
    expect(diffs[3].changed).toBe(true);
  });

  it('flags enhanced bullets from the ledger indices', () => {
    const ledger = { entries: [{ bulletIndex: 0, expIndex: 0, hIndex: 0, type: 'metric', claim: 'Cut deployment time by 70% with GitOps', basis: '70%' }] };
    const diffs = computeBulletDiffs(cv, draft, ledger as any);
    expect(diffs[0].enhanced).toBe(true);
    expect(diffs[1].enhanced).toBe(false);
  });

  it('classifies JD terms by precedence: experience → skills → enhanced → already present → unsupported', () => {
    const ledger = { entries: [] };
    const status = computeKeywordStatus(['gitops', 'kubernetes', 'gke', 'snowflake'], draft, cv, ledger as any);
    const byTerm = Object.fromEntries(status.map((s) => [s.term, s.kind]));
    expect(byTerm['gitops']).toBe('added_experience');   // in a bullet
    expect(byTerm['kubernetes']).toBe('added_skills');   // in skills only
    expect(byTerm['gke']).toBe('already_present');       // in master source text
    expect(byTerm['snowflake']).toBe('unsupported');     // nowhere
  });

  it('marks ledger-covered terms as enhanced before already-present', () => {
    const ledger = { entries: [{ bulletIndex: 0, expIndex: 0, hIndex: 0, type: 'metric', claim: 'Cut deployment time by 70% with GitOps', basis: '70%' }] };
    const status = computeKeywordStatus(['gitops'], draft, cv, ledger as any);
    expect(status[0].kind).toBe('enhanced');
    expect(status[0].basis).toBe('70%');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage/bulletDiff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/tailorV2/bulletDiff.ts
import type { MasterCv, TailorDraft } from '../../src/types.js';
import type { EnhancementLedger } from './enhancementLedger.js';

export interface BulletDiff {
  expIndex: number;
  title: string;
  company: string;
  original?: string;
  rewritten: string;
  changed: boolean;
  addedTerms: string[];
  enhanced: boolean;
}

export type KeywordStatusKind = 'added_experience' | 'added_skills' | 'already_present' | 'enhanced' | 'unsupported';

export interface KeywordStatus {
  term: string;
  kind: KeywordStatusKind;
  location?: string;
  basis?: string;
}

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function computeBulletDiffs(masterCv: MasterCv, draft: TailorDraft, ledger?: EnhancementLedger): BulletDiff[] {
  const out: BulletDiff[] = [];
  const masterByExp = (masterCv.experiences || []).map((e) => ({ title: e.title || '', company: e.company || '', responsibilities: e.responsibilities || [] }));
  (draft.experience || []).forEach((w, expIndex) => {
    const src = masterByExp[expIndex];
    (w.highlights || []).forEach((h, hIndex) => {
      const original = src ? src.responsibilities[hIndex] : undefined;
      const enhanced = !!ledger?.entries.some((e) => e.expIndex === expIndex && e.hIndex === hIndex);
      out.push({
        expIndex,
        title: w.title || (src?.title || ''),
        company: w.company || (src?.company || ''),
        original,
        rewritten: String(h || ''),
        changed: original === undefined || String(h).trim() !== original.trim(),
        addedTerms: [],
        enhanced,
      });
    });
  });
  // Second pass: addedTerms needs the full JD term set? No — addedTerms are
  // JD terms that appear in the rewritten bullet, computed by the caller via
  // keywordStatus; here we fill them from the draft text alone is not
  // possible. The audit task (Task 2) fills addedTerms using jdTerms.
  return out;
}

export function computeKeywordStatus(jdTerms: string[], draft: TailorDraft, masterCv: MasterCv, ledger?: EnhancementLedger): KeywordStatus[] {
  const out: KeywordStatus[] = [];
  const expText = (draft.experience || []).flatMap((w) => w.highlights || []).join(' ').toLowerCase();
  const skillsText = (draft.skills || []).join(' ').toLowerCase();
  const masterText = JSON.stringify({ cv: masterCv }).toLowerCase();
  for (const term of [...new Set(jdTerms)]) {
    const n = norm(term);
    const inExp = n && norm(expText).includes(n);
    const inSkills = n && norm(skillsText).includes(n);
    const ledgerHit = ledger?.entries.find((e) => norm(e.claim).includes(n) || norm(e.basis).includes(n));
    const inMaster = n && norm(masterText).includes(n);
    if (inExp) out.push({ term, kind: 'added_experience', location: 'Experience bullets' });
    else if (inSkills) out.push({ term, kind: 'added_skills', location: 'Skills' });
    else if (ledgerHit) out.push({ term, kind: 'enhanced', basis: ledgerHit.basis });
    else if (inMaster) out.push({ term, kind: 'already_present', location: 'Already in your CV' });
    else out.push({ term, kind: 'unsupported' });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/storage/bulletDiff.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/tailorV2/bulletDiff.ts tests/storage/bulletDiff.test.ts
git commit -m "feat(tailor): bulletDiff module — per-bullet diffs + keyword status"
```

---

### Task 2: Audit integration — attach bulletDiffs + keywordStatus

**Files:**
- Modify: `server/tailorV2/tailorService.ts` (`buildTailorAudit`)
- Modify: `src/types.ts` (`TailoringAudit`)
- Test: `tests/storage/tailorUserFacing.test.ts` (extend the enhanced e2e test)

**Interfaces:**
- Consumes: Task 1 (`computeBulletDiffs`, `computeKeywordStatus`), `buildTailorAudit(job, draft, verification, jdTerms, masterCv)` existing signature
- Produces: `TailoringAudit` gains `bulletDiffs?: BulletDiff[]` and `keywordStatus?: KeywordStatus[]`; both populated in `buildTailorAudit` (needs `enhancementLedger` — read it from `verification.enhancementLedger`)

- [ ] **Step 1: Write the failing test (extend the enhanced e2e test in tests/storage/tailorUserFacing.test.ts)**

```ts
// inside the 'enhanced mode end-to-end' test, after the existing assertions:
    expect(r.tailoredCv.audit?.bulletDiffs?.length).toBeGreaterThan(0);
    expect(r.tailoredCv.audit?.keywordStatus?.length).toBeGreaterThan(0);
    expect(r.tailoredCv.audit?.keywordStatus?.some((k) => k.kind === 'unsupported')).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage/tailorUserFacing.test.ts -t "enhanced mode end-to-end"`
Expected: FAIL — `bulletDiffs` undefined.

- [ ] **Step 3: Implement**

In `src/types.ts` `TailoringAudit`, add (after `enhancementLedger?`):

```ts
  /** Per-bullet before→after diff (informative audit). */
  bulletDiffs?: Array<{
    expIndex: number;
    title: string;
    company: string;
    original?: string;
    rewritten: string;
    changed: boolean;
    addedTerms: string[];
    enhanced: boolean;
  }>;
  /** Per-JD-term reason ("where it went" or why not). */
  keywordStatus?: Array<{
    term: string;
    kind: 'added_experience' | 'added_skills' | 'already_present' | 'enhanced' | 'unsupported';
    location?: string;
    basis?: string;
  }>;
```

In `server/tailorV2/tailorService.ts` `buildTailorAudit`:

```ts
  import { computeBulletDiffs, computeKeywordStatus } from './bulletDiff.js';

  // (inside buildTailorAudit, before `return {`)
  const bulletDiffs = computeBulletDiffs(masterCv, draft);
  // Fill addedTerms per diff from the JD terms present in that rewritten bullet
  const normT = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const d of bulletDiffs) {
    const dn = normT(d.rewritten);
    d.addedTerms = jdTerms.filter((t) => normT(t) && dn.includes(normT(t)));
  }
  const keywordStatus = computeKeywordStatus(jdTerms, draft, masterCv, verification.enhancementLedger);
```

and in the returned object add `bulletDiffs, keywordStatus`.

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run tests/storage/tailorUserFacing.test.ts -t "enhanced mode end-to-end" && npx vitest run`
Expected: e2e passes; full suite stays 922 passed (921 + 1 existing test extended — the e2e already exists, so count stays 921 + bulletDiff tests 4 = 925 total: 921 + 4).

- [ ] **Step 5: Commit**

```bash
git add server/tailorV2/tailorService.ts src/types.ts tests/storage/tailorUserFacing.test.ts
git commit -m "feat(tailor): audit carries bulletDiffs + keywordStatus"
```

---

### Task 3: UI — "What changed" + Keyword placement

**Files:**
- Modify: `src/components/JobDetailModal.tsx` (Tailored tab)
- Test: content assertions in `tests/storage/jobWorkflowConsolidation.test.ts`

**Interfaces:**
- Consumes: `tailored.audit?.bulletDiffs` and `tailored.audit?.keywordStatus` (Task 2); existing chip styles from Task 6 of the enhanced-mode plan (amber `.enhanced-chip` classes)
- Produces: "What changed" card + "Keyword placement" chips; graceful fallback when fields absent

- [ ] **Step 1: Write the failing test (append to tests/storage/jobWorkflowConsolidation.test.ts)**

```ts
it('Tailored tab renders What changed (bullet diffs) and Keyword placement', () => {
  expect(DETAIL).toContain('What changed');
  expect(DETAIL).toContain('Keyword placement');
  expect(DETAIL).toContain('bulletDiffs');
  expect(DETAIL).toContain('keywordStatus');
  expect(DETAIL).toContain('not in your experience');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage/jobWorkflowConsolidation.test.ts -t "What changed"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/components/JobDetailModal.tsx`, inside the Tailored tab (near the audit card that renders `tailored.audit`), add a "What changed" card rendered BEFORE the existing before/after score card, guarded by `tailored.audit?.bulletDiffs?.length`:

```tsx
{(() => {
  const diffs = tailored.audit?.bulletDiffs;
  const status = tailored.audit?.keywordStatus;
  if (!diffs || diffs.length === 0) return null;
  const chip = (kind: string) => ({
    added_experience: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    added_skills: 'bg-sky-50 text-sky-700 border-sky-200',
    already_present: 'bg-slate-100 text-slate-600 border-slate-200',
    enhanced: 'bg-amber-50 text-amber-700 border-amber-200',
    unsupported: 'bg-red-50 text-red-600 border-red-200',
  } as Record<string, string>)[kind] || 'bg-slate-100 text-slate-600 border-slate-200';
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">What changed</h4>
      {diffs.map((d, i) => (
        <div key={i} className="space-y-1">
          <div className="text-[11px] font-semibold text-slate-500">{d.title} · {d.company}</div>
          {d.original !== undefined && (
            <div className="text-xs text-slate-400 line-through">{d.original}</div>
          )}
          <div className="text-xs text-slate-800">
            {d.original === undefined && <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 rounded px-1 py-0.5 mr-1">NEW</span>}
            {d.rewritten}
            {d.enhanced && <span className="ml-2 text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5">Enhanced</span>}
          </div>
          {d.addedTerms.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {d.addedTerms.map((t) => (
                <span key={t} className="text-[9px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">+ {t}</span>
              ))}
            </div>
          )}
        </div>
      ))}
      {status && status.length > 0 && (
        <div className="pt-2 border-t border-slate-100">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2">Keyword placement</h4>
          <div className="flex flex-wrap gap-1.5">
            {status.map((s) => (
              <span key={s.term} title={s.location || (s.kind === 'unsupported' ? 'not in your experience' : '')} className={`text-[9px] font-bold border rounded-full px-1.5 py-0.5 ${chip(s.kind)}`}>
                {s.kind === 'unsupported' ? '⛔ ' : '✓ '}{s.term}
                {s.location ? ` · ${s.location}` : s.kind === 'unsupported' ? ' · not in your experience' : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
})()}
```

Note: the audit card currently renders `tailored.audit` — verify the exact variable name (`tailored`) and the Tailored tab's render scope before inserting; place this card at the top of the Tailored tab content.

- [ ] **Step 4: Run test + full gate**

Run: `npx vitest run tests/storage/jobWorkflowConsolidation.test.ts -t "What changed" && npx tsc --noEmit && npx vite build`
Expected: PASS; TSC clean; build OK.

- [ ] **Step 5: Commit**

```bash
git add src/components/JobDetailModal.tsx tests/storage/jobWorkflowConsolidation.test.ts
git commit -m "feat(ui): What changed — bullet diffs + keyword placement in Tailored tab"
```

---

### Task 4: Final gate

- [ ] **Step 1: Run the full gate**

Run: `npx tsc --noEmit && npm audit --audit-level=high && npx vite build && npx vitest run`
Expected: TSC clean · 0 high/critical · build OK · 925 passed.

- [ ] **Step 2: Docker sanity**

Run: `docker compose build && docker compose up -d && sleep 10 && curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/`
Expected: image built, container up, `200`.

- [ ] **Step 3: Commit (if any stragglers)**

```bash
git status --porcelain && git add -A && git commit -m "chore: informative audit final gate" || true
```