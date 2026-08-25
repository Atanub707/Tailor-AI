import { getDb } from '../storage/fileStorage.js';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One-time maintenance script: import official ATS company lists
// (community-maintained at kalil0321/ats-scrapers — 6,032 Greenhouse boards,
// plus Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio,
// BambooHR, Rippling, JazzHR, Jobvite, Workday, iCIMS, Teamtailor, Pinpoint)
// into the company_career_sites registry.
// Run: npx tsx server/ats/seedCompanies.ts
// Idempotent: INSERT OR IGNORE by id.

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
const db = getDb();
const stmt = db.prepare(
  `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
   VALUES (@id, @companyName, @careerUrl, @atsPlatform, 1, @now, @now)`
);
const now = new Date().toISOString();

const tx = db.transaction(() => {
  let imported = 0;
  for (const file of readdirSync(dataDir).filter((f) => f.endsWith('.json'))) {
    const companies = JSON.parse(readFileSync(path.join(dataDir, file), 'utf8')) as Array<{ id: string; companyName: string; careerUrl: string; atsPlatform: string }>;
    for (const c of companies) stmt.run({ ...c, now });
    imported += companies.length;
    console.log(`[Seed] ${file}: ${companies.length} companies`);
  }
  return imported;
});
const imported = tx();

const byPlatform = (db.prepare('SELECT LOWER(atsPlatform) p, count(*) c FROM company_career_sites WHERE isActive = 1 GROUP BY LOWER(atsPlatform) ORDER BY c DESC').all() as Array<{ p: string; c: number }>);
const total = byPlatform.reduce((s, r) => s + r.c, 0);
console.log(`[Seed] Imported ${imported} companies — registry now ${total} career sites`);
for (const r of byPlatform) console.log(`  ${r.p}: ${r.c}`);