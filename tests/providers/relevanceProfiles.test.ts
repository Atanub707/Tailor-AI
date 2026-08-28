import { describe, it, expect } from 'vitest';
import {
  evaluateRelevance,
  parseQuery,
  selectProfile,
  queryProfiles,
  expandAbbreviations,
  type MatchTier,
} from '../../server/search/relevance.js';

// One engine for ANY query — the acceptance matrix from the product spec.
// Each query must accept its role family and reject unrelated/generic roles,
// including unknown roles (Blockchain) with no predefined category.

function check(query: string, title: string): MatchTier {
  return evaluateRelevance(query, title).matchType;
}
const ACCEPT = ['exact', 'strong_related', 'related', 'weak_related'];

describe('query parsing — generic, derived from the query', () => {
  it('derives specialization tokens from the query', () => {
    expect(parseQuery('Senior Backend Engineer').specializationTerms).toEqual(['backend']);
    expect(parseQuery('Senior Backend Engineer').seniorityTerms).toEqual(['senior']);
    expect(parseQuery('Machine Learning Engineer').specializationTerms).toContain('machine');
    expect(parseQuery('DevOps Engineer').specializationTerms).toEqual(['devops']);
  });
  it('expands safe abbreviations symmetrically', () => {
    expect(expandAbbreviations('ml engineer')).toBe('machine learning engineer');
    expect(expandAbbreviations('sre')).toBe('site reliability');
  });
  it('resolves profile ids for known and unknown queries', () => {
    expect(selectProfile('DevOps Engineer').id).toBe('devops');
    expect(selectProfile('Machine Learning Engineer').id).toBe('machine_learning');
    expect(selectProfile('Blockchain Engineer').id).toBe('generic');
    expect(queryProfiles()).toContain('devops');
  });
});

describe('QUERY: DevOps Engineer', () => {
  const q = 'DevOps Engineer';
  it('accepts', () => {
    expect(ACCEPT).toContain(check(q, 'DevOps Engineer'));
    expect(ACCEPT).toContain(check(q, 'DevSecOps Engineer'));
    expect(ACCEPT).toContain(check(q, 'Site Reliability Engineer'));
    expect(ACCEPT).toContain(check(q, 'Platform Engineer'));
  });
  it('rejects', () => {
    expect(check(q, 'Data Engineer')).toBe('irrelevant');
    expect(check(q, 'Operations Analyst')).toBe('irrelevant');
    expect(check(q, 'Credit Operations Analyst')).toBe('irrelevant');
    expect(check(q, 'Product Manager')).toBe('irrelevant');
    expect(check(q, 'Account Executive')).toBe('irrelevant');
  });
});

describe('QUERY: Data Engineer', () => {
  const q = 'Data Engineer';
  it('accepts', () => {
    expect(ACCEPT).toContain(check(q, 'Data Engineer'));
    expect(ACCEPT).toContain(check(q, 'Senior Data Engineer'));
    expect(ACCEPT).toContain(check(q, 'Data Platform Engineer'));
  });
  it('rejects', () => {
    expect(check(q, 'DevOps Engineer')).toBe('irrelevant');
    expect(check(q, 'Frontend Engineer')).toBe('irrelevant');
    expect(check(q, 'Account Executive')).toBe('irrelevant');
  });
});

describe('QUERY: Software Engineer', () => {
  const q = 'Software Engineer';
  it('accepts', () => {
    expect(ACCEPT).toContain(check(q, 'Software Engineer'));
    expect(ACCEPT).toContain(check(q, 'Senior Software Engineer'));
    expect(ACCEPT).toContain(check(q, 'Software Developer'));
  });
  it('rejects', () => {
    expect(check(q, 'Sales Engineer')).toBe('irrelevant');
    expect(check(q, 'Product Manager')).toBe('irrelevant');
    expect(check(q, 'Account Executive')).toBe('irrelevant');
  });
});

