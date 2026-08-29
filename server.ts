import 'dotenv/config';
import crypto from 'crypto';
import { execSync } from 'node:child_process';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import * as pdfParseModule from 'pdf-parse';
import mammoth from 'mammoth';
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';

async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string> {
  try {
    const mod: any = pdfParseModule;
    if (mod && typeof mod === 'function') {
      const res = await mod(buffer);
      if (res?.text && res.text.trim().length > 0) return res.text;
    }
    if (mod && typeof mod.default === 'function') {
      const res = await mod.default(buffer);
      if (res?.text && res.text.trim().length > 0) return res.text;
    }
    if (mod && mod.PDFParse) {
      const parser = new mod.PDFParse({ data: buffer });
      const res = await parser.getText();
      if (typeof res === 'string' && res.trim().length > 0) return res;
      if (res && typeof res.text === 'string' && res.text.trim().length > 0) return res.text;
    }
  } catch (err) {
    console.warn('pdf-parse encountered an error extracting text:', err);
  }

  // Raw text stream regex fallback for PDF text extraction if pdf-parse fails or returns empty
  try {
    const str = buffer.toString('utf-8');
    const matches = str.match(/\(([^()]{2,})\)\s*T[jd]/g);
    if (matches && matches.length > 0) {
      const extracted = matches
        .map((m) => m.replace(/^\(/, '').replace(/\)\s*T[jd]$/, '').trim())
        .filter((t) => t.length > 1)
        .join(' ');
      if (extracted.length > 20) {
        return extracted;
      }
    }
  } catch (e) {
    // ignore
  }

  return '';
}

import { loadConfig, saveConfig } from './server/config.js';
import {
  getDb,
  getMasterCv,
  saveMasterCv,
  createUser,
  verifyLogin,
  getRecoveryInfo,
  resetPasswordWithRecovery,
  setRecoveryQuestions,
  listUsers,
  getUserById,
  createSession,
  getSessionUser,
  deleteSession,
  runWithUser,
  getCurrentUserId,
  getAllJobs,
  getJobById,
  updateJobInStorage,
  deleteJobFromStorage,
  deleteAllJobs,
  queryJobs,
  saveNewJobs,
  persistJobsWithUpgrade,
  getLpHistory,
  mergeLpHistory,
  markLpHistorySaved,
  clearLpHistory,
  runStorageMigration,
  fixMislabeledWorkTypes,
  repairJobDates,
  saveManualAnalysis,
  listManualAnalyses,
  getManualAnalysis,
  deleteManualAnalysis,
  saveCvVersion,
  listCvVersions,
  getCvVersion,
  deleteCvVersion,
  getCandidateProfile,
  saveCandidateProfile,
  listPortalBookmarks,
  addPortalBookmark,
  removePortalBookmark,
  listContacts,
  getContactById,
  recordContactEmail,
  recordContactEmailDetail,
  listContactCompanies,
  listContactsForJob,
  setContactHidden,
  setContactFollowUp,
  setContactFollowedUp,
  setContactPipeline,
  addContactNote,
  listContactEmails,
  getContactStats,
  listContactsCsv,
  backfillContacts,
  upsertContactsFromJob,
  getPostsDailyUsage,
  addPostsDailyUsage,
} from './server/storage/fileStorage.js';
import { ScraperFactory } from './server/scraper/scraperFactory.js';
import { LinkedInPostsScraper } from './server/scraper/linkedInPostsScraper.js';
import { LlmMatcher } from './server/matcher/llmMatcher.js';
import { hasApiKeyConfigured, mapLlmError } from './server/llm/apiKeyGuard.js';
import { LlmCvTailor } from './server/builder/llmCvTailor.js';
import { generatePdfBuffer, generatePlainTextCv } from './server/builder/docxGenerator.js';
import { JobFilterQueryParams, Job, MasterCv } from './src/types.js';
import { SOURCES } from './src/constants/sources.js';
import { isEmailFormatValid } from './src/lib/recruiters/emailUtils.js';
import { compressCv } from './server/ai/cvCompressor.js';
import { getMarketData } from './server/ai/marketData.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max file size
});

