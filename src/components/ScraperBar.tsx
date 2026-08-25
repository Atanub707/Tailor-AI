import React, { useState } from 'react';
import { MagnifyingGlass, MapPin, Play, CaretDown, CheckCircle } from '@phosphor-icons/react';
import { getRoleSuggestions, getKeywordSuggestions } from '../constants/suggestions';
import { searchLocations } from '../lib/locations';

interface ScraperBarProps {
  onScrape: (params: {
    keywords: string;
    location: string;
    postedWithin: 'all' | '24h' | '7d' | '30d';
    remote?: boolean;
    limit: number;
  }) => Promise<{ jobs: number; cacheHit: boolean; providersCalled: string[]; exhausted?: boolean; seenCount?: number; totalStored?: number } | void>;
  isLoading: boolean;
}

export const ScraperBar: React.FC<ScraperBarProps> = ({ onScrape, isLoading }) => {
  const [keywords, setKeywords] = useState('');
  const [location, setLocation] = useState('');
  const [locationOptions, setLocationOptions] = useState<string[]>([]);
  const [datePostedFilter, setDatePostedFilter] = useState<'all' | '24h' | '7d' | '30d'>('24h');
  const [maxJobs, setMaxJobs] = useState<number>(10);
  const [scrapeSuccessMsg, setScrapeSuccessMsg] = useState<string | null>(null);

  const roleSuggestions = getRoleSuggestions(keywords);
  const keywordSuggestions = getKeywordSuggestions(keywords);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keywords.trim()) return;

    setScrapeSuccessMsg(null);
    const result = await onScrape({
      keywords: keywords.trim(),
      location,
      postedWithin: datePostedFilter,
      limit: maxJobs,
    });

    if (result && result.jobs > 0) {
      const cacheNote = result.cacheHit ? ' — from cache, 0 credits' : '';
      const providers = result.providersCalled.length > 0 ? ` (${result.providersCalled.join(' + ')})` : '';
      const unseen = result.seenCount && result.totalStored
        ? ` · showing next ${result.seenCount} unseen · ${result.totalStored} stored in the last 24h`
        : '';
      setScrapeSuccessMsg(`Found ${result.jobs} jobs for "${keywords.trim()}"${providers}${cacheNote}${unseen}.`);
    } else if (result?.exhausted) {
      setScrapeSuccessMsg('No more new jobs in the last 24h — widen the window or check back later.');
    } else {
      setScrapeSuccessMsg('No results found in the selected window. Try different keywords, a wider posted window, or search again later.');
    }
    setTimeout(() => setScrapeSuccessMsg(null), 10000);
  };

  const selectClass =
    'w-full appearance-none bg-white border-[1.5px] border-[var(--color-hairline2)] rounded-[10px] pl-3 pr-9 py-2.5 text-[12.5px] font-semibold text-[var(--color-ink)] cursor-pointer transition-colors hover:border-[var(--color-brand-line)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-[3px] focus:ring-[var(--color-brand)]/12';
  const fieldLabelCls = 'text-[10px] font-extrabold uppercase tracking-[0.09em] text-[var(--color-faint)]';

  return (
    <div className="bg-white border-b border-[var(--color-hairline)] py-5">
      {/* Datalists for Native Auto-completion */}
      <datalist id="datalist-roles-keywords">
        {Array.from(new Set([...roleSuggestions, ...keywordSuggestions])).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <datalist id="datalist-locations">
        {locationOptions.map((loc) => (
          <option key={loc} value={loc} />
        ))}
      </datalist>

      <form onSubmit={handleSubmit} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
        {/* ── Row 1: Hero Search ── */}
        <div className="flex items-center gap-3 bg-[#FAFAF9] border-[1.5px] border-[var(--color-hairline2)] rounded-[12px] pl-5 pr-2 py-2 transition-colors focus-within:border-[var(--color-brand)] focus-within:bg-white focus-within:ring-[3px] focus-within:ring-[var(--color-brand)]/12">
          <MagnifyingGlass size={18} style={{ color: 'var(--color-faint)' }} weight="bold" />
          <input
            type="text"
            id="input-scrape-keywords"
            list="datalist-roles-keywords"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="Search role, skills, or job title — e.g. 'DevOps Engineer'"
            autoComplete="off"
            name="ats-search-keywords"
            className="flex-1 border-none outline-none bg-transparent text-[15px] font-semibold text-[var(--color-ink)] placeholder:text-[var(--color-faint)] placeholder:font-normal py-2"
            required
          />
          <button
            type="submit"
            disabled={isLoading}
            id="btn-scrape-submit"
            className="inline-flex items-center gap-2 bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] disabled:bg-[#A5A3D9] text-white rounded-[10px] px-6 py-3 text-[13.5px] font-bold transition-colors cursor-pointer whitespace-nowrap"
          >
            {isLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                <span>Searching jobs...</span>
              </>
            ) : (
              <>
                <Play size={13} weight="fill" />
                <span>Find Jobs</span>
              </>
            )}
          </button>
        </div>

        {/* ── Row 2: Unified filters — no source picker ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Location */}
          <div className="flex flex-col gap-[6px]">
            <label className={fieldLabelCls}>Where</label>
            <div className="relative">
              <MapPin size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--color-faint)' }} />
              <input
                type="text"
                id="input-scrape-location"
                list="datalist-locations"
                value={location}
                onChange={(e) => {
                  setLocation(e.target.value);
                  const q = e.target.value.trim();
                  if (q.length >= 1) {
                    searchLocations(q, 30).then((list) => setLocationOptions(list.map((l) => l.label)));
                  } else {
                    setLocationOptions([]);
                  }
                }}
                placeholder="Worldwide"
                autoComplete="off"
                name="ats-search-location"
                className="w-full bg-white border-[1.5px] border-[var(--color-hairline2)] rounded-[10px] pl-8 pr-3 py-2.5 text-[12.5px] font-semibold text-[var(--color-ink)] placeholder:text-[var(--color-faint)] placeholder:font-normal transition-colors hover:border-[var(--color-brand-line)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-[3px] focus:ring-[var(--color-brand)]/12"
              />
            </div>
          </div>

          {/* Posted */}
          <div className="flex flex-col gap-[6px]">
            <label className={fieldLabelCls}>Posted</label>
            <div className="relative">
              <select
                value={datePostedFilter}
                onChange={(e) => setDatePostedFilter(e.target.value as any)}
                className={selectClass}
              >
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="all">Anytime</option>
              </select>
              <CaretDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--color-faint)' }} />
            </div>
          </div>

          {/* Limit */}
          <div className="flex flex-col gap-[6px]">
            <label className={fieldLabelCls}>Limit</label>
            <div className="relative">
              <select
                id="select-scrape-limit"
                value={maxJobs}
                onChange={(e) => setMaxJobs(Number(e.target.value))}
                className={selectClass}
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={15}>15</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
              <CaretDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--color-faint)' }} />
            </div>
          </div>

          {/* Hint — no source picker */}
          <div className="flex flex-col justify-end">
            <p className="text-[10.5px] font-medium text-[var(--color-faint)] leading-snug">
              Searches all job sources (25+ ATS + job boards) automatically — no source selection needed.
            </p>
          </div>
        </div>

        {/* ── Scrape result banner ── */}
        {scrapeSuccessMsg && (
          <div className="flex items-start gap-2 w-full bg-[var(--color-cta-soft)] border border-[var(--color-cta-line)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#065F46]">
            <CheckCircle size={16} className="shrink-0 mt-[1px]" style={{ color: 'var(--color-cta)' }} weight="fill" />
            <span>{scrapeSuccessMsg}</span>
          </div>
        )}
      </form>
    </div>
  );
};