import React, { useState } from 'react';
import { MagnifyingGlass, MapPin, Play, CaretDown, CheckCircle, Info } from '@phosphor-icons/react';
import { JobSource } from '../types';
import { getRoleSuggestions, getKeywordSuggestions } from '../constants/suggestions';
import { getSourceFlag, getSourceCountry, getSourceMeta } from '../constants/sourceMeta';
import { searchLocations } from '../lib/locations';
import { SourceIcon } from './SourceIcon';

interface ScraperBarProps {
  onScrape: (params: {
    keywords: string;
    location: string;
    sources: JobSource[];
    datePostedFilter: 'all' | '24h' | '7d' | '30d';
    jobType?: 'all' | 'remote' | 'onsite' | 'hybrid';
    minSalary?: number;
    maxJobsPerSource?: number;
    contractType?: string;
    experienceLevel?: string;
    under10Applicants?: boolean;
  }) => Promise<{ scrapedTotal: number; addedCount: number; skippedDuplicates: number; filteredOutCount?: number; skippedSources?: { source: string; reason: string }[]; newContacts?: { name: string | null; email: string | null; phone: string | null; whatsapp: boolean; recruiterUrl: string | null; company: string }[] } | void>;
  isLoading: boolean;
  apifyAvailable?: boolean; // Apify enabled + token saved — lights up Apify-only sources
}

const ALL_SOURCES: JobSource[] = ['LinkedIn', 'Arbeitnow', 'SimplyHired', 'Dice', 'Reed', 'MyCareersFuture', 'Cutshort', 'Gupy', 'JobsCh', 'Daijob', 'MyJobMag', 'Indeed', 'Naukri', 'Glassdoor', 'Upwork', 'Greenhouse', 'Lever', 'Ashby', 'Workable', 'SmartRecruiters', 'Comeet', 'Join', 'Workday', 'Teamtailor', 'Personio', 'BambooHR', 'Rippling', 'JazzHR', 'Recruitee', 'iCIMS', 'Jobvite', 'Pinpoint'];
const COMING_SOON: JobSource[] = [];

