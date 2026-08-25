import { getDb } from './server/storage/fileStorage.js';
const db = getDb();
const rows = db.prepare("SELECT companyName, atsPlatform FROM company_career_sites WHERE atsPlatform = 'greenhouse'").all() as any[];
console.log('Greenhouse companies in registry:', rows.length);
console.log(rows.map(r => r.companyName).join(', '));
