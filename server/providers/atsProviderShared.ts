// Shared ATS-provider normalization — the only common behavior across the
// Greenhouse/Lever/Ashby providers. Provider-specific API parsing lives in
// directAtsProvider.ts (ghJob/leverJob/ashbyJob); these two functions are the
// thin bridge between provider-normalized Jobs and the orchestrator/durable
// layers. No profession logic, no relevance decisions.

import type { Job } from '../../src/types.js';
import type { NormalizedJob } from './types.js';

export function toNormalized(j: Job, sourceLabel: string): NormalizedJob {
  return {
    id: j.fingerprint || j.id,
    title: j.title,
    company: j.company,
    location: j.location,
    description: j.description,
    applyUrl: j.applyUrl || j.url,
    url: j.url || j.applyUrl,
    atsPlatform: j.atsPlatform,
    // Direct-ATS normalizers set the generic 'Custom' source — the provider
    // knows its real label (Greenhouse/Lever/Ashby).
    source: sourceLabel,
    postedDate: j.postedDate,
    postedDateSemantics: j.postedDateSemantics,
    employmentType: j.employmentType,
    remote: j.remote,
    fingerprint: j.fingerprint || `${j.atsPlatform || 'ats'}-${j.externalId || j.id}`,
  };
}

/** Durable-job shape for persisting only the SURVIVORS of a search. */
export function toDurableJob(n: NormalizedJob): Job {
  const url = n.applyUrl || n.url || '';
  return {
    id: n.fingerprint,
    externalId: n.id,
    title: n.title,
    company: n.company,
    companyId: n.company,
    location: n.location,
    description: n.description,
    atsPlatform: n.atsPlatform || 'ats',
    jobUrl: url,
    applyUrl: url,
    url,
    source: n.source as any,
    postedDate: n.postedDate,
    postedDateSemantics: n.postedDateSemantics,
    remote: n.remote,
    scrapedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    provider: 'direct-ats',
    fingerprint: n.fingerprint,
    isActive: true,
    state: 'pending',
  } as unknown as Job;
}