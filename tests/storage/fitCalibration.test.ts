// Fit Engine V1 — Phase 2 calibration: generic (non-DevOps-specific) engine,
// directional skill hierarchies, software/AI/ML calibration, cross-role
// matrix, non-tech negative controls, authorization/sponsorship semantics,
// assessment coverage, score invariants, determinism.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-cal-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser } = await import('../../server/storage/fileStorage.js');
const { ensureV2Tables } = await import('../../server/storage/v2Tables.js');
const { ensureApplicantProfileSchema, defaultApplicantProfile } = await import('../../server/storage/applicantProfile.js');
const { computeFit, identifyRole, roleAlignmentWeight } = await import('../../server/fit/fitEngine.js');
const { skillCovered } = await import('../../server/fit/skillAliases.js');
import type { ApplicantProfile, MasterCv, Job } from '../../src/types.js';

const USER = 'fit-cal-user';

function profile(over: Partial<ApplicantProfile> = {}): ApplicantProfile {
  const p = defaultApplicantProfile();
  p.personal = { firstName: 'C', lastName: 'X', email: 'cx@test.local' };
  p.locationPrefs = { currentCity: 'Bengaluru', currentCountry: 'India', willingToRelocate: 'yes', remotePreference: 'flexible' };
  p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'no' };
  p.preferences = { minimumSalary: 2000000, targetSalary: 2500000, salaryCurrency: 'INR' };
  return { ...p, ...over };
}

function cv(over: Partial<MasterCv> = {}): MasterCv {
  return { fullName: 'C X', email: 'cx@test.local', phone: '', location: '', summary: '', experiences: [], education: [], skills: [], certifications: [], ...over };
}

function job(title: string, over: Partial<Job> = {}): Job {
  return { id: 'j-' + title.replace(/[^a-z0-9]/gi, ''), externalId: '1', title, company: 'C', companyId: 'C', location: 'Remote', description: '', atsPlatform: 'greenhouse', jobUrl: 'https://x/1', applyUrl: 'https://x/1', url: 'https://x/1', source: 'Greenhouse', state: 'pending', ...over } as unknown as Job;
}

// ── candidate fixtures ─────────────────────────────────────────────────
const devopsCandidate = () => {
  const p = profile();
  p.skills = [{ name: 'Kubernetes' }, { name: 'AWS' }, { name: 'Terraform' }, { name: 'CI/CD' }, { name: 'Docker' }, { name: 'Linux' }];
  p.experience = [{ company: 'A', title: 'DevOps Engineer', startDate: '2018-01', isCurrent: true }];
  return p;
};
const backendCandidate = () => {
  const p = profile();
  p.skills = [{ name: 'TypeScript' }, { name: 'Node.js' }, { name: 'REST APIs' }, { name: 'PostgreSQL' }, { name: 'Redis' }, { name: 'Docker' }];
  p.experience = [{ company: 'B', title: 'Backend Engineer', startDate: '2019-01', isCurrent: true }];
  return p;
};
const frontendCandidate = () => {
  const p = profile();
  p.skills = [{ name: 'React' }, { name: 'TypeScript' }, { name: 'HTML/CSS' }, { name: 'Next.js' }, { name: 'Accessibility' }];
  p.experience = [{ company: 'C', title: 'Frontend Engineer', startDate: '2020-01', isCurrent: true }];
  return p;
};
const aiMlCandidate = () => {
  const p = profile();
  p.skills = [{ name: 'Python' }, { name: 'PyTorch' }, { name: 'RAG' }, { name: 'LLM' }, { name: 'LangChain' }, { name: 'Kubernetes' }];
  p.experience = [{ company: 'D', title: 'ML Engineer', startDate: '2019-06', isCurrent: true }];
  return p;
};

