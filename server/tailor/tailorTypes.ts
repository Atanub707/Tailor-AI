// Shared types + small helpers for the user-facing (V1) tailoring engine.

import type { ApplicantProfile, MasterCv } from '../../src/types.js';
import { extractJsonObject } from '../llm/jsonExtract.js';
import { parseJobRequirements } from '../fit/requirementsParser.js';

export interface TailorDraft {
  summary: string;
  skills: string[];
  experience: Array<{ title: string; company: string; location?: string; dates?: string; highlights: string[] }>;
  education: Array<{ degree?: string; institution?: string; dates?: string; details?: string }>;
  certifications: string[];
  projects?: Array<{ name?: string; description?: string }>;
}

export class TailorVerificationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TailorVerificationFailedError';
  }
}

export interface TailorVerificationIssue {
  type: string;
  claim: string;
  severity: 'error' | 'warning';
}

export interface TailorVerification {
  passed: boolean;
  issues: TailorVerificationIssue[];
  [key: string]: unknown;
}

export interface EnhancementLedger {
  entries: Array<{ expIndex: number; hIndex: number; claim: string; basis: string }>;
}

export function jdSkillTerms(jd: string): string[] {
  const reqs = parseJobRequirements(jd, {});
  return [...new Set([...reqs.requiredSkills, ...reqs.preferredSkills])];
}

export function parseDraftJson(raw: string): TailorDraft {
  // Reasoning models wrap JSON in <thinking>…</thinking> blocks or fences —
  // extractJsonObject strips both and parses the first balanced object.
  const parsed = extractJsonObject(raw) as TailorDraft;
  if (!parsed || typeof parsed !== 'object') throw new Error('Structured response is not an object.');
  if (!Array.isArray(parsed.skills)) parsed.skills = [];
  if (!Array.isArray(parsed.experience)) parsed.experience = [];
  if (!Array.isArray(parsed.education)) parsed.education = [];
  if (!Array.isArray(parsed.certifications)) parsed.certifications = [];
  return parsed;
}

export type { ApplicantProfile, MasterCv };
