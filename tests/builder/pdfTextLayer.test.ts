// PDF text layer — every template must extract the candidate name, role and
// section headings as WHOLE strings: ATS parsers read the text layer, not the
// pixels. Regression: the atanu templates drew the name/role/headings
// character-by-character (letter tracking), which split them into per-char
// items during extraction ("A", "t", "a", "n", "u"…) and broke section
// detection.
import { describe, it, expect } from 'vitest';

const { generatePdfBuffer } = await import('../../server/builder/docxGenerator.js');
const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');

const cv: any = {
  candidateName: 'Atanu Biswas',
  targetRole: 'Senior DevSecOps Engineer',
  contactInfo: {
    email: 'atanub707@gmail.com',
    phone: '+91 8420205661',
    location: 'Kolkata, India',
    linkedin: 'https://www.linkedin.com/in/atanu-biswas-006796239/',
  },
  professionalSummary:
    'Senior DevSecOps Engineer with 4+ years building secure, cloud-native CI/CD platforms on AWS, GCP and Azure. Cuts pipeline vulnerabilities by 80% with SAST/DAST/IaC scanning.',
  coreCompetencies: ['Kubernetes', 'Terraform', 'CI/CD'],
  workExperience: [
    {
      title: 'Senior DevSecOps Engineer',
      company: 'Human Managed',
      location: 'Singapore, Remote',
      dates: 'August 2024 – August 2026',
      highlights: [
        'Built an SLA-bound vulnerability remediation workflow, cutting exposed vulnerabilities by 80%.',
        'Moved container builds on GitLab CI/CD to a rootless, non-privileged setup using Kaniko and BuildKit.',
      ],
    },
  ],
  education: [{ degree: 'B.Tech, Mechanical Engineering', institution: 'Narula Institute of Technology', dates: '2019 – 2022' }],
  technicalSkills: [
    { category: 'AWS Services', skills: ['EC2', 'VPC', 'S3'] },
    { category: 'Observability', skills: ['Prometheus', 'Grafana'] },
  ],
  projects: [{ name: 'Tailor AI', description: 'Self-hosted AI job-search platform.', technologies: ['TypeScript'] }],
  certifications: ['Serverless LLM Apps with Amazon Bedrock (DeepLearning.AI)'],
};

async function extractItems(buf: Buffer): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const items: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    for (const it of content.items) items.push(String(it.str));
  }
  return items;
}

describe('PDF text layer is ATS-clean across templates', () => {
  for (const template of ['harvard', 'jake', 'atanu', 'atanu-pro']) {
    it(`${template}: name, role and headings extract as whole strings`, async () => {
      const buf = await generatePdfBuffer(cv, template);
      const items = await extractItems(buf);
      const trimmed = items.map((s) => s.trim());
      const joined = items.join('\n');

      // The name must survive as one coherent string (not per-character).
      expect(trimmed).toContain('Atanu Biswas');
      // The role line may be uppercase in some templates.
      expect(trimmed.some((s) => s.toUpperCase() === 'SENIOR DEVSECOPS ENGINEER')).toBe(true);

      // Standard section headings must be detectable whole words.
      expect(trimmed).toContain('SUMMARY');
      expect(trimmed.some((s) => s === 'SKILLS' || s === 'TECHNICAL SKILLS')).toBe(true);
      expect(trimmed.some((s) => /^(WORK )?EXPERIENCE$/.test(s))).toBe(true);
      expect(trimmed).toContain('EDUCATION');
      expect(trimmed).toContain('CERTIFICATIONS');

      // Skills categories (canonical taxonomy) and metrics survive extraction.
      expect(joined).toContain('AWS Services');
      expect(joined).toContain('EC2');
      expect(joined).toContain('Prometheus');
      expect(joined).toContain('80%');

      // No per-character garbage: the longest single-char run must be tiny.
      const singleCharItems = trimmed.filter((s) => s.length === 1 && /[A-Za-z]/.test(s)).length;
      expect(singleCharItems).toBeLessThan(6);
    });
  }
});
