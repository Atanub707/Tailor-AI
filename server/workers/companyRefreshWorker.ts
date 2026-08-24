/**
 * Company Refresh Worker — background job for Santa Maria.
 * Every 12-24h, batches active company_career_sites and refreshes via Santa Maria.
 * Non-blocking — runs via setInterval, not on user request.
 */

let interval: NodeJS.Timeout | null = null;

export function startCompanyRefreshWorker(): void {
  if (interval) return;
  const hours = Number(process.env.JOB_REFRESH_HOURS || 24);
  const ms = hours * 60 * 60 * 1000;

  interval = setInterval(async () => {
    try {
      console.log(`[RefreshWorker] Checking ${hours}h refresh...`);
      // TODO: Phase 8 — query company_career_sites where lastScrapedAt < now - TTL
      // For now, placeholder — actual Santa Maria batch will be added when registry is seeded.
    } catch (err) {
      console.error('[RefreshWorker] error:', err);
    }
  }, ms);

  console.log(`[RefreshWorker] Started — every ${hours}h`);
}

export function stopCompanyRefreshWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
