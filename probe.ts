import { getDb } from './server/storage/fileStorage.js';
const d = getDb();
const rows = d.prepare("SELECT data FROM jobs WHERE data LIKE '%Market Data Operations%'").all() as any[];
for (const r of rows) {
  const j = JSON.parse(r.data);
  const tc = j.tailoredCv;
  console.log('row id=' + j.id + ' state=' + j.state + ' descLen=' + (j.description || '').length);
  console.log('  updatedAt=' + j.updatedAt + ' tailoredAt=' + j.tailoredAt + ' matchScore=' + j.matchScore);
  console.log('  tailoredCv type=' + (tc === null ? 'null' : typeof tc) + (tc && typeof tc === 'object' ? ' keys=' + Object.keys(tc).join(',') : ''));
  console.log('  tailoredCv strLen=' + (typeof tc === 'string' ? tc.length : 'n/a'));
}
