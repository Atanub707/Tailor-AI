// Browser Companion Phase 0 — frozen-contract validation (pure helpers only;
// no extension code, no network, no storage).
import { describe, it, expect } from 'vitest';
import {
  BROWSER_COMPANION_PROTOCOL_VERSION, SESSION_TTL_MS,
  isSessionUsable, isSessionTerminal, companionEventKey,
  isAllowedLoopbackHost, isCanonicalSessionTarget, optionMatches,
} from '../../server/browserCompanion/companionContract.js';
import { sha256 } from '../../server/applicationEngine/contract.js';

const session = {
  sessionId: 's1',
  applicationAttemptId: 'attempt-1',
  provider: 'lever',
  externalJobId: 'lev-abc',
  canonicalActionUrl: 'https://jobs.lever.co/veo/abc/apply',
  packageSnapshotHash: 'pkg-hash',
  planFingerprint: 'plan-fp',
  approvalFingerprint: 'appr-fp',
  resumeArtifactHash: 'resume-hash',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  nonce: 'n1',
  protocolVersion: BROWSER_COMPANION_PROTOCOL_VERSION,
};

const binding = {
  provider: 'lever', externalJobId: 'lev-abc', packageSnapshotHash: 'pkg-hash',
  planFingerprint: 'plan-fp', approvalFingerprint: 'appr-fp',
  resumeArtifactHash: 'resume-hash', canonicalActionUrl: 'https://jobs.lever.co/veo/abc/apply',
};

describe('Session contract (frozen)', () => {
  it('valid session usable', () => {
    expect(isSessionUsable(session, Date.now(), binding)).toBe(true);
  });
  it('expired session unusable', () => {
    const expired = { ...session, expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(isSessionUsable(expired, Date.now(), binding)).toBe(false);
  });
  it('protocol mismatch unusable', () => {
    expect(isSessionUsable({ ...session, protocolVersion: 2 }, Date.now(), binding)).toBe(false);
  });
  it('any binding drift unusable (cross-job/package/plan/approval/resume/url)', () => {
    expect(isSessionUsable(session, Date.now(), { ...binding, externalJobId: 'lev-other' })).toBe(false);
    expect(isSessionUsable(session, Date.now(), { ...binding, packageSnapshotHash: 'x' })).toBe(false);
    expect(isSessionUsable(session, Date.now(), { ...binding, planFingerprint: 'x' })).toBe(false);
    expect(isSessionUsable(session, Date.now(), { ...binding, approvalFingerprint: 'x' })).toBe(false);
    expect(isSessionUsable(session, Date.now(), { ...binding, resumeArtifactHash: 'x' })).toBe(false);
    expect(isSessionUsable(session, Date.now(), { ...binding, canonicalActionUrl: 'https://jobs.lever.co/other/9/apply' })).toBe(false);
    expect(isSessionUsable(session, Date.now(), { ...binding, provider: 'greenhouse' })).toBe(false);
  });
  it('terminal events make a session unusable for further actions', () => {
    expect(isSessionTerminal([{ type: 'PAGE_VERIFIED' }, { type: 'FIELDS_FILLED' }])).toBe(false);
    for (const t of ['SUBMISSION_CONFIRMED', 'SUBMISSION_UNCONFIRMED', 'SESSION_EXPIRED', 'COMPANION_ERROR'] as const) {
      expect(isSessionTerminal([{ type: t }])).toBe(true);
    }
  });
  it('event idempotency keys are deterministic per session+type', () => {
    expect(companionEventKey('s1', 'FIELDS_FILLED')).toBe(companionEventKey('s1', 'FIELDS_FILLED'));
    expect(companionEventKey('s1', 'FIELDS_FILLED')).not.toBe(companionEventKey('s2', 'FIELDS_FILLED'));
  });
});

describe('Local API surface (frozen)', () => {
  it('loopback Host allowlist only', () => {
    expect(isAllowedLoopbackHost('127.0.0.1:3000')).toBe(true);
    expect(isAllowedLoopbackHost('localhost:3000')).toBe(true);
    expect(isAllowedLoopbackHost('[::1]:3000')).toBe(true);
    expect(isAllowedLoopbackHost('evil.com')).toBe(false);
    expect(isAllowedLoopbackHost('192.168.1.5:3000')).toBe(false);
    expect(isAllowedLoopbackHost('0.0.0.0:3000')).toBe(false);
    expect(isAllowedLoopbackHost(undefined)).toBe(false);
  });
  it('canonical target only — no arbitrary URLs', () => {
    expect(isCanonicalSessionTarget('https://jobs.lever.co/veo/abc/apply', 'https://jobs.lever.co/veo/abc/apply')).toBe(true);
    expect(isCanonicalSessionTarget('https://jobs.lever.co/veo/abc/apply', 'https://jobs.lever.co/veo/abc/apply?x=1')).toBe(false);
    expect(isCanonicalSessionTarget('https://jobs.lever.co/veo/abc/apply', 'http://jobs.lever.co/veo/abc/apply')).toBe(false);
    expect(isCanonicalSessionTarget('https://jobs.lever.co/veo/abc/apply', 'https://evil.com/veo/abc/apply')).toBe(false);
    expect(isCanonicalSessionTarget('https://jobs.lever.co/veo/abc/apply', 'javascript:alert(1)')).toBe(false);
  });
});

describe('Option stale-guard', () => {
  it('approved value must exist in CURRENT options; hash drift blocks', () => {
    const opts = ['Yes', 'No'];
    const hash = sha256(JSON.stringify(opts));
    expect(optionMatches('Yes', opts, hash)).toBe(true);
    expect(optionMatches('Maybe', opts, hash)).toBe(false);
    expect(optionMatches('Yes', opts, sha256(JSON.stringify(['Yes', 'No', 'Maybe'])))).toBe(false);
    expect(optionMatches('Any text', undefined, undefined)).toBe(true); // text field
  });
});