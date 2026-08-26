import { getDb } from './server/storage/fileStorage.js';
import { seedCompanyCareerSites } from './server/storage/v2Tables.js';
seedCompanyCareerSites();
const db = getDb();
const total = db.prepare('SELECT count(*) c FROM company_career_sites').get() as any;
const gh = db.prepare("SELECT count(*) c FROM company_career_sites WHERE atsPlatform='greenhouse'").get() as any;
console.log('total registry:', total.c, '| greenhouse boards:', gh.c);
