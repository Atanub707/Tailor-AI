// Tailor V2 — PDF text-layer verification via pdf-parse (already a
// dependency). Critical fields must survive into the extractable text.

import type { TailorDraft } from './drafter.js';

export interface PdfTextCheck {
  ok: boolean;
  missing: string[];
  textLength: number;
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result?.text || '');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Verify the PDF's extractable text layer contains the critical content. */
export async function verifyPdfTextLayer(buffer: Buffer, draft: TailorDraft, recent: { employer?: string; title?: string }, nameHint?: string): Promise<PdfTextCheck> {
  const text = await extractPdfText(buffer);
  const lower = text.toLowerCase();
  const missing: string[] = [];
  const has = (needle: string): boolean => {
    const n = String(needle || '').toLowerCase().trim();
    return n.length >= 3 && lower.includes(n);
  };
  if (nameHint && !has(nameHint.split(/\s+/)[0])) missing.push('candidate name');
  if (recent.employer && !has(recent.employer)) missing.push('recent employer');
  if (recent.title && !has(recent.title)) missing.push('recent title');
  for (const s of (draft.skills || []).slice(0, 5)) {
    if (s && !has(s)) missing.push(`skill: ${s}`);
  }
  if (draft.experience && draft.experience.length && !text.trim()) missing.push('no text layer');
  return { ok: missing.length === 0, missing, textLength: text.length };
}