export const ScraperBar: React.FC<ScraperBarProps> = ({ onScrape, isLoading, apifyAvailable }) => {
  const [keywords, setKeywords] = useState('');
  const [location, setLocation] = useState('');
  const [locationOptions, setLocationOptions] = useState<string[]>([]);
  const [datePostedFilter, setDatePostedFilter] = useState<'all' | '24h' | '7d' | '30d'>('24h');
  const [jobType, setJobType] = useState<'all' | 'remote' | 'onsite' | 'hybrid'>('remote');
  const [jobTypeInfoOpen, setJobTypeInfoOpen] = useState(false);
  const [experienceLevel, setExperienceLevel] = useState('');
  const [contractType, setContractType] = useState('');
  const [maxJobsPerSource, setMaxJobsPerSource] = useState<number>(10);
  const [under10Applicants, setUnder10Applicants] = useState(false);
  const [scrapeSuccessMsg, setScrapeSuccessMsg] = useState<string | null>(null);
  const [scrapeNewContacts, setScrapeNewContacts] = useState<{ name: string | null; email: string | null; phone: string | null; whatsapp: boolean; recruiterUrl: string | null }[]>([]);
  const [selectedSources, setSelectedSources] = useState<JobSource[]>(['LinkedIn']);
  const [atsCounts, setAtsCounts] = useState<Record<string, number>>({});

  // Per-ATS official career-portal counts — orders ATS chips by popularity
  // and labels each with its company-board count.
  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/ats/company-counts')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d?.counts) setAtsCounts(d.counts); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Non-ATS sources keep their fixed order; ATS (sources with official
  // career-portal counts) sorted by count desc, locked last.
  const visibleSources = React.useMemo(() => {
    const isAts = (s: JobSource) => atsCounts[s] !== undefined;
    const nonAts = ALL_SOURCES.filter((s) => !isAts(s));
    const locked = ALL_SOURCES.filter((s) => isAts(s) && getSourceMeta(s)?.locked);
    const activeAts = ALL_SOURCES.filter((s) => isAts(s) && !getSourceMeta(s)?.locked);
    const byCount = (list: JobSource[]) => [...list].sort((a, b) => (atsCounts[b] ?? 0) - (atsCounts[a] ?? 0));
    return [...nonAts, ...byCount(activeAts), ...byCount(locked)];
  }, [atsCounts]);

  const roleSuggestions = getRoleSuggestions(keywords);
  const keywordSuggestions = getKeywordSuggestions(keywords);

  const isApifyGated = (source: JobSource) => !!getSourceMeta(source)?.needsApify && !apifyAvailable;

  // Estimated Apify cost for the current selection at the chosen per-source limit.
  const costPerSearch = selectedSources.reduce((acc, s) => {
    const meta = getSourceMeta(s);
    const price = parseFloat(String(meta?.pricePer1K || '0').replace('$', '').replace(',', '')) || 0;
    return acc + price * (maxJobsPerSource / 1000);
  }, 0);

  const toggleSource = (source: JobSource) => {
    if (COMING_SOON.includes(source) || isApifyGated(source) || getSourceMeta(source)?.locked) return;
    setSelectedSources((prev) =>
      prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keywords.trim()) return;

    setScrapeSuccessMsg(null);
    setScrapeNewContacts([]);
    const result = await onScrape({
      keywords: keywords.trim(),
      location,
      sources: selectedSources,
      datePostedFilter,
      jobType,
      maxJobsPerSource,
      contractType: contractType || undefined,
      experienceLevel: experienceLevel || undefined,
      under10Applicants,
    });

    if (result && result.scrapedTotal > 0) {
      const filterNote = result.filteredOutCount && result.filteredOutCount > 0
        ? ` (${result.filteredOutCount} filtered out — over 10 applicants)`
        : '';
      setScrapeNewContacts(result.newContacts || []);
      if (result.addedCount > 0) {
        setScrapeSuccessMsg(`Scraped ${result.scrapedTotal} live postings! Added ${result.addedCount} new jobs to top (${result.skippedDuplicates} duplicates skipped).${filterNote}`);
      } else {
        setScrapeSuccessMsg(`Scraped ${result.scrapedTotal} live postings! (All ${result.skippedDuplicates} were already in your job list).${filterNote}`);
      }
    } else if (result?.skippedSources && result.skippedSources.length > 0) {
      const skippedNames = result.skippedSources.map((s) => `${s.source} (${s.reason})`).join(', ');
      setScrapeSuccessMsg(`Searched — skipped: ${skippedNames}.`);
    } else {
      const srcList = selectedSources.join(' + ');
      setScrapeSuccessMsg(`Searched ${srcList} — No results found in the selected window. Try different keywords, a wider posted window, or search again later.`);
    }
    setTimeout(() => setScrapeSuccessMsg(null), 10000);
  };

  const selectClass =
    'w-full appearance-none bg-white border-[1.5px] border-[var(--color-hairline2)] rounded-[10px] pl-3 pr-9 py-2.5 text-[12.5px] font-semibold text-[var(--color-ink)] cursor-pointer transition-colors hover:border-[var(--color-brand-line)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-[3px] focus:ring-[var(--color-brand)]/12';
  const fieldLabelCls = 'text-[10px] font-extrabold uppercase tracking-[0.09em] text-[var(--color-faint)]';

  const renderSourceChip = (src: JobSource) => {
    const isComingSoon = COMING_SOON.includes(src);
    const isSelected = selectedSources.includes(src);
    const gated = isApifyGated(src);
    const meta = getSourceMeta(src);
    const locked = !!meta?.locked;
    const disabled = isComingSoon || gated || locked;
    const title = isComingSoon
      ? `${src} — Coming soon`
      : locked
      ? `${src} — paid/enterprise-only API — locked`
      : gated
      ? `${src} — requires Apify API key — enable in Settings`
      : `${src} — ${getSourceCountry(src)}${meta?.pricePer1K ? ` · ${meta.pricePer1K}/1K jobs` : ''}`;
    return (
      <button
        key={src}
        type="button"
        onClick={() => toggleSource(src)}
        disabled={disabled}
        title={title}
        aria-pressed={isSelected}
        className={`inline-flex items-center gap-2 pl-2.5 pr-3 py-[7px] rounded-full text-[11.5px] font-semibold border-[1.5px] whitespace-nowrap cursor-pointer select-none transition-all duration-200 ${
          disabled
            ? 'opacity-45 cursor-not-allowed bg-white border-[var(--color-hairline)] text-[var(--color-faint)]'
            : isSelected
            ? 'bg-[var(--color-brand)] border-[var(--color-brand)] text-white font-bold shadow-sm sc-chip-pop'
            : 'bg-white border-[var(--color-hairline)] text-[var(--color-muted)] hover:border-[var(--color-brand-line)] hover:text-[var(--color-ink)] hover:shadow-sm'
        }`}
      >
        <SourceIcon source={src} size={15} />
        <span>{src}</span>
        {meta?.apifyActorId && !locked && atsCounts[src] > 1 && (
          <span className={`text-[9px] font-extrabold tabular-nums rounded-full px-[6px] py-[1px] ${isSelected ? 'bg-white/20 text-white' : 'bg-[var(--color-brand-soft)] text-[var(--color-brand-strong)] border border-[var(--color-brand-line)]'}`} title="Official career portals in registry">{atsCounts[src].toLocaleString()}</span>
        )}
        {locked && (
          <span className="text-[8.5px] font-extrabold uppercase text-[var(--color-faint)] bg-white/60 border border-[var(--color-hairline)] rounded-full px-[7px] py-[2px]">🔒 {atsCounts[src] > 0 ? atsCounts[src].toLocaleString() : ''}</span>
        )}
        {isComingSoon && (
          <span className="text-[8.5px] font-extrabold uppercase text-[var(--color-faint)] bg-white/60 border border-[var(--color-hairline)] rounded-full px-[7px] py-[2px]">Soon</span>
        )}
        <span className={`w-[15px] h-[15px] inline-flex items-center justify-center rounded-full text-[9px] font-black transition-all ${isSelected ? 'bg-white/25 text-white' : 'hidden'}`}>✓</span>
      </button>
    );
  };

  return (
    <div className="bg-white border-b border-[var(--color-hairline)] py-5">
      <style>{`
        @keyframes sc-chip-pop { 0% { transform: scale(.85); } 60% { transform: scale(1.06); } 100% { transform: scale(1); } }
        .sc-chip-pop { animation: sc-chip-pop .28s cubic-bezier(.22,1,.36,1); }
        @media (prefers-reduced-motion: reduce) { .sc-chip-pop { animation: none; } }
      `}</style>
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
                <span>Search Jobs</span>
              </>
            )}
          </button>
        </div>

        {/* ── Row 2: Filter Grid ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* Location */}
          <div className="flex flex-col gap-[6px]">
            <label className={fieldLabelCls}>Location</label>
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

          {/* Job Type */}
          <div className="flex flex-col gap-[6px]">
            <label className={`${fieldLabelCls} flex items-center gap-1`}>
              Job Type
              <span className="relative inline-flex group">
                <button
                  type="button"
                  aria-label="Job type may not be accurate"
                  onClick={() => setJobTypeInfoOpen((v) => !v)}
                  className="inline-flex items-center justify-center w-[15px] h-[15px] rounded-full border border-[var(--color-hairline2)] bg-[#F1F5F9] text-[var(--color-faint)] cursor-pointer transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-brand)]"
                >
                  <Info size={9} weight="bold" />
                </button>
                <span
                  className={`absolute top-full left-1/2 -translate-x-1/2 mt-1.5 w-52 bg-[var(--color-ink)] text-white text-[10.5px] font-medium leading-relaxed rounded-[10px] px-2.5 py-2 shadow-lg z-20 pointer-events-none transition-opacity duration-150 ${jobTypeInfoOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                >
                  Job-type labels are detected from descriptions and may not always be accurate.
                </span>
              </span>
            </label>
            <div className="relative">
              <select
                value={jobType}
                onChange={(e) => setJobType(e.target.value as any)}
                className={selectClass}
              >
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="onsite">On-site</option>
                <option value="all">All</option>
              </select>
              <CaretDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--color-faint)' }} />
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

          {/* Level */}
          <div className="flex flex-col gap-[6px]">
            <label className={fieldLabelCls}>Level</label>
            <div className="relative">
              <select
                value={experienceLevel}
                onChange={(e) => setExperienceLevel(e.target.value as any)}
                className={selectClass}
              >
                <option value="">Any level</option>
                <option value="1">Internship</option>
                <option value="2">Entry</option>
                <option value="3">Associate</option>
                <option value="4">Mid-Senior</option>
                <option value="5">Director</option>
                <option value="6">Executive</option>
              </select>
              <CaretDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--color-faint)' }} />
            </div>
          </div>

          {/* Contract type */}
          <div className="flex flex-col gap-[6px]">
            <label className={fieldLabelCls}>Contract</label>
            <div className="relative">
              <select
                value={contractType}
                onChange={(e) => setContractType(e.target.value as any)}
                className={selectClass}
              >
                <option value="">Any contract</option>
                <option value="F">Full-time</option>
                <option value="P">Part-time</option>
                <option value="C">Contract</option>
                <option value="T">Temporary</option>
                <option value="I">Internship</option>
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
                value={maxJobsPerSource}
                onChange={(e) => setMaxJobsPerSource(Number(e.target.value))}
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

          {/* Under 10 applicants */}
          <div className="flex flex-col gap-[6px]">
            <label className={fieldLabelCls}>Competition</label>
            <label className="flex items-center gap-2 bg-white border border-[var(--color-hairline)] rounded-[10px] px-3 py-2.5 cursor-pointer transition-colors hover:border-[var(--color-brand-line)]" title="Only show jobs with 10 or fewer applicants — low-competition roles (LinkedIn only; other sources are skipped when enabled)">
              <input
                type="checkbox"
                checked={under10Applicants}
                onChange={(e) => setUnder10Applicants(e.target.checked)}
                className="accent-[var(--color-brand)] w-[15px] h-[15px] cursor-pointer"
              />
              <span className="text-[12px] font-semibold text-[var(--color-muted)] truncate">Under 10 applicants</span>
            </label>
          </div>

        </div>

        {/* ── Row 3: Source Pills with Flags (wrap — never overflow) ── */}
        <div className="flex items-start gap-3 pt-4 border-t border-[var(--color-hairline)]">
          <span className={`${fieldLabelCls} pt-[9px] whitespace-nowrap shrink-0`}>Sources</span>
          <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
            {visibleSources.map((src) => renderSourceChip(src))}
          </div>
        </div>

        {/* ── Scrape result banner (own row — never overlaps the source chips) ── */}
        {scrapeSuccessMsg && (
          <div className="flex items-start gap-2 w-full bg-[var(--color-cta-soft)] border border-[var(--color-cta-line)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#065F46]">
            <CheckCircle size={16} className="shrink-0 mt-[1px]" style={{ color: 'var(--color-cta)' }} weight="fill" />
            <div className="min-w-0">
              <span>{scrapeSuccessMsg}</span>
              {scrapeNewContacts.length > 0 && (
                <div className="mt-1 flex items-start gap-1.5 text-[11.5px]">
                  <span className="font-bold whitespace-nowrap">
                    +{scrapeNewContacts.length} recruiter{scrapeNewContacts.length > 1 ? 's' : ''}:
                  </span>
                  <span className="text-[#047857]">
                    {scrapeNewContacts.slice(0, 6).map((c) => {
                      const value = c.email || c.phone || c.recruiterUrl || '';
                      const label = value.replace(/^https?:\/\//, '');
                      return c.name ? `${c.name} (${label})` : label;
                    }).join(' · ')}
                    {scrapeNewContacts.length > 6 ? ` · +${scrapeNewContacts.length - 6} more` : ''}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </form>
    </div>
  );
};
