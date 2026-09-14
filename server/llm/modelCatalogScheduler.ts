// Model-catalog background refresher — the local "cron" for provider models.
//
// Why: the Settings model list must show the provider's CURRENT catalog
// (OpenCode adds/deprecates models weekly). Relying on a manual Refresh click
// meant new users — who don't know to click it — never saw new models, and
// the 6h server cache made even a click a no-op most of the time.
//
// Design (local-first, same pattern as the ATS index scheduler):
//   * Runs INSIDE each user's local server — no cloud cron, the API key never
//     leaves the machine.
//   * Refreshes immediately on boot, then every MODEL_CATALOG_REFRESH_HOURS
//     (default 12h, clamped 1h..168h).
//   * Skips silently when no API key is configured (built-in list in use) —
//     no network attempt, one honest log line per tick.
//   * Never blocks startup or HTTP requests; ticks never overlap.
//   * A failed refresh keeps the last good catalog (the catalog module owns
//     that rule) and is retried on the next tick.

import { fetchModelCatalog, type ModelCatalog } from './modelCatalog.js';
import { loadConfig } from '../config.js';

export interface ModelCatalogSchedulerDeps {
  intervalMs?: number;
  log?: (message: string) => void;
  /** Test seam — default reads the live config. */
  config?: () => { provider: string; apiKey: string };
  /** Test seam — default fetches the live catalog (forced). */
  fetchCatalog?: () => Promise<ModelCatalog>;
}

export interface ModelCatalogScheduler {
  start(): void;
  stop(): void;
  refreshNow(): Promise<void>;
}

export function refreshIntervalMs(): number {
  const hours = Number(process.env.MODEL_CATALOG_REFRESH_HOURS);
  const h = Number.isFinite(hours) && hours >= 1 ? Math.min(hours, 168) : 12;
  return h * 3600e3;
}

export function createModelCatalogScheduler(deps: ModelCatalogSchedulerDeps = {}): ModelCatalogScheduler {
  const intervalMs = deps.intervalMs ?? refreshIntervalMs();
  const log = deps.log ?? ((m: string) => console.log(m));
  const readConfig = deps.config ?? (() => {
    const cfg = loadConfig();
    return { provider: String(cfg?.llm?.provider ?? 'opencode-go'), apiKey: String(cfg?.llm?.apiKey ?? '') };
  });
  const fetchCatalog = deps.fetchCatalog ?? (() => fetchModelCatalog(undefined, undefined, { force: true }));

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const refresh = async (): Promise<void> => {
    if (running) return; // ticks never overlap
    running = true;
    try {
      const { provider, apiKey } = readConfig();
      if (!apiKey) {
        log('[ModelCatalog] skipped — no API key configured (built-in list in use)');
        return;
      }
      const cat = await fetchCatalog();
      if (cat.stale) {
        log(`[ModelCatalog] refresh failed (${cat.reason ?? 'unknown'}) — keeping last good catalog`);
      } else {
        log(`[ModelCatalog] refreshed — ${cat.models.length} models from ${provider}`);
      }
    } catch (err: any) {
      log(`[ModelCatalog] refresh error: ${String(err?.message || err).slice(0, 140)}`);
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      void refresh(); // immediate refresh on boot — new users get the live list with zero clicks
      timer = setInterval(() => void refresh(), intervalMs);
      // Never hold the process open on this timer (graceful shutdown, tests).
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    refreshNow: refresh,
  };
}
