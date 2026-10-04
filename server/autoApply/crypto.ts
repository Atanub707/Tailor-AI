// Single-use token helpers for the desktop handoff + submission receipts.

import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
