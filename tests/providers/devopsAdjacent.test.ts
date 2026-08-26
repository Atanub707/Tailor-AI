import { describe, it, expect } from 'vitest';
import { isDevOpsAdjacent } from '../../server/storage/v2Tables.js';

describe('isDevOpsAdjacent', () => {
  it('accepts explicit DevOps/SRE titles', () => {
    expect(isDevOpsAdjacent('DevOps Engineer (f/m/d)')).toBe(true);
    expect(isDevOpsAdjacent('Embedded SRE')).toBe(true);
    expect(isDevOpsAdjacent('Site Reliability Engineer')).toBe(true);
  });
  it('accepts infra word + engineering role', () => {
    expect(isDevOpsAdjacent('Senior Platform Engineer')).toBe(true);
    expect(isDevOpsAdjacent('Cloud Infrastructure Engineer')).toBe(true);
    expect(isDevOpsAdjacent('Systems Administrator')).toBe(true);
    expect(isDevOpsAdjacent('Release Engineer')).toBe(true);
  });
  it('rejects bare infra words without an engineering role', () => {
    expect(isDevOpsAdjacent('Account Executive, Enterprise Platforms')).toBe(false);
    expect(isDevOpsAdjacent('Director, Product Management - Platforms')).toBe(false);
    expect(isDevOpsAdjacent('Product Manager, Cash Platform')).toBe(false);
    expect(isDevOpsAdjacent('Account Executive, Strategic Platform Partnerships')).toBe(false);
  });
  it('rejects generic engineering without an infra word', () => {
    expect(isDevOpsAdjacent('Senior Data Engineer')).toBe(false);
    expect(isDevOpsAdjacent('Security Incident Response Engineer')).toBe(false);
    expect(isDevOpsAdjacent('Software Engineer, Mobile')).toBe(false);
  });
});
