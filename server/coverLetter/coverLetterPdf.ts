// Cover-letter PDF — ATS-readable, selectable text with embedded fonts, built
// with PDFKit (the same renderer as CV PDFs). Persisted content-addressed so
// Auto Apply uploads the EXACT bytes that were verified.

import PDFDocument from 'pdfkit';
import path from 'node:path';
import { CoverLetter, Job } from '../../src/types.js';
import { persistPdfArtifact } from '../applicationPackage/artifactStore.js';

const PAGE_MARGIN_X = 56;
const PAGE_MARGIN_TOP = 52;

function registerEmbeddedFonts(doc: PDFKit.PDFDocument): string {
  try {
    const fontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');
    doc.registerFont('HelveticaEmbed', path.join(fontDir, 'LiberationSans-Regular.ttf'));
    doc.registerFont('HelveticaEmbed-Bold', path.join(fontDir, 'LiberationSans-Bold.ttf'));
    return 'HelveticaEmbed';
  } catch {
    return 'Helvetica';
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function sanitizeFilenamePart(s: string): string {
  return String(s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'job';
}

export function coverLetterFilename(job: Pick<Job, 'company' | 'title'>): string {
  return `Cover-Letter-${sanitizeFilenamePart(job.company)}-${sanitizeFilenamePart(job.title)}.pdf`;
}

export function renderCoverLetterPdf(job: Job, letter: CoverLetter): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: PAGE_MARGIN_TOP, bottom: PAGE_MARGIN_TOP, left: PAGE_MARGIN_X, right: PAGE_MARGIN_X },
        info: {
          Title: `Cover Letter - ${job.title} - ${job.company}`,
          Author: job.tailoredCv?.candidateName || '',
          Creator: 'Tailor AI',
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const font = registerEmbeddedFonts(doc);
      const bold = font === 'HelveticaEmbed' ? 'HelveticaEmbed-Bold' : 'Helvetica-Bold';
      const contentWidth = doc.page.width - PAGE_MARGIN_X * 2;
      const name = job.tailoredCv?.candidateName || 'Candidate';
      const contact = job.tailoredCv?.contactInfo || {};
      const contactLine = [contact.email, contact.phone, contact.location]
        .filter(Boolean)
        .join('  |  ');

      doc.font(bold).fontSize(17).fillColor('#111111').text(name, { width: contentWidth });
      if (contactLine) {
        doc.moveDown(0.25);
        doc.font(font).fontSize(9).fillColor('#555555').text(contactLine, { width: contentWidth });
      }
      doc.moveDown(0.6);
      doc.moveTo(PAGE_MARGIN_X, doc.y).lineTo(doc.page.width - PAGE_MARGIN_X, doc.y).lineWidth(0.7).strokeColor('#999999').stroke();
      doc.moveDown(0.9);

      doc.font(font).fontSize(10).fillColor('#333333').text(formatDate(letter.generatedAt));
      doc.moveDown(0.9);

      doc.font(bold).fontSize(10.5).fillColor('#111111').text(`Re: ${job.title}`);
      if (job.company) {
        doc.font(font).fontSize(10.5).fillColor('#333333').text(job.company);
      }
      doc.moveDown(0.9);

      doc.font(font).fontSize(10.5).fillColor('#1f2937');
      const paragraphs = String(letter.text || '')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      paragraphs.forEach((p, i) => {
        doc.text(p, { width: contentWidth, lineGap: 1.5, paragraphGap: 0 });
        if (i < paragraphs.length - 1) doc.moveDown(0.65);
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export async function ensureCoverLetterPdf(job: Job): Promise<{ letter: CoverLetter; pdfHash: string; pdfSize: number; filename: string }> {
  const letter = job.coverLetter;
  if (!letter || !letter.verified || !letter.text.trim()) {
    throw new Error('Cover letter is not verified; refusing to produce an uploadable PDF.');
  }
  const buf = await renderCoverLetterPdf(job, letter);
  const artifact = persistPdfArtifact(buf);
  const updated: CoverLetter = { ...letter, pdfHash: artifact.sha256, pdfSize: artifact.size };
  return { letter: updated, pdfHash: artifact.sha256, pdfSize: artifact.size, filename: coverLetterFilename(job) };
}
