import type { MasterCv } from '../../src/types.js';
import type { EnhancementLedger, TailorDraft } from './tailorTypes.js';
import { containsKeyword } from './keywordMatch.js';

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
  return out;
}

export function computeKeywordStatus(jdTerms: string[], draft: TailorDraft, masterCv: MasterCv, ledger?: EnhancementLedger): KeywordStatus[] {
  const out: KeywordStatus[] = [];
  const expText = (draft.experience || []).flatMap((w) => w.highlights || []).join(' ').toLowerCase();
  const skillsText = (draft.skills || []).join(' ').toLowerCase();
  const summaryText = String(draft.summary || '').toLowerCase();
  const masterText = JSON.stringify({ cv: masterCv }).toLowerCase();
  for (const term of [...new Set(jdTerms)]) {
    if (!String(term || '').trim()) continue;
    const inExp = containsKeyword(expText, term);
    const inSkills = containsKeyword(skillsText, term);
    const inSummary = containsKeyword(summaryText, term);
    const ledgerHit = ledger?.entries.find((e) => containsKeyword(e.claim, term) || containsKeyword(e.basis, term));
    const inMaster = containsKeyword(masterText, term);
    if (inExp) out.push({ term, kind: 'added_experience', location: 'Experience bullets' });
    else if (inSkills) out.push({ term, kind: 'added_skills', location: 'Skills' });
    else if (inSummary) out.push({ term, kind: 'added_experience', location: 'Summary' });
    else if (ledgerHit) out.push({ term, kind: 'enhanced', basis: ledgerHit.basis });
    else if (inMaster) out.push({ term, kind: 'already_present', location: 'Already in your CV' });
    else out.push({ term, kind: 'unsupported' });
  }
  return out;
}
