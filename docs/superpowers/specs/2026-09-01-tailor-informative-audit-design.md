# Informative Tailor Audit — "What changed" (bullet diffs + keyword reasons) — Design

Date: 2026-09-01
Status: Approved (direction + sections confirmed by user)

## Problem

The Tailor (job-card) audit panel is not informative: it shows aggregate
"Missing from Master CV" and "Added & Optimized" lists that look like a
transfer, with no explanation of WHY a term is still missing (unsupported
fact vs. not placed), and no per-bullet view of what actually changed. The
Manual JD screen already computes per-bullet rewrites (`bulletRewrites`); the
standard Tailor modal only receives a count (`rephrasedHighlightsCount`).

## Goal

When a user clicks Tailor → Tailored Resume tab, they see:
1. Every experience bullet as a before→after pair (original → rewritten),
   with JD terms that landed in the new bullet highlighted.
2. For every JD keyword: where it went (a bullet / skills / summary) or why
   it did NOT go in ("not in your experience" — honest, self-explanatory).
3. Enhanced (budget) lines already flagged via the existing amber chips +
   basis.

## Architecture

- NEW pure module `server/tailorV2/bulletDiff.ts` (deterministic, no LLM):
  - `computeBulletDiffs(masterCv, draft): BulletDiff[]`
  - `computeKeywordStatus(jdTerms, draft, ledger?): KeywordStatus[]`
- `buildTailorAudit` (server/tailorV2/tailorService.ts) gains two fields:
  - `bulletDiffs: BulletDiff[]`
  - `keywordStatus: KeywordStatus[]`
- `TailoringAudit` (src/types.ts) gains the two optional fields.
- JobDetailModal Tailored tab renders "What changed" + "Keyword placement".

## Types

```ts
interface BulletDiff {
  expIndex: number;
  title: string;
  company: string;
  original?: string;   // undefined = inserted ("New") bullet
  rewritten: string;
  changed: boolean;
  addedTerms: string[]; // JD terms present in the rewritten bullet
  enhanced: boolean;    // covered by an enhancement ledger entry
}

type KeywordStatusKind = 'added_experience' | 'added_skills' | 'already_present' | 'enhanced' | 'unsupported';
interface KeywordStatus {
  term: string;
  kind: KeywordStatusKind;
  location?: string;   // e.g. 'bullet 2 · Human Managed' or 'Skills'
  basis?: string;      // for 'enhanced'
}
```

## Computation rules (deterministic)

- Alignment: master CV responsibilities ↔ draft highlights positionally per
  experience (same approach as the existing Manual JD `bulletRewrites` at
  server.ts:3699-3708). Extra highlights beyond source count = inserted
  (`original: undefined`).
- `addedTerms`: normalize (lowercase, strip non-alnum) each JD term; a term
  is in the bullet if its normalized form appears in the normalized bullet.
- `changed`: rewritten !== original.
- `enhanced`: true when an `enhancementLedger.entries` entry's
  `expIndex`+`hIndex` matches this bullet.
- `keywordStatus`:
  - `added_experience` — term present in draft experience highlights
  - `added_skills` — term present in draft skills but not in highlights
  - `already_present` — term present in the MASTER CV source text (candidate
    evidence) even if the draft carries it elsewhere (location: 'Already in
    your CV')
  - `enhanced` — term covered by a ledger entry (basis from the entry)
  - `unsupported` — term not present in the draft AND not in the candidate's
    source evidence (the honest replacement for "Missing")
  - Order: check draft-experience → draft-skills → enhanced → already in
    master → unsupported.

## UI (JobDetailModal, Tailored tab)

- New "What changed" card, above the existing audit/score card:
  - Per experience (collapsible, default first experience expanded):
    - Each bullet pair: original in gray (`text-slate-400 line-through`
      applied to the whole original line) → arrow → rewritten in ink with
      `addedTerms` highlighted (green bold underline chips).
    - Inserted bullets: "New" badge, no original.
    - `enhanced` bullets: existing amber "Enhanced" chip + basis tooltip.
  - "Keyword placement" chips row: every JD term as a small color-coded chip
    (green = added experience, blue = skills, gray = already present, amber
    = enhanced, red = not in your experience) with a location label.
- Old stored audits without `bulletDiffs`/`keywordStatus`: render the
  current aggregate view (graceful fallback; next Re-Tailor regenerates).

## Data flow

`tailorJobWithV2` → `buildTailorAudit(job, draft, verification, jdTerms,
masterCv)` now also computes `bulletDiffs` + `keywordStatus` (all inputs
already in scope) → attached to `audit` via the existing `enrichTailoredCv`
→ persisted with the tailored CV → UI reads them.

No new LLM calls. No new fabrication surface (reasons are derived from the
already-verified data + ledger).

## Testing (mocked, 0 paid calls)

- Unit: diff alignment (equal, inserted, moved bullets), `changed` flags,
  `addedTerms` normalization (multi-word terms, punctuation), enhanced flag
  from ledger indices.
- Unit: keywordStatus classification for each kind (added_experience /
  added_skills / already_present / enhanced / unsupported).
- E2E: extended enhanced-mode test asserts `audit.bulletDiffs.length > 0`
  and `keywordStatus` contains an `unsupported` entry for a JD-only term.
- UI: content assertions for "What changed" + "Keyword placement" + chip
  color classes.
- Regression: full suite stays green (921 tests baseline).

## Constraints

- Deterministic computation only — no LLM in the diff/reason path.
- Strict mode unchanged; strict audits gain the same diff fields (they are
  factual views of the same artifacts).
- No marketing/site changes.