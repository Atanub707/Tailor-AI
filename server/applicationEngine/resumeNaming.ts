// Professional resume attachment naming for auto-apply.
//
// The file uploaded to the ATS form must carry a human-readable,
// recruiter-friendly name (Atanu_Biswas_Platform_Engineer_Veo_CV.pdf) —
// never a hash. The artifact SHA-256 remains the internal integrity check
// (byte-exactness is verified before upload); the filename is presentation.

import type { ApplicationPackage } from '../applicationPackage/packageModel.js';

const SAFE_RE = /[^A-Za-z0-9]+/g;

function slug(value: unknown, maxLen: number): string {
  return String(value ?? '')
    .replace(SAFE_RE, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

/** Deterministic, professional attachment filename for the package resume:
 *  <FullName>_<Role>_<Company>_CV.pdf. Falls back to 'Candidate' when the
 *  name is unknown; only [A-Za-z0-9_] survive, so the result is always
 *  safe for form uploads and provider validation. */
export function resumeAttachmentFilename(pkg: ApplicationPackage): string {
  const answers = pkg.answers || [];
  const fullName =
    answers.find((a) => a.key === 'fullName')?.value ??
    (pkg.applicantSnapshot?.personal as Record<string, unknown> | undefined)?.fullName ??
    '';
  const name = slug(fullName, 60) || 'Candidate';
  const role = slug(pkg.jobSnapshot?.title, 40);
  const company = slug(pkg.jobSnapshot?.company, 40);
  return `${name}${role ? `_${role}` : ''}${company ? `_${company}` : ''}_CV.pdf`;
}