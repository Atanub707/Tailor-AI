import React, { useState, useEffect } from 'react';
import { HamburgerTrigger } from '../navigation';
import { X, MagnifyingGlass, ArrowSquareOut, Sparkle } from '@phosphor-icons/react';
import { ArrowLeft } from 'lucide-react';

interface PostResult {
  id: string;
  title: string;
  company: string;
  url: string;
  applyUrl?: string;
  postedDate?: string;
  description?: string;
  hashtags?: string[];
}

type SearchState = 'idle' | 'searching' | 'done' | 'error';

// Search results persist SERVER-SIDE (per user, SQLite lp_history table) —
// they stay on this screen across refresh, browser, and device, and are never
// auto-added to the job list (dashboard). Explicit per-post saves go there
// via POST /api/linkedin-posts/save.
const MAX_HISTORY = 200;
const mergeHistory = (existing: PostResult[], fresh: PostResult[]): PostResult[] => {
  const seen = new Set(existing.map((p) => p.id));
  const merged = [...existing];
  for (const p of fresh) {
    if (!seen.has(p.id)) {
      merged.unshift(p);
      seen.add(p.id);
    }
  }
  return merged.slice(0, MAX_HISTORY);
};

const RELATIVE = (iso?: string): string => {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))} min ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)} hr ago`;
  return `${Math.round(ms / 86400000)} days ago`;
};

const DAY_LABEL = (iso?: string): string => {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Group saved posts by their (posted or saved) date, newest first.
const groupByDay = (items: PostResult[]): { label: string; items: PostResult[] }[] => {
  const groups = new Map<string, PostResult[]>();
  for (const p of items) {
    const key = DAY_LABEL(p.postedDate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  return [...groups.entries()].map(([label, list]) => ({ label, items: list }));
};

const PostCard: React.FC<{ p: PostResult; onSave?: (p: PostResult) => void; saved?: boolean; saving?: boolean }> = ({ p, onSave, saved, saving }) => (
  <div className="lp-card">
    <div className="lp-card-top">
      <span className="lp-avatar">{p.company?.charAt(0)?.toUpperCase() || 'L'}</span>
      <div className="lp-card-meta">
        <b>{p.title}</b>
        <span>{p.company}{p.postedDate ? ` · ${RELATIVE(p.postedDate)}` : ''}</span>
      </div>
    </div>
    {p.description && <p className="lp-card-text">{p.description}</p>}
    {p.hashtags && p.hashtags.length > 0 && (
      <div className="lp-tags">
        {p.hashtags.map((h) => <span key={h} className="lp-tag">{h}</span>)}
      </div>
    )}
    <div className="lp-card-actions">
      <a className="lp-link" href={p.url} target="_blank" rel="noreferrer">
        Open post <ArrowSquareOut size={12} weight="bold" />
      </a>
      {p.applyUrl && (
        <a className="lp-link apply" href={p.applyUrl} target="_blank" rel="noreferrer">
          Apply link <ArrowSquareOut size={12} weight="bold" />
        </a>
      )}
      {onSave && (
        saved ? (
          <span className="lp-link saved" title="Saved to your job list">Saved ✓</span>
        ) : (
          <button type="button" className="lp-link save" onClick={() => onSave(p)} disabled={saving} title="Save to your job list (dashboard)">
            {saving ? 'Saving…' : 'Save to my job list'}
          </button>
        )
      )}
    </div>
  </div>
);

export const LinkedInPostsScreen: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [posts, setPosts] = useState<PostResult[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<{ queriesTried: number; linksFound: number } | null>(null);
  const [setup, setSetup] = useState<{ cookie: boolean; apify: boolean } | null>(null);
  // Search-history cache: persisted server-side per user, so it survives
  // refresh, closing/reopening this screen, and any browser/device.
  const [history, setHistory] = useState<PostResult[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => setSetup({ cookie: !!(c?.linkedin?.liAt), apify: !!(c?.apify?.enabled && c?.apify?.token) }))
      .catch(() => setSetup(null));
  }, []);

  // Restore previous search results + saved markers from the server so the
  // screen always shows what was found before — grouped by date, newest first.
  useEffect(() => {
    fetch('/api/linkedin-posts/history')
      .then((r) => r.json())
      .then((d) => {
        const posts: PostResult[] = d?.posts || [];
        setHistory(posts);
        setSavedIds(new Set(posts.filter((p) => (p as any).saved).map((p) => p.id)));
      })
      .catch(() => {})
      .finally(() => setHistoryLoaded(true));
  }, []);

  const search = async (raw?: string) => {
    const q = (raw ?? query).trim();
    if (!q || state === 'searching') return;
    setQuery(q);
    setState('searching');
    setError(null);
    setMessage(null);
    setPosts([]);
    try {
      const res = await fetch('/api/linkedin-posts/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: q, limit: 20, engine: 'free' }),
      });
      const d = await res.json();
      if (!res.ok) {
        throw new Error(d?.error || 'Search failed.');
      }
      setPosts(d.posts || []);
      setDebug(d.debug || null);
      setState('done');
      // Keep every found post on this screen (server persists it per user),
      // grouped by date, across visits.
      const fresh = d.posts || [];
      if (fresh.length > 0) {
        setHistory((prev) => mergeHistory(prev, fresh));
      }
      const window = 'from the last 24 hours ';
      if (d.valid === false) {
        // Prefer the server's precise, engine-aware message (it distinguishes
        // "engines rate-limited/blocked" from "found posts but all older than
        // 24h") — fall back to a generic hint only if the server omitted it.
        setMessage(d.message || (
          d.discoveryFailed
            ? `Search engines returned no results from this server (likely rate-limited or blocked — ${d.debug?.queriesTried ?? 0} queries tried). Try again in a minute.`
            : 'No recent job postings matched this search. Try a broader job role, e.g. "DevOps Engineer".'
        ));
      } else if (d.total === 0) {
        setMessage(`No job postings found ${window}for this search. Try broader keywords or search again later.`);
      } else {
        setMessage(`Found ${d.total} job postings ${window}— results stay on this screen. Save the ones you want with “Save to my job list”.`);
      }
    } catch (e: any) {
      setError(e?.message || 'Could not search LinkedIn posts.');
      setState('error');
    }
  };

  // Explicit per-post save into the user's job list (dashboard). Search
  // results are never auto-saved — this is the only way in.
  const savePost = async (p: PostResult) => {
    if (savingId) return;
    setSavingId(p.id);
    setError(null);
    try {
      const res = await fetch('/api/linkedin-posts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post: p }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || 'Could not save post.');
      const next = new Set(savedIds).add(p.id);
      setSavedIds(next);
      setMessage(d.alreadySaved
        ? `“${p.title}” was already in your job list.`
        : `“${p.title}” saved to your job list.`);
    } catch (e: any) {
      setError(e?.message || 'Could not save post.');
    } finally {
      setSavingId(null);
    }
  };

  const busy = state === 'searching';

  return (
    <div className="lp-screen">
      <header className="lp-hdr">
        <HamburgerTrigger />
        <div className="lp-hdr-logo"><span className="lp-orb" aria-hidden="true"></span></div>
        <div className="lp-hdr-ttl">
          <b>LinkedIn Posts</b>
          <span>Job openings recruiters share as posts — from the last 24 hours</span>
        </div>
        <div className="lp-spacer" />
        <button className="lp-x" onClick={onClose} aria-label="Close"><X size={18} weight="bold" /></button>
      </header>

      <div className="lp-body">
        {setup && !setup.apify && (
          <div className="lp-setup">
            <b>⚡ Free engine is active — no token needed</b>
            <p>Search runs through built-in search engines (Google/DuckDuckGo/Bing) — free and unlimited. The paid Apify engine is coming later.</p>
          </div>
        )}
        <div className="lp-hero">
          <span className="lp-eyebrow"><Sparkle size={12} weight="fill" /> Real-time job posts</span>
          <h1>Find jobs shared as LinkedIn posts</h1>
          <p>Recruiters announce openings in posts hours before formal listings. Search any role — we scrape the last 24 hours of LinkedIn posts and bring back the announcements with links.</p>

          {/* ChatGPT-style pill search bar */}
          <form
            className={`lp-search ${busy ? 'searching' : ''}`}
            onSubmit={(e) => { e.preventDefault(); search(); }}
            role="search"
          >
            <input
              className="lp-search-input"
              placeholder="Search job posts — e.g. DevOps Engineer, Cyber Security Engineer…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search LinkedIn posts"
              autoFocus
            />
            {busy && <span className="lp-spin" aria-hidden="true"></span>}
            <button type="submit" className="lp-search-btn" disabled={busy || !query.trim()} aria-label="Search">
              <MagnifyingGlass size={19} weight="bold" />
            </button>
          </form>

          {/* Engine indicator — Free engine active. Apify engine is locked for
              now (unlock later); the toggle stays hidden until it ships. */}
          <div className="lp-engine" role="group" aria-label="Search engine">
            <span className="lp-engine-btn on" aria-current="true">
              <span className="lp-engine-dot">◉</span> Free engine
              <span className="lp-engine-sub">built-in · no token</span>
            </span>
            <span className="lp-quota free">Free · unlimited</span>
            <span className="lp-engine-locked" title="Apify engine will unlock later">✦ Apify engine — coming soon</span>
          </div>
          <p className="lp-hint">Job postings only · last 24 hours · unlimited · results stay on this screen — save the ones you want to your job list</p>
        </div>

        {error && <div className="lp-error">{error}</div>}
        {message && <div className="lp-msg">{message}</div>}
        {state === 'done' && debug && debug.linksFound === 0 && (
          <p className="lp-debug">Diagnostics: {debug.queriesTried} queries tried · {debug.enginesUsed ?? 0} engine(s) reached · {debug.linksFound} LinkedIn post links returned. Sources: Google News RSS + DuckDuckGo/Bing (via render proxy) — retry in a minute if the engines are rate-limiting.</p>
        )}

        {state === 'done' && posts.length > 0 && (
          <div className="lp-results">
            <div className="lp-results-head">
              <b>{posts.length} job postings from the last 24 hours</b>
              <span>results stay here — save the ones you want</span>
            </div>
            <div className="lp-grid">
              {posts.map((p) => (
                <PostCard
                  key={p.id}
                  p={p}
                  onSave={savePost}
                  saved={savedIds.has(p.id)}
                  saving={savingId === p.id}
                />
              ))}
            </div>
          </div>
        )}

        {/* Search history — all posts found on this screen, kept across
            visits (this browser), grouped by date. Not auto-added to the
            dashboard; only explicitly saved posts go there. */}
        {historyLoaded && history.length > 0 && (
          <div className="lp-feed">
            <div className="lp-feed-title">
              <b>Your search results</b>
              <span>{history.length} post{history.length === 1 ? '' : 's'} kept on this screen</span>
              <button
                type="button"
                className="lp-feed-clear"
                onClick={async () => {
                  try {
                    await fetch('/api/linkedin-posts/history', { method: 'DELETE' });
                  } catch { /* server clear failed — still clear locally */ }
                  setHistory([]);
                  setSavedIds(new Set());
                }}
                title="Clear all search results from this screen"
              >
                Clear
              </button>
            </div>
            {groupByDay(history).map((g) => (
              <div className="lp-feed-day" key={g.label}>
                <div className="lp-feed-day-hdr">
                  <span className="lp-feed-dot" aria-hidden="true"></span>
                  <b>{g.label}</b>
                  <em>{g.items.length} post{g.items.length === 1 ? '' : 's'}</em>
                </div>
                <div className="lp-grid">
                  {g.items.map((p) => (
                    <PostCard
                      key={p.id}
                      p={p}
                      onSave={savePost}
                      saved={savedIds.has(p.id)}
                      saving={savingId === p.id}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        .lp-screen{position:relative; height:100vh; background:#F7F8FA; color:#0F172A; display:flex; flex-direction:column;
          font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;}
        .lp-hdr{display:flex; align-items:center; gap:13px; padding:0 28px; height:64px; border-bottom:1px solid #E2E8F0;
          background:rgba(255,255,255,.82); backdrop-filter:blur(12px); flex-shrink:0;}
        .lp-hdr-logo{display:inline-flex;}
        .lp-orb{width:30px; height:30px; border-radius:50%;
          background:radial-gradient(circle at 32% 28%, #fff 0%, #DBEAFE 9%, #7C3AED 42%, #2563EB 68%, #1E3A8A 100%);
          box-shadow:inset -6px -5px 10px rgba(30,58,138,.45), inset 4px 4px 8px rgba(255,255,255,.5), 0 6px 16px -6px rgba(37,99,235,.5);}
        .lp-hdr-ttl b{font-size:15px; font-weight:800; display:block; line-height:1.2;}
        .lp-hdr-ttl span{font-size:11px; color:#64748B; font-weight:500;}
        .lp-spacer{flex:1;}
        .lp-x{border:0; background:none; color:#64748B; cursor:pointer; padding:8px; border-radius:10px; display:inline-flex; transition:all .2s ease;}
        .lp-x:hover{background:#F1F5F9; color:#0F172A;}

        .lp-body{flex:1; overflow-y:auto; padding:44px 30px 60px;}
        .lp-hero{max-width:720px; margin:0 auto; text-align:center; display:flex; flex-direction:column; align-items:center;}
        .lp-eyebrow{display:inline-flex; align-items:center; gap:7px; font-size:10.5px; font-weight:800; letter-spacing:.16em; text-transform:uppercase;
          color:#7C3AED; background:#fff; border:1px solid #E9D5FF; border-radius:999px; padding:7px 16px; margin-bottom:18px; box-shadow:0 1px 3px rgba(15,23,42,.06);}
        .lp-hero h1{font-size:30px; font-weight:800; letter-spacing:-.045em; line-height:1.15;}
        .lp-hero p{font-size:13px; color:#475569; margin-top:10px; max-width:560px; line-height:1.7;}

        /* ChatGPT-style pill search bar */
        .lp-search{display:flex; align-items:center; gap:10px; width:100%; max-width:620px; margin:30px auto 0;
          background:#fff; border:1.5px solid #CBD5E1; border-radius:999px; padding:7px 7px 7px 24px;
          box-shadow:0 4px 18px -8px rgba(15,23,42,.12), 0 2px 6px -3px rgba(15,23,42,.06);
          transition:border-color .2s ease, box-shadow .2s ease;}
        .lp-search:focus-within{border-color:#2563EB; box-shadow:0 0 0 4px rgba(37,99,235,.1), 0 8px 24px -10px rgba(15,23,42,.14);}
        .lp-search-input{flex:1; border:0; outline:none; background:none; font-size:14px; color:#0F172A; font-family:inherit; padding:9px 0;}
        .lp-search-input::placeholder{color:#94A3B8;}
        .lp-search-btn{width:46px; height:46px; border-radius:50%; border:0; display:inline-flex; align-items:center; justify-content:center;
          background:linear-gradient(135deg,#2563EB,#1D4ED8); color:#fff; cursor:pointer; transition:filter .2s ease, transform .15s ease; flex-shrink:0;
          box-shadow:0 8px 18px -8px rgba(37,99,235,.6);}
        .lp-search-btn:hover{filter:brightness(1.08);}
        .lp-search-btn:active{transform:scale(.96);}
        .lp-search-btn:disabled{opacity:.5; cursor:not-allowed;}
        .lp-spin{width:18px; height:18px; border-radius:50%; border:2.5px solid #DBEAFE; border-top-color:#2563EB; animation:lpRot .7s linear infinite; flex-shrink:0;}
        @keyframes lpRot{to{transform:rotate(360deg)}}
        .lp-hint{font-size:11px; color:#64748B; margin-top:12px; font-weight:600;}
        .lp-engine{display:flex; align-items:center; justify-content:center; gap:9px; margin-top:18px; flex-wrap:wrap;}
        .lp-engine-btn{display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:700; color:#475569; cursor:pointer;
          background:#fff; border:1.5px solid #CBD5E1; border-radius:999px; padding:8px 15px; transition:all .18s ease; font-family:inherit;}
        .lp-engine-btn .lp-engine-sub{font-size:10px; font-weight:600; color:#94A3B8;}
        .lp-engine-btn.on{border-color:#2563EB; color:#1D4ED8; background:#EFF6FF; box-shadow:0 0 0 3px rgba(37,99,235,.12);}
        .lp-engine-btn:disabled{opacity:.45; cursor:not-allowed;}
        .lp-engine-dot{font-size:13px; line-height:1;}
        .lp-quota{font-size:11px; font-weight:800; color:#7C3AED; background:#F5F3FF; border:1px solid #E9D5FF; border-radius:999px; padding:6px 13px;}
        .lp-quota.out{color:#DC2626; background:#FEF2F2; border-color:#FECACA;}
        .lp-quota.free{color:#15803D; background:#F0FDF4; border-color:#BBF7D0;}
        .lp-engine-locked{font-size:11px; font-weight:800; color:#94A3B8; background:#F1F5F9; border:1px dashed #CBD5E1; border-radius:999px; padding:6px 13px; cursor:not-allowed;}
        .lp-debug{max-width:620px; margin:12px auto 0; font-size:10.5px; color:#94A3B8; text-align:center; line-height:1.6;}
        .lp-setup{max-width:620px; margin:0 auto 22px; background:#FFFBEB; border:1px solid #FDE68A; border-radius:14px; padding:15px 18px;}
        .lp-setup b{display:block; font-size:12.5px; font-weight:800; color:#92400E; margin-bottom:4px;}
        .lp-setup p{font-size:11.5px; color:#B45309; line-height:1.65;}

        .lp-error{align-self:center; font-size:12px; font-weight:700; color:#DC2626; background:#FEF2F2; border:1px solid #FECACA; border-radius:10px; padding:10px 15px;}
        .lp-msg{max-width:620px; margin:26px auto 0; font-size:12.5px; font-weight:700; color:#475569; background:#fff;
          border:1px solid #E2E8F0; border-radius:13px; padding:13px 17px; box-shadow:0 1px 3px rgba(15,23,42,.05); text-align:center;}

        .lp-results{max-width:900px; margin:34px auto 0;}
        .lp-results-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; padding:0 2px;}
        .lp-results-head b{font-size:15px; font-weight:800;}
        .lp-results-head span{font-size:11px; font-weight:800; color:#7C3AED; background:#F5F3FF; border:1px solid #E9D5FF; border-radius:999px; padding:4px 12px;}
        .lp-feed{max-width:900px; margin:44px auto 0; border-top:1px dashed #E2E8F0; padding-top:30px;}
        .lp-feed-title{display:flex; align-items:baseline; gap:10px; margin-bottom:6px; padding:0 2px;}
        .lp-feed-title b{font-size:16px; font-weight:800;}
        .lp-feed-title span{font-size:11px; color:#94A3B8; font-weight:600;}
        .lp-feed-clear{margin-left:auto; font-size:10.5px; font-weight:800; color:#64748B; background:#F1F5F9;
          border:1px solid #E2E8F0; border-radius:999px; padding:4px 12px; cursor:pointer; font-family:inherit; transition:all .18s ease;}
        .lp-feed-clear:hover{color:#DC2626; background:#FEF2F2; border-color:#FECACA;}
        .lp-feed-day{margin-top:20px;}
        .lp-feed-day-hdr{display:flex; align-items:center; gap:8px; margin-bottom:12px; padding:0 2px;}
        .lp-feed-day-hdr b{font-size:12.5px; font-weight:800; color:#334155;}
        .lp-feed-day-hdr em{font-size:10.5px; font-style:normal; font-weight:700; color:#94A3B8;}
        .lp-feed-dot{width:7px; height:7px; border-radius:50%; background:linear-gradient(135deg,#7C3AED,#2563EB); flex-shrink:0;}
        .lp-grid{display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:14px;}
        .lp-card{background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:18px 19px; box-shadow:0 1px 3px rgba(15,23,42,.05);
          display:flex; flex-direction:column; gap:11px; transition:border-color .2s ease, box-shadow .2s ease, transform .2s ease;}
        .lp-card:hover{border-color:#C7D2FE; box-shadow:0 10px 26px -12px rgba(15,23,42,.16); transform:translateY(-2px);}
        .lp-card-top{display:flex; align-items:center; gap:11px;}
        .lp-avatar{width:38px; height:38px; border-radius:11px; background:linear-gradient(135deg,#7C3AED,#2563EB); color:#fff; font-weight:800; font-size:14px;
          display:flex; align-items:center; justify-content:center; flex-shrink:0;}
        .lp-card-meta{min-width:0;}
        .lp-card-meta b{display:block; font-size:13px; font-weight:800; line-height:1.35;}
        .lp-card-meta span{font-size:11px; color:#64748B; display:inline-flex; align-items:center; gap:5px;}
        .lp-tags{display:flex; flex-wrap:wrap; gap:6px;}
        .lp-tag{font-size:10.5px; font-weight:800; color:#7C3AED; background:#F5F3FF; border:1px solid #E9D5FF; border-radius:999px; padding:3px 10px;}
        .lp-card-text{font-size:12px; color:#475569; line-height:1.6; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;}
        .lp-card-actions{display:flex; gap:9px; margin-top:auto; padding-top:2px;}
        .lp-link{display:inline-flex; align-items:center; gap:5px; font-size:11.5px; font-weight:800; color:#2563EB; text-decoration:none;
          background:#EFF6FF; border:1px solid #BFDBFE; border-radius:999px; padding:6px 12px; transition:all .18s ease;}
        .lp-link:hover{background:#DBEAFE;}
        .lp-link.apply{color:#7C3AED; background:#F5F3FF; border-color:#E9D5FF;}
        .lp-link.apply:hover{background:#EDE9FE;}
        .lp-link.save{color:#15803D; background:#F0FDF4; border-color:#BBF7D0; cursor:pointer; font-family:inherit; transition:all .18s ease;}
        .lp-link.save:hover{background:#DCFCE7;}
        .lp-link.save:disabled{opacity:.6; cursor:wait;}
        .lp-link.saved{color:#15803D; background:#F0FDF4; border-color:#BBF7D0; font-weight:800;}
        @media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none !important; transition:none !important;}}
      `}</style>
    </div>
  );
};
