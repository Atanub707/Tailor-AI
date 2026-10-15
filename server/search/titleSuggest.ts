// Live job-TITLE suggestions — REAL titles from the actual jobs, never a
// hardcoded list. Sources, merged:
//   1. the user's own saved jobs (their market context),
//   2. the live ATS index (Greenhouse/Lever/Ashby corpus, ~250k titles) via
//      the FTS5 title index — a role that appears tomorrow is suggestible
//      the moment the index syncs it.
// Only job TITLES are returned: no skills, no companies, no locations.

import { getDb } from '../storage/fileStorage.js';

export interface TitleSuggestion {
  title: string;
}

const CACHE_TTL_MS = 45_000;
const CACHE_MAX = 300;
const cache = new Map<string, { at: number; titles: string[] }>();

function normalize(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FTS5 prefix expression for a query: every token must prefix-match in the
 *  title column (word-level autocomplete semantics). */
function ftsExprFor(query: string): string | null {
  const tokens = normalize(query)
    .split(' ')
    .filter((t) => t.length >= 1)
    .slice(0, 5)
    .map((t) => t.replace(/"/g, ''));
  if (!tokens.length) return null;
  return tokens.map((t) => `title:"${t}"*`).join(' ');
}

export function suggestJobTitles(userId: string, query: string, limit = 8): string[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  const cacheKey = `${userId}|${q}|${limit}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.titles;

  const agg = new Map<string, { display: string; count: number; lastMs: number }>();
  const bump = (rawTitle: string, weight: number, lastMs: number) => {
    const title = String(rawTitle || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 120) return;
    const key = title.toLowerCase();
    const cur = agg.get(key);
    if (cur) {
      cur.count += weight;
      cur.lastMs = Math.max(cur.lastMs, lastMs);
    } else {
      agg.set(key, { display: title, count: weight, lastMs });
    }
  };

  try {
    const db = getDb();
    // 1) Live market titles via FTS (fast: title-only index).
    const expr = ftsExprFor(q);
    if (expr) {
      const rows = db
        .prepare(
          `SELECT j.title, j.posted_date FROM ats_jobs_fts f
           JOIN ats_jobs j ON j.rowid = f.rowid
           WHERE ats_jobs_fts MATCH ? AND j.is_active = 1
           LIMIT 800`
        )
        .all(expr) as { title: string; posted_date: string | null }[];
      for (const r of rows) bump(r.title, 1, r.posted_date ? Date.parse(r.posted_date) || 0 : 0);
    }
    // 2) The user's own jobs — their context ranks a little higher.
    const own = db
      .prepare(`SELECT data FROM jobs WHERE user_id = ?`)
      .all(userId) as { data: string }[];
    for (const row of own) {
      try {
        const j = JSON.parse(row.data) as { title?: string; postedDate?: string };
        const t = String(j.title || '');
        if (t && normalize(t).includes(q.split(' ')[0])) bump(t, 6, j.postedDate ? Date.parse(j.postedDate) || 0 : 0);
      } catch {
        /* malformed row — skip */
      }
    }
  } catch {
    /* index unavailable — suggestions degrade to the user's own titles */
  }

  const tokens = q.split(' ');
  const tier = (title: string): number => {
    const t = normalize(title);
    if (t.startsWith(q)) return 0; // "forward deploy" → "Forward Deployed Engineer"
    if (t.includes(q)) return 1; // contains the exact phrase
    // all tokens present as word-prefixes anywhere in the title
    const words = t.split(' ');
    const all = tokens.every((tok) => words.some((w) => w.startsWith(tok)));
    return all ? 2 : 3;
  };

  const titles = [...agg.values()]
    .sort((a, b) => {
      const ta = tier(a.display) - tier(b.display);
      if (ta !== 0) return ta;
      if (b.count !== a.count) return b.count - a.count;
      if (b.lastMs !== a.lastMs) return b.lastMs - a.lastMs;
      return a.display.length - b.display.length;
    })
    .slice(0, limit)
    .map((e) => e.display);

  // Cache only POSITIVE results: an empty answer must never mask a title
  // that just entered the corpus (the whole point of live suggestions).
  if (titles.length > 0) {
    if (cache.size >= CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, CACHE_MAX / 2);
      for (const [k] of oldest) cache.delete(k);
    }
    cache.set(cacheKey, { at: Date.now(), titles });
  }
  return titles;
}
