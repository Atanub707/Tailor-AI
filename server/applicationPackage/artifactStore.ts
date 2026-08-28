// Application Package — immutable PDF artifact store.
//
// The EXACT verified PDF bytes are persisted once, content-addressed by
// SHA-256, under the persistent application data directory. Retrieval never
// regenerates the PDF — a future Application Engine receives the byte-exact
// document that was verified at package time. Atomic writes (temp + rename).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ARTIFACT_DIR = path.join(process.env.TAILOR_DATA_DIR || path.join(process.cwd(), 'data'), 'application-artifacts');

export function artifactPath(sha256: string): string {
  return path.join(ARTIFACT_DIR, `${sha256}.pdf`);
}

export function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Persist exact PDF bytes (atomic: temp file + rename). Content-addressed:
 *  identical bytes share one artifact; different bytes never overwrite. */
export function persistPdfArtifact(buf: Buffer): { sha256: string; size: number; path: string } {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const sha256 = sha256Bytes(buf);
  const finalPath = artifactPath(sha256);
  if (!fs.existsSync(finalPath)) {
    const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, finalPath);
  }
  const size = fs.statSync(finalPath).size;
  return { sha256, size, path: finalPath };
}

/** Read the exact artifact bytes; throws when missing or hash-mismatched. */
export function readPdfArtifact(sha256: string): Buffer {
  const p = artifactPath(sha256);
  if (!fs.existsSync(p)) throw new Error('PDF artifact missing.');
  const buf = fs.readFileSync(p);
  if (sha256Bytes(buf) !== sha256) throw new Error('PDF artifact hash mismatch — corruption detected.');
  return buf;
}

export function artifactExists(sha256: string): boolean {
  return fs.existsSync(artifactPath(sha256));
}