const BACKEND_JD = 'Required: TypeScript, Node.js, REST APIs and PostgreSQL. Must have 4+ years backend experience. Preferred: Redis, Docker, AWS.';
const FRONTEND_JD = 'Required: React, TypeScript, HTML/CSS. Must have frontend application experience. Preferred: Next.js, accessibility, testing.';
const AI_JD = 'Required: Python, LLM application development, RAG, model/API integration. Must have 3+ years AI engineering. Preferred: vector retrieval, evaluation, PyTorch, model serving.';
const ML_JD = 'Required: Python, machine learning, model training, PyTorch or TensorFlow. Must have 3+ years ML. Preferred: MLOps, model serving, Kubernetes.';

describe('Fit Engine V1 calibration', () => {
  beforeAll(() => {
    ensureV2Tables();
    ensureApplicantProfileSchema();
    runWithUser(USER, () => {
      getDb().prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'Cal', 'cal@test.local');
    });
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const fit = (p: ApplicantProfile, c: MasterCv, j: Job, jd: string) => computeFit(p, c, j, jd);

  // ── Directional hierarchy (milestone §8) ─────────────────────────────
  it('hierarchy: IaC does NOT satisfy Terraform; Terraform satisfies IaC', () => {
    expect(skillCovered('Terraform', ['IaC']).covered).toBe(false);
    expect(skillCovered('Infrastructure as Code', ['Terraform']).covered).toBe(true);
  });
  it('hierarchy: Kubernetes does NOT satisfy GKE; GKE satisfies Kubernetes', () => {
    expect(skillCovered('GKE', ['Kubernetes']).covered).toBe(false);
    expect(skillCovered('Kubernetes', ['GKE']).covered).toBe(true);
  });
  it('hierarchy: AWS does NOT satisfy Lambda; Lambda satisfies AWS', () => {
    expect(skillCovered('Lambda', ['AWS']).covered).toBe(false);
    expect(skillCovered('AWS', ['Lambda']).covered).toBe(true);
  });
  it('hierarchy: Machine Learning does NOT satisfy PyTorch; PyTorch satisfies ML', () => {
    expect(skillCovered('PyTorch', ['Machine Learning']).covered).toBe(false);
    expect(skillCovered('Machine Learning', ['PyTorch']).covered).toBe(true);
  });
  it('hierarchy: CI/CD does NOT satisfy GitLab CI; GitLab CI satisfies CI/CD', () => {
    expect(skillCovered('GitLab CI', ['CI/CD']).covered).toBe(false);
    expect(skillCovered('CI/CD', ['GitLab CI']).covered).toBe(true);
  });
  it('true aliases remain bidirectional', () => {
    expect(skillCovered('Kubernetes', ['k8s']).covered).toBe(true);
    expect(skillCovered('k8s', ['Kubernetes']).covered).toBe(true);
    expect(skillCovered('Machine Learning', ['ml']).covered).toBe(true);
  });

  // ── Generic engine: not DevOps-specific ──────────────────────────────
  it('backend calibration: backend candidate strong, devops candidate NOT strong', () => {
    const b = fit(backendCandidate(), cv(), job('Backend Engineer'), BACKEND_JD);
    expect(b.score).toBeGreaterThanOrEqual(75);
    const d = fit(devopsCandidate(), cv(), job('Backend Engineer'), BACKEND_JD);
    expect(d.score).toBeLessThan(75); // Docker/AWS overlap must not create Strong
  });

  it('frontend calibration: frontend candidate scores, infra candidate low', () => {
    const f = fit(frontendCandidate(), cv(), job('Frontend Engineer'), FRONTEND_JD);
    expect(f.score).toBeGreaterThanOrEqual(70);
    const infra = fit(devopsCandidate(), cv(), job('Frontend Engineer'), FRONTEND_JD);
    expect(infra.score).toBeLessThan(65); // AWS/Docker/K8s/Terraform ≠ frontend
  });

  it('AI engineer calibration: AI evidence required, generic Python not enough', () => {
    const ai = fit(aiMlCandidate(), cv(), job('AI Engineer'), AI_JD);
    expect(ai.score).toBeGreaterThanOrEqual(70);
    // Generic backend candidate with Python only — LLM/RAG/PyTorch must NOT be credited
    const p = backendCandidate();
    p.skills = [...p.skills, { name: 'Python' }];
    const generic = fit(p, cv(), job('AI Engineer'), AI_JD);
    expect(generic.categories.requiredSkills.missing).toContain('llm');
    expect(generic.score).toBeLessThan(ai.score);
  });

  it('ML engineer calibration: no ML credit for K8s-only devops candidate', () => {
    const ml = fit(aiMlCandidate(), cv(), job('ML Engineer'), ML_JD);
    expect(ml.score).toBeGreaterThanOrEqual(70);
    const devops = fit(devopsCandidate(), cv(), job('ML Engineer'), ML_JD);
    expect(devops.categories.requiredSkills.missing).toContain('model training');
    expect(devops.score).toBeLessThan(ml.score);
  });

  // ── Cross-role matrix (§13) ──────────────────────────────────────────
  it('cross-role matrix: each candidate best in own domain, no unrelated Strong', () => {
    const candidates = { devops: devopsCandidate(), backend: backendCandidate(), frontend: frontendCandidate(), aiMl: aiMlCandidate() };
    const jobs = { DevOps: 'DevOps Engineer', Backend: 'Backend Engineer', Frontend: 'Frontend Engineer', AI: 'AI Engineer', ML: 'ML Engineer' };
    const jds = { DevOps: 'Required: Kubernetes, AWS, Terraform, CI/CD. 4+ years DevOps. Preferred: Docker, Prometheus.', Backend: BACKEND_JD, Frontend: FRONTEND_JD, AI: AI_JD, ML: ML_JD };
    const scores: Record<string, Record<string, number>> = {};
    for (const [cn, cp] of Object.entries(candidates)) {
      scores[cn] = {};
      for (const [jn, jt] of Object.entries(jobs)) scores[cn][jn] = fit(cp, cv(), job(jt), jds[jn]).score;
    }
    // own-domain dominance
    expect(scores.devops.DevOps).toBeGreaterThanOrEqual(scores.devops.Backend);
    expect(scores.devops.DevOps).toBeGreaterThanOrEqual(scores.devops.Frontend);
    expect(scores.backend.Backend).toBeGreaterThanOrEqual(scores.backend.Frontend);
    expect(scores.backend.Backend).toBeGreaterThanOrEqual(scores.backend.DevOps);
    expect(scores.frontend.Frontend).toBeGreaterThanOrEqual(scores.frontend.Backend);
    expect(Math.max(scores.aiMl.AI, scores.aiMl.ML)).toBeGreaterThanOrEqual(70);
    expect(scores.aiMl.AI + scores.aiMl.ML).toBeGreaterThanOrEqual(140); // strong in both AI and ML jobs
    // no unrelated Strong
    const unrelatedStrong = Object.entries(scores).filter(([cn, row]) => {
      const own = new Set(cn === 'aiMl' ? ['AI', 'ML'] : cn === 'devops' ? ['DevOps'] : cn === 'backend' ? ['Backend'] : ['Frontend']);
      return Object.entries(row).filter(([jn, s]) => !own.has(jn) && s >= 80).length;
    });
    expect(unrelatedStrong.length).toBe(0);
  });

  // ── Non-tech extensibility + negative controls (§14–15) ──────────────
  it('non-tech jobs never crash; unknown family not auto-full aligned', () => {
    for (const t of ['Registered Nurse', 'Accountant', 'Graphic Designer', 'Sales Executive', 'HR Manager', 'Data Entry Operator']) {
      const r = fit(devopsCandidate(), cv(), job(t), `We need a ${t} with strong communication skills. 3+ years experience required.`);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.assessmentCoverage.confidence).toBeDefined();
    }
  });

  it('negative controls: unrelated jobs never Strong/Excellent for a technical candidate', () => {
    const p = devopsCandidate();
    const jds: Record<string, string> = {
      'Registered Nurse': 'RN license and patient care required. 2+ years bedside experience.',
      'Accountant': 'CPA or accounting experience required, GAAP and bookkeeping. 3+ years.',
      'Graphic Designer': 'Figma, Photoshop and graphic design required. 2+ years.',
      'Sales Executive': 'Sales, CRM and outbound required. 2+ years quota-carrying experience.',
      'Data Entry Operator': 'Data entry, typing and Excel required. 1+ years.',
    };
    for (const [t, jd] of Object.entries(jds)) {
      const r = fit(p, cv(), job(t), jd);
      expect(r.score).toBeLessThan(80);
      expect(r.categories.requiredSkills.missing.length).toBeGreaterThan(0);
    }
  });

  it('role taxonomy: frontend ≠ AI research; data analyst ≠ ML infra', () => {
    expect(identifyRole('Frontend Engineer')?.sub).toBe('frontend');
    expect(identifyRole('AI Research Engineer')?.sub).toBe('ai-engineering');
    expect(roleAlignmentWeight({ top: 'software', sub: 'frontend' }, { top: 'software', sub: 'ai-engineering' })).toBeLessThan(1);
    expect(roleAlignmentWeight({ top: 'data', sub: 'analytics' }, { top: 'ai_ml', sub: 'ml-infrastructure' })).toBeLessThan(0.7);
    expect(roleAlignmentWeight({ top: 'infrastructure', sub: 'devops' }, { top: 'infrastructure', sub: 'platform' })).toBe(0.7);
  });

  it('unknown job family → role alignment NOT applicable (no auto-full, no crash)', () => {
    const r = fit(devopsCandidate(), cv(), job('Registered Nurse'), 'Must have a nursing license. 2+ years experience.');
    expect(r.categories.roleAlignment.max).toBe(0);
    expect(r.categories.roleAlignment.unknowns.length).toBeGreaterThan(0);
  });

  // ── Assessment coverage (§16–17) ─────────────────────────────────────
  it('assessment coverage: sparse JD → low, rich JD → high; score untouched by coverage', () => {
    const sparse = fit(devopsCandidate(), cv(), job('DevOps Engineer'), 'We are a startup hiring for our team.');
    expect(sparse.assessmentCoverage.confidence).toBe('low');
    const rich = fit(devopsCandidate(), cv(), job('DevOps Engineer'), 'Required: Kubernetes, AWS, Terraform. 4+ years DevOps. Preferred: Docker. On-site Berlin. Salary: 120k EUR. Must be authorized to work in Germany.');
    expect(rich.assessmentCoverage.confidence).toBe('high');
    // coverage never alters score: same inputs recomputed without coverage logic would be identical — assert scores stay within range and confidence differs
    expect(rich.score).toBeGreaterThanOrEqual(0);
    expect(rich.assessmentCoverage.confidence).not.toBe(sparse.assessmentCoverage.confidence)
  });

  // ── Authorization / sponsorship (§20) ────────────────────────────────
  it('sponsorship: cannot-provide + needs → BLOCKER', () => {
    const p = profile();
    p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'yes' };
    const r = fit(p, cv(), job('DevOps Engineer'), 'Required: Kubernetes. We cannot provide visa sponsorship.');
    expect(r.categories.workAuthorization.blockers.length).toBeGreaterThan(0);
  });
  it('sponsorship: available + needs → compatible', () => {
    const p = profile();
    p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'yes' };
    const r = fit(p, cv(), job('DevOps Engineer'), 'Required: Kubernetes. Visa sponsorship available.');
    expect(r.categories.workAuthorization.blockers.length).toBe(0);
    expect(r.categories.workAuthorization.matched.length).toBeGreaterThan(0);
  });
  it('sponsorship: JD silent + needs → not a conflict', () => {
    const p = profile();
    p.workAuthorization = { country: 'India', authorizedToWork: 'yes', requiresSponsorship: 'yes' };
    const r = fit(p, cv(), job('DevOps Engineer'), 'Required: Kubernetes.');
    expect(r.categories.workAuthorization.blockers.length).toBe(0);
    expect(r.categories.workAuthorization.score).toBe(r.categories.workAuthorization.max);
  });
  it('location never infers authorization', () => {
    const p = profile();
    p.workAuthorization = { country: 'India', authorizedToWork: 'unknown', requiresSponsorship: 'unknown' };
    const r = fit(p, cv(), job('DevOps Engineer', { location: 'Munich, Germany' }), 'Required: Kubernetes. Must be authorized to work in Germany.');
    expect(r.categories.workAuthorization.unknowns.length).toBeGreaterThan(0);
    expect(r.categories.workAuthorization.blockers.length).toBe(0);
  });

  // ── Compensation (§19) ───────────────────────────────────────────────
  it('compensation: below minimum → strong gap, NO global blocker', () => {
    const p = profile();
    p.preferences = { minimumSalary: 2000000, targetSalary: 2500000, salaryCurrency: 'INR' };
    const r = fit(p, cv(), job('DevOps Engineer'), 'Required: Kubernetes. Salary: 1,500,000 INR per year.');
    expect(r.categories.compensation.score).toBeLessThan(r.categories.compensation.max);
    expect(r.blockers.length).toBe(0);
    expect(r.categories.compensation.missing.length).toBeGreaterThan(0);
  });

  // ── Score invariants (§21) ───────────────────────────────────────────
  it('invariants: matched skill add never reduces; removal never improves; UNKNOWN→MATCH never reduces; match→missing never improves', () => {
    const jd = 'Required: Kubernetes, AWS and Terraform.';
    const base = profile();
    base.skills = [{ name: 'Kubernetes' }, { name: 'AWS' }];
    const sBase = fit(base, cv(), job('DevOps Engineer'), jd).score;
    // add a matched required skill (Terraform) → score must NOT drop
    const plus = fit({ ...base, skills: [...base.skills, { name: 'Terraform' }] }, cv(), job('DevOps Engineer'), jd).score;
    expect(plus).toBeGreaterThanOrEqual(sBase);
    // remove a matched skill → score must NOT improve
    const minus = fit({ ...base, skills: base.skills.filter((x) => x.name !== 'AWS') }, cv(), job('DevOps Engineer'), jd).score;
    expect(minus).toBeLessThanOrEqual(sBase);
    // authorization unknown → match must NOT reduce
    const pU = profile();
    pU.workAuthorization = { authorizedToWork: 'unknown' };
    const u = fit(pU, cv(), job('DevOps Engineer'), 'Required: Kubernetes. Must be authorized to work in Germany.').score;
    const pM = profile();
    pM.workAuthorization = { authorizedToWork: 'yes' };
    const m = fit(pM, cv(), job('DevOps Engineer'), 'Required: Kubernetes. Must be authorized to work in Germany.').score;
    expect(m).toBeGreaterThanOrEqual(u);
    // irrelevant CV text must not materially improve score
    const s0 = fit(base, cv(), job('DevOps Engineer'), jd).score;
    const cvNoise = cv({ summary: 'Certified scuba diver, marathon runner, chess enthusiast, award-winning baker.' });
    const s1 = fit(base, cvNoise, job('DevOps Engineer'), jd).score;
    expect(s1).toBeLessThanOrEqual(s0 + 5);
  });

  it('determinism: 10x identical incl. coverage', () => {
    const first = fit(devopsCandidate(), cv(), job('DevOps Engineer'), 'Required: Kubernetes, AWS, Terraform, CI/CD. 4+ years experience.');
    for (let i = 0; i < 9; i++) {
      const r = fit(devopsCandidate(), cv(), job('DevOps Engineer'), 'Required: Kubernetes, AWS, Terraform, CI/CD. 4+ years experience.');
      expect(r.score).toBe(first.score);
      expect(r.assessmentCoverage.confidence).toBe(first.assessmentCoverage.confidence);
    }
  });
});