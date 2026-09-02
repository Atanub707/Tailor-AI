# Tailor Enhanced Mode (Option C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Enhanced" tailoring mode with a deterministic 30% yellow-zone invention budget (metrics/scope/tools/leadership derived from real evidence), keeping the red zone (employers, titles, dates, degrees, certs, projects, orgs) hard-forbidden and Strict mode as the current behavior.

**Architecture:** `tailorService.tailorJobWithV2` gains a `mode: 'strict' | 'enhanced'` param plumbed into `runTailorV2`. The drafter prompt gains an enhancement schema with self-declared `__enhanced: {type, basis}` annotations; the verifier gets 3-zone rules (green free / yellow tracked within a 30% budget / red hard-ban); a new `enhancementLedger.ts` records every invented element; the UI shows "Enhanced" chips + budget in the audit panel; a per-job Strict/Enhanced toggle persists on the job.

**Tech Stack:** TypeScript, Node 22, Express, better-sqlite3, React 18, vitest (mocked LLM via stubbed fetch), Vite.

## Global Constraints

- Zero paid LLM calls in tests — always stub `globalThis.fetch`.
- Mode `'strict'` must produce byte-identical behavior to current output (regression: existing 899 tests keep passing unchanged).
- RED zone tokens fail closed with `TailorVerificationFailedError` (422 contract preserved).
- Budget = 30% of total claim elements; violation → one bounded retry → fail closed.
- Enhancement annotations must be self-declared by the drafter AND deterministically re-checked by the verifier (never trust the LLM's declaration alone).
- No marketing/site changes (product-owner decision).
- Existing conventions: static imports in server modules (no `require`), `askJson`-style model-agnostic JSON, per-user AsyncLocalStorage.

---

### Task 1: EnhancementLedger type + zone classification module

**Files:**
- Create: `server/tailorV2/enhancementLedger.ts`
- Test: `tests/storage/enhancementLedger.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; imports `MasterCv` type only)
- Produces:
  - `export type EnhancementType = 'metric' | 'scope' | 'tool' | 'leadership'`
  - `export interface EnhancementEntry { bulletIndex: number; type: EnhancementType; claim: string; basis: string }`
  - `export interface EnhancementLedger { entries: EnhancementEntry[] }`
  - `export function parseEnhancementAnnotations(draft: TailorDraft): EnhancementEntry[]` — extracts `__enhanced` annotations from draft highlights (JSON suffix on the bullet string)
  - `export function countClaimElements(draft: TailorDraft): number` — summary (1) + every highlight (1 each) + every skill line (1 each)
  - `export function budgetExceeded(ledger: EnhancementLedger, totalElements: number, budgetRatio?: number): boolean` — default budgetRatio 0.3
  - `export function normalizeRedZoneTokens(cv: MasterCv): Set<string>` — normalized employers + titles + degree/institution strings + cert names + project names (from ledger semantics: `buildCandidateFactLedger` sources)

**Test data**: reuse the fixture shape from `tests/storage/tailorUserFacing.test.ts` (cv with Human Managed / Nexus, CKA cert, K8s Cluster Autoscaler project).

- [ ] **Step 1: Write the failing test**

```ts
// tests/storage/enhancementLedger.test.ts
import { describe, it, expect } from 'vitest';
import { parseEnhancementAnnotations, countClaimElements, budgetExceeded, normalizeRedZoneTokens } from '../../server/tailorV2/enhancementLedger.js';
import type { TailorDraft } from '../../server/tailorV2/drafter.js';
import type { MasterCv } from '../../src/types.js';

const draft: TailorDraft = {
  summary: 'DevOps engineer.',
  skills: ['Kubernetes', 'AWS'],
  experience: [
    { title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present',
      highlights: [
        'Reduced deployment time by 70% {"__enhanced":{"type":"metric","basis":"70% deploy cut in source"}}',
        'Managed production clusters',
      ] },
  ],
  education: [], certifications: [],
};

describe('enhancement ledger', () => {
  it('parses self-declared annotations from highlight JSON suffixes', () => {
    const entries = parseEnhancementAnnotations(draft);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('metric');
    expect(entries[0].bulletIndex).toBe(0);
    expect(entries[0].basis).toContain('70%');
  });

  it('counts claim elements as summary + highlights + skills', () => {
    expect(countClaimElements(draft)).toBe(1 + 2 + 2);
  });

  it('budget exceeded at >30%', () => {
    const ledger = { entries: [ { bulletIndex: 0, type: 'metric' as const, claim: 'x', basis: 'y' } ] };
    // 1 enhancement / 5 elements = 20% → OK
    expect(budgetExceeded(ledger, 5)).toBe(false);
    // 2 / 5 = 40% → exceeded
    expect(budgetExceeded({ entries: [ledger.entries[0], ledger.entries[0]] }, 5)).toBe(true);
  });

  it('red zone tokens cover employers, titles, degrees, certs, projects', () => {
    const cv = { experiences: [{ company: 'Human Managed', title: 'Senior DevSecOps Engineer' }],
      education: [{ degree: 'B.Tech', institution: 'IIT' }],
      certifications: [{ name: 'CKA' }],
      projects: [{ name: 'K8s Cluster Autoscaler' }] } as unknown as MasterCv;
    const s = normalizeRedZoneTokens(cv);
    expect(s.has('human managed')).toBe(true);
    expect(s.has('b.tech')).toBe(true);
    expect(s.has('cka')).toBe(true);
    expect(s.has('k8s cluster autoscaler')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage/enhancementLedger.test.ts`
Expected: FAIL — module not found (`Cannot find module`).

- [ ] **Step 3: Write the implementation**

```ts
// server/tailorV2/enhancementLedger.ts
import type { MasterCv } from '../../src/types.js';
import type { TailorDraft } from './drafter.js';

export type EnhancementType = 'metric' | 'scope' | 'tool' | 'leadership';

export interface EnhancementEntry {
  bulletIndex: number;
  type: EnhancementType;
  claim: string;
  basis: string;
}

export interface EnhancementLedger {
  entries: EnhancementEntry[];
}

const ANNOTATION_RE = /\{"__enhanced":\s*\{[^}]+\}\}\s*$/;

export function parseEnhancementAnnotations(draft: TailorDraft): EnhancementEntry[] {
  const entries: EnhancementEntry[] = [];
  (draft.experience || []).forEach((w, bulletIndex) => {
    (w.highlights || []).forEach((h) => {
      const m = String(h || '').match(ANNOTATION_RE);
      if (!m) return;
      try {
        const ann = JSON.parse(m[0]);
        if (ann.__enhanced && typeof ann.__enhanced.type === 'string') {
          entries.push({
            bulletIndex,
            type: ann.__enhanced.type as EnhancementType,
            claim: String(h).replace(ANNOTATION_RE, '').trim(),
            basis: String(ann.__enhanced.basis || ''),
          });
        }
      } catch { /* ignore malformed annotation */ }
    });
  });
  return entries;
}

export function countClaimElements(draft: TailorDraft): number {
  const highlights = (draft.experience || []).reduce((n, w) => n + (w.highlights || []).length, 0);
  return 1 + highlights + (draft.skills || []).length;
}

export function budgetExceeded(ledger: EnhancementLedger, totalElements: number, budgetRatio = 0.3): boolean {
  if (totalElements <= 0) return false;
  return ledger.entries.length / totalElements > budgetRatio;
}

export function normalizeRedZoneTokens(cv: MasterCv): Set<string> {
  const out = new Set<string>();
  const add = (s?: string | null) => { const t = String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); if (t) out.add(t); };
  for (const e of cv.experiences || []) { add(e.company); add(e.title); }
  for (const e of cv.education || []) { add(e.degree); add(e.institution); }
  for (const c of cv.certifications || []) add(typeof c === 'string' ? c : c.name);
  for (const p of cv.projects || []) add(p.name);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/storage/enhancementLedger.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/tailorV2/enhancementLedger.ts tests/storage/enhancementLedger.test.ts
git commit -m "feat(tailor): enhancement ledger — annotations, budget, red-zone tokens"
```

---

### Task 2: Verifier 3-zone rules + budget check

**Files:**
- Modify: `server/tailorV2/verifier.ts`
- Modify: `server/tailorV2/tailorV2Engine.ts` (signature only in this task: pass mode + ledger into verify)
- Test: `tests/storage/tailorV2.test.ts` (append cases)

**Interfaces:**
- Consumes: Task 1 (`parseEnhancementAnnotations`, `budgetExceeded`, `normalizeRedZoneTokens`, `countClaimElements`, `EnhancementLedger`), existing `buildCandidateFactLedger`/`skillCovered`
- Produces:
  - `export interface TailorVerification { passed: boolean; issues: VerificationIssue[]; supportedJdTermsBefore: number; supportedJdTermsAfter: number; unsupportedInserted: number; enhancementLedger?: EnhancementLedger }`
  - `verifyDraft(draft, cv, profile, jdTerms, opts?: { mode?: 'strict' | 'enhanced'; enhancementLedger?: EnhancementLedger })`
  - New issue types: `'red_zone' | 'budget_exceeded' | 'invalid_enhancement'` on `VerificationIssue['type']`

**Rules (deterministic):**
- `mode === 'strict'` (default): current behavior — any yellow-zone content is a normal `skill`/`metric`/`claim_strength` violation exactly as today. No ledger logic.
- `mode === 'enhanced'`:
  - Parse annotations from the draft (Task 1). For each annotation:
    - `metric`: the claim's number(s) via existing `extractDraftNumbers(claim)`; FAIL `invalid_enhancement` if no extracted number appears in `sourceText` numbers (reuse `metricSupported`).
    - `tool`: FAIL if the tool name is not covered by `supportedSkill(tool)` OR within 1-hop adjacency — implement `TOOL_ADJACENCY: Record<string, string[]>` map (e.g. `flask: ['fastapi']`, `express: ['fastify','koa']`, `jenkins: ['github actions','gitlab ci']`, `docker: ['podman','containerd']`, `mysql: ['postgresql']`, `gke: ['kubernetes','eks']`, `eks: ['kubernetes','gke']`, `terraform: ['pulumi','cloudformation']`, `react: ['next.js','vue']`, `python: ['fastapi','django','flask']`) — supported if the tool OR any adjacency token is ledger-supported.
    - `scope`/`leadership`: FAIL if neither the claim contains a strength verb from `STRENGTH_VERBS` present in `sourceText` nor the claim shares a content token with the employer-local context (reuse the bullet-provenance token logic from the existing `achievement` check).
  - After per-annotation checks: `budgetExceeded(ledger, countClaimElements(draft))` → issue `budget_exceeded`.
  - Red-zone scan over the WHOLE draft text (existing `draftText` JSON): for each `normalizeRedZoneTokens(cv)` token, if it appears as a whole word in the draft but is NOT in the candidate's own source text (i.e., introduced), → issue `red_zone`. (Employers/titles already checked per-experience; this is the sweep for invented orgs/degrees/certs/projects anywhere.)
- Existing employer/title/dates/education/cert/skill/metric checks continue to run in BOTH modes (red zone is double-covered).

- [ ] **Step 1: Write the failing tests (append to `tests/storage/tailorV2.test.ts`)**

```ts
it('ENHANCED: yellow metric derived from a real number passes and is tracked', async () => {
  const draft = { professionalSummary: 'x', coreCompetencies: [], workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present', highlights: ['Reduced deployment time by 70% across 40+ services {"__enhanced":{"type":"metric","basis":"70%"}}'] }], education: [], technicalSkills: [], certifications: [] };
  const v = await verifyDraft(draft as any, cv, profile(), ['kubernetes'], { mode: 'enhanced', enhancementLedger: { entries: [{ bulletIndex: 0, type: 'metric', claim: 'Reduced deployment time by 70% across 40+ services', basis: '70%' }] } });
  expect(v.passed).toBe(true);
  expect(v.enhancementLedger?.entries).toHaveLength(1);
});

it('ENHANCED: yellow metric WITHOUT a real base number fails', async () => {
  const draft = { professionalSummary: 'x', coreCompetencies: [], workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present', highlights: ['Reduced deployment time by 95% {"__enhanced":{"type":"metric","basis":"invented"}}'] }], education: [], technicalSkills: [], certifications: [] };
  const v = await verifyDraft(draft as any, cv, profile(), ['kubernetes'], { mode: 'enhanced', enhancementLedger: { entries: [{ bulletIndex: 0, type: 'metric', claim: 'Reduced deployment time by 95%', basis: 'invented' }] } });
  expect(v.passed).toBe(false);
  expect(v.issues.some((i) => i.type === 'invalid_enhancement')).toBe(true);
});

it('ENHANCED: invented red-zone organization fails', async () => {
  const draft = { professionalSummary: 'Built the payment platform at Stripe', coreCompetencies: [], workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present', highlights: ['x'] }], education: [], technicalSkills: [], certifications: [] };
  const v = await verifyDraft(draft as any, cv, profile(), ['kubernetes'], { mode: 'enhanced', enhancementLedger: { entries: [] } });
  expect(v.passed).toBe(false);
  expect(v.issues.some((i) => i.type === 'red_zone')).toBe(true);
});

it('ENHANCED: budget >30% fails', async () => {
  const draft = { professionalSummary: 'x', coreCompetencies: ['A', 'B', 'C', 'D'], workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present', highlights: ['Reduced deployment time by 70% one {"__enhanced":{"type":"metric","basis":"70%"}}', 'Reduced deployment time by 70% two {"__enhanced":{"type":"metric","basis":"70%"}}', 'Reduced deployment time by 70% three {"__enhanced":{"type":"metric","basis":"70%"}}'] }], education: [], technicalSkills: [], certifications: [] };
  const v = await verifyDraft(draft as any, cv, profile(), ['kubernetes'], { mode: 'enhanced', enhancementLedger: { entries: [{ bulletIndex: 0, type: 'metric', claim: '1', basis: '70%' }, { bulletIndex: 0, type: 'metric', claim: '2', basis: '70%' }, { bulletIndex: 0, type: 'metric', claim: '3', basis: '70%' }] } });
  // elements = 1 summary + 3 highlights + 4 skills = 8; 3/8 = 37.5% > 30%
  expect(v.passed).toBe(false);
  expect(v.issues.some((i) => i.type === 'budget_exceeded')).toBe(true);
});

it('ENHANCED: tool adjacency — Flask supported only if Flask/Python in source', async () => {
  const withFlaskCv: MasterCv = { ...cv, experiences: [{ id: '1', title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present', responsibilities: ['Built Python services with Flask'] }] };
  const draft = { professionalSummary: 'x', coreCompetencies: [], workExperience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', dates: 'Jan 2021 – Present', highlights: ['Built Python services with FastAPI {"__enhanced":{"type":"tool","basis":"Flask"}}'] }], education: [], technicalSkills: [], certifications: [] };
  const v = await verifyDraft(draft as any, withFlaskCv, profile(), ['kubernetes'], { mode: 'enhanced', enhancementLedger: { entries: [{ bulletIndex: 0, type: 'tool', claim: 'Built Python services with FastAPI', basis: 'Flask' }] } });
  expect(v.passed).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/storage/tailorV2.test.ts -t "ENHANCED"`
Expected: FAIL — `verifyDraft` has no `opts` param / unknown issue types.

- [ ] **Step 3: Implement verifier changes**

In `server/tailorV2/verifier.ts`:
- Extend the issue type union: `'red_zone' | 'budget_exceeded' | 'invalid_enhancement'`.
- Extend `TailorVerification` with `enhancementLedger?: EnhancementLedger`.
- Import from `./enhancementLedger.js`: `parseEnhancementAnnotations`, `countClaimElements`, `budgetExceeded`, `normalizeRedZoneTokens`, `EnhancementLedger`.
- Add `const TOOL_ADJACENCY: Record<string, string[]>` (the map from the Interfaces block).
- Change signature to `verifyDraft(draft, cv, profile, jdTerms, opts: { mode?: 'strict' | 'enhanced'; enhancementLedger?: EnhancementLedger } = {})`.
- Before the existing checks, when `opts.mode === 'enhanced'`:
  ```ts
  const ledger = opts.enhancementLedger ?? { entries: parseEnhancementAnnotations(draft as any) };
  const redTokens = normalizeRedZoneTokens(cv);
  const sourceLower = JSON.stringify({ cv, profile }).toLowerCase();
  const draftTextAll = JSON.stringify(draft).toLowerCase();
  for (const t of redTokens) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc}\\b`).test(draftTextAll) && !new RegExp(`\\b${esc}\\b`).test(sourceLower)) {
      issues.push({ type: 'red_zone', claim: t.slice(0, 100), severity: 'error' });
    }
  }
  for (const e of ledger.entries) {
    if (e.type === 'metric') {
      // The BASE number must be real; additional (scaled/scope) numbers are
      // the invention itself and are allowed. Fail only when NO number in
      // the claim is supported by the source.
      const nums = extractDraftNumbers(e.claim);
      if (!nums.length || !nums.some((n) => metricSupported(n))) {
        issues.push({ type: 'invalid_enhancement', claim: `metric: ${e.claim}`.slice(0, 100), severity: 'error' });
      }
    } else if (e.type === 'tool') {
      const tool = e.claim.split(/\s+/).pop() || '';
      const adj = TOOL_ADJACENCY[tool.toLowerCase()] || [];
      const ok = supportedSkill(tool) || adj.some((a) => supportedSkill(a));
      if (!ok) issues.push({ type: 'invalid_enhancement', claim: `tool: ${tool}`.slice(0, 100), severity: 'error' });
    } else {
      const inStrength = STRENGTH_VERBS.some((v) => e.claim.toLowerCase().includes(v) && sourceLower.includes(v));
      const tokens = contentTokens(e.claim);
      const ctxTokens = sourceTokens;
      let overlap = 0; for (const t of tokens) if (ctxTokens.has(t)) overlap++;
      if (!inStrength && overlap === 0) {
        issues.push({ type: 'invalid_enhancement', claim: `${e.type}: ${e.claim}`.slice(0, 100), severity: 'error' });
      }
    }
  }
  if (budgetExceeded(ledger, countClaimElements(draft as any))) {
    issues.push({ type: 'budget_exceeded', claim: `budget > 30% (${ledger.entries.length}/${countClaimElements(draft as any)})`, severity: 'error' });
  }
  ```
  (Keep all existing checks; when mode is strict the new block is skipped entirely.)
- At the end, set `verification.enhancementLedger = ledger` when mode is enhanced.

- [ ] **Step 4: Run the ENHANCED tests**

Run: `npx vitest run tests/storage/tailorV2.test.ts -t "ENHANCED"`
Expected: 5 passed.

- [ ] **Step 5: Run the full suite (strict regression)**

Run: `npx vitest run`
Expected: 904 passed (899 + 5).

- [ ] **Step 6: Commit**

```bash
git add server/tailorV2/verifier.ts server/tailorV2/tailorV2Engine.ts tests/storage/tailorV2.test.ts
git commit -m "feat(tailor): verifier 3-zone rules + enhancement budget (enhanced mode)"
```

---

### Task 3: Drafter enhancement schema

**Files:**
- Modify: `server/tailorV2/drafter.ts`
- Test: `tests/storage/tailorV2.test.ts` (append 1 test via engine call in Task 4; here only prompt-content assertion)

**Interfaces:**
- Consumes: existing `buildTailorPrompt`/`askForDraft`
- Produces: `askForDraft(cv, profile, job, jd, fit, violations?, mode?: 'strict' | 'enhanced')` — mode appends the enhancement schema section to the prompt

- [ ] **Step 1: Write the failing test**

```ts
it('ENHANCED prompt includes the enhancement schema', async () => {
  const { buildTailorPrompt } = await import('../../server/tailorV2/drafter.js');
  const strict = buildTailorPrompt(cv, profile(), job(), JD, fitFor());
  expect(strict).not.toContain('ENHANCEMENT SCHEMA');
  // enhanced variant built via a mode-aware exporter (added in Step 3)
  const { buildTailorPromptEnhanced } = await import('../../server/tailorV2/drafter.js');
  const enhanced = buildTailorPromptEnhanced(cv, profile(), job(), JD, fitFor());
  expect(enhanced).toContain('ENHANCEMENT SCHEMA');
  expect(enhanced).toContain('__enhanced');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage/tailorV2.test.ts -t "ENHANCED prompt"`
Expected: FAIL — `buildTailorPromptEnhanced` not exported.

- [ ] **Step 3: Implement**

In `server/tailorV2/drafter.ts`:
- Extract the current prompt assembly into `buildTailorPrompt(cv, profile, job, jd, fit)` (unchanged).
- Add:
  ```ts
  const ENHANCEMENT_SCHEMA = `
  ENHANCEMENT SCHEMA (Enhanced mode only — OPTIONAL, budget-capped at 30% of all lines):
  You may STRENGTHEN a limited number of lines with plausible, experience-grounded embellishments. NEVER touch employers, job titles, dates, degrees, certifications, project names or organizations — those are FORBIDDEN.
  Allowed (each used line must derive from the candidate's REAL evidence):
  - metric: scale a REAL number from the candidate sources (e.g. real "70%" may become "70% across 40+ services"). NEVER invent a base number that has no source.
  - tool: a tool within ONE step of the candidate's real stack (e.g. real Flask allows FastAPI; real GKE/EKS allows Kubernetes claims).
  - scope / leadership: only when the candidate's source shows a weak signal (coordinated/managed people, team words).
  Mark EVERY embellished bullet by appending a JSON annotation to the bullet string:
  {"__enhanced":{"type":"metric|tool|scope|leadership","basis":"<the real source fact it derives from>"}}
  Do not annotate plain rewrites.`;
  export function buildTailorPromptEnhanced(cv: MasterCv, profile: ApplicantProfile, job: Job, jd: string, fit: FitResult): string {
    return buildTailorPrompt(cv, profile, job, jd, fit) + ENHANCEMENT_SCHEMA;
  }
  ```
- Change `askForDraft(cv, profile, job, jd, fit, violations?, mode = 'strict')` to use `mode === 'enhanced' ? buildTailorPromptEnhanced(...) : buildTailorPrompt(...)`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/storage/tailorV2.test.ts -t "ENHANCED prompt"`
Expected: 1 passed.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: 905 passed.

- [ ] **Step 6: Commit**

```bash
git add server/tailorV2/drafter.ts tests/storage/tailorV2.test.ts
git commit -m "feat(tailor): drafter enhancement schema for enhanced mode"
```

---

### Task 4: Engine mode plumbing + budget retry

**Files:**
- Modify: `server/tailorV2/tailorV2Engine.ts`
- Modify: `server/tailorV2/tailorService.ts`
- Test: `tests/storage/tailorUserFacing.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 (`verifyDraft` opts), Task 3 (`askForDraft` mode), Task 1 (`parseEnhancementAnnotations`, `countClaimElements`, `budgetExceeded`)
- Produces:
  - `runTailorV2(userId, cv, profile, job, jd, fit, keys, llmDraft = defaultLlmDraft, opts: { mode?: 'strict' | 'enhanced' } = {})`
  - `TailorV2Result` gains `enhancementLedger?: EnhancementLedger`
  - `tailorJobWithV2(job, opts: { userId?: string; mode?: 'strict' | 'enhanced' })`

- [ ] **Step 1: Write the failing test (append to `tests/storage/tailorUserFacing.test.ts`)**

```ts
it('enhanced mode end-to-end: annotated metric passes; strict mode identical to today', async () => {
  const enhancedDraft = (): TailorDraft => ({
    summary: 'DevOps engineer with 7+ years experience.',
    skills: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'GitLab CI'],
    experience: [{ title: 'Senior DevSecOps Engineer', company: 'Human Managed', location: 'Bengaluru', dates: 'Jan 2021 – Present',
      highlights: ['Cut deployment time by 70% across 40+ services {"__enhanced":{"type":"metric","basis":"70% deploy cut"}}', 'Managed GKE and EKS production clusters', 'Built CI/CD pipelines with GitLab'] }],
    education: [{ degree: 'B.Tech', institution: 'IIT', dates: '2012 – 2016' }],
    certifications: ['CKA'],
    projects: [{ name: 'K8s Cluster Autoscaler', description: 'Autoscaling for GKE' }],
  });
  stubLlm(enhancedDraft);
  const r = await runWithUser(USER, () => tailorJobWithV2(getJobById('j1')!, { userId: USER, mode: 'enhanced' }));
  expect(r.verification.passed).toBe(true);
  expect(r.enhancementLedger?.entries).toHaveLength(1);
  // strict mode: the same annotated draft is treated as a normal metric violation
  stubLlm(enhancedDraft);
  const s = await runWithUser(USER, () => tailorJobWithV2(getJobById('j1')!, { userId: USER, mode: 'strict' }))
    .then(() => 'ok').catch((e: any) => e?.name);
  expect(s).toBe('TailorVerificationFailedError');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/storage/tailorUserFacing.test.ts -t "enhanced mode end-to-end"`
Expected: FAIL — `mode` param unknown.

- [ ] **Step 3: Implement engine changes**

In `server/tailorV2/tailorV2Engine.ts`:
- Signature: add `opts: { mode?: 'strict' | 'enhanced' } = {}` as the 9th param; pass `opts.mode` to `askForDraft` (via `defaultLlmDraft`) and to `verifyDraft(..., { mode: opts.mode, enhancementLedger: { entries: parseEnhancementAnnotations(draft) } })`.
- In the retry loop, when mode is enhanced and verification failed with ONLY `budget_exceeded`/`invalid_enhancement` issues, the existing retry already feeds `violations` back — no change needed beyond mode propagation.
- In the post-loop repair path: for enhanced mode, do NOT run `deterministicRepair` on yellow-zone elements (only on green-zone violations as today); red_zone/budget issues still fail closed (they throw).
- Add to `TailorV2Result`: `enhancementLedger?: EnhancementLedger` = `verification.enhancementLedger`.

In `server/tailorV2/tailorService.ts`:
- `tailorJobWithV2(job, opts: { userId?: string; mode?: 'strict' | 'enhanced' } = {})` → pass `opts.mode` into `runTailorV2`'s `opts`; include `enhancementLedger: result.enhancementLedger` in the returned `TailorJobResult`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/storage/tailorUserFacing.test.ts -t "enhanced mode end-to-end"`
Expected: 1 passed.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: TSC clean; 906 passed.

- [ ] **Step 6: Commit**

```bash
git add server/tailorV2/tailorV2Engine.ts server/tailorV2/tailorService.ts tests/storage/tailorUserFacing.test.ts
git commit -m "feat(tailor): engine+service mode plumbing with budget retry"
```

---

### Task 5: API route accepts mode; job persists it

**Files:**
- Modify: `server.ts` (single tailor route, batch-tailor, analyze-jd/tailor)
- Test: `tests/storage/jobWorkflowConsolidation.test.ts` (append route-content assertion) OR content assertion in `tests/storage/tailorUserFacing.test.ts`

**Interfaces:**
- Consumes: Task 4 `tailorJobWithV2(job, { userId, mode })`
- Produces: `POST /api/jobs/:id/tailor` reads `req.body.mode` (fallback `'enhanced'`), stores `job.tailorMode = mode`; batch + manual JD also read `req.body.mode`.

- [ ] **Step 1: Write the failing test**

```ts
it('tailor routes read the mode from the request body and persist it', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
  expect(src).toContain("const mode = req.body?.mode === 'strict' ? 'strict' : 'enhanced'");
  expect(src).toContain("tailorJobWithV2(jobToTailor, { mode })");
  expect(src).toContain("tailorMode: mode");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/storage/tailorUserFacing.test.ts -t "tailor routes read the mode"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the single-tailor route (`POST /api/jobs/:id/tailor`, server.ts ~3456):
- `const mode = req.body?.mode === 'strict' ? 'strict' : 'enhanced';`
- call `tailorJobWithV2(jobToTailor, { mode })`
- persist `tailorMode: mode` in the `updateJobInStorage({ ...jobToTailor, tailoredCv, state: 'tailored', tailoredAt, tailorMode: mode })`
- Same `mode` read + pass in `batch-tailor` (~3513) and `analyze-jd/tailor` (~3665).

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run tests/storage/tailorUserFacing.test.ts -t "tailor routes read the mode" && npx tsc --noEmit`
Expected: PASS; TSC clean.

- [ ] **Step 5: Commit**

```bash
git add server.ts tests/storage/tailorUserFacing.test.ts
git commit -m "feat(tailor): routes accept and persist strict/enhanced mode"
```

---

### Task 6: UI — mode toggle, Enhanced chips, budget panel

**Files:**
- Modify: `src/components/JobDetailModal.tsx`
- Modify: `src/components/JobMatrix.tsx` (pass mode on Tailor click)
- Modify: `src/App.tsx` (handleTailorJob sends mode)
- Test: content assertions in `tests/storage/jobWorkflowConsolidation.test.ts` (this repo's convention: assert UI strings)

**Interfaces:**
- Consumes: API `POST /api/jobs/:id/tailor` with `{ mode }`; `tailoredCv.audit.enhancementLedger` (from Task 4 result via `enrichTailoredCv`? — attach ledger to audit in Task 7; this task reads `tailoredCv.audit?.enhancementLedger?.entries`)
- Produces: UI state `mode: 'strict' | 'enhanced'` persisted per job (job.tailorMode), toggle in modal header

- [ ] **Step 1: Write the failing test**

```ts
it('UI exposes Strict/Enhanced toggle and Enhanced chips', () => {
  const modal = fs.readFileSync(path.join(process.cwd(), 'src/components/JobDetailModal.tsx'), 'utf8');
  expect(modal).toContain('Strict');
  expect(modal).toContain('Enhanced');
  expect(modal).toContain('enhancementLedger');
  const app = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
  expect(app).toContain('mode:');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/storage/jobWorkflowConsolidation.test.ts -t "UI exposes Strict/Enhanced"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `src/App.tsx handleTailorJob`: `body: JSON.stringify({ mode: selectedMode })` where `selectedMode` comes from the modal's toggle via a new `onTailorModeChange` callback (simplest: read `job.tailorMode ?? 'enhanced'` from the selected job; the toggle writes it back through the same route payload on next tailor).
- `src/components/JobDetailModal.tsx`:
  - Header area of the Tailored tab: two small toggle buttons `Strict | Enhanced` bound to `tailored` job's `tailorMode` (fallback 'enhanced'); clicking sets local state + a banner note "Mode applies on next Tailor/Re-Tailor".
  - Bullet render: for each highlight, if `audit.enhancementLedger.entries` has an entry with `bulletIndex` matching, append a `<span className="enhanced-chip">Enhanced</span>` after the bullet (styled amber, 9px, bold).
  - Audit panel: add "Enhancement budget: X used / N total (Y%)" + list of `claim — basis` lines when ledger present.

- [ ] **Step 4: Run test + build**

Run: `npx vitest run tests/storage/jobWorkflowConsolidation.test.ts -t "UI exposes Strict/Enhanced" && npx vite build`
Expected: PASS; build OK.

- [ ] **Step 5: Commit**

```bash
git add src/components/JobDetailModal.tsx src/components/JobMatrix.tsx src/App.tsx tests/storage/jobWorkflowConsolidation.test.ts
git commit -m "feat(ui): Strict/Enhanced toggle, Enhanced chips, budget panel"
```

---

### Task 7: Audit integration (enrichTailoredCv carries the ledger)

**Files:**
- Modify: `server/tailorV2/tailorService.ts`
- Test: extend `tests/storage/tailorUserFacing.test.ts` (existing verbatim test asserts new field)

**Interfaces:**
- Consumes: Task 4 `TailorJobResult.enhancementLedger`
- Produces: `tailoredCv.audit.enhancementLedger` — attached in `enrichTailoredCv` so the UI reads it from the job object (Task 6 depends on this)

- [ ] **Step 1: Write the failing test (extend the end-to-end test from Task 4)**

```ts
expect(r.tailoredCv.audit?.enhancementLedger?.entries).toHaveLength(1);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/storage/tailorUserFacing.test.ts -t "enhanced mode end-to-end"`
Expected: FAIL on the new assertion (audit lacks `enhancementLedger`).

- [ ] **Step 3: Implement**

In `server/tailorV2/tailorService.ts` `enrichTailoredCv`:
```ts
if (audit) audit.enhancementLedger = (tailoredCv as any).__enhancementLedger || undefined;
```
and in `tailorJobWithV2`, before `enrichTailoredCv`, stash the ledger:
```ts
(tailoredCv as any).__enhancementLedger = result.enhancementLedger;
```
(Also attach it to `buildTailorAudit` output type: extend `TailoringAudit` in `src/types.ts` with optional `enhancementLedger?: EnhancementLedger` — import the type from `server/tailorV2/enhancementLedger.js` via `import type`.)

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run tests/storage/tailorUserFacing.test.ts -t "enhanced mode end-to-end" && npx tsc --noEmit`
Expected: PASS; TSC clean.

- [ ] **Step 5: Commit**

```bash
git add server/tailorV2/tailorService.ts src/types.ts tests/storage/tailorUserFacing.test.ts
git commit -m "feat(tailor): enhancement ledger attached to audit for UI"
```

---

### Task 8: Final gate + release notes

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full gate**

Run: `npx tsc --noEmit && npm audit --audit-level=high && npx vite build && npx vitest run`
Expected: TSC clean · 0 high/critical · build OK · 906+ passed.

- [ ] **Step 2: Docker sanity**

Run: `docker compose build && docker compose up -d && sleep 10 && curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/`
Expected: image built, container up, `200`.

- [ ] **Step 3: Update CHANGELOG.md** (append under the next release heading):

```markdown
## v2.8.0 (2026-09-01)

### ⚡ Enhanced Tailoring (new)

- New Enhanced mode with a bounded 30% embellishment budget: metrics derived
  from real numbers, one-hop-adjacent tools, and leadership/scope language
  from real signals — each flagged as "Enhanced" in the preview and listed in
  the audit panel with its source basis.
- Strict mode (previous behavior) remains available per job.
- Employers, titles, dates, education, certifications and projects are NEVER
  changed in either mode.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore(release): v2.8.0 notes — enhanced tailoring"
```