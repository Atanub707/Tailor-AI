# Enhanced Tailoring Mode — Option C (30% yellow-zone budget) — Design

Date: 2026-09-01
Status: Approved (direction + red-zone rule agreed; implementation summary pending)

## Problem

Strict Tailor V2 rewrites bullets with fresh wording but never adds a fact the
candidate's evidence doesn't support. Match scores therefore cap below what
aggressive (but plausible) phrasing could reach. The product decision: allow a
**bounded 30% of invented/embellished claim elements** ("Enhanced" mode) while
keeping the red zone (identity facts) hard-forbidden.

## Zones

- **GREEN (no budget):** generalize adjacent experience (GKE→Kubernetes),
  rename tools to family (Bitbucket→Git), verb strengthening within real
  evidence, reorder/select/emphasize, rewrite wording. (Current behavior.)
- **YELLOW (budget, ≤30% of claim elements):**
  - `metric` — must derive from a real number in the ledger; scale/scope may
    expand (real 70% → "70% across 40+ services")
  - `scope` — must trace to a weak real signal (coordinated/managed people)
  - `tool` — must be within 1-hop adjacency of the real stack (alias map)
  - `leadership` — leadership/scale language rounded from real signals
- **RED (hard ban, never invented):** employers, job titles, dates, degrees,
  certifications, project names, organizations. Interview/background-check
  fatal; no ATS score justifies it.

## Budget mechanics

- Denominator = total claim elements (summary + bullets + skill lines)
- Drafter self-declares yellow elements (`__enhanced: {type, basis}`)
- Verifier deterministically re-checks every annotation:
  - metric → real base number must exist
  - tool → alias adjacency
  - scope/leadership → weak real signal present
  - red-zone tokens not in ledger → fail
- Budget >30% or red-zone hit → one bounded retry with feedback → fail closed
  (422, master untouched) if still violating.

## Components

- `server/tailorV2/tailorService.ts` — `mode: 'strict' | 'enhanced'` plumbing
- `server/tailorV2/tailorV2Engine.ts` — mode + budget loop (retry on budget/red)
- `server/tailorV2/drafter.ts` — enhancement schema + self-declared annotations
- `server/tailorV2/verifier.ts` — 3-zone rules; yellow tracked not rejected
- `server/tailorV2/enhancementLedger.ts` (NEW) — per-resume record:
  `{ bulletIndex, type, claim, basis, reason }`
- Version store — persists `enhanced: true` + ledger alongside verification

## Data flow

`POST /api/jobs/:id/tailor` (+ batch, manual JD) → `tailorJobWithV2(job, {mode})`
→ fit → ledger → drafter (enhanced rules) → verify (3-zone + budget) →
enhancementLedger → audit → persisted version.

## UI

- JobDetailModal Tailored tab: invented lines show a small "Enhanced" chip
  (color-coded by type)
- Mode toggle in modal: Strict / Enhanced (per-job, default Enhanced)
- Audit panel: "Enhancement budget: 4/14 used (29%)" + invented claims with
  their basis

## Error handling

- Red-zone attempt or budget overflow → retry once with feedback → fail closed
  (same 422 contract, master resume untouched)
- Strict mode = current behavior (regression-safe; existing 899 tests pass)

## Testing (mocked, 0 paid calls)

- green generalization passes (current tests)
- yellow metric with real base number → passes, tracked
- yellow metric with NO base number → fails
- red employer/title/degree/project → fails
- budget 35% → retry/fail; 29% → pass
- strict mode regression = current suite

## Marketing

Per product owner: marketing copy stays unchanged (internal capability).
Optional future one-line swap (stays true, reveals nothing):
"Employers, titles, education, certifications and project history are never
changed."