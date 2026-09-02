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

export const ENHANCEMENT_ANNOTATION_RE = /\{"__enhanced":\s*\{[^}]+\}\}\s*$/;

export function parseEnhancementAnnotations(draft: TailorDraft): EnhancementEntry[] {
  const entries: EnhancementEntry[] = [];
  (draft.experience || []).forEach((w, bulletIndex) => {
    (w.highlights || []).forEach((h) => {
      const m = String(h || '').match(ENHANCEMENT_ANNOTATION_RE);
      if (!m) return;
      try {
        const ann = JSON.parse(m[0]);
        if (ann.__enhanced && typeof ann.__enhanced.type === 'string') {
          entries.push({
            bulletIndex,
            type: ann.__enhanced.type as EnhancementType,
            claim: String(h).replace(ENHANCEMENT_ANNOTATION_RE, '').trim(),
            basis: String(ann.__enhanced.basis || ''),
          });
        }
      } catch { /* ignore malformed annotation */ }
    });
  });
  return entries;
}

/** Remove the trailing `{"__enhanced":{...}}` JSON suffix from every
 *  highlight. Emitted bullets must render clean; the ledger (parsed from
 *  the UNSTRIPPED draft) keeps the claims for the UI. */
export function stripEnhancementAnnotations(draft: TailorDraft): TailorDraft {
  return {
    ...draft,
    experience: (draft.experience || []).map((w) => ({
      ...w,
      highlights: (w.highlights || []).map((h) => String(h || '').replace(ENHANCEMENT_ANNOTATION_RE, '').trim()),
    })),
  };
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