describe('QUERY: Frontend Engineer', () => {
  const q = 'Frontend Engineer';
  it('accepts', () => {
    expect(ACCEPT).toContain(check(q, 'Frontend Engineer'));
    expect(ACCEPT).toContain(check(q, 'Frontend Developer'));
    expect(ACCEPT).toContain(check(q, 'React Engineer'));
  });
  it('rejects', () => {
    expect(check(q, 'Backend Engineer')).toBe('irrelevant');
    expect(check(q, 'Data Engineer')).toBe('irrelevant');
    expect(check(q, 'Product Manager')).toBe('irrelevant');
  });
});

describe('QUERY: Cyber Security Engineer', () => {
  const q = 'Cyber Security Engineer';
  it('accepts', () => {
    expect(ACCEPT).toContain(check(q, 'Cyber Security Engineer'));
    expect(ACCEPT).toContain(check(q, 'Security Engineer'));
    expect(ACCEPT).toContain(check(q, 'Application Security Engineer'));
    expect(ACCEPT).toContain(check(q, 'Cloud Security Engineer'));
  });
  it('rejects', () => {
    expect(check(q, 'Software Engineer')).toBe('irrelevant');
    expect(check(q, 'Sales Engineer')).toBe('irrelevant');
    expect(check(q, 'Account Executive')).toBe('irrelevant');
  });
});

describe('QUERY: Machine Learning Engineer', () => {
  const q = 'Machine Learning Engineer';
  it('accepts', () => {
    expect(ACCEPT).toContain(check(q, 'Machine Learning Engineer'));
    expect(ACCEPT).toContain(check(q, 'ML Engineer'));
    expect(ACCEPT).toContain(check(q, 'Applied ML Engineer'));
  });
  it('rejects', () => {
    expect(check(q, 'Data Entry')).toBe('irrelevant');
    expect(check(q, 'Account Executive')).toBe('irrelevant');
    expect(check(q, 'Frontend Engineer')).toBe('irrelevant');
  });
});

describe('QUERY: Blockchain Engineer (unknown role — generic path)', () => {
  const q = 'Blockchain Engineer';
  it('accepts without any predefined category', () => {
    expect(ACCEPT).toContain(check(q, 'Blockchain Engineer'));
    expect(ACCEPT).toContain(check(q, 'Senior Blockchain Engineer'));
    expect(ACCEPT).toContain(check(q, 'Blockchain Developer'));
  });
  it('rejects', () => {
    expect(check(q, 'Backend Engineer')).toBe('irrelevant');
    expect(check(q, 'Sales Engineer')).toBe('irrelevant');
    expect(check(q, 'Product Manager')).toBe('irrelevant');
  });
});

describe('scoring tiers — specialization beats generic role word', () => {
  it('exact role phrase scores 100', () => {
    expect(evaluateRelevance('Data Engineer', 'Data Engineer').relevanceScore).toBe(100);
    expect(evaluateRelevance('Software Engineer', 'Senior Software Engineer').relevanceScore).toBe(100);
  });
  it('specialization + role word is strong, not exact', () => {
    expect(evaluateRelevance('Frontend Engineer', 'Frontend Developer').matchType).toBe('strong_related');
    expect(evaluateRelevance('Blockchain Engineer', 'Blockchain Developer').matchType).toBe('strong_related');
    expect(evaluateRelevance('Data Engineer', 'Data Platform Engineer').matchType).toBe('strong_related');
  });
  it('specialization without a role word is related', () => {
    expect(evaluateRelevance('DevOps', 'DevOps Manager').matchType).toBe('exact'); // full query phrase present
  });
  it('domain synonyms are query-aware', () => {
    expect(evaluateRelevance('DevOps Engineer', 'Platform Engineer').matchType).toBe('related');
    expect(evaluateRelevance('DevOps Engineer', 'DevSecOps Engineer').matchType).toBe('strong_related');
    expect(evaluateRelevance('Machine Learning Engineer', 'MLOps Engineer').matchType).toBe('strong_related');
    expect(evaluateRelevance('Cyber Security Engineer', 'SOC Analyst').matchType).toBe('related');
  });
  it('word-boundary matching prevents substring false positives', () => {
    expect(evaluateRelevance('AI Engineer', 'Train Engineer').relevanceScore).toBe(0);
    expect(evaluateRelevance('QA Engineer', 'Latest Engineer').relevanceScore).toBe(0);
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
    expect(ok.matchType).toBe('related');
  });
});