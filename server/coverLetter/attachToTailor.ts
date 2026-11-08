// Auto-generation wrapper — a cover letter is generated after every successful
// tailored-CV run (when enabled). It NEVER blocks or fails the tailor itself:
// any error is stored honestly on the job (verified:false + error) and returned.

import { CoverLetter, Job } from '../../src/types.js';
import { loadConfig } from '../config.js';
import { saveCoverLetter } from '../storage/fileStorage.js';
import { generateCoverLetterForJob } from './coverLetterService.js';
import { ensureCoverLetterPdf } from './coverLetterPdf.js';

export function coverLetterAutoEnabled(): boolean {
  return loadConfig().coverLetter?.autoGenerate !== false;
}

/** Generate, validate, render the PDF when verified, and persist the result. */
export async function generateAndStoreCoverLetter(
  job: Job,
  opts: { force?: boolean } = {},
): Promise<CoverLetter> {
  const { letter } = await generateCoverLetterForJob(job, opts);
  if (!letter.verified) return letter;
  try {
    const withPdf = await ensureCoverLetterPdf({ ...job, coverLetter: letter });
    const stored = saveCoverLetter(job.id, withPdf.letter)?.coverLetter || withPdf.letter;
    return stored;
  } catch (err: any) {
    // The text is still verified; the PDF can be rendered on demand later.
    console.warn(`[CoverLetter] PDF render failed for job ${job.id}: ${String(err?.message || err).slice(0, 200)}`);
    return letter;
  }
}

/** Called by tailor routes AFTER the tailored CV is persisted. Fail-soft. */
export async function attachCoverLetterAfterTailor(job: Job): Promise<CoverLetter | undefined> {
  if (!coverLetterAutoEnabled()) return undefined;
  try {
    return await generateAndStoreCoverLetter(job, { force: true });
  } catch (err: any) {
    const letter: CoverLetter = {
      text: job.coverLetter?.text || '',
      verified: false,
      generatedAt: new Date().toISOString(),
      error: String(err?.message || err).slice(0, 300) || 'Cover letter generation failed.',
    };
    saveCoverLetter(job.id, letter);
    return letter;
  }
}
