import React, { useState } from 'react';
import { MagnifyingGlass, MapPin, Play, CaretDown, CheckCircle, Info, X, DotsSixVertical } from '@phosphor-icons/react';
import { JobSource } from '../types';
import { getRoleSuggestions, getKeywordSuggestions } from '../constants/suggestions';
import { getSourceFlag, getSourceCountry, getSourceMeta } from '../constants/sourceMeta';
import { searchLocations } from '../lib/locations';

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

const ALL_SOURCES: JobSource[] = ['LinkedIn', 'Arbeitnow', 'SimplyHired', 'Dice', 'Reed', 'MyCareersFuture', 'Cutshort', 'Gupy', 'JobsCh', 'Daijob', 'MyJobMag', 'RemoteOK', 'WeWorkRemotely', 'Indeed', 'Naukri', 'Glassdoor', 'Upwork', 'Greenhouse', 'Lever', 'Ashby', 'Workable', 'Workday', 'SmartRecruiters', 'Teamtailor', 'Personio', 'BambooHR', 'Rippling', 'JazzHR', 'Recruitee', 'iCIMS', 'Comeet', 'Pinpoint', 'Join'];
const COMING_SOON: JobSource[] = ['RemoteOK', 'WeWorkRemotely'];

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
  // Drag & drop state: the source currently being dragged, and whether the tray
  // is a valid drop target (highlighted while a palette chip hovers it).
  const [dragSource, setDragSource] = useState<JobSource | null>(null);
  const [trayDragOver, setTrayDragOver] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const roleSuggestions = getRoleSuggestions(keywords);
  const keywordSuggestions = getKeywordSuggestions(keywords);

  const isApifyGated = (source: JobSource) => !!getSourceMeta(source)?.needsApify && !apifyAvailable;

  const toggleSource = (source: JobSource) => {
    if (COMING_SOON.includes(source) || isApifyGated(source)) return;
    setSelectedSources((prev) =>
      prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source]
    );
  };

  // Palette → tray: append at the end (lowest priority).
  const addSource = (source: JobSource) => {
    if (COMING_SOON.includes(source) || isApifyGated(source)) return;
    setSelectedSources((prev) => (prev.includes(source) ? prev : [...prev, source]));
  };

  // Tray → tray: reorder by swapping positions (order = search priority).
  const moveSource = (from: JobSource, to: JobSource) => {
    if (from === to) return;
    setSelectedSources((prev) => {
      const next = [...prev];
      const fi = next.indexOf(from);
      const ti = next.indexOf(to);
      if (fi < 0 || ti < 0) return prev;
      next.splice(fi, 1);
      next.splice(ti, 0, from);
      return next;
    });
  };

  // Grouped palette: ATS-25 (Santa Maria actor), job boards (Valig actors), free built-ins.
  const ATS_25_SOURCES = ALL_SOURCES.filter((s) => getSourceMeta(s)?.apifyActorId === 'santamaria-automations~career-site-jobs-scraper');
  const BOARD_SOURCES = ALL_SOURCES.filter((s) => getSourceMeta(s)?.apifyActorId && getSourceMeta(s)?.apifyActorId !== 'santamaria-automations~career-site-jobs-scraper');
  const FREE_SOURCES = ALL_SOURCES.filter((s) => !getSourceMeta(s)?.apifyActorId);

  // Estimated Apify cost for the selection at the chosen per-source limit.
  const costPerSearch = selectedSources.reduce((acc, s) => {
    const meta = getSourceMeta(s);
    const price = parseFloat(String(meta?.pricePer1K || '0').replace('$', '').replace(',', '')) || 0;
    return acc + price * (maxJobsPerSource / 1000);
  }, 0);

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

  // Palette chip — draggable, click toggles selection.
  const renderPaletteChip = (src: JobSource) => {
    const isComingSoon = COMING_SOON.includes(src);
    const gated = isApifyGated(src);
    const meta = getSourceMeta(src);
    const disabled = isComingSoon || gated;
    const title = isComingSoon
      ? `${src} — Coming soon`
      : gated
      ? `${src} — requires Apify API key — enable in Settings`
      : `${src} — ${getSourceCountry(src)}${meta?.pricePer1K ? ` · ${meta.pricePer1K}/1K jobs` : ''}`;
    return (
      <button
        key={src}
        type="button"
        draggable={!disabled}
        onDragStart={(e) => { setDragSource(src); e.dataTransfer.effectAllowed = 'copy'; try { e.dataTransfer.setData('text/plain', src); } catch { /* ok */ } }}
        onDragEnd={() => setDragSource(null)}
        onClick={() => toggleSource(src)}
        disabled={disabled}
        title={title}
        className={`inline-flex items-center gap-2 pl-2.5 pr-3 py-[7px] rounded-full text-[11.5px] font-semibold border-[1.5px] transition-all whitespace-nowrap cursor-pointer select-none ${
          disabled
            ? 'opacity-45 cursor-not-allowed bg-white border-[var(--color-hairline)] text-[var(--color-faint)]'
            : dragSource === src
            ? 'opacity-40 scale-95 bg-white border-[var(--color-brand-line)] text-[var(--color-muted)]'
            : 'bg-white border-[var(--color-hairline)] text-[var(--color-muted)] hover:border-[var(--color-brand-line)] hover:text-[var(--color-ink)] hover:shadow-sm'
        }`}
      >
        <span className="text-[13px] leading-none">{getSourceFlag(src)}</span>
        <span>{src}</span>
        {meta?.apifyActorId && !gated && (
          <span className="text-[8.5px] font-extrabold uppercase tracking-[0.06em] text-white bg-[var(--color-brand)] rounded-full px-[7px] py-[2px]">Apify</span>
        )}
        {isComingSoon && (
          <span className="text-[8.5px] font-extrabold uppercase text-[var(--color-faint)]">Soon</span>
        )}
      </button>
    );
  };

  // Selected chip — draggable to reorder, ✕ removes.
  const renderSelectedChip = (src: JobSource, idx: number) => {
    const meta = getSourceMeta(src);
    return (
      <div
        key={src}
        draggable
        onDragStart={(e) => { setDragSource(src); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', src); } catch { /* ok */ } }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDrop={(e) => { e.preventDefault(); if (dragSource) moveSource(dragSource, src); }}
        onDragEnd={() => setDragSource(null)}
        title={`${src} — search priority ${idx + 1}. Drag to reorder.`}
        className={`inline-flex items-center gap-2 pl-2.5 pr-2 py-[7px] rounded-full text-[11.5px] font-bold border-[1.5px] whitespace-nowrap cursor-grab select-none transition-all ${
          dragSource === src
            ? 'opacity-50 scale-95 bg-[var(--color-brand-soft)] border-[var(--color-brand)] text-[var(--color-brand)]'
            : 'bg-[var(--color-brand-soft)] border-[var(--color-brand)] text-[var(--color-brand)] shadow-sm'
        }`}
      >
        <DotsSixVertical size={11} weight="bold" className="opacity-40 shrink-0" />
        <span className="text-[13px] leading-none">{getSourceFlag(src)}</span>
        <span>{src}</span>
        {meta?.pricePer1K && <span className="text-[9px] font-extrabold text-[var(--color-faint)] bg-white/70 border border-[var(--color-brand-line)] rounded-full px-[6px] py-[1px]">{meta.pricePer1K}/1K</span>}
        <button
          type="button"
          aria-label={`Remove ${src}`}
          onClick={(e) => { e.stopPropagation(); toggleSource(src); }}
          className="w-[15px] h-[15px] inline-flex items-center justify-center rounded-full bg-white/70 text-[var(--color-brand)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] transition-colors cursor-pointer shrink-0"
        >
          <X size={10} weight="bold" />
        </button>
      </div>
    );
  };

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

        {/* ── Row 3: Source Tray + Palette (drag to select, drag to reorder) ── */}
        <div className="pt-4 border-t border-[var(--color-hairline)] space-y-3">
          {/* Selection tray — drop palette sources here; drag inside to reorder */}
          <div
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = dragSource ? 'copy' : 'none'; setTrayDragOver(!!dragSource); }}
            onDragLeave={() => setTrayDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setTrayDragOver(false); if (dragSource) addSource(dragSource); }}
            className={`flex items-center gap-2 flex-wrap min-h-[50px] px-3 py-2 rounded-xl border-[1.5px] border-dashed transition-all duration-200 ${
              trayDragOver
                ? 'bg-[var(--color-brand-soft)] border-[var(--color-brand)]'
                : selectedSources.length === 0
                ? 'bg-[#FAFAF9] border-[var(--color-hairline2)]'
                : 'bg-white border-[var(--color-hairline2)]'
            }`}
          >
            {selectedSources.length === 0 ? (
              <span className="text-[12.5px] font-semibold text-[var(--color-faint)] px-2">
                Drag sources here — or click one below. Drag inside to set search priority.
              </span>
            ) : (
              selectedSources.map((src, i) => renderSelectedChip(src, i))
            )}
          </div>

          {/* Cost hint — what this selection will cost at the chosen limit */}
          <div className="flex items-center gap-2 text-[11px] font-semibold text-[var(--color-faint)]">
            <span>~${costPerSearch.toFixed(3)} per search</span>
            <span className="text-[var(--color-hairline2)]">|</span>
            <span>{selectedSources.length} source{selectedSources.length === 1 ? '' : 's'} · order = priority</span>
          </div>

          {/* Palette groups */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Job boards */}
            <div className="rounded-xl border border-[var(--color-hairline)] p-3">
              <div className="flex items-center justify-between mb-2">
                <span className={`${fieldLabelCls}`}>Job Boards</span>
                <span className="text-[10px] font-bold text-[var(--color-faint)] bg-[#F1F5F9] rounded-full px-2 py-0.5">{BOARD_SOURCES.length}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {BOARD_SOURCES.map((src) => renderPaletteChip(src))}
              </div>
            </div>

            {/* ATS career sites (25) */}
            <div className="rounded-xl border border-[var(--color-hairline)] p-3">
              <div className="flex items-center justify-between mb-2">
                <span className={`${fieldLabelCls}`}>ATS Career Sites</span>
                <span className="text-[10px] font-bold text-[var(--color-faint)] bg-[#F1F5F9] rounded-full px-2 py-0.5">{ATS_25_SOURCES.length}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {ATS_25_SOURCES.map((src) => renderPaletteChip(src))}
              </div>
            </div>
          </div>

          {/* Free built-ins — collapsible */}
          <div className="rounded-xl border border-[var(--color-hairline)] p-3">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className="w-full flex items-center justify-between text-left cursor-pointer"
            >
              <span className={`${fieldLabelCls}`}>Free Built-in Sources</span>
              <span className="flex items-center gap-1.5 text-[10px] font-bold text-[var(--color-faint)]">
                <span className="bg-[#F1F5F9] rounded-full px-2 py-0.5">{FREE_SOURCES.length}</span>
                <CaretDown size={11} className={`transition-transform duration-200 ${moreOpen ? 'rotate-180' : ''}`} />
              </span>
            </button>
            {moreOpen && (
              <div className="flex flex-wrap gap-2 pt-2.5">
                {FREE_SOURCES.map((src) => renderPaletteChip(src))}
              </div>
            )}
          </div>
        </div>

        {/* ── Scrape result banner ── */}
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