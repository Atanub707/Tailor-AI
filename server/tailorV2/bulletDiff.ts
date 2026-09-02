import type { MasterCv } from '../../src/types.js';
import type { TailorDraft } from './drafter.js';
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
