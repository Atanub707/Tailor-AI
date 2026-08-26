import { describe, it, expect } from 'vitest';
import { evaluateRelevance, selectProfile, queryProfiles } from '../../server/search/relevance.js';

describe('query profiles — all registered', () => {
  it('has the required profiles', () => {
    const ids = queryProfiles();
    for (const p of ['devops', 'cybersecurity', 'ai-ml', 'backend', 'frontend', 'fullstack', 'data-engineering', 'qa', 'mobile']) {
      expect(ids).toContain(p);
    }
  });
  it('selects the right profile per query', () => {
    expect(selectProfile('DevOps Engineer').id).toBe('devops');
    expect(selectProfile('Cyber Security Engineer').id).toBe('cybersecurity');
    expect(selectProfile('AI Engineer').id).toBe('ai-ml');
    expect(selectProfile('Backend Engineer').id).toBe('backend');
    expect(selectProfile('Frontend Developer').id).toBe('frontend');
    expect(selectProfile('Full Stack Engineer').id).toBe('fullstack');
    expect(selectProfile('Data Engineer').id).toBe('data-engineering');
    expect(selectProfile('QA Engineer').id).toBe('qa');
    expect(selectProfile('Mobile Engineer').id).toBe('mobile');
  });
});

describe('DevOps Engineer query', () => {
  const q = 'DevOps Engineer';
  const tier = (title: string) => evaluateRelevance(q, title).matchType;
  it('accepts DevOps titles', () => {
    expect(tier('DevOps Engineer')).toBe('exact');
    expect(tier('Senior DevOps Engineer')).toBe('exact');
    expect(tier('DevSecOps Engineer')).toBe('exact');
    expect(tier('SRE')).toBe('exact');
  });
  it('accepts strong related', () => {
    expect(tier('Platform Engineer')).toBe('strong_related');
    expect(tier('Infrastructure Engineer')).toBe('strong_related');
    expect(tier('Cloud Infrastructure Engineer')).toBe('strong_related');
  });
  it('accepts related', () => {
    expect(tier('Cloud Engineer')).toBe('related');
    expect(tier('Systems Engineer')).toBe('related');
  });
  it('rejects unrelated roles', () => {
    expect(tier('Software Engineer')).toBe('irrelevant');
    expect(tier('Data Engineer')).toBe('irrelevant');
    expect(tier('Product Manager')).toBe('irrelevant');
    expect(tier('Account Executive')).toBe('irrelevant');
    expect(tier('Backend Engineer')).toBe('irrelevant');
    expect(tier('Security Engineer')).toBe('irrelevant');
  });
});

describe('Cyber Security Engineer query', () => {
  const q = 'Cyber Security Engineer';
  const tier = (title: string) => evaluateRelevance(q, title).matchType;
  it('accepts security titles', () => {
    expect(tier('Cybersecurity Engineer')).toBe('exact');
    expect(tier('Security Engineer')).toBe('exact');
    expect(tier('Cloud Security Engineer')).toBe('exact'); // contains "security engineer" + cloud
    expect(tier('Application Security Engineer')).toBe('exact');
    expect(tier('DevSecOps Engineer')).toBe('exact');
    expect(tier('Security Architect')).toBe('exact');
  });
  it('rejects unrelated roles', () => {
    expect(tier('Data Engineer')).toBe('irrelevant');
    expect(tier('Platform Engineer')).toBe('irrelevant');
    expect(tier('Product Manager')).toBe('irrelevant');
  });
});

describe('AI Engineer query', () => {
  const q = 'AI Engineer';
  const tier = (title: string) => evaluateRelevance(q, title).matchType;
  it('accepts AI/ML titles', () => {
    expect(tier('AI Engineer')).toBe('exact');
    expect(tier('ML Engineer')).toBe('exact');
    expect(tier('Machine Learning Engineer')).toBe('exact');
    expect(tier('LLM Engineer')).toBe('exact');
    expect(tier('Generative AI Engineer')).toBe('exact');
  });
  it('rejects unrelated roles', () => {
    expect(tier('DevOps Engineer')).toBe('irrelevant');
    expect(tier('Data Analyst')).toBe('irrelevant');
    expect(tier('Product Manager')).toBe('irrelevant');
    expect(tier('Frontend Engineer')).toBe('irrelevant');
  });
});

describe('other profiles — smoke', () => {
  it('backend', () => {
    expect(evaluateRelevance('Backend Engineer', 'Backend Engineer').matchType).toBe('exact');
    expect(evaluateRelevance('Backend Engineer', 'Java Backend Developer').matchType).toBe('strong_related');
    expect(evaluateRelevance('Backend Engineer', 'Frontend Engineer').matchType).toBe('irrelevant');
  });
  it('frontend', () => {
    expect(evaluateRelevance('Frontend Engineer', 'React Engineer').matchType).toBe('exact');
    expect(evaluateRelevance('Frontend Engineer', 'Backend Engineer').matchType).toBe('irrelevant');
  });
  it('data engineering', () => {
    expect(evaluateRelevance('Data Engineer', 'Data Engineer').matchType).toBe('exact');
    expect(evaluateRelevance('Data Engineer', 'ETL Engineer').matchType).toBe('exact');
    expect(evaluateRelevance('Data Engineer', 'DevOps Engineer').matchType).toBe('irrelevant');
  });
  it('qa', () => {
    expect(evaluateRelevance('QA Engineer', 'Test Automation Engineer').matchType).toBe('exact');
    expect(evaluateRelevance('QA Engineer', 'Software Engineer').matchType).toBe('irrelevant');
  });
  it('mobile', () => {
    expect(evaluateRelevance('Mobile Engineer', 'iOS Engineer').matchType).toBe('exact');
    expect(evaluateRelevance('Mobile Engineer', 'Frontend Engineer').matchType).toBe('irrelevant');
  });
});

describe('generic fallback — conservative', () => {
  it('unknown query requires the exact term in the title', () => {
    expect(evaluateRelevance('Cassandra Administrator', 'Cassandra Administrator').matchType).toBe('exact');
    expect(evaluateRelevance('Cassandra Administrator', 'Software Engineer').matchType).toBe('irrelevant');
  });
});

describe('leak regression — generic words never qualify alone', () => {
  const q = 'DevOps Engineer';
  it('platform/engineer words alone cannot enter a DevOps search', () => {
    expect(evaluateRelevance(q, 'Account Executive, Enterprise Platforms').matchType).toBe('irrelevant');
    expect(evaluateRelevance(q, 'Product Manager, Cash Platform').matchType).toBe('irrelevant');
    expect(evaluateRelevance(q, 'Senior Data Engineer').matchType).toBe('irrelevant');
    expect(evaluateRelevance(q, 'Director, Product Management - Platforms').matchType).toBe('irrelevant');
    expect(evaluateRelevance(q, 'Platform Sales Representative').matchType).toBe('irrelevant');
    expect(evaluateRelevance(q, 'Account Executive, Strategic Platform Partnerships').matchType).toBe('irrelevant');
  });
  it('metadata carries matched + excluded signals', () => {
    const r = evaluateRelevance(q, 'Account Executive, Enterprise Platforms');
    expect(r.excludedSignals.length).toBeGreaterThan(0);
    expect(r.relevanceScore).toBe(0);
    const ok = evaluateRelevance(q, 'Platform Engineer');
    expect(ok.matchedSignals).toContain('platform');
    expect(ok.matchType).toBe('strong_related');
  });
});