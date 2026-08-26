import { getDb, getAllJobs, runWithUser, listUsers } from '../storage/fileStorage.js';

const RETENTION_DAYS = 7;
const KEEP_STATES = new Set(['applied', 'tailored', 'ready']);

function ageMs(j: any): number {
  const t = j.firstSeenAt || j.scrapedAt || j.postedDate;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? Date.now() - ms : 0;
}

/**
 * Option B retention: delete jobs where (age > 7d OR isActive=false) AND
 * state is NOT applied/tailored/ready. Also removes orphaned search_jobs
 * links. Runs per user (jobs are user-scoped).
 */
export function runRetentionSweep(): { deleted: number; kept: number } {
  const cutoff = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const db = getDb();
  let deleted = 0;
  let kept = 0;

  for (const user of listUsers()) {
    const perUser = runWithUser(user.id, () => {
      const jobs = getAllJobs();
      const toDelete = jobs.filter((j) => {
        const stale = !j.isActive || ageMs(j) > cutoff;
        return stale && !KEEP_STATES.has(j.state || 'pending');
      });
      if (!toDelete.length) return 0;
      const ids = toDelete.map((j) => j.id);
      const tx = db.transaction(() => {
        for (const id of ids) {
          db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').run(id, user.id);
          db.prepare('DELETE FROM search_jobs WHERE job_id = ?').run(id);
        }
      });
      tx();
      return toDelete.length;
    });
    deleted += perUser;
  }

  // kept = everything still present after the sweep (approx; used by tests)
  const stillPresent = db.prepare('SELECT count(*) c FROM jobs').get() as { c: number };
  kept = stillPresent.c;
  return { deleted, kept };
}