function fallbackParseCvFromText(rawText: string) {
  const lines = (rawText || '').split('\n').map((l) => l.trim()).filter(Boolean);

  let fullName = 'Candidate Name';
  let email = '';
  let phone = '';
  let location = '';
  let linkedin = '';
  let github = '';
  let website = '';

  for (const line of lines) {
    if (!email && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(line)) {
      const match = line.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (match) email = match[0];
    }
    if (!phone && /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(line)) {
      const match = line.match(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      if (match) phone = match[0];
    }
    if (!linkedin && /linkedin\.com\/in\/[a-zA-Z0-9_-]+/i.test(line)) {
      const match = line.match(/https?:\/\/[^\s]+/i) || line.match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
      if (match) linkedin = match[0];
    }
    if (!github && /github\.com\/[a-zA-Z0-9_-]+/i.test(line)) {
      const match = line.match(/https?:\/\/[^\s]+/i) || line.match(/github\.com\/[a-zA-Z0-9_-]+/i);
      if (match) github = match[0];
    }
  }

  for (const line of lines.slice(0, 5)) {
    if (line.length < 40 && !line.includes('@') && !line.includes('http') && !line.toLowerCase().includes('resume') && !line.toLowerCase().includes('curriculum')) {
      fullName = line;
      break;
    }
  }

  const knownSkills = [
    'TypeScript', 'JavaScript', 'React', 'Node.js', 'Python', 'Java', 'C++', 'Go',
    'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'SQL', 'PostgreSQL', 'MongoDB',
    'GraphQL', 'REST API', 'Git', 'Linux', 'CI/CD', 'Terraform', 'Microservices',
    'DevOps', 'HTML', 'CSS', 'Tailwind', 'Redux', 'Next.js', 'Express'
  ];
  const foundSkills: string[] = [];
  const textLower = (rawText || '').toLowerCase();
  for (const s of knownSkills) {
    if (textLower.includes(s.toLowerCase())) {
      foundSkills.push(s);
    }
  }

  const paragraphs = (rawText || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const summary = paragraphs[0] || (rawText || '').slice(0, 300) || 'Experienced software professional.';

  return {
    fullName,
    email: email || 'candidate@example.com',
    phone: phone || '+1 (555) 000-0000',
    location: location || 'Remote',
    linkedin,
    github,
    website,
    summary,
    experiences: [
      {
        id: 'exp-1',
        title: 'Senior Engineer / IT Specialist',
        company: 'Professional Organization',
        location: location || 'Remote / Hybrid',
        dates: '2021 - Present',
        responsibilities: paragraphs.slice(1, 6).map((p) => p.slice(0, 200)) || [
          'Engineered scalability, infrastructure resilience, and cloud operations.',
          'Collaborated with cross-functional technical teams.',
        ],
      },
    ],
    education: [
      {
        id: 'edu-1',
        degree: 'Degree in Engineering / Science / Technology',
        institution: 'Academic Institution',
        dates: 'Graduated',
        details: 'Core technical focus',
      },
    ],
    skills: [
      {
        category: 'Core Competencies',
        items: foundSkills.length > 0 ? foundSkills : ['Engineering', 'Software Development', 'System Architecture'],
      },
    ],
    projects: [],
    certifications: [],
    rawText: rawText || '',
  };
}

import { ask } from './server/llm/llmAdapter.js';
import { startInterview, askNextQuestion, scoreAnswer, buildScorecard, getInterviewSession, getRoleOptions, getJobsForRole } from './server/interview.js';
import { saveInterviewSession, getInterviewHistory, getInterviewSessionRecord } from './server/storage/fileStorage.js';
import nodemailer from 'nodemailer';

// Convert the stored Master CV into the TailoredCv shape the PDF generator
// consumes (same conversion the master-download route uses).
function masterCvToTailoredCv(m: ReturnType<typeof getMasterCv>): any {
  return {
    candidateName: m.fullName,
    contactInfo: {
      email: m.email,
      phone: m.phone,
      location: m.location,
      linkedin: m.linkedin,
      github: m.github,
      website: m.website,
    },
    targetRole: m.experiences[0]?.title || '',
    professionalSummary: m.summary,
    coreCompetencies: m.skills.flatMap((s) => s.items),
    workExperience: m.experiences.map((e) => ({
      title: e.title,
      company: e.company,
      location: e.location,
      dates: e.dates,
      highlights: e.responsibilities,
    })),
    education: m.education.map((e) => ({
      degree: e.degree,
      institution: e.institution,
      dates: e.dates,
      details: e.details || '',
    })),
    technicalSkills: m.skills.map((s) => ({
      category: s.category,
      skills: s.items,
    })),
    projects: m.projects || [],
    certifications: (m.certifications || []).map((c) =>
      typeof c === 'string' ? c : `${c.name}${c.issuer ? ' (' + c.issuer + ')' : ''}`
    ),
  };
}

async function parseCvWithLLM(
  input: string | { buffer: Buffer; mimeType: string; originalName: string }
) {
  let rawText = typeof input === 'string' ? input : '';
  let fileInfo = typeof input === 'object' ? input : null;

  if (fileInfo) {
    const { buffer, mimeType, originalName } = fileInfo;
    const filenameLower = originalName.toLowerCase();

    if (mimeType === 'application/pdf' || filenameLower.endsWith('.pdf')) {
      rawText = await extractTextFromPdfBuffer(buffer);
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filenameLower.endsWith('.docx')
    ) {
      try {
        const parsedDocx = await mammoth.extractRawText({ buffer });
        rawText = parsedDocx.value || '';
      } catch (err) {
        console.warn('mammoth docx extraction error:', err);
      }
    } else {
      rawText = buffer.toString('utf-8');
    }
  }

  const promptText = `You are an expert ATS resume parser. 
Extract every detail from A to Z from the resume into clean, structured JSON.

INSTRUCTIONS:
1. Contact Details: Extract Full Name, Email, Phone Number, Location/Address, LinkedIn URL, GitHub URL, and Portfolio Website.
2. Professional Summary: Extract or formulate a thorough 3-5 sentence master professional summary covering the candidate's core domain, years of experience, and key value proposition.
3. Work History (Experiences): Extract EVERY job role with Title, Company, Location, Dates (e.g., "Jan 2021 - Present"), and an array of individual responsibilities/achievements as bullet points.
4. Education: Extract degrees, university/institution names, graduation dates/years, and any honors or details.
5. Technical Skills: Group skills into logical categories (e.g., "Languages & Frameworks", "Cloud & Infrastructure", "Tools & Methodologies") with an array of individual skill tags.
6. Projects: Extract any key projects mentioned with Project Name, Description, Technologies used (array of strings), Link/URL, and Dates/Period.
7. Certifications: Extract any professional certifications, licenses, or credentials with Certification Name, Issuer (e.g., AWS, Microsoft, Google), Date obtained, and Link if available.

Return valid JSON with these exact fields: fullName, email, phone, location, linkedin, github, website, summary, experiences (array of {title, company, location, dates, responsibilities[]}), education (array of {degree, institution, dates, details}), skills (array of {category, items[]}), projects (array of {name, description, technologies[], link, dates}), certifications (array of {name, issuer, date, link}).

RAW RESUME TEXT:
${rawText || 'No readable text extracted.'}`;

  try {
    const jsonText = await ask(promptText, 0.1);
    const parsedData = JSON.parse(jsonText);

    return {
      fullName: parsedData.fullName || 'Candidate Name',
      email: parsedData.email || '',
      phone: parsedData.phone || '',
      location: parsedData.location || '',
      linkedin: parsedData.linkedin || '',
      github: parsedData.github || '',
      website: parsedData.website || '',
      summary: parsedData.summary || '',
      experiences: (parsedData.experiences || []).map((exp: any, i: number) => ({
        id: `exp-${i + 1}`,
        title: exp.title || 'Role',
        company: exp.company || 'Company',
        location: exp.location || '',
        dates: exp.dates || '',
        responsibilities: Array.isArray(exp.responsibilities) ? exp.responsibilities : [],
      })),
      education: (parsedData.education || []).map((edu: any, i: number) => ({
        id: `edu-${i + 1}`,
        degree: edu.degree || 'Degree',
        institution: edu.institution || 'University',
        dates: edu.dates || '',
        details: edu.details || '',
      })),
      skills: (parsedData.skills || []).map((sk: any) => ({
        category: sk.category || 'Core Skills',
        items: Array.isArray(sk.items) ? sk.items : [],
      })),
      projects: (parsedData.projects || []).map((p: any, i: number) => ({
        id: `proj-${i + 1}`,
        name: p.name || 'Project Name',
        description: p.description || '',
        technologies: Array.isArray(p.technologies) ? p.technologies : [],
        link: p.link || '',
        dates: p.dates || '',
      })),
      certifications: (parsedData.certifications || []).map((c: any, i: number) => {
        if (typeof c === 'string') {
          return { id: `cert-${i + 1}`, name: c, issuer: '', date: '', link: '' };
        }
        return {
          id: `cert-${i + 1}`,
          name: c.name || 'Certification Name',
          issuer: c.issuer || '',
          date: c.date || '',
          link: c.link || '',
        };
      }),
      rawText,
    };
  } catch (err: any) {
    console.warn('LLM parse call failed, using fallback parser:', err?.message || err);
    return fallbackParseCvFromText(rawText);
  }
}

// Convert a plain-text email body (which may contain the candidate's phone
// and portfolio from the Master CV) into safe HTML with clickable tel: and
// https: links — recipients can tap-to-call or open the portfolio directly
// from the email instead of seeing plain text.
import { textBodyToHtmlWithLinks } from './server/emailHtml.js';
import { buildProfileText } from './server/emailProfile.js';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // One-time data fix: re-derive LinkedIn work-type labels that were
  // incorrectly defaulted to "Full-time · Remote" (idempotent).
  const fixedTypes = fixMislabeledWorkTypes();
  if (fixedTypes > 0) console.log(`[data-fix] Reclassified ${fixedTypes} mislabeled jobs`);
  // Repair malformed stored dates (doubled timestamps).
  const fixedDates = repairJobDates();
  if (fixedDates > 0) console.log(`[data-fix] Repaired ${fixedDates} malformed job dates`);

  // Session middleware: resolve the auth cookie to a user and make it
  // available to every handler (and storage call) for this request.
  app.use((req, _res, next) => {
    const cookieHeader = (req.headers.cookie || '').split(';').map((s) => s.trim());
    const match = cookieHeader.find((c) => c.startsWith('ats_session='));
    const token = match ? match.slice('ats_session='.length) : '';
    const userId = token ? getSessionUser(token) : undefined;
    if (userId) {
      runWithUser(userId, () => next());
    } else {
      runWithUser('', () => next());
    }
  });

  // Warn if a previously-committed (compromised) API key is still in use
  // Compromised keys stored as SHA-256 hashes (never plaintext in the repo).
  // Hash of the previously leaked key; compare by hashing the configured key.
  const COMPROMISED_KEY_HASHES = new Set(['a2117087d9a8d23cd2b4f14d61139102293d11bfc0faf57552d02b50f402274a']);
  const configuredKey = loadConfig().llm.apiKey;
  const configuredKeyHash = crypto.createHash('sha256').update(configuredKey || '').digest('hex');
  if (COMPROMISED_KEY_HASHES.has(configuredKeyHash)) {
    console.warn('\n==========================================================');
    console.warn('⚠️  SECURITY WARNING: Your API key was exposed in an old');
    console.warn('    public git commit. Anyone with repo history has it.');
    console.warn('    Generate a NEW key in your LLM provider dashboard and');
    console.warn('    paste it in Settings → LLM API Key (or config.ini).');
    console.warn('    Then revoke the old key on the provider side.');
    console.warn('==========================================================\n');
  }

  // Seed sample jobs if store is completely empty on initial startup.
  // Runs in the first user's context so the seed lands in a real account.
  const { ensureV2Tables, seedCompanyCareerSites } = await import('./server/storage/v2Tables.js');
  ensureV2Tables();
  seedCompanyCareerSites();

  // Local ATS index (flag-gated): schema + in-process background ingestion.
  // The scheduler tick is async and never blocks startup or HTTP requests;
  // the index lives on the persistent ./data volume and survives restarts.
  {
    const { ATS_FLAGS } = await import('./server/providers/providerRegistry.js');
    if (ATS_FLAGS.ENABLE_LOCAL_ATS_INDEX) {
      const { ensureAtsIndexSchema } = await import('./server/ats-index/atsRepository.js');
      const { createAtsScheduler } = await import('./server/ats-index/atsScheduler.js');
      ensureAtsIndexSchema();
      const platforms = (process.env.ATS_INDEX_PLATFORMS ?? 'greenhouse')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s === 'greenhouse' || s === 'lever' || s === 'ashby');
      const schedulers = platforms.map((p) => createAtsScheduler(p));
      for (const s of schedulers) s.start();
      console.log(`[ATS Index] local ATS index enabled (platforms: ${platforms.join(', ')})`);
    }
  }

  const seedUser = (getDb().prepare('SELECT id FROM users ORDER BY is_guest ASC, created_at ASC LIMIT 1').get() as any)?.id as string | undefined;
  if (seedUser) {
    runWithUser(seedUser, () => {
      const initialJobs = getAllJobs();
      if (initialJobs.length === 0) {
        (async () => {
          const sampleScrape = await ScraperFactory.runScrape({
            keywords: 'Full Stack TypeScript Engineer',
            location: 'Remote',
            sources: ['LinkedIn'],
            maxJobsPerSource: 5,
          });
          saveNewJobs(sampleScrape);
        })();
      }
    });
  }

  // --- API ROUTES ---

  // Installed version of this app (read from the package.json shipped in the image).
  const readInstalledVersion = (): string => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  };

  // Compare dotted version strings (with optional leading "v"), e.g. v1.7.0 > v1.6.9.
  const versionGt = (a: string, b: string): boolean => {
    const parse = (v: string) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const [pa, pb] = [parse(a), parse(b)];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff > 0;
    }
    return false;
  };

  // Update check: pull the latest version of this repo's main branch straight
  // from GitHub (no API key, no CORS). The contents API reads the git blob
  // directly, so the banner shows the moment a push lands (raw.githubusercontent
  // is CDN-cached and can lag minutes). The client shows a banner whenever
  // the installed version is behind the pushed one. GitHub webhooks can't
  // reach self-hosted Docker installs (no public inbound URL), so installs
  // poll this endpoint instead — same UX, no inbound traffic.
  app.get('/api/update-check', async (_req, res) => {
    const installed = readInstalledVersion();
    const repo = 'https://github.com/Atanub707/Tailor-AI';
    try {
      const apiRes = await fetch('https://api.github.com/repos/Atanub707/Tailor-AI/contents/package.json?ref=main', {
        headers: { 'User-Agent': 'tailor-ai', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000),
      });
      if (apiRes.ok) {
        const api = await apiRes.json();
        const latest = (JSON.parse(Buffer.from(api.content, 'base64').toString('utf8')).version || '');
        return res.json({ updateAvailable: versionGt(latest, installed), installed, latest, repo });
      }
      // Fallback: raw file (CDN-cached, may lag briefly after a push).
      const rawRes = await fetch('https://raw.githubusercontent.com/Atanub707/Tailor-AI/main/package.json', { signal: AbortSignal.timeout(8000) });
      if (!rawRes.ok) return res.json({ updateAvailable: false, installed, repo });
      const latest = (await rawRes.json()).version || '';
      return res.json({ updateAvailable: versionGt(latest, installed), installed, latest, repo });
    } catch {
      return res.json({ updateAvailable: false, installed, repo });
    }
  });

  // One-click auto-update: pull the latest main from GitHub, reinstall deps if
  // the lockfile changed, then exit — Docker's restart:unless-stopped brings
  // the app back up on the new code. Data lives outside git (data/, config.ini
  // are gitignored), so it is never touched. Works because installs mount the
  // live source at /app (docker-compose) — this only runs on git checkouts.
  app.post('/api/update', (_req, res) => {
    try {
      const isRepo = execSync('git -C /app rev-parse --is-inside-work-tree 2>/dev/null || echo no', { encoding: 'utf8' }).trim();
      if (isRepo !== 'true') {
        return res.status(400).json({ error: 'Auto-update unavailable on this install (not a git checkout). Update manually: git pull && docker compose build && docker compose up -d.' });
      }
      // Respond first; the heavy work happens after the client got the OK.
      res.json({ ok: true, message: 'Updating — the app will restart automatically in a few seconds.' });
      const lockBefore = (() => {
        try { return crypto.createHash('sha256').update(readFileSync('/app/package-lock.json')).digest('hex'); } catch { return ''; }
      })();
      execSync('git -C /app fetch origin main && git -C /app reset --hard origin/main', { stdio: 'inherit', timeout: 120000 });
      const lockAfter = (() => {
        try { return crypto.createHash('sha256').update(readFileSync('/app/package-lock.json')).digest('hex'); } catch { return ''; }
      })();
      if (lockBefore !== lockAfter) {
        execSync('npm install --loglevel=error', { cwd: '/app', stdio: 'inherit', timeout: 600000 });
      }
      // Let the response flush, then hand over to Docker's restart policy.
      setTimeout(() => process.exit(0), 2000);
    } catch (err: any) {
      try { res.status(500).json({ error: `Update failed: ${err?.message || 'unknown error'}` }); } catch { /* response already sent */ }
    }
  });

  // Configuration routes
  app.get('/api/config', (req, res) => {
    res.json(loadConfig());
  });

  // Source registry — lets clients (and API consumers) see which sources
  // are Apify-powered and what each Apify source costs per 1K jobs.
  app.get('/api/sources', (_req, res) => {
    res.json({ sources: Object.values(SOURCES) });
  });

  app.post('/api/config', (req, res) => {
    try {
      saveConfig(req.body);
      res.json({ success: true, config: loadConfig() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Test an LLM connection with the CURRENT form values (nothing is saved).
  app.post('/api/settings/test-llm', async (req, res) => {
    try {
      const { provider, apiKey, baseUrl, model } = req.body || {};
      const p = String(provider || 'opencode-go');
      const key = String(apiKey || '').trim();
      const mdl = String(model || '').trim();
      if (!key) {
        res.status(400).json({ ok: false, error: 'Enter an API key first.' });
        return;
      }
      if (!mdl) {
        res.status(400).json({ ok: false, error: 'Enter a model name first.' });
        return;
      }
      const started = Date.now();
      const TIMEOUT_MS = 20_000; // bounded probe — never hangs the settings UI
      const check = async (): Promise<void> => {
        if (p === 'gemini') {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(key)}`;
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!r.ok) throw new Error(`Gemini API error ${r.status}`);
          return;
        }
        if (p === 'anthropic') {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: mdl, messages: [{ role: 'user', content: 'ping' }] }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!r.ok) throw new Error(`Anthropic API error ${r.status}`);
          return;
        }
        const base = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('Enter a Base URL first.');
        // IMPORTANT: no max_tokens in the probe — the opencode.ai router
        // HANGS (never responds) when max_tokens is present, even for a
        // valid key. The probe mirrors the working completion shape.
        const r = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: mdl, messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (r.status === 404) throw new Error('Model or endpoint not found (404) — check the model name and base URL.');
        if (!r.ok) throw new Error(`API error ${r.status}`);
      };
      await check();
      res.json({ ok: true, latencyMs: Date.now() - started });
    } catch (err: any) {
      console.error('LLM test failed:', err.message);
      res.status(502).json({ ok: false, error: String(err?.message || 'Connection failed.').slice(0, 300) });
    }
  });

  // ── Applicant Profile v1 (scoped to logged-in user, local-only) ──────────
  app.get('/api/applicant-profile', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getApplicantProfile } = await import('./server/storage/applicantProfile.js');
      res.json(getApplicantProfile(userId));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to load profile.' });
    }
  });

  app.put('/api/applicant-profile', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { validateApplicantProfile, saveApplicantProfile, getApplicantProfile } = await import('./server/storage/applicantProfile.js');
      const profile = req.body;
      const v = validateApplicantProfile(profile);
      if (!v.ok) {
        res.status(422).json({ error: v.errors[0], details: v.errors });
        return;
      }
      saveApplicantProfile(profile, userId);
      res.json({ success: true, profile: getApplicantProfile(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to save profile.' });
    }
  });

  // Deterministic import from the structured Master CV — only fills EMPTY
  // fields; a populated profile is never silently overwritten.
  app.post('/api/applicant-profile/import-master-cv', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getApplicantProfile, saveApplicantProfile } = await import('./server/storage/applicantProfile.js');
      const { importMasterCvIntoProfile } = await import('./server/profile/cvImporter.js');
      const current = getApplicantProfile(userId);
      const merged = importMasterCvIntoProfile(current, getMasterCv(userId));
      saveApplicantProfile(merged, userId);
      res.json({ success: true, profile: merged, filledFromCv: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Import failed.' });
    }
  });

  // Local JSON export — profile only; NEVER includes provider secrets.
  app.get('/api/applicant-profile/export', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getApplicantProfile } = await import('./server/storage/applicantProfile.js');
      const profile = getApplicantProfile(userId);
      const safe = JSON.parse(JSON.stringify(profile));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="applicant-profile.json"');
      res.json(safe);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Export failed.' });
    }
  });

  // Master CV routes (scoped to logged-in user)
  app.get('/api/cv/master', (req, res) => {
    const userId = getCurrentUserId();
    if (!userId) return res.status(401).json({ error: 'Not signed in.' });
    res.json(getMasterCv(userId));
  });

  app.post('/api/cv/master', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      saveMasterCv(req.body, userId);
      res.json({ success: true, cv: getMasterCv(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/profile', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      res.json({ profile: getCandidateProfile() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/profile', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const profile = req.body?.profile;
      if (!profile || typeof profile !== 'object') {
        return res.status(400).json({ error: 'Profile is required.' });
      }
      const p = profile as any;
      const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      const bool = (v: unknown): boolean => v === true;
      const relocation = (v: unknown): 'yes' | 'no' | 'certain-cities' => (v === 'yes' || v === 'certain-cities' ? v : v === true ? 'yes' : 'no');
      const clean = {
        workModes: arr(p.workModes), preferredLocations: arr(p.preferredLocations),
        noticePeriod: str(p.noticePeriod), availableFrom: str(p.availableFrom),
        employmentTypes: arr(p.employmentTypes), yearsExperience: str(p.yearsExperience),
        currentRole: str(p.currentRole), currentCompany: str(p.currentCompany),
        currentSalary: str(p.currentSalary), expectedSalaryMin: str(p.expectedSalaryMin),
        expectedSalaryMax: str(p.expectedSalaryMax), salaryCurrency: str(p.salaryCurrency),
        jobSearchStatus: str(p.jobSearchStatus), willingToRelocate: relocation(p.willingToRelocate),
        willingToTravelPct: str(p.willingToTravelPct), workAuthorization: str(p.workAuthorization),
        needsSponsorship: bool(p.needsSponsorship), languages: arr(p.languages),
        preferredCompanySize: str(p.preferredCompanySize), recruiterNote: str(p.recruiterNote),
      };
      saveCandidateProfile(clean);
      res.json({ success: true, profile: getCandidateProfile() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── LinkedIn Posts (job postings, last 24h) ──
  // Daily cap (20/day, resets at midnight) applies to the APIFY engine only —
  // it protects the user's token spend. The FREE engine is unlimited.
  app.post('/api/linkedin-posts/search', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const keywords = String(req.body?.keywords || '').trim();
      if (!keywords) return res.status(400).json({ error: 'Keywords are required.' });
      const engine = req.body?.engine === 'apify' ? 'apify' : 'free';
      // Apify: show all ~100 posts the actor fetched. Free: cap at 20.
      const limit = Math.min(engine === 'apify' ? 100 : 20, Math.max(1, Number(req.body?.limit) || 20));
      const quota = getPostsDailyUsage(userId);
      if (engine === 'apify' && quota.used >= quota.quota) {
        return res.status(429).json({
          valid: false,
          error: `Apify daily limit reached: ${quota.quota} search used today. Resets at ${new Date(quota.resetAt).toLocaleTimeString()}. Switch to the Free engine — it has no limit.`,
          quota,
        });
      }

      let posts: Job[] = [];
      let debug: Record<string, unknown> = {};
      {
        const scraper = new LinkedInPostsScraper();
        posts = await scraper.scrape({
          keywords,
          location: '',
          sources: [],
          datePostedFilter: '24h',
          jobType: 'all',
          maxJobsPerSource: limit,
          engine,
        } as any);
        debug = { ...scraper.lastDebug };
        // Job-posting search only — anything else returns "not valid".
        if (posts.length === 0) {
          const remaining = engine === 'apify' ? Math.max(0, quota.quota - quota.used) : quota.quota;
          // RESEARCH: distinguish "engines blocked/rate-limited" from "engines
          // found links but none were job postings in the last 24h".
          const discoveryFailed = scraper.lastDebug.linksFound === 0;
          return res.status(200).json({
            valid: false,
            discoveryFailed,
            message: discoveryFailed
              ? `Search engines returned no results from this server — likely rate-limited or blocked (${scraper.lastDebug.queriesTried} queries tried). Try again in a minute.`
              : 'not valid — engines found posts but none were job postings from the last 24 hours. Try broader keywords.',
            debug: scraper.lastDebug,
            posts: [],
            addedCount: 0,
            total: 0,
            quota: { ...quota, remaining },
          });
        }
      }
      // Apify engine: cap the search at the remaining daily quota (10/day max).
      const remaining = engine === 'apify' ? Math.max(0, quota.quota - quota.used) : posts.length;
      const cappedPosts = engine === 'apify' ? posts.slice(0, remaining) : posts;
      if (engine === 'apify' && cappedPosts.length === 0) {
        return res.status(429).json({
          valid: false,
          error: `Apify daily limit reached: ${quota.quota} search used today. Resets at ${new Date(quota.resetAt).toLocaleTimeString()}. Switch to the Free engine — it has no limit.`,
          quota,
        });
      }
      // Search results are NOT auto-saved as jobs — they live on the search
      // screen only, persisted per user in the lp_history table so they
      // survive refresh/browser/device. Explicit saves go via
      // POST /api/linkedin-posts/save.
      if (posts.length > 0) {
        mergeLpHistory(
          userId,
          posts.map((p) => ({
            id: p.id,
            title: p.title,
            company: p.company,
            url: p.url,
            applyUrl: p.applyUrl,
            postedDate: p.postedDate,
            description: p.description,
            hashtags: p.hashtags || [],
          }))
        );
      }
      const newUsed = engine === 'apify' ? addPostsDailyUsage(userId, cappedPosts.length) : quota.used;
      res.json({
        valid: true,
        debug,
        posts: posts.map((p) => ({
          id: p.id,
          title: p.title,
          company: p.company,
          url: p.url,
          applyUrl: p.applyUrl,
          postedDate: p.postedDate,
          description: (p.description || '').slice(0, 500),
          hashtags: p.hashtags || [],
        })),
        addedCount: 0,
        upgradedCount: 0,
        total: posts.length,
        quota: { used: newUsed, quota: quota.quota, remaining: Math.max(0, quota.quota - newUsed), resetAt: quota.resetAt },
      });
    } catch (err: any) {
      console.error('LinkedIn posts search error:', err);
      res.status(500).json({ error: err?.message || 'Could not search LinkedIn posts.' });
    }
  });

  // Save ONE LinkedIn post from the search screen to the user's job list
  // (dashboard). Idempotent: already-saved posts are skipped.
  app.post('/api/linkedin-posts/save', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const p = req.body?.post;
      if (!p?.title || !p?.url) return res.status(400).json({ error: 'Post is required.' });
      const job: Job = {
        id: String(p.id || `linkedinpost-${crypto.createHash('sha1').update(String(p.url)).digest('base64url').slice(0, 20)}`),
        title: String(p.title).slice(0, 110),
        company: String(p.company || 'Unknown Company').slice(0, 100),
        url: String(p.url),
        applyUrl: String(p.applyUrl || ''),
        location: '',
        postedDate: String(p.postedDate || new Date().toISOString()),
        description: String(p.description || '').slice(0, 3000),
        hashtags: Array.isArray(p.hashtags) ? p.hashtags.map(String).slice(0, 10) : [],
        source: 'LinkedInPosts',
        jobType: 'Post',
        state: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const { added } = persistJobsWithUpgrade([job]);
      markLpHistorySaved(userId, job.id);
      res.json({ saved: added.length > 0, alreadySaved: added.length === 0, id: job.id });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not save post.' });
    }
  });

  // LinkedIn Posts search history — per user, server-side. Returns every post
  // found on the search screen so it survives refresh/browser/device.
  app.get('/api/linkedin-posts/history', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      res.json({ posts: getLpHistory(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load LinkedIn Posts history.' });
    }
  });

  app.delete('/api/linkedin-posts/history', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      clearLpHistory(userId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not clear LinkedIn Posts history.' });
    }
  });

  // ── AI System · Interview (job-description grounded) ──
  app.get('/api/interview/roles', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      res.json({ roles: getRoleOptions() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load roles.' });
    }
  });

  app.get('/api/interview/jobs', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const role = String(req.query.role || '').trim();
      if (!role) return res.json({ jobs: [] });
      res.json({ jobs: getJobsForRole(role).map((j) => ({ id: j.id, title: j.title, company: j.company })) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load jobs.' });
    }
  });

  app.post('/api/interview/start', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const role = String(req.body?.role || req.body?.targetRole || '').trim();
      if (!role) return res.status(400).json({ error: 'Target role is required.' });
      const session = startInterview({
        role,
        experienceYears: String(req.body?.experienceYears || ''),
        jobIds: Array.isArray(req.body?.jobIds) ? req.body.jobIds.map(String) : req.body?.jobId ? [String(req.body.jobId)] : undefined,
      });
      const { question, jobTitle, company } = await askNextQuestion(session);
      res.json({ sessionId: session.id, question, jobTitle, company, questionIndex: 1, total: session.total });
    } catch (err: any) {
      console.error('Interview start error:', err);
      res.status(500).json({ error: err?.message || 'Could not start the interview.' });
    }
  });

  app.post('/api/interview/answer', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const session = getInterviewSession(String(req.body?.sessionId || ''));
      if (!session) return res.status(404).json({ error: 'Interview session expired. Start a new one.' });
      const answer = String(req.body?.answer || '').trim();
      if (!answer) return res.status(400).json({ error: 'Answer is required.' });
      const last = session.qa[session.qa.length - 1];
      const { score, feedback, dims } = await scoreAnswer(session, last?.question || 'your last question', last?.jobTitle || session.role, last?.company || '', answer);
      if (session.qIndex >= session.total) {
        const scorecard = await buildScorecard(session);
        saveInterviewSession({
          id: session.id,
          role: session.role,
          total: session.total,
          overall: scorecard.overall,
          verdict: scorecard.verdict,
          perQuestion: scorecard.perQuestion,
        });
        return res.json({ done: true, scorecard, sessionId: session.id });
      }
      const { question, jobTitle, company } = await askNextQuestion(session);
      res.json({ done: false, score, feedback, dims, question, jobTitle, company, questionIndex: session.qIndex + 1, total: session.total });
    } catch (err: any) {
      console.error('Interview answer error:', err);
      res.status(500).json({ error: err?.message || 'Could not evaluate your answer.' });
    }
  });

  // Interview history
  app.get('/api/interview/history', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      res.json({ sessions: getInterviewHistory() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load interview history.' });
    }
  });

  app.get('/api/interview/history/:id', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const record = getInterviewSessionRecord(req.params.id);
      if (!record) return res.status(404).json({ error: 'Interview not found.' });
      res.json({ session: record });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not load the interview.' });
    }
  });

  // ── Auth ──
  app.get('/api/auth/me', (req, res) => {
    const userId = getCurrentUserId();
    if (!userId) return res.json({ user: null });
    const user = getUserById(userId);
    res.json({ user: user ? { id: user.id, email: user.email, name: user.name, isGuest: user.isGuest } : null });
  });

  app.post('/api/auth/register', (req, res) => {
    try {
      const { email, password, name, recoveryQ1, recoveryA1, recoveryQ2, recoveryA2 } = req.body;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email is required.' });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }
      // Recovery questions are mandatory for password accounts (local
      // forgot-password mechanism — no email service exists).
      if (!recoveryQ1 || !recoveryA1 || !recoveryQ2 || !recoveryA2) {
        return res.status(400).json({ error: 'Please set two recovery questions (answers at least 3 characters).' });
      }
      if (String(recoveryA1).trim().length < 3 || String(recoveryA2).trim().length < 3) {
        return res.status(400).json({ error: 'Recovery answers must be at least 3 characters.' });
      }
      const displayName = (name || '').trim() || email.split('@')[0];
      const user = createUser(email, displayName, password, {
        q1: String(recoveryQ1).trim(),
        a1: String(recoveryA1),
        q2: String(recoveryQ2).trim(),
        a2: String(recoveryA2),
      });
      const token = createSession(user.id);
      res.cookie('ats_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 90 * 24 * 60 * 60 * 1000 });
      res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, isGuest: user.isGuest } });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // ── Password recovery (security questions, fully local) ──
  const recoveryAttempts = new Map<string, { count: number; lockedUntil: number }>();
  const MAX_RECOVERY_ATTEMPTS = 5;
  const RECOVERY_LOCK_MS = 5 * 60 * 1000;

  // Step 1: does this email exist and have recovery questions set?
  app.post('/api/auth/forgot-password/check', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const info = getRecoveryInfo(email);
    if (!info.exists) return res.status(404).json({ error: 'No account found with this email.' });
    if (!info.hasRecovery) {
      return res.status(400).json({ error: 'This account has no recovery questions set. Sign in and add them in Settings.' });
    }
    const lock = recoveryAttempts.get(email);
    if (lock && lock.lockedUntil > Date.now()) {
      const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Too many attempts — try again in ${mins} minute(s).` });
    }
    res.json({ success: true, q1: info.q1, q2: info.q2 });
  });

  // Step 2: verify answers + set new password
  app.post('/api/auth/forgot-password/reset', (req, res) => {
    try {
      const { email, answer1, answer2, newPassword } = req.body;
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (!cleanEmail) return res.status(400).json({ error: 'Email is required.' });
      if (!newPassword || String(newPassword).length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }
      const lock = recoveryAttempts.get(cleanEmail);
      if (lock && lock.lockedUntil > Date.now()) {
        const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
        return res.status(429).json({ error: `Too many attempts — try again in ${mins} minute(s).` });
      }
      try {
        const user = resetPasswordWithRecovery(cleanEmail, String(answer1 || ''), String(answer2 || ''), String(newPassword));
        recoveryAttempts.delete(cleanEmail);
        res.json({ success: true, email: user.email });
      } catch (err: any) {
        const entry = recoveryAttempts.get(cleanEmail) || { count: 0, lockedUntil: 0 };
        entry.count += 1;
        if (entry.count >= MAX_RECOVERY_ATTEMPTS) {
          entry.lockedUntil = Date.now() + RECOVERY_LOCK_MS;
          entry.count = 0;
          recoveryAttempts.set(cleanEmail, entry);
          return res.status(429).json({ error: 'Too many wrong answers — locked for 5 minutes.' });
        }
        recoveryAttempts.set(cleanEmail, entry);
        return res.status(400).json({ error: err.message });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Authed: set/update recovery questions from Settings (needs current password)
  app.post('/api/auth/recovery-questions', (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { currentPassword, recoveryQ1, recoveryA1, recoveryQ2, recoveryA2 } = req.body;
      if (!currentPassword || !recoveryQ1 || !recoveryA1 || !recoveryQ2 || !recoveryA2) {
        return res.status(400).json({ error: 'All fields are required.' });
      }
      if (String(recoveryA1).trim().length < 3 || String(recoveryA2).trim().length < 3) {
        return res.status(400).json({ error: 'Recovery answers must be at least 3 characters.' });
      }
      setRecoveryQuestions(userId, String(currentPassword), {
        q1: String(recoveryQ1).trim(),
        a1: String(recoveryA1),
        q2: String(recoveryQ2).trim(),
        a2: String(recoveryA2),
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { email, password } = req.body;
      const user = verifyLogin(email || '', password || '');
      if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
      const token = createSession(user.id);
      res.cookie('ats_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 90 * 24 * 60 * 60 * 1000 });
      res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, isGuest: user.isGuest } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/guest', (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Guest name is required.' });
      // Sign in to an existing guest, or create a new one
      let user = listUsers().find((u) => u.isGuest && u.name.toLowerCase() === name.toLowerCase());
      if (!user) {
        user = createUser(`guest-${Date.now()}@local`, name, undefined);
      }
      const token = createSession(user.id);
      res.cookie('ats_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 90 * 24 * 60 * 60 * 1000 });
      res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, isGuest: user.isGuest } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const cookieHeader = (req.headers.cookie || '').split(';').map((s) => s.trim());
    const match = cookieHeader.find((c) => c.startsWith('ats_session='));
    if (match) deleteSession(match.slice('ats_session='.length));
    res.clearCookie('ats_session');
    res.json({ success: true });
  });

  // Existing guest accounts are listed so the login screen can offer one-click sign-in
  app.get('/api/auth/guests', (req, res) => {
    res.json({ guests: listUsers().filter((u) => u.isGuest).map((u) => ({ id: u.id, name: u.name, email: u.email })) });
  });

  // Skill Gaps - aggregate missing skills across all scored jobs
  app.get('/api/cv/skill-gaps', (req, res) => {
    try {
      const allJobs = getAllJobs();
      const scoredJobs = allJobs.filter((j) => j.gapAnalysis?.missingSkills?.length > 0);
      const gapCounts: Record<string, { count: number; totalScored: number }> = {};

      for (const job of scoredJobs) {
        const allMissing = [
          ...(job.gapAnalysis?.missingSkills || []),
          ...(job.gapAnalysis?.missingKeywords || []),
        ];
        for (const skill of allMissing) {
          const key = skill.toLowerCase().trim();
          if (!key) continue;
          if (!gapCounts[key]) gapCounts[key] = { count: 0, totalScored: scoredJobs.length };
          gapCounts[key].count++;
        }
      }

      const gaps = Object.entries(gapCounts)
        .map(([skill, data]) => ({ skill, count: data.count, totalScored: data.totalScored }))
        .sort((a, b) => b.count - a.count);

      res.json({ gaps, totalScored: scoredJobs.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download Master CV
  app.get('/api/cv/master/download', async (req, res) => {
    try {
      const m = getMasterCv();
      const format = ((req.query.format as string) || 'pdf').toLowerCase();

      const masterAsTailored = masterCvToTailoredCv(m);

      const safeName = m.fullName.replace(/ /g, '_');
      const filename = `${safeName}_Master_CV`;
      const template = (req.query.template as string) || (['harvard', 'jake', 'atanu', 'atanu-pro'].includes(m.templateId || '') ? m.templateId : 'harvard');

      if (format === 'pdf') {
        const pdfBuffer = await generatePdfBuffer(masterAsTailored, template);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
        res.send(pdfBuffer);
      } else if (format === 'txt') {
        const textCv = generatePlainTextCv(masterAsTailored);
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
        res.send(textCv);
      } else {
        const pdfBuffer = await generatePdfBuffer(masterAsTailored, template);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
        res.send(pdfBuffer);
      }
    } catch (err: any) {
      console.error('Master CV download error:', err);
      res.status(500).json({ error: 'Failed to generate master CV document.' });
    }
  });

  app.post('/api/cv/improve-summary', async (req, res) => {
    try {
      const { summary, experiences, skills, certifications, fullName } = req.body;
      if (!summary || typeof summary !== 'string' || !summary.trim()) {
        res.status(400).json({ error: 'Summary is required.' });
        return;
      }

      const prompt = `You are an elite Executive Resume Writer. The candidate wants improved versions of their professional summary.

CURRENT SUMMARY:
"""${summary}"""

CANDIDATE CONTEXT:
Name: ${fullName || 'Candidate'}
Work Experience:
${JSON.stringify(experiences || [], null, 2)}
Skills:
${JSON.stringify(skills || [], null, 2)}
Certifications:
${JSON.stringify(certifications || [], null, 2)}

Write 3 improved professional summary options (2-3 sentences each). Rules:
- Never fabricate skills, companies, or achievements.
- Use strong action verbs and quantify impact where facts allow.
- Each option should have a distinct tone: (1) Concise & Impact-Driven, (2) Leadership-Focused, (3) Skill-Dense for ATS keyword matching.
- Do NOT invent new experience. Only rephrase and emphasize what exists.

Return valid JSON only — NO markdown, NO code fences:
{
  "options": [
    { "label": "Concise & Impact-Driven", "text": "..." },
    { "label": "Leadership-Focused", "text": "..." },
    { "label": "Skill-Dense (ATS)", "text": "..." }
  ]
}`;

      const jsonText = await ask(prompt, 0.4);
      const parsed = JSON.parse(jsonText);
      const options = Array.isArray(parsed.options) ? parsed.options.slice(0, 3) : [];

      res.json({ success: true, options });
    } catch (err: any) {
      console.error('Improve summary error:', err);
      res.status(500).json({ error: err.message || 'Failed to generate summary suggestions.' });
    }
  });

  // ── AI CV Compression ──
  app.post('/api/cv/ai/analyze', async (req, res) => {
    if (!hasApiKeyConfigured()) {
      res.status(428).json({ error: 'No API token configured — add your API key in Settings. This process will not run.', code: 'no_api_key' });
      return;
    }
    try {
      const masterCv = getMasterCv();
      if (!masterCv) {
        res.status(400).json({ error: 'No master CV found. Create one first.' });
        return;
      }
      const targetRole = (req.body?.targetRole as string)?.trim() || masterCv.experiences?.[0]?.title || '';
      if (!targetRole) {
        res.status(400).json({ error: 'Cannot determine target role from the CV.' });
        return;
      }
      const marketData = getMarketData(targetRole);
      const result = await compressCv(masterCv, targetRole, marketData);
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error('AI compress analyze error:', err);
      const mapped = mapLlmError(err);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
  });

  app.post('/api/cv/ai/accept', async (req, res) => {
    try {
      const compressed = req.body?.compressedCv;
      if (!compressed || typeof compressed !== 'object') {
        res.status(400).json({ error: 'compressedCv is required.' });
        return;
      }
      const masterCv = getMasterCv();
      if (!masterCv) {
        res.status(400).json({ error: 'No master CV found.' });
        return;
      }

      // Backup current CV before overwriting
      saveCvVersion(masterCv, `Before AI compression (${masterCv.fullName})`);

      const exp = (compressed.workExperience || []).map((e: any, i: number) => ({
        id: `exp-${Date.now()}-${i}`,
        title: e.title || '',
        company: e.company || '',
        location: e.location || '',
        dates: e.dates || '',
        responsibilities: Array.isArray(e.highlights) ? e.highlights : [],
      }));
      const education = (compressed.education || []).map((e: any, i: number) => ({
        id: `edu-${Date.now()}-${i}`,
        degree: e.degree || '',
        institution: e.institution || '',
        dates: e.dates || '',
        details: e.details || '',
      }));
      const skills = (compressed.technicalSkills || []).map((s: any) => ({
        category: s.category || 'Skills',
        items: Array.isArray(s.skills) ? s.skills : [],
      }));
      if (skills.length === 0 && Array.isArray(compressed.coreCompetencies)) {
        skills.push({ category: 'Core Competencies', items: compressed.coreCompetencies });
      }
      const projects = (compressed.projects || []).map((p: any, i: number) => ({
        id: `proj-${Date.now()}-${i}`,
        name: p.name || '',
        description: p.description || '',
        technologies: Array.isArray(p.technologies) ? p.technologies : [],
        link: p.link,
        dates: p.dates,
      }));
      const certifications = (compressed.certifications || []).map((c: any, i: number) =>
        typeof c === 'string'
          ? { id: `cert-${Date.now()}-${i}`, name: c }
          : { id: `cert-${Date.now()}-${i}`, name: c.name || '', issuer: c.issuer, date: c.date, link: c.link }
      );

      const newCv: MasterCv = {
        fullName: compressed.candidateName || masterCv.fullName,
        email: compressed.contactInfo?.email || masterCv.email,
        phone: compressed.contactInfo?.phone || masterCv.phone,
        location: compressed.contactInfo?.location || masterCv.location,
        linkedin: compressed.contactInfo?.linkedin || masterCv.linkedin,
        github: compressed.contactInfo?.github || masterCv.github,
        website: compressed.contactInfo?.website || masterCv.website,
        summary: compressed.professionalSummary || masterCv.summary,
        experiences: exp,
        education,
        skills,
        projects,
        certifications,
        rawText: masterCv.rawText,
        downloadFilename: masterCv.downloadFilename,
        templateId: masterCv.templateId,
      };
      saveMasterCv(newCv);
      res.json({ success: true, cv: getMasterCv() });
    } catch (err: any) {
      console.error('AI compress accept error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/cv/versions', (req, res) => {
    res.json({ versions: listCvVersions() });
  });

  app.post('/api/cv/versions/:id/restore', (req, res) => {
    try {
      const version = getCvVersion(req.params.id);
      if (!version) {
        res.status(404).json({ error: 'Version not found.' });
        return;
      }
      saveCvVersion(getMasterCv(), `Before restore of ${req.params.id.slice(-6)}`);
      saveMasterCv(version.data);
      res.json({ success: true, cv: getMasterCv() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/cv/versions/:id', (req, res) => {
    res.json({ success: deleteCvVersion(req.params.id) });
  });

  // ── Job portal bookmarks (per user) ──
  app.get('/api/portals/bookmarks', (req, res) => {
    res.json({ bookmarks: listPortalBookmarks() });
  });

  app.post('/api/portals/bookmarks', (req, res) => {
    const { portalName } = req.body || {};
    if (!portalName || typeof portalName !== 'string') {
      res.status(400).json({ error: 'portalName is required.' });
      return;
    }
    res.json({ success: addPortalBookmark(portalName.trim()) });
  });

  app.delete('/api/portals/bookmarks/:name', (req, res) => {
    res.json({ success: removePortalBookmark(decodeURIComponent(req.params.name)) });
  });

  app.post('/api/cv/parse-text', async (req, res) => {
    try {
      const { rawText } = req.body;
      if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
        res.status(400).json({ error: 'rawText string is required' });
        return;
      }

      const formattedCv = await parseCvWithLLM(rawText);
      res.json({ success: true, cv: formattedCv });
    } catch (err: any) {
      console.error('Error parsing resume text:', err);
      res.status(500).json({ error: err.message || 'Failed to parse resume text' });
    }
  });

  app.post('/api/cv/upload-file', (req, res, next) => {
    upload.any()(req, res, (err: any) => {
      if (err) {
        console.error('Multer file upload error:', err);
        return res.status(400).json({ error: err.message || 'File upload failed. Please ensure file size is under 15MB.' });
      }
      next();
    });
  }, async (req: express.Request, res: express.Response) => {
    try {
      const files = (req as any).files;
      const uploadedFile = (files && files.length > 0) ? files[0] : (req as any).file;

      if (!uploadedFile) {
        res.status(400).json({ error: 'No file uploaded. Please select a PDF, DOCX, or TXT file.' });
        return;
      }

      const originalName = uploadedFile.originalname || 'uploaded_resume';
      const formattedCv = await parseCvWithLLM({
        buffer: uploadedFile.buffer,
        mimeType: uploadedFile.mimetype,
        originalName,
      });

      res.json({ success: true, cv: formattedCv, fileName: originalName });
    } catch (err: any) {
      console.error('Error parsing uploaded resume file:', err);
      res.status(500).json({ error: err.message || 'Failed to extract resume from file' });
    }
  });

  // Scrape Jobs
  // ATS index status — lets the UI honestly say "building index" instead of
  // "no jobs found" during bootstrapping.
  app.get('/api/ats-index/status', async (_req, res) => {
    try {
      const { ATS_FLAGS } = await import('./server/providers/providerRegistry.js');
      if (!ATS_FLAGS.ENABLE_LOCAL_ATS_INDEX) {
        res.json({ enabled: false, platforms: {} });
        return;
      }
      const { boardRefreshStats } = await import('./server/ats-index/atsRepository.js');
      const platforms = ((process.env.ATS_INDEX_PLATFORMS ?? 'greenhouse') as string)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s === 'greenhouse' || s === 'lever' || s === 'ashby');
      const { isAtsCycleRunning } = await import('./server/ats-index/atsScheduler.js');
      const out: Record<string, unknown> = {};
      for (const p of platforms) out[p] = { ...boardRefreshStats(p), refreshInProgress: isAtsCycleRunning() };
      res.json({ enabled: true, platforms: out });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'status failed' });
    }
  });

// Search history — the user's search ACTIVITY, newest first (last-searched
  // activity time, then creation time, then deterministic id).
  app.get('/api/searches', async (req, res) => {
    try {
      const { getSearchHistory } = await import('./server/storage/v2Tables.js');
      const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 50;
      const history = getSearchHistory(getCurrentUserId(), limit);
      res.json({ searches: history });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'history failed' });
    }
  });

  app.post('/api/jobs/scrape', async (req, res) => {
    try {
      const { keywords, location, sources, datePostedFilter, jobType, minSalary, maxJobsPerSource, jobTitle, contractType, experienceLevel, under10Applicants } = req.body;

      if (!keywords || !keywords.trim()) {
        res.status(400).json({ error: 'Keywords parameter is required.' });
        return;
      }

      // Single-source enforcement (server-side, not just UI): exactly one
      // source per search. No multi-source fan-out, no hidden sources.
      if (!Array.isArray(sources) || sources.length === 0) {
        res.status(400).json({ error: 'Select exactly one job source per search.' });
        return;
      }
      if (sources.length > 1) {
        res.status(400).json({ error: 'Select exactly one job source per search.' });
        return;
      }

      const wantUnder10 = under10Applicants === true;

      // Local ATS index path (flag-gated): route the search through the
      // neutral V2 pipeline. With the index enabled, Greenhouse searches
      // read the LOCAL index (zero network — the indexer has already
      // collected market data); the orchestrator applies date/location/
      // relevance constraints, ranks, dedupes, and caps at LIMIT. Only
      // survivors (relevance > 0) are persisted. Single-source is mandatory:
      // exactly the selected ATS is queried — never a silent fallback to
      // another provider. When the flag is OFF, the request-driven V1
      // direct-ATS path below is unchanged.
      const { ATS_FLAGS, atsProviderMode } = await import('./server/providers/providerRegistry.js');
      const { greenhouseProvider } = await import('./server/providers/greenhouseProvider.js');
      const { leverProvider } = await import('./server/providers/leverProvider.js');
      const { ashbyProvider } = await import('./server/providers/ashbyProvider.js');
      const { greenhouseIndexProvider, leverIndexProvider, ashbyIndexProvider } = await import('./server/providers/greenhouseIndexProvider.js');
      const { toDurableJob } = await import('./server/providers/atsProviderShared.js');
      // Index-backed providers (searched from ats_jobs); the others stay
      // network-backed until their ingestion phases land. NEVER falls back
      // from local_index to the legacy 8-board path.
      const indexProviders: Partial<Record<string, import('./server/providers/types.js').JobSearchProvider>> = {
        Greenhouse: greenhouseIndexProvider,
        Lever: leverIndexProvider,
        Ashby: ashbyIndexProvider,
      };
      const networkProviders = { Greenhouse: greenhouseProvider, Lever: leverProvider, Ashby: ashbyProvider } as const;
      if (sources.length === 1 && atsProviderMode(sources[0], ATS_FLAGS.ENABLE_LOCAL_ATS_INDEX) === 'local_index') {
        const selectedProvider = indexProviders[sources[0]];
        if (selectedProvider) {
          const { runV2Search } = await import('./server/search/searchOrchestrator.js');
          const userLimit = Math.min(maxJobsPerSource ? Number(maxJobsPerSource) : 15, 50);
          const result = await runV2Search(
            getCurrentUserId(),
            {
              keywords: keywords.trim(),
              // ATS path: empty location = no constraint (no 'Remote' default —
              // that default belongs to the job-board sources, not ATS APIs).
              location: (location || '').trim() || undefined,
              postedWindow: datePostedFilter && datePostedFilter !== 'all' ? datePostedFilter : 'any',
              jobType: jobType || 'all',
              workMode: jobType || 'all',
              level: (experienceLevel as any) || 'any',
              limit: userLimit,
              source: sources[0],
            },
            [selectedProvider]
          );
          // Persist ONLY the ranked survivors — every one passed the relevance
          // guard (score 0 candidates never reach this point). saveNewJobs
          // dedupes by fingerprint, so repeated searches never duplicate.
          const { added, skipped } = persistJobsWithUpgrade(result.jobs.map(toDurableJob));
          // Index-state honesty for the UI: an empty/incomplete index is
          // "building", never "no jobs exist". searchMode proves the path.
          let indexState = {};
          if (sources[0] === 'Greenhouse') {
            const { indexResponseState } = await import('./server/ats-index/atsRepository.js');
            indexState = indexResponseState('greenhouse');
          }
          res.json({
            success: true,
            searchId: result.searchId,
            scrapedTotal: result.returnedCount,
            addedCount: added.length,
            skippedDuplicates: skipped,
            upgradedCount: 0,
            filteredOutCount: 0,
            skippedSources: [],
            newContacts: [],
            isAtsIndex: true,
            cacheHit: result.cacheHit,
            exhausted: result.exhausted,
            ...indexState,
          });
          return;
        }
      }

      // skipJobId: tell the Apify actor to skip LinkedIn jobs we already have
      // (avoids re-fetching and re-paying for duplicates).
      let jobIds: string[] = [];
      try {
        const existing = getAllJobs().filter((j) => j.source === 'LinkedIn' && j.id.startsWith('linkedin-'));
        jobIds = existing
          .map((j) => j.id.replace(/^linkedin-/, ''))
          .filter((id) => /^\d+$/.test(id))
          .slice(0, 1000);
      } catch { jobIds = []; }

      const scrapedJobsRaw = await ScraperFactory.runScrape({
        keywords: keywords.trim(),
        location: location || 'Remote',
        sources,
        datePostedFilter: datePostedFilter || 'all',
        jobType: jobType || 'all',
        minSalary: minSalary ? Number(minSalary) : undefined,
        maxJobsPerSource: maxJobsPerSource ? Number(maxJobsPerSource) : 15,
        jobTitle: jobTitle?.trim() || undefined,
        contractType: contractType || undefined,
        experienceLevel: experienceLevel || undefined,
        under10Applicants: wantUnder10,
        jobIds,
      });

      // Deterministic "under 10 applicants" guarantee: LinkedIn's f_AL=true
      // filter is unreliable on the guest API, and other sources don't expose
      // applicant counts at all. Post-filter on the scraped applicantCount so
      // the option always delivers what it promises. LinkedIn jobs showing
      // "Be among the first N applicants" are flagged lowCompetition — those
      // are exactly the low-competition roles this option targets.
      const scrapedJobs = wantUnder10
        ? scrapedJobsRaw.filter((j) => j.lowCompetition === true || (j.applicantCount !== undefined && j.applicantCount <= 10))
        : scrapedJobsRaw;

      const filteredOutCount = scrapedJobsRaw.length - scrapedJobs.length;

      // Descriptions are stored exactly as scraped — the user runs these
      // sources with their own official Apify key, so no contact stripping.
      //
      // Truncated LinkedIn-post jobs stored by earlier runs (Google-News
      // token links, ~210-char titles) get UPGRADED IN PLACE when this run
      // resolves their real post URL: full description (recruiter email/phone),
      // real URL, recruiter name. Kept as one job — no duplicate.
      const { added, skipped, newContacts, upgradedCount } = persistJobsWithUpgrade(scrapedJobs);

      // Search-context isolation: create/reuse a `searches` row for this
      // query+location+window, then link every RELEVANT job that survived the
      // scrape (added + already-stored) to it. The returned searchId lets the
      // UI scope its follow-up GET /api/jobs to exactly this search.
      const { getOrCreateSearch, replaceJobsForSearch } = await import('./server/storage/v2Tables.js');
      // Every user-visible constraint is part of the context identity. A
      // Glassdoor-only/Remote search must never reuse a prior all-ATS search.
      const filterKey = JSON.stringify({
        sources: [...(Array.isArray(sources) ? sources : [])].sort(),
        jobType: jobType || 'all',
        contractType: contractType || '',
        experienceLevel: experienceLevel || '',
        under10Applicants: wantUnder10,
        limit: maxJobsPerSource ? Number(maxJobsPerSource) : 15,
      });
      const searchId = getOrCreateSearch(
        getCurrentUserId(),
        keywords.trim(),
        location,
        datePostedFilter || 'all',
        filterKey,
        Array.isArray(sources) && sources.length === 1 ? sources[0] : undefined
      );
      const relevantIds = [...new Set(scrapedJobs.map((j) => j.id).filter(Boolean))];
      replaceJobsForSearch(searchId, relevantIds);

      res.json({
        success: true,
        searchId,
        scrapedTotal: scrapedJobs.length,
        addedCount: added.length,
        skippedDuplicates: skipped,
        upgradedCount,
        filteredOutCount,
        skippedSources: ScraperFactory.lastSkippedSources,
        newContacts: newContacts.map((c) => ({
          name: c.name,
          email: c.email,
          phone: c.phone,
          whatsapp: c.whatsapp,
          recruiterUrl: c.recruiterUrl,
          company: c.company,
        })),
      });
    } catch (err: any) {
      console.error('Scrape error:', err);
      res.status(500).json({ error: err.message || 'Scraping failed.' });
    }
  });

  // V2 — provider-driven unified search (cache-first, top-up). Additive: V1
  // POST /api/jobs/scrape stays untouched; V2 path is flag-gated
  // (V2_SEARCH_ENABLED). No V2 providers are wired yet — this endpoint
  // returns an honest empty result until a real provider is integrated.
  app.post('/api/jobs/search-v2', async (req, res) => {
    try {
      const { V2_FLAGS } = await import('./server/providers/providerRegistry.js');
      if (!V2_FLAGS.V2_SEARCH_ENABLED) {
        res.status(404).json({ error: 'V2 search disabled (V2_SEARCH_ENABLED=false)' });
        return;
      }
      const { keywords, location, datePostedFilter, jobType, workMode, level, limit } = req.body;
      if (!keywords || !String(keywords).trim()) {
        res.status(400).json({ error: 'Keywords required' });
        return;
      }
      const { runV2Search } = await import('./server/search/searchOrchestrator.js');
      const result = await runV2Search(getCurrentUserId(), {
        keywords: String(keywords).trim(),
        location: location ? String(location).trim() : undefined,
        postedWindow: (datePostedFilter as any) || 'any',
        jobType: jobType || 'all',
        workMode: workMode || 'all',
        level: level || 'any',
        limit: Math.min(Number(limit) || 25, 50),
      }, []); // no providers wired — honest empty result
      res.json(result);
    } catch (err: any) {
      console.error('V2 search error:', err);
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // V2 — unified ATS search (DB-first, budgeted Santa Maria + provider router).
  // Additive: V1 POST /api/jobs/scrape stays untouched. Cost-safe by design:
  // local DB hit → $0; provider calls always go through the central fetch budget.
  app.post('/api/jobs/search', async (req, res) => {
    try {
      const { keywords, location, remote, postedWithin, limit } = req.body;
      if (!keywords || !String(keywords).trim()) {
        res.status(400).json({ error: 'Keywords required' });
        return;
      }
      const userLimit = Math.min(Number(limit) || 25, 50);
      const { searchWithCache } = await import('./server/services/searchService.js');
      const { routeProvider } = await import('./server/services/providerRouter.js');
      const searchRequest = {
        query: String(keywords).trim(),
        location: location ? String(location).trim() : undefined,
        remote: remote === true,
        postedWithin: (postedWithin as any) || 'all',
        limit: userLimit,
      };
      const result = await searchWithCache(searchRequest, (providerId: string, fetchLimit: number) =>
        routeProvider(searchRequest, providerId, fetchLimit)
      );
      res.json({
        ...result,
        jobs: result.jobs,
        providersCalled: result.providersCalled,
        cacheHit: result.cacheHit,
        exhausted: result.exhausted === true,
        seenCount: result.seenCount ?? 0,
        totalStored: result.totalStored ?? 0,
      });
    } catch (err: any) {
      console.error('V2 search error:', err);
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Generic URL-based job description scraper
  app.post('/api/scrape-full-text', async (req, res) => {
    try {
      const { jobUrl } = req.body;
      if (!jobUrl || typeof jobUrl !== 'string') {
        res.status(400).json({ error: 'jobUrl string is required.' });
        return;
      }

      const { scrapeJobDescription } = await import('./server/scraper/genericScraper.js');
      const result = await scrapeJobDescription(jobUrl);

      if (!result) {
        res.status(422).json({ error: 'Could not extract job description from the provided URL.' });
        return;
      }

      res.json({ success: true, text: result.text, source: result.source });
    } catch (err: any) {
      console.error('Generic scrape error:', err);
      res.status(500).json({ error: err.message || 'Scraping failed.' });
    }
  });

  // Job stats for KPI dashboard (counts computed server-side from all jobs)
  // Per-ATS official career-portal counts (source name → number of company boards)
  app.get('/api/jobs/stats', (req, res) => {
    try {
      const all = getAllJobs();
      const pending = all.filter((j) => j.state === 'pending').length;
      const matched = all.filter((j) => j.state === 'matched' || j.state === 'tailored' || j.state === 'ready').length;
      const tailored = all.filter((j) => j.state === 'tailored' || j.state === 'ready').length;
      const applied = all.filter((j) => j.state === 'applied').length;
      const scored = all.filter((j) => j.matchScore !== undefined);
      const avgScore = scored.length > 0
        ? Math.round(scored.reduce((acc, j) => acc + (j.matchScore || 0), 0) / scored.length)
        : 0;

      const byState: Record<string, number> = { pending: 0, matched: 0, tailored: 0, ready: 0, applied: 0 };
      for (const j of all) if (byState[j.state] !== undefined) byState[j.state]++;

      res.json({ total: all.length, pending, matched, tailored, applied, scoredCount: scored.length, avgScore, byState });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get Jobs list with filters & pagination
  // HR / Recruiter contacts
  app.get('/api/contacts', (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const company = typeof req.query.company === 'string' ? req.query.company : '';
      res.json({ contacts: listContacts({ q, company }), companies: listContactCompanies() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs/:id/contacts', (req, res) => {
    try {
      const job = getJobById(req.params.id);
      const contacts = listContactsForJob(req.params.id, job?.recruiterUrl);
      res.json({ contacts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/contacts/:id/hide', (req, res) => {
    try {
      res.json({ success: setContactHidden(req.params.id, true) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/contacts/:id/unhide', (req, res) => {
    try {
      res.json({ success: setContactHidden(req.params.id, false) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/contacts/stats', (req, res) => {
    try {
      res.json({ stats: getContactStats() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/contacts/:id/notes', (req, res) => {
    try {
      const note = typeof req.body?.note === 'string' ? req.body.note : '';
      res.json({ success: addContactNote(req.params.id, note) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/contacts/:id/followup', (req, res) => {
    try {
      const date = typeof req.body?.date === 'string' && req.body.date ? req.body.date : null;
      res.json({ success: setContactFollowUp(req.params.id, date) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/contacts/:id/followedup', (req, res) => {
    try {
      res.json({ success: setContactFollowedUp(req.params.id, !!req.body?.value) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/contacts/:id/pipeline', (req, res) => {
    try {
      const status = typeof req.body?.status === 'string' ? req.body.status : null;
      res.json({ success: setContactPipeline(req.params.id, status) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/contacts/:id/emails', (req, res) => {
    try {
      res.json({ emails: listContactEmails(req.params.id) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/contacts/export', (req, res) => {
    try {
      const rows = listContactsCsv();
      const esc = (v: string | null): string => {
        const s = v ?? '';
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [
        'Email,Name,Company,Job Role,Phone,WhatsApp,LinkedIn,Type,Context,Last Seen',
        ...rows.map((r) => [r.email, r.name, r.company, r.jobRole, r.phone, r.whatsapp ? 'yes' : '', r.recruiterUrl, r.typeLabel, r.context, r.lastSeen].map(esc).join(',')),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="recruiters.csv"');
      res.send('\uFEFF' + lines.join('\r\n'));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/contacts/bulk-hide', (req, res) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const count = ids.filter((id) => setContactHidden(id, true)).length;
      res.json({ success: count > 0, count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Cold email (L2 SMTP) ────────────────────────────────────────────────

  // AI-draft a cold email for a recruiter contact (personalized from their
  // job posting + the candidate's own Master CV). Nothing is sent here.
  app.post('/api/emails/draft', async (req, res) => {
    try {
      const { contactId, to } = req.body || {};
      const contact = contactId ? getContactById(contactId) : undefined;
      if (contactId && !contact) {
        res.status(404).json({ error: 'Contact not found.' });
        return;
      }
      const masterCv = getMasterCv();
      const profile = getCandidateProfile();
      const profileText = buildProfileText(profile);
      const job = contact?.sourceJobId ? getJobById(contact.sourceJobId) : undefined;
      // Manual emails (no contact): derive a greeting from the address if it
      // looks like a personal name, otherwise fall back to "there".
      const localPart = String(to || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
      const greetingGuess = localPart.length >= 4 && !/^(info|contact|careers|jobs|hr|hello|support|admin|team|apply)$/i.test(localPart)
        ? localPart.split(/\s+/)[0]
        : '';
      const name = contact?.name || contact?.recruiterName || (greetingGuess ? `${greetingGuess[0].toUpperCase()}${greetingGuess.slice(1)}` : 'there');
      const company = contact?.company || job?.company || 'your company';
      const role = job?.title || contact?.jobRole || 'the role';
      const firstName = (contact?.name || contact?.recruiterName || greetingGuess || '').trim().split(/\s+/)[0] || '';
      // Heuristic: only greet with a first name when it actually looks like
      // a personal name. Extracted "names" are often companies or
      // departments ("Company Mob", "Talent Acquisition", "O CLRS").
      const NON_NAME_TOKENS = ['talent', 'acquisition', 'delivery', 'consulting', 'recruiting', 'recruitment', 'careers', 'company', 'mob', 'hr', 'team', 'sourcing', 'staffing', 'people', 'support', 'operations', 'engineering', 'hiring'];
      const companyFirst = company.trim().split(/\s+/)[0]?.toLowerCase() || '';
      const firstLower = firstName.toLowerCase();
      const looksLikeName =
        firstName.length >= 4 &&
        !NON_NAME_TOKENS.includes(firstLower) &&
        firstLower !== companyFirst &&
        (contact?.type !== 'careers');
      const greetingName = looksLikeName ? firstName : '';

      const skillsText = (masterCv?.skills || [])
        .map((s) => `${s.category}: ${(s.items || []).join(', ')}`)
        .filter(Boolean)
        .join(' | ');
      const expText = (masterCv?.experiences || [])
        .map((x) => `${x.title} @ ${x.company} (${x.dates}) — ${(x.responsibilities || []).slice(0, 3).map((r) => r.slice(0, 110)).join('; ')}`)
        .filter(Boolean)
        .join('\n');
      const projectsText = (masterCv?.projects || [])
        .filter((p) => p.name)
        .map((p) => `${p.name}${p.dates ? ` (${p.dates})` : ''} — ${(p.description || '').slice(0, 140)}${(p.technologies || []).length ? ` [${p.technologies.slice(0, 5).join(', ')}]` : ''}`)
        .join('\n');
      const certsText = (masterCv?.certifications || []).slice(0, 3).map((c) => c.name).filter(Boolean).join(', ');

      const prompt = `You are a senior career coach writing a cold outreach email that reads like a real human wrote it.

Recruiter name: ${name}
Company: ${company}
Role they are hiring for: ${role}
Job description (if available): ${(job?.description || '').slice(0, 1200)}
Candidate: ${masterCv?.fullName || 'the candidate'}
Candidate location: ${masterCv?.location || ''}
Candidate summary: ${(masterCv?.summary || '').slice(0, 600)}
Candidate skills: ${skillsText}
Candidate career journey (roles in order, oldest → newest, with what they actually did): ${expText}
Candidate projects: ${projectsText}
Candidate certifications: ${certsText}
Candidate job preferences (from their account — separate from the CV):
${profileText || '(none set)'}

Rules — this must feel human, not AI:
- FIRST LINE: a greeting — literally "${greetingName ? 'Hi ' + greetingName + ',' : 'Hi there,'}" followed by a newline, then continue with the email. Nothing may appear before the greeting.
- Write in the FIRST PERSON as the candidate: always "I", "my", "me". Never refer to the candidate by name, and never write in the third person ("he/she/their CV").
- 120-160 words total (excluding the greeting and signature). Three short paragraphs maximum.
- Use ONLY the candidate's REAL data above — never invent facts, companies, projects, numbers, or credentials.
- If "Candidate job preferences" has a notice period or availability, weave it in naturally when it helps the recruiter (e.g. "I'm available immediately" or "I'm on a 30-day notice period") — one short clause max. Do NOT invent availability if none is set.
- If the role's work mode (remote/onsite/hybrid from the job description) matches the candidate's stated preference, mention the fit briefly ("I work fully remote today, which fits this remote setup"). One clause max. Never mention salary expectations in the email body.
- The candidate IS interested in this role — say so directly and naturally early on ("I'm interested in the ${role} role at ${company}" or similar, in your own words). Do not be coy or generic.
- Establish the candidate's experience LEVEL from the WHOLE career: state their total years of experience and the progression of roles and companies from "Candidate career journey" (e.g. "I've spent over four years in DevOps and DevSecOps, starting as a DevOps Engineer at PearlThoughts and now working as a Senior DevSecOps Engineer at Human Managed"), plus what they actually do day-to-day.
- Include ALL of the candidate's projects from "Candidate projects" — every single one, each as ONE short clause (name + what it does, e.g. "I also built Tailor CV, an AI job-search platform, and OS-Admin, a multi-tenant restaurant SaaS"). Do not drop any project.
- Use ONE concrete number or measurable outcome from the journey/summary when it fits naturally (e.g. an 80% reduction, a migration, a pipeline cut) — specificity is what makes it human.
- No AI-sounding phrases. NEVER use: "I'm writing to express", "I hope this email finds you well", "I would be glad", "Would you be open to", "leverage", "passionate", "delve", "I trust this", "excited", "thrilled", exclamation marks, bullet points, or listicles.
- Vary the sentence rhythm — some sentences short, some longer. Read like a person typing quickly, not like a brochure.
- Close with a soft, natural ask (e.g. "Happy to chat briefly this week if it's useful.") — not a formal request.
- Do NOT include any signature, name, phone, or sign-off in the body — the system adds it.
- Sign nothing. No "Best regards". No name at the end.

Return valid JSON only, no markdown:
{ "subject": string (max 8 words, no fluff), "body": string }`;

      const raw = await ask(prompt, 0.5);
      const parsed = JSON.parse(raw);
      const body = String(parsed.body || '').trim();
      // Deterministic signature: candidate name, then their saved phone and
      // portfolio URL (from the Master CV) — each line only when it exists.
      // The portfolio keeps its full https:// URL so mail clients render it
      // as a clickable link in the sent email.
      const nameLine = masterCv?.fullName ? masterCv.fullName.trim() : '';
      const phoneLine = masterCv?.phone ? masterCv.phone.trim() : '';
      const portfolioLine = masterCv?.website ? masterCv.website.trim() : '';
      const signature = [nameLine, phoneLine, portfolioLine].filter(Boolean).join('\n');
      res.json({
        success: true,
        draft: {
          to: contact?.email || String(to || ''),
          subject: String(parsed.subject || '').slice(0, 160),
          body: body ? `${body}\n\n${signature}` : '',
        },
      });
    } catch (err: any) {
      console.error('Email draft error:', err);
      res.status(500).json({ error: 'Failed to draft email.' });
    }
  });

  // Check an email's format + domain MX records (validity hint for the UI).
  app.post('/api/contacts/verify-email', async (req, res) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const valid = isEmailFormatValid(email);
      let mx: boolean | null = null;
      if (valid) {
        try {
          const records = await dns.resolveMx(email.split('@')[1]);
          mx = records.length > 0;
        } catch {
          mx = false;
        }
      }
      res.json({ format: valid, mx, detail: !valid ? 'invalid-format' : mx === null ? 'unknown' : mx ? 'valid' : 'no-mx' });
    } catch (err: any) {
      res.status(500).json({ error: 'Verification failed.' });
    }
  });

  // Send a cold email through the user's own SMTP (from Settings → Email).
  // Optional attachment: attachMaster generates the Master CV PDF on the
  // fly; attachment { filename, data(base64) } attaches an uploaded file.
  app.post('/api/emails/send', async (req, res) => {
    try {
      const { contactId, to, subject, body, attachMaster, attachment } = req.body || {};
      const emailCfg = loadConfig().email;
      if (!emailCfg.host || !emailCfg.user || !emailCfg.password) {
        res.status(400).json({ error: 'SMTP is not configured — add it in Settings → Email.' });
        return;
      }
      if (!to || !String(to).includes('@')) {
        res.status(400).json({ error: 'A valid recipient email is required.' });
        return;
      }
      if (!subject || !body) {
        res.status(400).json({ error: 'Subject and body are required.' });
        return;
      }

      const transport = nodemailer.createTransport({
        host: emailCfg.host,
        port: Number(emailCfg.port) || 587,
        secure: emailCfg.secure === true,
        auth: { user: emailCfg.user, pass: emailCfg.password },
        tls: { rejectUnauthorized: false },
      });

      const fromLabel = (emailCfg.fromName || '').trim();
      const from = fromLabel ? `"${fromLabel}" <${emailCfg.user}>` : emailCfg.user;

      // Build attachments: Master CV PDF and/or an uploaded file (one of
      // each max — the UI offers both options, user picks one).
      const attachments: any[] = [];
      if (attachMaster) {
        const m = getMasterCv();
        if (m && m.fullName) {
          const masterTemplate = ['harvard', 'jake', 'atanu', 'atanu-pro'].includes(m.templateId || '') ? m.templateId : 'harvard';
          const pdf = await generatePdfBuffer(masterCvToTailoredCv(m), masterTemplate);
          const cvName = m.downloadFilename || `${m.fullName.replace(/\s+/g, '_')}_CV`;
          attachments.push({ filename: `${cvName}.pdf`, content: pdf });
        }
      }
      if (attachment && typeof attachment.filename === 'string' && typeof attachment.data === 'string') {
        attachments.push({ filename: attachment.filename, content: Buffer.from(attachment.data, 'base64') });
      }

      const info = await transport.sendMail({
        from,
        to: String(to).trim(),
        subject: String(subject),
        text: String(body),
        html: textBodyToHtmlWithLinks(String(body)),
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      if (contactId) {
        recordContactEmail(contactId, 'sent', info.messageId);
        recordContactEmailDetail(contactId, {
          recipient: to, subject, body,
          attachmentName: attachMaster ? 'Master CV' : (attachment?.filename || null),
          status: 'sent',
        });
      }
      res.json({ success: true, messageId: info.messageId });
    } catch (err: any) {
      if (req.body?.contactId) {
        recordContactEmail(req.body.contactId, 'failed');
        recordContactEmailDetail(req.body.contactId, {
          recipient: req.body.to,
          subject: req.body.subject,
          body: req.body.body,
          status: 'failed',
        });
      }
      console.error('Email send error:', err);
      res.status(500).json({ error: err?.message || 'Failed to send email.' });
    }
  });

  // Verify the configured SMTP credentials (Settings → Email → Test connection).
  // If the connection fails with a TLS/plaintext mismatch (e.g. SSL on a
  // STARTTLS port or vice versa), retry once with the secure flag flipped
  // and report which mode worked.
  app.post('/api/emails/test', async (req, res) => {
    try {
      const { host, port, secure, user, password } = req.body || {};
      if (!host || !user || !password) {
        res.status(400).json({ ok: false, error: 'Host, username and password are required.' });
        return;
      }
      const attempt = async (useSecure: boolean) => {
        const transport = nodemailer.createTransport({
          host: String(host),
          port: Number(port) || 587,
          secure: useSecure,
          auth: { user: String(user), pass: String(password) },
          tls: { rejectUnauthorized: false },
        });
        await transport.verify();
        return useSecure;
      };
      try {
        await attempt(secure === true);
        res.json({ ok: true });
      } catch (firstErr: any) {
        const msg = String(firstErr?.message || '');
        const tlsMismatch = /SSL|TLS|wrong version|handshake|ECONNRESET|socket hang up/i.test(msg);
        if (tlsMismatch) {
          try {
            const worked = await attempt(secure !== true);
            res.json({ ok: true, autoCorrected: true, secureUsed: worked, note: `Connected with ${worked ? 'SSL' : 'STARTTLS'} — the SSL/TLS toggle was adjusted automatically.` });
            return;
          } catch { /* fall through to the original error */ }
        }
        res.status(400).json({ ok: false, error: msg.includes('Invalid login') || msg.includes('535') || msg.includes('authentication')
          ? 'Authentication failed — check username and password (Gmail needs an App Password).'
          : `${msg}${tlsMismatch ? ' — check the SSL/TLS toggle: port 465 uses SSL, port 587 uses STARTTLS.' : ''}` });
      }
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message || 'Connection failed.' });
    }
  });

  app.get('/api/jobs', async (req, res) => {
    try {
      const queryParams: JobFilterQueryParams = {
        state: (req.query.state as any) || 'all',
        source: (req.query.source as any) || 'all',
        search: (req.query.search as string) || '',
        searchId: (req.query.searchId as string) || undefined,
        jobType: (req.query.jobType as any) || 'all',
        location: (req.query.location as string) || '',
        datePostedFilter: (req.query.datePostedFilter as any) || 'all',
        under10Applicants: req.query.under10Applicants === 'true',
        minScore: req.query.minScore ? Number(req.query.minScore) : undefined,
        maxScore: req.query.maxScore ? Number(req.query.maxScore) : undefined,
        sortBy: (req.query.sortBy as any) || 'createdAt',
        sortOrder: (req.query.sortOrder as any) || 'desc',
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 25,
      };

      // Resolve searchId → the job ids linked to that search context, so the
      // result view shows only jobs belonging to the current search.
      if (queryParams.searchId) {
        const { getJobIdsForSearch } = await import('./server/storage/v2Tables.js');
        queryParams.jobIds = getJobIdsForSearch(getCurrentUserId(), queryParams.searchId);
      }

      const result = queryJobs(queryParams);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single job details
  app.get('/api/jobs/:id', (req, res) => {
    const job = getJobById(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.json(job);
  });

  // Single Job Match Scoring
  app.post('/api/jobs/:id/match', async (req, res) => {
    if (!hasApiKeyConfigured()) {
      res.status(428).json({ error: 'No API token configured — add your API key in Settings. This process will not run.', code: 'no_api_key' });
      return;
    }
    try {
      const job = getJobById(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }

      // Score shares the same JD resolver as Tailor — scoring resume-vs-job
      // with an empty description would be meaningless.
      const { ensureJobDescription } = await import('./server/tailor/jdResolver.js');
      let scoredJob: Job;
      try {
        scoredJob = await ensureJobDescription(job);
      } catch (jdErr: any) {
        if (jdErr?.name === 'JDResolutionError') {
          res.status(502).json({ error: jdErr.message });
          return;
        }
        throw jdErr;
      }

      const masterCv = getMasterCv();
      const config = loadConfig();
      const matcher = new LlmMatcher();

      const { LLMError } = await import('./server/llm/llmErrors.js');
      let result: Awaited<ReturnType<typeof matcher.matchJob>>;
      try {
        result = await matcher.matchJob(
          scoredJob,
          masterCv,
          config.thresholds.earlyBlockThreshold
        );
      } catch (llmErr: any) {
        if (llmErr instanceof LLMError) {
          const status = llmErr.code === 'timeout' ? 504 : llmErr.code === 'invalid_key' ? 401 : llmErr.code === 'rate_limit' ? 429 : 502;
          res.status(status).json({ error: llmErr.message, code: llmErr.code });
          return;
        }
        throw llmErr;
      }

      const updatedJob = updateJobInStorage({
        ...scoredJob,
        matchScore: result.matchScore,
        gapAnalysis: result.gapAnalysis,
        state: result.isEarlyBlocked ? 'pending' : 'matched',
        matchedAt: new Date().toISOString(),
      });

      res.json({
        success: true,
        matchScore: result.matchScore,
        gapAnalysis: result.gapAnalysis,
        isEarlyBlocked: result.isEarlyBlocked,
        job: updatedJob,
      });
    } catch (err: any) {
      const mapped = mapLlmError(err);
      console.error('Match error:', err);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
  });

  // Batch Job Match Scoring (Score all pending)
  app.post('/api/jobs/batch-match', async (req, res) => {
    if (!hasApiKeyConfigured()) {
      res.status(428).json({ error: 'No API token configured — add your API key in Settings. This process will not run.', code: 'no_api_key' });
      return;
    }
    try {
      const { jobIds } = req.body || {};
      const allJobs = getAllJobs();
      const targetJobs = jobIds && jobIds.length > 0
        ? allJobs.filter((j) => jobIds.includes(j.id))
        : allJobs.filter((j) => j.state === 'pending');

      const masterCv = getMasterCv();
      const config = loadConfig();
      const matcher = new LlmMatcher();

      // Process concurrently (bounded) so a large batch finishes fast
      // and the rest of the app keeps working.
      const CONCURRENCY = 3;
      const updatedResults: any[] = [];
      let cursor = 0;

      const worker = async () => {
        while (cursor < targetJobs.length) {
          const job = targetJobs[cursor++];
          try {
            const result = await matcher.matchJob(
              job,
              masterCv,
              config.thresholds.earlyBlockThreshold
            );

            const updated = updateJobInStorage({
              ...job,
              matchScore: result.matchScore,
              gapAnalysis: result.gapAnalysis,
              state: result.isEarlyBlocked ? 'pending' : 'matched',
              matchedAt: new Date().toISOString(),
            });

            updatedResults.push(updated);
          } catch (err) {
            console.warn(`Batch match failed for job ${job.id}:`, err);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targetJobs.length) }, () => worker()));

      res.json({
        success: true,
        processedCount: updatedResults.length,
        jobs: updatedResults,
      });
    } catch (err: any) {
      const mapped = mapLlmError(err);
      console.error('Batch match error:', err);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
  });

function computePlanStatus(plan: { manualFields: unknown[]; consentFields: unknown[]; unresolvedDetails: Array<{ required: boolean }> }): string {
  if (plan.manualFields.length > 0 || plan.consentFields.length > 0) return 'NEEDS_REVIEW';
  if (plan.unresolvedDetails.some((u) => u.required)) return 'NEEDS_INPUT';
  return 'READY_TO_SUBMIT';
}

  // ── Application Engine V1 (Phase 1) — provider-neutral plans ──────────
  // Prepare-only: inspection + dry-run. NO submission endpoints.

const bearerToken = (req: any): string | undefined => {
  const h = String(req.headers?.authorization || '');
  if (h.startsWith('Bearer ')) return h.slice(7);
  return undefined;
};

const sanitizeSummary = (a: any) => ({
  applicationId: a.applicationId, planId: a.planId, attemptId: a.attemptId,
  jobId: a.jobId, jobTitle: a.jobTitle, company: a.company, provider: a.provider,
  userStatus: a.userStatus,
  checkpoint: a.checkpoint ? { type: a.checkpoint.type, reasonCode: a.checkpoint.reasonCode, title: a.checkpoint.title, description: a.checkpoint.description, provider: a.checkpoint.provider } : null,
  availableActions: a.availableActions,
  updatedAt: a.updatedAt,
});
const sanitizeApproval = (a: any) => ({
  id: a.id, planId: a.planId, packageId: a.packageId, status: a.status,
  approvedAt: a.approvedAt,
  resumeArtifactHash: a.resumeArtifactHash,
  mappedFieldsHash: a.mappedFieldsHash,
  consents: (a.consents || []).map((c: any) => ({ providerFieldId: c.providerFieldId, classification: c.classification, selectedValue: c.selectedValue })),
  fingerprintBound: { planFingerprint: a.planFingerprint, packageSnapshotHash: a.packageSnapshotHash, requirementsFingerprint: a.requirementsFingerprint },
});
const sanitizeDryRun = (r: any) => {
  const parts = r.payload?.parts || [];
  return {
    attempt: r.attempt ? { id: r.attempt.id, status: r.attempt.status, provider: r.attempt.provider, externalJobId: r.attempt.externalJobId, executionKey: r.attempt.executionKey?.slice(0, 16) } : null,
    requirementsMatch: r.requirementsMatch,
    captcha: r.captcha,
    dryRunAvailable: r.dryRunAvailable,
    formAutomationEligible: r.formAutomationEligible,
    submissionTransportEnabled: r.submissionTransportEnabled,
    executionEligible: r.executionEligible,
    reason: r.reason ?? null,
    payload: r.payload ? {
      target: r.payload.target,
      method: r.payload.method,
      textParts: parts.filter((p: any) => p.kind === 'TEXT').map((p: any) => {
        const sensitive = /password|token|secret|key/i.test(p.name) || p.name.includes('baseTemplate');
        return { name: p.name, classification: p.classification, semantic: p.semantic, value: sensitive ? '[REDACTED]' : p.value };
      }),
      fileParts: parts.filter((p: any) => p.kind === 'FILE').map((p: any) => ({ name: p.name, filename: p.filename, mimeType: p.mimeType, size: p.size, sha256: p.sha256.slice(0, 16) })),
      omittedTracking: r.payload.omittedTracking,
      captcha: r.payload.captcha,
      executionEligible: r.payload.executionEligible,
    } : null,
    payloadFingerprint: r.payloadFingerprint,
  };
};
const sanitizeAttemptDryRun = (a: any) => ({
  id: a.id, status: a.status, provider: a.provider, executionKey: a.executionKey?.slice(0, 16),
  transportAttemptCount: a.transportAttemptCount, startedAt: a.startedAt, finishedAt: a.finishedAt ?? null,
  verification: a.verification ?? null, failure: a.failure ? { kind: a.failure.kind, retryClass: a.failure.retryClass } : null,
});

  const engineContext = async (userId: string, packageId: string) => {
    const { getPackageById } = await import('./server/applicationPackage/packageStore.js');
    const { readPdfArtifact } = await import('./server/applicationPackage/artifactStore.js');
    const { FixtureInspectionAdapter } = await import('./server/applicationEngine/fixtureAdapter.js');
    const pkg = getPackageById(userId, packageId);
    if (!pkg) return { pkg: undefined as undefined | import('./server/applicationPackage/packageModel.js').ApplicationPackage, artifactOk: false, adapter: new FixtureInspectionAdapter() };
    let artifactOk = false;
    if (pkg.resumeSnapshot?.pdfHash) {
      try {
        const bytes = readPdfArtifact(pkg.resumeSnapshot.pdfHash);
        artifactOk = bytes.length > 0;
      } catch { artifactOk = false; }
    }
    return { pkg, artifactOk, adapter: new FixtureInspectionAdapter() };
  };

  // Read-only plan preparation: package gate + live GET inspection (Lever)
  // + deterministic mapping + dry-run preview. NEVER a submission path.
  app.post('/api/application-packages/:packageId/plan', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const ctx = await engineContext(userId, req.params.packageId);
      if (!ctx.pkg) return res.status(404).json({ error: 'Package not found.' });
      const job = getJobById(ctx.pkg.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found.' });
      const { createPlan } = await import('./server/applicationEngine/engine.js');
      const { plan, reused, gate } = await createPlan({ userId, pkg: ctx.pkg, job, adapter: ctx.adapter, artifactOk: ctx.artifactOk });
      res.json({ plan, reused, gate });
    } catch (err: any) {
      if (err?.name === 'EngineGateError') {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: String(err?.message || 'Plan creation failed.').slice(0, 300) });
    }
  });

  app.get('/api/submission-plans/:planId', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getPlanById } = await import('./server/applicationEngine/engine.js');
      const plan = getPlanById(userId, req.params.planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found.' });
      res.json({ plan });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'failed' });
    }
  });

  app.get('/api/submission-plans/:planId/preview', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getPlanById, buildPreview } = await import('./server/applicationEngine/engine.js');
      const { getPackageById } = await import('./server/applicationPackage/packageStore.js');
      const plan = getPlanById(userId, req.params.planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found.' });
      const pkg = getPackageById(userId, plan.packageId);
      if (!pkg) return res.status(404).json({ error: 'Package not found.' });
      res.json({ preview: buildPreview(plan, pkg) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'failed' });
    }
  });

  // Ordinary unresolved answers (source=USER). Consent/EEO/UNKNOWN remain
  // review-only; READY_TO_SUBMIT plans are frozen (409).
  // ── Browser Companion Phase 1: secure local bridge (loopback-only). ──
  // Pairing (web UI, authenticated user)
  app.post('/api/browser-companion/pairing-code', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { createPairingCode } = await import('./server/browserCompanion/companionService.js');
      const { assertLoopbackHost } = await import('./server/browserCompanion/companionService.js');
      assertLoopbackHost(req.headers.host);
      const { code, expiresAt } = createPairingCode(getDb(), userId);
      res.json({ code, expiresAt });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Pairing code failed.').slice(0, 200) });
    }
  });
  // Extension pairing (loopback + rate-limited)
  app.post('/api/browser-companion/pair', async (req, res) => {
    try {
      const { pairExtension } = await import('./server/browserCompanion/companionService.js');
      const { assertLoopbackHost } = await import('./server/browserCompanion/companionService.js');
      assertLoopbackHost(req.headers.host);
      const { code } = req.body || {};
      const r = pairExtension(getDb(), String(code || ''));
      res.json(r);
    } catch (err: any) {
      if (err?.name === 'CompanionError') return res.status(401).json({ error: err.message, code: err.code });
      res.status(500).json({ error: String(err?.message || 'Pairing failed.').slice(0, 200) });
    }
  });
  // Extension presence handshake
  app.post('/api/browser-companion/status', async (req, res) => {
    try {
      const { companionStatus } = await import('./server/browserCompanion/companionService.js');
      const { assertLoopbackHost } = await import('./server/browserCompanion/companionService.js');
      assertLoopbackHost(req.headers.host);
      const { pairingId, installSecret } = req.body || {};
      res.json(companionStatus(getDb(), String(pairingId || ''), String(installSecret || '')));
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Status failed.').slice(0, 200) });
    }
  });
  // Web UI unpair (authenticated user)
  app.post('/api/browser-companion/unpair', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { unpairExtension } = await import('./server/browserCompanion/companionService.js');
      const { pairingId } = req.body || {};
      if (!pairingId) return res.status(400).json({ error: 'pairingId required.' });
      unpairExtension(getDb(), String(pairingId));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Unpair failed.').slice(0, 200) });
    }
  });
  // Web UI: create a BrowserAssistSession for an attempt (user-triggered)
  app.post('/api/browser-companion/sessions', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { createCompanionSession } = await import('./server/browserCompanion/companionService.js');
      const { attemptId } = req.body || {};
      if (!attemptId) return res.status(400).json({ error: 'attemptId required.' });
      const r = createCompanionSession(getDb(), userId, String(attemptId));
      res.json(r);
    } catch (err: any) {
      if (err?.name === 'CompanionError') return res.status(409).json({ error: err.message, code: err.code });
      res.status(500).json({ error: String(err?.message || 'Session creation failed.').slice(0, 200) });
    }
  });
  // Extension: claim session bearer (paired extension only, one-time)
  app.post('/api/browser-companion/sessions/:id/claim', async (req, res) => {
    try {
      const { claimSessionToken } = await import('./server/browserCompanion/companionService.js');
      const { assertLoopbackHost } = await import('./server/browserCompanion/companionService.js');
      assertLoopbackHost(req.headers.host);
      const { pairingId, installSecret } = req.body || {};
      const r = claimSessionToken(getDb(), String(pairingId || ''), String(installSecret || ''), req.params.id);
      res.json(r);
    } catch (err: any) {
      if (err?.name === 'CompanionError') return res.status(401).json({ error: err.message, code: err.code });
      res.status(500).json({ error: String(err?.message || 'Claim failed.').slice(0, 200) });
    }
  });
  // Extension: session payload (approved fields only; bearer token)
  app.get('/api/browser-companion/sessions/:id/payload', async (req, res) => {
    try {
      const { sessionPayload } = await import('./server/browserCompanion/companionService.js');
      const { assertLoopbackHost } = await import('./server/browserCompanion/companionService.js');
      assertLoopbackHost(req.headers.host);
      const token = bearerToken(req);
      const payload = sessionPayload(getDb(), token);
      res.json(payload);
    } catch (err: any) {
      if (err?.name === 'CompanionError') return res.status(401).json({ error: err.message, code: err.code });
      res.status(500).json({ error: String(err?.message || 'Payload failed.').slice(0, 200) });
    }
  });
  // Extension: event intake (enum-only, idempotent, non-PII)
  app.post('/api/browser-companion/sessions/:id/events', async (req, res) => {
    try {
      const { recordCompanionEvent } = await import('./server/browserCompanion/companionService.js');
      const { assertLoopbackHost } = await import('./server/browserCompanion/companionService.js');
      assertLoopbackHost(req.headers.host);
      const token = bearerToken(req);
      const { type, reasonCode, metadata } = req.body || {};
      const r = recordCompanionEvent(getDb(), token, String(type || ''), reasonCode ? String(reasonCode) : undefined, metadata || {});
      res.json(r);
    } catch (err: any) {
      if (err?.name === 'CompanionError') return res.status(401).json({ error: err.message, code: err.code });
      res.status(500).json({ error: String(err?.message || 'Event failed.').slice(0, 200) });
    }
  });

  // ── Application Experience V1: user-facing dashboard + handoff. ──
  app.get('/api/applications', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { applicationSummaries } = await import('./server/applicationExperience/applicationService.js');
      const filter = String(req.query?.filter || 'all');
      let rows = applicationSummaries(getDb(), userId);
      if (filter === 'action') rows = rows.filter((r) => r.userStatus === 'ACTION_REQUIRED' || r.userStatus === 'WAITING_FOR_YOU');
      if (filter === 'applied') rows = rows.filter((r) => r.userStatus === 'APPLIED');
      const counts = {
        all: rows.length,
        action: applicationSummaries(getDb(), userId).filter((r) => r.userStatus === 'ACTION_REQUIRED' || r.userStatus === 'WAITING_FOR_YOU').length,
        applied: applicationSummaries(getDb(), userId).filter((r) => r.userStatus === 'APPLIED').length,
      };
      res.json({ applications: rows.map(sanitizeSummary), counts, filter });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Applications fetch failed.').slice(0, 300) });
    }
  });

  // PRODUCT command: orchestrates approval + fresh reinspection + execution
  // preparation from ONE user action. Idempotent; never bypasses review.
  app.post('/api/applications/:applicationId/start', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { startApplication } = await import('./server/applicationExperience/applicationService.js');
      const result = await startApplication(getDb(), userId, req.params.applicationId);
      res.json({ application: sanitizeSummary(result.summary), started: result.started, reason: result.reason ?? null });
    } catch (err: any) {
      if (err?.name === 'ExperienceError') return res.status(err.code === 'NOT_FOUND' ? 404 : 409).json({ error: err.message, code: err.code });
      res.status(500).json({ error: String(err?.message || 'Start failed.').slice(0, 300) });
    }
  });

  app.post('/api/applications/:attemptId/handoff', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { recordHandoff } = await import('./server/applicationExperience/applicationService.js');
      const { url, summary } = recordHandoff(getDb(), userId, req.params.attemptId);
      res.json({ url, application: sanitizeSummary(summary) });
    } catch (err: any) {
      if (err?.name === 'ExperienceError') return res.status(err.code === 'NOT_FOUND' ? 404 : 409).json({ error: err.message, code: err.code });
      res.status(500).json({ error: String(err?.message || 'Handoff failed.').slice(0, 300) });
    }
  });

  app.post('/api/applications/:attemptId/confirm-submitted', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { confirmUserSubmitted } = await import('./server/applicationExperience/applicationService.js');
      const summary = confirmUserSubmitted(getDb(), userId, req.params.attemptId);
      res.json({ application: sanitizeSummary(summary) });
    } catch (err: any) {
      if (err?.name === 'ExperienceError') return res.status(err.code === 'NOT_FOUND' ? 404 : err.code === 'NOT_HANDED_OFF' ? 409 : 403).json({ error: err.message, code: err.code });
      res.status(500).json({ error: String(err?.message || 'Confirmation failed.').slice(0, 300) });
    }
  });

  app.get('/api/applications/:applicationId/details', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { applicationDetails } = await import('./server/applicationExperience/applicationDetails.js');
      const details = applicationDetails(getDb(), userId, req.params.applicationId);
      if (!details) return res.status(404).json({ error: 'Application not found.' });
      res.json({ details });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Details fetch failed.').slice(0, 300) });
    }
  });

  // ── Execution (Phase 1): approval + attempt + LOCAL dry-run. No mutation. ──
  app.post('/api/submission-plans/:planId/approval', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getPlanById } = await import('./server/applicationEngine/engine.js');
      const { getPackageById } = await import('./server/applicationPackage/packageStore.js');
      const { createApproval } = await import('./server/applicationEngine/executionEngine.js');
      const plan = getPlanById(userId, req.params.planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found.' });
      const pkg = getPackageById(userId, plan.packageId);
      if (!pkg) return res.status(404).json({ error: 'Package not found.' });
      const body = req.body || {};
      const consents = Array.isArray(body.consents) ? body.consents : [];
      const approval = createApproval({ db: getDb(), userId, plan, pkg, consents, marketingOptIn: !!body.marketingOptIn });
      res.json({ approval: sanitizeApproval(approval) });
    } catch (err: any) {
      if (err?.name === 'ExecutionError') return res.status(409).json({ error: err.message, code: err.kind });
      res.status(500).json({ error: String(err?.message || 'Approval failed.').slice(0, 300) });
    }
  });

  app.get('/api/application-approvals/:approvalId', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getApproval } = await import('./server/applicationEngine/executionStore.js');
      const approval = getApproval(getDb(), userId, req.params.approvalId);
      if (!approval) return res.status(404).json({ error: 'Approval not found.' });
      res.json({ approval: sanitizeApproval(approval) });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Approval fetch failed.').slice(0, 300) });
    }
  });

  // Local-only: fresh GET reinspection + requirements compare + local payload
  // build. Performs NO ATS submission.
  app.post('/api/application-approvals/:approvalId/prepare-execution', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getApproval } = await import('./server/applicationEngine/executionStore.js');
      const { getPlanById } = await import('./server/applicationEngine/engine.js');
      const { getPackageById } = await import('./server/applicationPackage/packageStore.js');
      const { prepareExecution } = await import('./server/applicationEngine/executionEngine.js');
      const approval = getApproval(getDb(), userId, req.params.approvalId);
      if (!approval) return res.status(404).json({ error: 'Approval not found.' });
      const plan = getPlanById(userId, approval.planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found.' });
      const pkg = getPackageById(userId, approval.packageId);
      if (!pkg) return res.status(404).json({ error: 'Package not found.' });
      const result = await prepareExecution({ db: getDb(), userId, plan, pkg, approval, marketingOptIn: !!req.body?.marketingOptIn, omitTracking: true });
      res.json({ result: sanitizeDryRun(result) });
    } catch (err: any) {
      if (err?.name === 'ExecutionError' || err?.name === 'PayloadBuildError') return res.status(409).json({ error: err.message, code: err.kind || err.reason });
      res.status(500).json({ error: String(err?.message || 'Preparation failed.').slice(0, 300) });
    }
  });

  app.get('/api/application-attempts/:attemptId', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getAttempt } = await import('./server/applicationEngine/executionStore.js');
      const attempt = getAttempt(getDb(), userId, req.params.attemptId);
      if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
      res.json({ attempt });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Attempt fetch failed.').slice(0, 300) });
    }
  });

  app.get('/api/application-attempts/:attemptId/dry-run', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getAttempt } = await import('./server/applicationEngine/executionStore.js');
      const attempt = getAttempt(getDb(), userId, req.params.attemptId);
      if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
      res.json({ dryRun: sanitizeAttemptDryRun(attempt) });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Dry-run fetch failed.').slice(0, 300) });
    }
  });

  app.patch('/api/submission-plans/:planId/answers', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getPlanById } = await import('./server/applicationEngine/engine.js');
      const { getPackageById } = await import('./server/applicationPackage/packageStore.js');
      const { storePlan } = await import('./server/applicationEngine/planStore.js');
      const plan = getPlanById(userId, req.params.planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found.' });
      if (plan.status === 'READY_TO_SUBMIT') return res.status(409).json({ error: 'Plan is frozen — create a new plan after package changes.' });
      const { providerFieldId, value } = req.body || {};
      const detail = plan.unresolvedDetails.find((d) => d.providerFieldId === providerFieldId);
      if (!detail) return res.status(400).json({ error: `Unknown unresolved field: ${providerFieldId}` });
      const pkg = getPackageById(userId, plan.packageId);
      if (!pkg) return res.status(404).json({ error: 'Package not found.' });
      // Re-run mapping with a USER-supplied value for this field.
      const { mapRequirements } = await import('./server/applicationEngine/mapper.js');
      const { FixtureInspectionAdapter, LEVER_FIXTURES } = await import('./server/applicationEngine/fixtureAdapter.js');
      const reqs = await new FixtureInspectionAdapter().inspect(plan.target);
      const mapping = mapRequirements(pkg, reqs.fields);
      const idx = plan.mappedFields.findIndex((m) => m.providerFieldId === providerFieldId);
      if (idx !== -1) {
        plan.mappedFields[idx] = { ...plan.mappedFields[idx], value: value ?? null, source: 'USER', mappingMethod: 'USER', mappingConfidence: 'high' };
      }
      plan.unresolvedFields = plan.unresolvedFields.filter((id) => id !== providerFieldId);
      plan.unresolvedDetails = plan.unresolvedDetails.filter((d) => d.providerFieldId !== providerFieldId);
      plan.status = computePlanStatus(plan) as any;
      plan.updatedAt = new Date().toISOString();
      storePlan(plan);
      res.json({ plan });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'failed' });
    }
  });


  // PREPARE ONLY. No submission endpoints exist.
  const loadPackageDeps = async () => {
    const { preparePackage, resumePdfHash } = await import('./server/applicationPackage/packageEngine.js');
    const { getLatestPackage, listPackages, getPackageById, markPackageStale, packageInputFingerprint } = await import('./server/applicationPackage/packageStore.js');
    const { getApplicantProfile } = await import('./server/storage/applicantProfile.js');
    const { getMasterCv, getMasterCvUpdatedAt } = await import('./server/storage/fileStorage.js');
    const { getLatestTailorVersion } = await import('./server/tailorV2/versionStore.js');
    return { preparePackage, resumePdfHash, getLatestPackage, listPackages, getPackageById, markPackageStale, packageInputFingerprint, getApplicantProfile, getMasterCv, getMasterCvUpdatedAt, getLatestTailorVersion };
  };
  const packageContext = async (userId: string, job: Job) => {
    const deps = await loadPackageDeps();
    const { ensureJobDescription } = await import('./server/tailor/jdResolver.js');
    const { computeFit } = await import('./server/fit/fitEngine.js');
    const { fitCacheKeyFor, getCachedFit, storeCachedFit, jdHash } = await import('./server/fit/fitCache.js');
    const fullJob = await ensureJobDescription(job);
    const profile = deps.getApplicantProfile(userId);
    const masterCv = deps.getMasterCv(userId);
    const jd = fullJob.description || '';
    const key = fitCacheKeyFor(profile.updatedAt, deps.getMasterCvUpdatedAt(userId), jd);
    let fit = getCachedFit(userId, job.id, key);
    if (!fit) {
      fit = computeFit(profile, masterCv, fullJob, jd);
      storeCachedFit(userId, job.id, key, fit);
    }
    const tailored = deps.getLatestTailorVersion(userId, job.id);
    return { deps, fullJob, profile, masterCv, jd, fit, tailored };
  };

  // Create or reuse the current package for a job.
  app.post('/api/jobs/:id/application-package', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const job = getJobById(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found.' });
      const ctx = await packageContext(userId, job);
      const { buildPackage, computePackageKeys } = await import('./server/applicationPackage/packageEngine.js');
      const { getLatestPackage, storePackage, packageInputFingerprint } = await import('./server/applicationPackage/packageStore.js');
      const latest = getLatestPackage(userId, job.id);
      const keys = computePackageKeys({ userId, job: ctx.fullJob, jd: ctx.jd, profile: ctx.profile, masterCv: ctx.masterCv, fit: ctx.fit, tailoredVersion: ctx.tailored });
      keys.masterCvUpdatedAt = ctx.deps.getMasterCvUpdatedAt(userId);
      const fp = packageInputFingerprint(keys);
      if (latest && latest.status !== 'STALE' && latest.inputFingerprint === fp) {
        res.json({ package: latest, reused: true });
        return;
      }
      const pkg = await buildPackage({ userId, job: ctx.fullJob, jd: ctx.jd, profile: ctx.profile, masterCv: ctx.masterCv, fit: ctx.fit, tailoredVersion: ctx.tailored }, ctx.deps.getMasterCvUpdatedAt(userId));
      storePackage(pkg);
      res.json({ package: pkg, reused: false });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'Package preparation failed.').slice(0, 300) });
    }
  });

  app.get('/api/jobs/:id/application-package', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getLatestPackage } = await import('./server/applicationPackage/packageStore.js');
      const pkg = getLatestPackage(userId, req.params.id);
      if (!pkg) return res.status(404).json({ error: 'No package for this job yet.' });
      res.json({ package: pkg });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'failed' });
    }
  });

  app.get('/api/jobs/:id/application-packages', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { listPackages } = await import('./server/applicationPackage/packageStore.js');
      res.json({ packages: listPackages(userId, req.params.id) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'failed' });
    }
  });

  // User supplies a missing answer value (validated; source = USER).
  app.patch('/api/application-packages/:packageId/answers', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getPackageById, storePackage } = await import('./server/applicationPackage/packageStore.js');
      const { validatePackage } = await import('./server/applicationPackage/answers.js');
      const pkg = getPackageById(userId, req.params.packageId);
      if (!pkg) return res.status(404).json({ error: 'Package not found.' });
      if (pkg.status === 'READY') {
        // Never mutate a frozen READY package — tell the caller to rebuild.
        return res.status(409).json({ error: 'Package is READY — rebuild to change answers.', code: 'ready_frozen' });
      }
      const { key, value } = req.body || {};
      const idx = pkg.answers.findIndex((a) => a.key === key);
      if (idx === -1) return res.status(400).json({ error: `Unknown answer key: ${key}` });
      const allowed = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value);
      if (!allowed) return res.status(400).json({ error: 'Invalid answer value type.' });
      pkg.answers[idx] = { ...pkg.answers[idx], value: value ?? null, source: 'USER', status: value === null || value === '' ? 'NEEDS_INPUT' : 'RESOLVED' };
      const { getApplicantProfile } = await import('./server/storage/applicantProfile.js');
      pkg.validation = validatePackage(pkg, pkg.answers, undefined, getApplicantProfile(userId));
      pkg.status = pkg.validation.status;
      pkg.updatedAt = new Date().toISOString();
      storePackage(pkg);
      res.json({ package: pkg });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'failed' });
    }
  });

  // Immutable PDF artifact retrieval — exact stored bytes, NEVER regenerated.
  app.get('/api/application-packages/:packageId/resume.pdf', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getPackageById } = await import('./server/applicationPackage/packageStore.js');
      const pkg = getPackageById(userId, req.params.packageId); // ownership enforced
      if (!pkg) return res.status(404).json({ error: 'Package not found.' });
      if (!pkg.resumeSnapshot?.pdfHash) return res.status(404).json({ error: 'No PDF artifact for this package.' });
      const { readPdfArtifact } = await import('./server/applicationPackage/artifactStore.js');
      let buf: Buffer;
      try {
        buf = readPdfArtifact(pkg.resumeSnapshot.pdfHash);
      } catch (err: any) {
        return res.status(410).json({ error: err?.message || 'PDF artifact unavailable.' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="package-v${pkg.version}-resume.pdf"`);
      res.send(buf);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'failed').slice(0, 200) });
    }
  });

  // Rebuild a new package version from current inputs (old versions preserved).
  app.post('/api/application-packages/:packageId/rebuild', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getPackageById } = await import('./server/applicationPackage/packageStore.js');
      const old = getPackageById(userId, req.params.packageId);
      if (!old) return res.status(404).json({ error: 'Package not found.' });
      const job = getJobById(old.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found.' });
      const ctx = await packageContext(userId, job);
      const { buildPackage } = await import('./server/applicationPackage/packageEngine.js');
      const { storePackage } = await import('./server/applicationPackage/packageStore.js');
      const pkg = await buildPackage({ userId, job: ctx.fullJob, jd: ctx.jd, profile: ctx.profile, masterCv: ctx.masterCv, fit: ctx.fit, tailoredVersion: ctx.tailored, answers: old.answers, questions: old.questions }, ctx.deps.getMasterCvUpdatedAt(userId));
      storePackage(pkg);
      res.json({ package: pkg, oldStatus: old.status });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'failed' });
    }
  });

  // ── Tailor V2 — grounded resume tailoring + fact verification ─────────
  app.post('/api/jobs/:id/tailor-v2', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const job = getJobById(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }
      const { ensureJobDescription } = await import('./server/tailor/jdResolver.js');
      let fullJob: Job;
      try {
        fullJob = await ensureJobDescription(job);
      } catch (jdErr: any) {
        if (jdErr?.name === 'JDResolutionError') {
          res.status(502).json({ error: jdErr.message });
          return;
        }
        throw jdErr;
      }
      const { computeFit } = await import('./server/fit/fitEngine.js');
      const { getApplicantProfile } = await import('./server/storage/applicantProfile.js');
      const { getMasterCv, getMasterCvUpdatedAt } = await import('./server/storage/fileStorage.js');
      const { fitCacheKeyFor, getCachedFit, storeCachedFit } = await import('./server/fit/fitCache.js');
      const profile = getApplicantProfile(userId);
      const masterCv = getMasterCv(userId);
      const jd = fullJob.description || '';
      const key = fitCacheKeyFor(profile.updatedAt, getMasterCvUpdatedAt(userId), jd);
      let fit = getCachedFit(userId, job.id, key);
      if (!fit) {
        fit = computeFit(profile, masterCv, fullJob, jd);
        storeCachedFit(userId, job.id, key, fit);
      }
      const { runTailorV2 } = await import('./server/tailorV2/tailorV2Engine.js');
      const { jdHash } = await import('./server/fit/fitCache.js');
      const result = await runTailorV2(
        userId, masterCv, profile, fullJob, jd, fit,
        { masterCvUpdatedAt: getMasterCvUpdatedAt(userId), profileUpdatedAt: profile.updatedAt, jdHash: jdHash(jd), fitEngineVersion: fit.version }
      );
      res.json({
        success: true,
        version: result.version,
        resume: result.draft,
        verification: result.verification,
        jdTerms: result.jdTerms,
        pdfOk: result.pdfOk,
        fromCache: false,
      });
    } catch (err: any) {
      if (err?.name === 'TailorVerificationFailedError') {
        res.status(422).json({ error: err.message, code: 'verification_failed' });
        return;
      }
      res.status(500).json({ error: String(err?.message || 'Tailor V2 failed.').slice(0, 300) });
    }
  });

  // PDF for the latest Tailor V2 version of a job (regenerated deterministically).
  app.get('/api/jobs/:id/tailor-v2/pdf', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const { getLatestTailorVersion } = await import('./server/tailorV2/versionStore.js');
      const { toTailoredCv } = await import('./server/tailorV2/tailorV2Engine.js');
      const { getMasterCv } = await import('./server/storage/fileStorage.js');
      const v = getLatestTailorVersion(userId, req.params.id);
      if (!v) {
        res.status(404).json({ error: 'No tailored resume for this job yet.' });
        return;
      }
      const { generatePdfBuffer } = await import('./server/builder/docxGenerator.js');
      const cv = getMasterCv(userId);
      const buf = await generatePdfBuffer(toTailoredCv(v.content, cv.fullName || ''));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="tailored-cv-v${v.version}.pdf"`);
      res.send(buf);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || 'PDF failed.').slice(0, 200) });
    }
  });

  // ── Fit Engine V1 — deterministic applicant ↔ job matching ───────────
  app.post('/api/jobs/:id/fit', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const job = getJobById(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }
      const { ensureJobDescription } = await import('./server/tailor/jdResolver.js');
      let fullJob: Job;
      try {
        fullJob = await ensureJobDescription(job);
      } catch (jdErr: any) {
        if (jdErr?.name === 'JDResolutionError') {
          res.status(502).json({ error: jdErr.message });
          return;
        }
        throw jdErr;
      }
      const { computeFit } = await import('./server/fit/fitEngine.js');
      const { getApplicantProfile } = await import('./server/storage/applicantProfile.js');
      const { getMasterCv, getMasterCvUpdatedAt } = await import('./server/storage/fileStorage.js');
      const { fitCacheKeyFor, getCachedFit, storeCachedFit } = await import('./server/fit/fitCache.js');
      const profile = getApplicantProfile(userId);
      const masterCv = getMasterCv(userId);
      const key = fitCacheKeyFor(profile.updatedAt, getMasterCvUpdatedAt(userId), fullJob.description || '');
      const cached = getCachedFit(userId, job.id, key);
      if (cached) {
        res.json({ ...cached, fromCache: true });
        return;
      }
      const result = computeFit(profile, masterCv, fullJob, fullJob.description || '');
      storeCachedFit(userId, job.id, key, result);
      res.json({ ...result, fromCache: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Fit calculation failed.' });
    }
  });

  // Tailor CV for Single Job
  app.post('/api/jobs/:id/tailor', async (req, res) => {
    if (!hasApiKeyConfigured()) {
      res.status(428).json({ error: 'No API token configured — add your API key in Settings. This process will not run.', code: 'no_api_key' });
      return;
    }
    try {
      const job = getJobById(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }

      // Tailor must operate on the REAL job description — resolve it before
      // any LLM work. A failed resolution is a hard error (never tailor on
      // title+company pretending to be a JD).
      const { ensureJobDescription } = await import('./server/tailor/jdResolver.js');
      let jobToTailor: Job;
      try {
        jobToTailor = await ensureJobDescription(job);
      } catch (jdErr: any) {
        if (jdErr?.name === 'JDResolutionError') {
          res.status(502).json({ error: jdErr.message });
          return;
        }
        throw jdErr;
      }
      if (!jobToTailor.gapAnalysis) {
        const masterCv = getMasterCv();
        const matcher = new LlmMatcher();
        const { LLMError } = await import('./server/llm/llmErrors.js');
        let matchResult: Awaited<ReturnType<typeof matcher.matchJob>>;
        try {
          matchResult = await matcher.matchJob(jobToTailor, masterCv);
        } catch (llmErr: any) {
          if (llmErr instanceof LLMError) {
            const status = llmErr.code === 'timeout' ? 504 : llmErr.code === 'invalid_key' ? 401 : llmErr.code === 'rate_limit' ? 429 : 502;
            res.status(status).json({ error: llmErr.message, code: llmErr.code });
            return;
          }
          throw llmErr;
        }
        jobToTailor = updateJobInStorage({
          ...job,
          matchScore: matchResult.matchScore,
          gapAnalysis: matchResult.gapAnalysis,
          state: 'matched',
          matchedAt: new Date().toISOString(),
        });
      }

      const masterCv = getMasterCv();
      const tailorEngine = new LlmCvTailor();
      let tailoredCv: Awaited<ReturnType<typeof tailorEngine.tailorCv>>;
      try {
        tailoredCv = await tailorEngine.tailorCv(jobToTailor, masterCv);
      } catch (llmErr: any) {
        const { LLMError } = await import('./server/llm/llmErrors.js');
        if (llmErr instanceof LLMError) {
          const status = llmErr.code === 'timeout' ? 504 : llmErr.code === 'invalid_key' ? 401 : llmErr.code === 'rate_limit' ? 429 : 502;
          res.status(status).json({ error: llmErr.message, code: llmErr.code });
          return;
        }
        throw llmErr;
      }

      const updatedJob = updateJobInStorage({
        ...jobToTailor,
        tailoredCv,
        state: 'tailored',
        tailoredAt: new Date().toISOString(),
      });

      res.json({
        success: true,
        tailoredCv,
        job: updatedJob,
      });
    } catch (err: any) {
      const mapped = mapLlmError(err);
      console.error('Tailor CV error:', err);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
  });

  // Batch Tailor CVs for Matched Jobs (>= threshold)
  app.post('/api/jobs/batch-tailor', async (req, res) => {
    if (!hasApiKeyConfigured()) {
      res.status(428).json({ error: 'No API token configured — add your API key in Settings. This process will not run.', code: 'no_api_key' });
      return;
    }
    try {
      const config = loadConfig();
      const minScore = config.thresholds.minMatchForTailor;

      const allJobs = getAllJobs();
      const candidateJobs = allJobs.filter(
        (j) => j.state === 'matched' && (j.matchScore || 0) >= minScore
      );

      const masterCv = getMasterCv();
      const tailorEngine = new LlmCvTailor();

      // Process concurrently (bounded) so a large batch finishes fast
      // and the rest of the app keeps working.
      const CONCURRENCY = 3;
      const tailoredResults: any[] = [];
      let cursor = 0;

      const worker = async () => {
        while (cursor < candidateJobs.length) {
          const job = candidateJobs[cursor++];
          try {
            const tailoredCv = await tailorEngine.tailorCv(job, masterCv);

            const updated = updateJobInStorage({
              ...job,
              tailoredCv,
              state: 'tailored',
              tailoredAt: new Date().toISOString(),
            });

            tailoredResults.push(updated);
          } catch (err) {
            console.warn(`Batch tailor failed for job ${job.id}:`, err);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidateJobs.length) }, () => worker()));

      res.json({
        success: true,
        processedCount: tailoredResults.length,
        jobs: tailoredResults,
      });
    } catch (err: any) {
      const mapped = mapLlmError(err);
      console.error('Batch tailor error:', err);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
  });

  // Analyze a manual JD (no scraping needed)
  const manualResults = new Map<string, { tailoredCv: any; title: string; company: string }>();

  app.post('/api/analyze-jd', async (req, res) => {
    if (!hasApiKeyConfigured()) {
      res.status(428).json({ error: 'No API token configured — add your API key in Settings. This process will not run.', code: 'no_api_key' });
      return;
    }
    try {
      const { title, company, description } = req.body;
      if (!title || !description) {
        res.status(400).json({ error: 'Title and description are required.' });
        return;
      }

      const masterCv = getMasterCv();
      if (!masterCv) {
        res.status(400).json({ error: 'No master CV found. Create one first.' });
        return;
      }

      const virtualJob: Job = {
        id: `manual-${Date.now()}`,
        title: title.trim(),
        company: company?.trim() || 'Unknown Company',
        location: 'Remote',
        source: 'Custom',
        description: description.trim(),
        url: '',
        postedDate: new Date().toISOString(),
        postedDateParsed: new Date().toISOString().split('T')[0],
        state: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Match only — no tailoring yet
      const matcher = new LlmMatcher();
      const matchResult = await matcher.matchJob(virtualJob, masterCv);

      // Persist to history (per user)
      let historyId: string | undefined;
      try {
        const saved = saveManualAnalysis({
          role: virtualJob.title,
          company: virtualJob.company,
          description: virtualJob.description,
          score: matchResult.matchScore,
          gapAnalysis: matchResult.gapAnalysis,
          diff: null,
          tailoredCv: null,
        });
        historyId = saved.id;
      } catch (err) {
        console.warn('Manual JD history save failed:', err);
      }

      res.json({
        success: true,
        matchScore: matchResult.matchScore,
        gapAnalysis: matchResult.gapAnalysis,
        historyId,
      });
    } catch (err: any) {
      console.error('Analyze JD error:', err);
      const mapped = mapLlmError(err);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
  });

  // Tailor a manually analyzed JD (separate step after user updates master CV)
  app.post('/api/analyze-jd/tailor', async (req, res) => {
    if (!hasApiKeyConfigured()) {
      res.status(428).json({ error: 'No API token configured — add your API key in Settings. This process will not run.', code: 'no_api_key' });
      return;
    }
    try {
      const { title, company, description, gapAnalysis, matchScore, historyId, includeSkills } = req.body;
      if (!title || !description) {
        res.status(400).json({ error: 'Title and description are required.' });
        return;
      }

      const masterCv = getMasterCv();
      if (!masterCv) {
        res.status(400).json({ error: 'No master CV found. Create one first.' });
        return;
      }

      const virtualJob: Job = {
        id: `manual-${Date.now()}`,
        title: title.trim(),
        company: company?.trim() || 'Unknown Company',
        location: 'Remote',
        source: 'Custom',
        description: description.trim(),
        url: '',
        postedDate: new Date().toISOString(),
        postedDateParsed: new Date().toISOString().split('T')[0],
        state: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Pass through the analysis so the tailor engine knows what to integrate
        ...(gapAnalysis ? { gapAnalysis } : {}),
        ...(matchScore !== undefined ? { matchScore: Number(matchScore) } : {}),
      };

      const tailorEngine = new LlmCvTailor();
      const tailoredCv = await tailorEngine.tailorCv(
        virtualJob,
        masterCv,
        Array.isArray(includeSkills) && includeSkills.length > 0 ? { includeSkills } : undefined
      );

      const token = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      manualResults.set(token, {
        tailoredCv,
        title: virtualJob.title,
        company: virtualJob.company,
      });
      setTimeout(() => manualResults.delete(token), 30 * 60 * 1000);

      // Per-bullet before → after diff: pair each original responsibility
      // with its tailored highlight so the UI can show exactly what changed.
      const bulletRewrites: { original: string; rewritten: string }[] = [];
      const origExps = masterCv.experiences || [];
      const newExps = tailoredCv.workExperience || [];
      origExps.forEach((exp, i) => {
        const newExp = newExps[i];
        if (!newExp) return;
        (exp.responsibilities || []).forEach((orig, j) => {
          const rewritten = newExp.highlights?.[j];
          if (rewritten && String(rewritten).trim() !== String(orig).trim()) {
            bulletRewrites.push({ original: String(orig), rewritten: String(rewritten) });
          }
        });
      });

      // Diff payload for the UI's "what we add & why" panel
      const audit = tailoredCv.audit;
      const diffPayload = {
        beforeScore: audit?.beforeScore ?? 0,
        afterScore: audit?.afterScore ?? 0,
        scoreBoost: audit?.scoreBoost ?? 0,
        scoreBreakdown: audit?.scoreBreakdown ?? { alreadyMatched: 0, newlyIntegrated: 0, remainingGap: 0 },
        missingBefore: audit?.missingBefore ?? { skills: [], keywords: [] },
        addedAfter: audit?.addedAfter ?? {
          keywordsIncorporated: [],
          keywordsInExperience: [],
          keywordsInSkills: [],
          rephrasedHighlightsCount: 0,
          skillsAdded: [],
        },
        notIntegrable: audit?.notIntegrable ?? [],
        auditNotes: audit?.auditNotes ?? [],
        bulletRewrites,
      };

      // Update the history record with the diff + tailored CV
      if (historyId) {
        try {
          const existing = getManualAnalysis(historyId);
          if (existing) {
            saveManualAnalysis({
              id: historyId,
              role: existing.role,
              company: existing.company,
              description: existing.description,
              score: existing.score,
              gapAnalysis: existing.gapAnalysis,
              diff: diffPayload,
              tailoredCv,
            });
          }
        } catch (err) {
          console.warn('Manual JD history update failed:', err);
        }
      }

      res.json({
        success: true,
        downloadToken: token,
        historyId,
        diff: diffPayload,
        tailoredCv,
      });
    } catch (err: any) {
      console.error('Tailor JD error:', err);
      const mapped = mapLlmError(err);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
  });

  // Download manual JD tailored CV
  app.get('/api/analyze-jd/download', async (req, res) => {
    try {
      const token = req.query.token as string;
      const format = (req.query.format as string) || 'pdf';
      const data = manualResults.get(token);

      if (!data) {
        res.status(404).json({ error: 'Analysis result expired or not found. Please re-analyze.' });
        return;
      }

      const safeName = data.tailoredCv.candidateName.replace(/ /g, '_');
      const safeRole = (data.title || data.tailoredCv.targetRole || '').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
      const safeCompany = data.company.replace(/[^a-zA-Z0-9]/g, '_');

      // Template: explicit ?template= wins (Manual JD selector); otherwise
      // the Master CV's template is the default.
      const requestedTemplate = req.query.template as string | undefined;
      const masterTemplate = ['harvard', 'jake', 'atanu', 'atanu-pro'].includes(getMasterCv()?.templateId || '') ? getMasterCv()?.templateId : 'harvard';
      const effectiveTemplate = requestedTemplate && ['harvard', 'jake', 'atanu', 'atanu-pro'].includes(requestedTemplate) ? requestedTemplate : masterTemplate;

      if (format === 'pdf') {
        const pdfBuffer = await generatePdfBuffer(data.tailoredCv, effectiveTemplate);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}${safeRole ? '_' + safeRole : ''}${safeCompany ? '_' + safeCompany : ''}_CV.pdf"`);
        res.send(pdfBuffer);
      } else if (format === 'txt') {
        const textCv = generatePlainTextCv(data.tailoredCv);
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}${safeRole ? '_' + safeRole : ''}${safeCompany ? '_' + safeCompany : ''}_CV.txt"`);
        res.send(textCv);
      } else if (format === 'json') {
        // Used by the Manual JD comparison slider to render the new CV.
        res.json(data.tailoredCv);
      } else {
        const pdfBuffer = await generatePdfBuffer(data.tailoredCv, effectiveTemplate);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}${safeRole ? '_' + safeRole : ''}${safeCompany ? '_' + safeCompany : ''}_CV.pdf"`);
        res.send(pdfBuffer);
      }
    } catch (err: any) {
      console.error('Manual download error:', err);
      res.status(500).json({ error: 'Failed to generate file.' });
    }
  });

  // ── Manual JD · Preview Stage download (EDITED cv) ──
  // The Preview stage lets users edit the tailored CV and download the
  // edited version, not just the server's original. Accepts the edited
  // PdfCvShape + template + format from the client.
  app.post('/api/analyze-jd/preview-download', async (req, res) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return res.status(401).json({ error: 'Not signed in.' });
      const cv = req.body?.cv;
      if (!cv || typeof cv !== 'object') return res.status(400).json({ error: 'Edited CV is required.' });
      const format = req.body?.format === 'txt' ? 'txt' : 'pdf';
      const requestedTemplate = req.body?.template;
      const effectiveTemplate = requestedTemplate && ['harvard', 'jake', 'atanu', 'atanu-pro'].includes(requestedTemplate) ? requestedTemplate : 'harvard';
      const safeName = (cv.candidateName || 'Candidate').replace(/ /g, '_');
      const safeRole = (req.body?.title || cv.targetRole || '').toString().replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
      const safeCompany = (req.body?.company || '').toString().replace(/[^a-zA-Z0-9]/g, '_');

      if (format === 'txt') {
        const textCv = generatePlainTextCv(cv);
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}${safeRole ? '_' + safeRole : ''}${safeCompany ? '_' + safeCompany : ''}_CV.txt"`);
        res.send(textCv);
      } else {
        const pdfBuffer = await generatePdfBuffer(cv, effectiveTemplate);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}${safeRole ? '_' + safeRole : ''}${safeCompany ? '_' + safeCompany : ''}_CV.pdf"`);
        res.send(pdfBuffer);
      }
    } catch (err: any) {
      console.error('Preview download error:', err);
      res.status(500).json({ error: 'Failed to generate file.' });
    }
  });

  // ── Manual JD history (per user) ──
  app.get('/api/manual-jd/history', (req, res) => {
    res.json({ analyses: listManualAnalyses() });
  });

  app.get('/api/manual-jd/history/:id', (req, res) => {
    try {
      const record = getManualAnalysis(req.params.id);
      if (!record) {
        res.status(404).json({ error: 'Analysis not found.' });
        return;
      }
      // Re-issue a download token if the record has a tailored CV,
      // so downloads keep working long after the original session.
      let downloadToken: string | undefined;
      if (record.tailoredCv) {
        downloadToken = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        manualResults.set(downloadToken, {
          tailoredCv: record.tailoredCv,
          title: record.role,
          company: record.company,
        });
        setTimeout(() => manualResults.delete(downloadToken), 30 * 60 * 1000);
      }
      res.json({ analysis: record, downloadToken });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/manual-jd/history/:id', (req, res) => {
    try {
      const deleted = deleteManualAnalysis(req.params.id);
      res.json({ success: deleted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update Job Status
  app.put('/api/jobs/:id/status', (req, res) => {
    try {
      const { state } = req.body;
      const job = getJobById(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }

      const updated = updateJobInStorage({
        ...job,
        state,
      });

      res.json({ success: true, job: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create Job manually
  app.post('/api/jobs', (req, res) => {
    try {
      const { title, company, location, description, url, source } = req.body;
      if (!title || !title.trim()) {
        res.status(400).json({ error: 'Title is required.' });
        return;
      }
      const job: Job = {
        id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: title.trim(),
        company: company?.trim() || 'Unknown Company',
        location: location?.trim() || 'Remote',
        source: source || 'Custom',
        description: description?.trim() || '',
        url: url?.trim() || '',
        postedDate: new Date().toISOString(),
        postedDateParsed: new Date().toISOString().split('T')[0],
        jobType: 'Full-time',
        state: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const { added, skipped } = saveNewJobs([job]);
      res.json({ success: true, job: added[0] || job, skippedDuplicates: skipped });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete Job
  app.delete('/api/jobs/:id', (req, res) => {
    const deleted = deleteJobFromStorage(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.json({ success: true });
  });

  // Clear All Jobs
  app.delete('/api/jobs', (req, res) => {
    const count = deleteAllJobs();
    res.json({ success: true, deletedCount: count });
  });

  // Download ATS .pdf CV
  app.get('/api/jobs/:id/download-pdf', async (req, res) => {
    try {
      const job = getJobById(req.params.id);
      if (!job || !job.tailoredCv) {
        res.status(400).json({ error: 'Job or tailored CV not available for download.' });
        return;
      }

      const pdfBuffer = await generatePdfBuffer(job.tailoredCv, ['harvard', 'jake', 'atanu', 'atanu-pro'].includes(getMasterCv()?.templateId || '') ? getMasterCv()?.templateId : 'harvard');

      const safeName = job.tailoredCv.candidateName.replace(/ /g, '_');
      const safeCompany = job.company.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `${safeName}_${safeCompany}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdfBuffer);
    } catch (err: any) {
      console.error('Download pdf error:', err);
      res.status(500).json({ error: 'Failed to generate pdf file.' });
    }
  });

  // Download ATS CV in dynamic format (?format=docx|pdf|txt)
  app.get('/api/jobs/:id/download', async (req, res) => {
    try {
      const job = getJobById(req.params.id);
      if (!job || !job.tailoredCv) {
        res.status(400).json({ error: 'Job or tailored CV not available for download.' });
        return;
      }

      const format = ((req.query.format as string) || 'pdf').toLowerCase();
      const safeName = job.tailoredCv.candidateName.replace(/ /g, '_');
      const safeCompany = job.company.replace(/[^a-zA-Z0-9]/g, '_');
      const baseName = `${safeName}_${safeCompany}`;

      if (format === 'pdf') {
        const pdfBuffer = await generatePdfBuffer(job.tailoredCv, ['harvard', 'jake', 'atanu', 'atanu-pro'].includes(getMasterCv()?.templateId || '') ? getMasterCv()?.templateId : 'harvard');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
        res.send(pdfBuffer);
      } else if (format === 'txt') {
        const textCv = generatePlainTextCv(job.tailoredCv);
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.txt"`);
        res.send(textCv);
      } else {
        const pdfBuffer = await generatePdfBuffer(job.tailoredCv, ['harvard', 'jake', 'atanu', 'atanu-pro'].includes(getMasterCv()?.templateId || '') ? getMasterCv()?.templateId : 'harvard');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
        res.send(pdfBuffer);
      }
    } catch (err: any) {
      console.error('Download error:', err);
      res.status(500).json({ error: 'Failed to generate requested document.' });
    }
  });

  // Storage Migration endpoint
  app.post('/api/storage/migrate', (req, res) => {
    const { targetMode } = req.body;
    const mode = targetMode === 'sqlite' ? 'sqlite' : 'json';
    const result = runStorageMigration(mode);
    res.json(result);
  });

  // --- VITE / SERVING FRONTEND ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ATS Job Search & CV Tailor server running at http://0.0.0.0:${PORT}`);
  });

  // One-time backfill: extract recruiter/HR emails from descriptions of
  // jobs that were scraped before the contacts feature existed.
  try {
    let total = 0;
    for (const u of listUsers()) {
      runWithUser(u.id, () => {
        total += backfillContacts();
      });
    }
    console.log(`[Contacts] Backfilled ${total} new contact rows from existing job descriptions`);
  } catch (err: any) {
    console.warn('[Contacts] Backfill skipped:', err?.message || err);
  }
}

startServer();
