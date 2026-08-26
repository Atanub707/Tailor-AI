import { describe, it, expect } from 'vitest';
import { isDevOpsAdjacent, relevanceScore } from '../../server/storage/v2Tables.js';

describe('relevance — DevOps query', () => {
  it('accepts explicit DevOps/SRE titles', () => {
    expect(isDevOpsAdjacent('DevOps Engineer (f/m/d)')).toBe(true);
    expect(isDevOpsAdjacent('Embedded SRE')).toBe(true);
    expect(isDevOpsAdjacent('Site Reliability Engineer')).toBe(true);
    expect(isDevOpsAdjacent('DevSecOps Engineer')).toBe(true);
  });
  it('accepts infra word + engineering role', () => {
    expect(isDevOpsAdjacent('Senior Platform Engineer')).toBe(true);
    expect(isDevOpsAdjacent('Cloud Infrastructure Engineer')).toBe(true);
    expect(isDevOpsAdjacent('Systems Administrator')).toBe(true);
    expect(isDevOpsAdjacent('Kubernetes Engineer')).toBe(true);
  });
  it('rejects bare infra words without an engineering role', () => {
    expect(isDevOpsAdjacent('Account Executive, Enterprise Platforms')).toBe(false);
    expect(isDevOpsAdjacent('Director, Product Management - Platforms')).toBe(false);
    expect(isDevOpsAdjacent('Product Manager, Cash Platform')).toBe(false);
    expect(isDevOpsAdjacent('Account Executive, Strategic Platform Partnerships')).toBe(false);
    expect(isDevOpsAdjacent('Platform Sales Representative')).toBe(false);
  });
  it('rejects generic engineering without an infra word', () => {
    expect(isDevOpsAdjacent('Senior Data Engineer')).toBe(false);
    expect(isDevOpsAdjacent('Security Incident Response Engineer')).toBe(false);
    expect(isDevOpsAdjacent('Software Engineer, Mobile')).toBe(false);
  });
});

describe('relevance — query-aware vocabularies', () => {
  it('DevOps query accepts DevOps titles, rejects Data Engineer', () => {
    expect(relevanceScore('DevOps Engineer', 'DevOps Engineer')).toBeGreaterThan(0);
    expect(relevanceScore('DevOps Engineer', 'Platform Engineer')).toBeGreaterThan(0);
    expect(relevanceScore('DevOps Engineer', 'Senior Data Engineer')).toBe(0);
    expect(relevanceScore('DevOps Engineer', 'Product Manager, Platforms')).toBe(0);
    expect(relevanceScore('DevOps Engineer', 'Account Executive')).toBe(0);
  });
  it('Cyber Security query accepts security titles, rejects Data Engineer', () => {
    expect(relevanceScore('Cyber Security Engineer', 'Security Engineer')).toBeGreaterThan(0);
    expect(relevanceScore('Cyber Security Engineer', 'Cloud Security Engineer')).toBeGreaterThan(0);
    expect(relevanceScore('Cyber Security Engineer', 'Application Security Architect')).toBeGreaterThan(0);
    expect(relevanceScore('Cyber Security Engineer', 'DevSecOps Engineer')).toBeGreaterThan(0);
    expect(relevanceScore('Cyber Security Engineer', 'Senior Data Engineer')).toBe(0);
    expect(relevanceScore('Cyber Security Engineer', 'DevOps Engineer')).toBe(0);
    expect(relevanceScore('Cyber Security Engineer', 'Account Executive')).toBe(0);
  });
  it('exact query term always wins even outside a category', () => {
    expect(relevanceScore('DevOps', 'DevOps Manager')).toBeGreaterThan(0); // term present
    expect(relevanceScore('DevOps', 'DevOps Engineer')).toBeGreaterThan(0);
  });
});