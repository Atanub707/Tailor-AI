import { describe, it, expect } from 'vitest';
import type { Job } from '../../src/types.js';
import {
  coverLetterFilename,
  renderCoverLetterPdf,
  sanitizeFilenamePart,
} from '../../server/coverLetter/coverLetterPdf.js';
import { resolveRecipientName } from '../../server/coverLetter/coverLetterService.js';

const job = {
  id: 'j1',
  title: 'DevOps Engineer',
  company: 'FitCo Systems',
  tailoredCv: {
    candidateName: 'Atanu Biswas',
    contactInfo: { email: 'atanu@example.com', phone: '+91 90000 00000', location: 'Kolkata, India' },
  },
  coverLetter: {
    text: 'Dear Hiring Team,\n\nI am applying for the DevOps Engineer role at FitCo Systems. I reduced deployment time by 70%.\n\nSincerely,\nAtanu Biswas',
    verified: true,
    generatedAt: '2026-10-29T10:00:00.000Z',
  },
} as unknown as Job;

describe('cover letter PDF', () => {
  it('renders a real PDF with an extractable text layer', async () => {
    const buf = await renderCoverLetterPdf(job, job.coverLetter!);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');

    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((i: any) => i.str).join(' ');
    expect(text).toContain('Atanu Biswas');
    expect(text).toContain('FitCo Systems');
    expect(text).toContain('DevOps Engineer');
    expect(text).toContain('reduced deployment time by 70%');
  });

  it('sanitizes download filenames', () => {
    expect(sanitizeFilenamePart('FitCo Systems, Inc.')).toBe('FitCo-Systems-Inc');
    expect(coverLetterFilename({ company: 'FitCo Systems', title: 'DevOps Engineer' })).toBe(
      'Cover-Letter-FitCo-Systems-DevOps-Engineer.pdf',
    );
  });
});

describe('recipient resolution', () => {
  it('uses a real person name only', () => {
    expect(resolveRecipientName({ recruiterName: 'Sarah Johnson' })).toBe('Sarah Johnson');
    expect(resolveRecipientName({ recruiterName: 'Hiring Team' })).toBeUndefined();
    expect(resolveRecipientName({ recruiterName: 'Talent Acquisition' })).toBeUndefined();
    expect(resolveRecipientName({ recruiterName: 'Acme Recruiting' })).toBeUndefined();
    expect(resolveRecipientName({})).toBeUndefined();
  });
});
