import { getDb } from '../storage/fileStorage.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One-time maintenance script: import the official Greenhouse company list
// (community-maintained at kalil0321/ats-scrapers, 6,031 board tokens) into
// the company_career_sites registry. Run: npx tsx server/ats/seedGreenhouse.ts
// Idempotent: INSERT OR IGNORE by id.

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, 'data', 'greenhouse-companies.json');
const companies = JSON.parse(readFileSync(file, 'utf8')) as Array<{ id: string; companyName: string; careerUrl: string; atsPlatform: string }>;

const db = getDb();
const stmt = db.prepare(
  `INSERT OR IGNORE INTO company_career_sites (id, companyName, careerUrl, atsPlatform, isActive, createdAt, updatedAt)
   VALUES (@id, @companyName, @careerUrl, @atsPlatform, 1, @now, @now)`
);
const now = new Date().toISOString();
const tx = db.transaction(() => {
  for (const c of companies) stmt.run({ ...c, now });
});
tx();

const total = (db.prepare('SELECT count(*) c FROM company_career_sites').get() as any).c;
const gh = (db.prepare("SELECT count(*) c FROM company_career_sites WHERE atsPlatform='greenhouse'").get() as any).c;
console.log(`[Seed] Imported ${companies.length} Greenhouse companies — registry now ${total} career sites (${gh} Greenhouse)`);