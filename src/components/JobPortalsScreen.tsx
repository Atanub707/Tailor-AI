import React, { useEffect, useMemo, useRef, useState } from 'react';
import { HamburgerTrigger } from '../navigation';
import { ExternalLink, Globe, Search, Star, X } from 'lucide-react';
import { JOB_PORTALS, PORTAL_CATEGORIES, JobPortal } from '../constants/jobPortals';
import { LIVE_SOURCES, isPortalLive } from '../constants/sourcePortalMap';
import {
  RECOMMENDED_REASON,
  RECOMMENDED_SET,
} from '../constants/recommendedPortals';
import {
  portalHost,
  portalHue,
  portalInitials,
  portalLogoUrl,
} from '../lib/portalDisplay';

interface JobPortalsScreenProps {
  isOpen: boolean;
  onClose: () => void;
}

type FilterId = 'all' | 'saved' | 'recommended' | string;

const ALL = 'all';
const SAVED = 'saved';
const RECOMMENDED = 'recommended';

const SEARCH_SUGGESTIONS = ['India', 'Remote', 'LinkedIn', 'Japan', 'Europe'];
const KNOWN_FILTERS = new Set<string>([
  ALL,
  SAVED,
  RECOMMENDED,
  ...PORTAL_CATEGORIES.map((c) => c.id),
]);

const CATEGORY_COUNTS = new Map(
  PORTAL_CATEGORIES.map((c) => [c.id, JOB_PORTALS.filter((p) => p.category === c.id).length])
);

const TOTAL = JOB_PORTALS.length;
const LIVE_PORTAL_COUNT = LIVE_SOURCES.filter((s) => s.portal !== null).length;

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand)]';

const FOCUS_RING_INSET =
  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-brand)]';

// Deep links: ?q= and ?f= survive a reload. The screen is URL-driven in App.tsx
// (/job-portals), so this is a query-string update, not a new route.
function readInitialFilters(): { q: string; filter: FilterId } {
  if (typeof window === 'undefined') return { q: '', filter: ALL };
  const params = new URLSearchParams(window.location.search);
  const f = params.get('f');
  return {
    q: params.get('q') || '',
    filter: f && KNOWN_FILTERS.has(f) ? f : ALL,
  };
}

function realHost(url: string): string {
  return portalHost(url);
}

interface PortalCardProps {
  portal: JobPortal;
  saved: boolean;
  onToggleSaved: (name: string) => void;
}

const PortalCard: React.FC<PortalCardProps> = ({ portal, saved, onToggleSaved }) => {
  const [logoFailed, setLogoFailed] = useState(false);
  const logoSrc = portalLogoUrl(portal.url);
  const live = isPortalLive(portal.name);
  const showLogo = Boolean(logoSrc) && !logoFailed;

  return (
    <div
      className={`group relative flex items-center gap-[11px] rounded-xl border px-[11px] py-2.5 transition-[border-color,box-shadow,transform] duration-150 motion-reduce:transition-none motion-reduce:hover:translate-y-0 hover:-translate-y-px hover:shadow-[0_6px_16px_-7px_rgba(15,23,42,0.16)] ${
        saved
          ? 'border-[var(--color-amber-line)] bg-[var(--color-amber-soft)] hover:border-[var(--color-amber-line)]'
          : 'border-[var(--color-hairline)] bg-[var(--color-surface)] hover:border-[#C3D6F5]'
      }`}
    >
      <a
        href={portal.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${portal.name} in a new tab`}
        className={`absolute inset-0 z-0 rounded-xl ${FOCUS_RING}`}
      />

      <span className="relative z-10 pointer-events-none shrink-0">
        {showLogo ? (
          <span className="flex h-[34px] w-[34px] items-center justify-center overflow-hidden rounded-[9px] border border-[var(--color-hairline)] bg-white p-1 transition-colors duration-150 group-hover:border-[#CBD9EE]">
            <img
              src={logoSrc ?? undefined}
              alt=""
              width={26}
              height={26}
              loading="lazy"
              decoding="async"
              className="block h-full w-full object-contain"
              onError={() => setLogoFailed(true)}
            />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="flex h-[33px] w-[33px] items-center justify-center rounded-[9px] text-[12.5px] font-extrabold tracking-[-0.02em] text-white"
            style={{ backgroundColor: `hsl(${portalHue(portal.name)} 56% 45%)` }}
          >
            {portalInitials(portal.name)}
          </span>
        )}
      </span>

      <span className="relative z-10 pointer-events-none min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="block truncate text-[13px] font-bold tracking-[-0.011em] text-[var(--color-ink)] transition-colors duration-150 group-hover:text-[var(--color-brand)]">
            {portal.name}
          </span>
          {live && (
            <span className="shrink-0 rounded-full border border-[var(--color-cta-line)] bg-[var(--color-cta-soft)] px-[5px] py-px text-[8.5px] font-extrabold uppercase tracking-[0.08em] text-[var(--color-cta)]">
              Live
            </span>
          )}
        </span>
        <span className="mt-px block truncate text-[10.5px] font-medium text-[var(--color-faint)]">
          {realHost(portal.url)}
        </span>
      </span>

      <span className="pointer-events-none relative z-10 flex shrink-0 items-center gap-px">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSaved(portal.name);
          }}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${portal.name} from saved` : `Save ${portal.name}`}
          title={saved ? `Remove ${portal.name} from saved` : `Save ${portal.name}`}
          className={`pointer-events-auto grid h-[27px] w-[27px] cursor-pointer place-items-center rounded-[7px] transition-colors duration-150 ${
            saved
              ? 'text-[var(--color-amber)] hover:bg-white/60'
              : 'text-[#C9D2DE] hover:bg-[#F1F5F9] hover:text-[var(--color-muted)]'
          } ${FOCUS_RING_INSET}`}
        >
          <Star size={14} strokeWidth={2} className={saved ? 'fill-current' : undefined} />
        </button>
        <span
          aria-hidden="true"
          className="grid h-[27px] w-[27px] place-items-center rounded-[7px] text-[#C9D2DE] transition-colors duration-150 group-hover:text-[var(--color-brand)]"
        >
          <ExternalLink size={13} strokeWidth={2.2} />
        </span>
      </span>
    </div>
  );
};

export const JobPortalsScreen: React.FC<JobPortalsScreenProps> = ({ isOpen, onClose }) => {
  const initialFilters = useMemo(readInitialFilters, []);
  const [searchInput, setSearchInput] = useState(initialFilters.q);
  const [query, setQuery] = useState(initialFilters.q);
  const [filter, setFilter] = useState<FilterId>(initialFilters.filter);
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Bookmarks are server-persisted: load on open, toggle through the same
  // GET / POST / DELETE contract the screen has always used.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetch('/api/portals/bookmarks')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setBookmarks(new Set(data.bookmarks || []));
      })
      .catch(() => {
        if (!cancelled) setBookmarks(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Search is debounced; the input stays responsive while the list settles.
  useEffect(() => {
    if (searchInput === query) return;
    const timer = window.setTimeout(() => setQuery(searchInput), 90);
    return () => window.clearTimeout(timer);
  }, [searchInput, query]);

  // Keep the filtered view shareable without adding a route.
  useEffect(() => {
    if (!isOpen) return;
    const params = new URLSearchParams(window.location.search);
    if (query) params.set('q', query);
    else params.delete('q');
    if (filter !== ALL) params.set('f', filter);
    else params.delete('f');
    const next = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    window.history.replaceState(null, '', next);
  }, [isOpen, query, filter]);

  const toggleBookmark = async (name: string) => {
    const isBookmarked = bookmarks.has(name);
    const url = isBookmarked
      ? `/api/portals/bookmarks/${encodeURIComponent(name)}`
      : '/api/portals/bookmarks';
    try {
      const res = await fetch(url, {
        method: isBookmarked ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isBookmarked ? undefined : JSON.stringify({ portalName: name }),
      });
      if (!res.ok) return;
      setBookmarks((prev) => {
        const next = new Set(prev);
        if (isBookmarked) next.delete(name);
        else next.add(name);
        return next;
      });
    } catch {
      // Leave the favourite untouched when the server cannot be reached.
    }
  };

  const savedCount = useMemo(
    () => JOB_PORTALS.filter((p) => bookmarks.has(p.name)).length,
    [bookmarks]
  );
  const recommendedCount = useMemo(
    () => JOB_PORTALS.filter((p) => RECOMMENDED_SET.has(p.name)).length,
    []
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return JOB_PORTALS.filter((p) => {
      if (filter === SAVED && !bookmarks.has(p.name)) return false;
      if (filter === RECOMMENDED && !RECOMMENDED_SET.has(p.name)) return false;
      if (filter !== ALL && filter !== SAVED && filter !== RECOMMENDED && p.category !== filter) {
        return false;
      }
      if (!q) return true;
      const category = PORTAL_CATEGORIES.find((c) => c.id === p.category);
      return (
        p.name.toLowerCase().includes(q) ||
        p.url.toLowerCase().includes(q) ||
        (category?.label.toLowerCase().includes(q) ?? false) ||
        (category?.description.toLowerCase().includes(q) ?? false)
      );
    });
  }, [query, filter, bookmarks]);

  const groups = useMemo(
    () =>
      PORTAL_CATEGORIES.map((category) => ({
        category,
        items: filtered.filter((p) => p.category === category.id),
      })).filter((group) => group.items.length > 0),
    [filtered]
  );

  if (!isOpen) return null;

  const flatFilter = filter === SAVED || filter === RECOMMENDED;
  const countLabel =
    filtered.length === TOTAL ? `${TOTAL} portals` : `${filtered.length} of ${TOTAL}`;

  const chips: Array<{ id: FilterId; label: string; count: number; tone?: 'saved' }> = [
    { id: ALL, label: 'All portals', count: TOTAL },
    { id: SAVED, label: 'Saved', count: savedCount, tone: 'saved' },
    { id: RECOMMENDED, label: 'Recommended', count: recommendedCount },
    ...PORTAL_CATEGORIES.map((c) => ({
      id: c.id as FilterId,
      label: c.label,
      count: CATEGORY_COUNTS.get(c.id) ?? 0,
    })),
  ];

  const applySuggestion = (value: string) => {
    setSearchInput(value);
    setQuery(value);
    setFilter(ALL);
  };

  const clearSearch = () => {
    setSearchInput('');
    setQuery('');
    inputRef.current?.focus();
  };

  const resetFilters = () => {
    setSearchInput('');
    setQuery('');
    setFilter(ALL);
    inputRef.current?.focus();
  };

  return (
    <div className="flex h-screen flex-col bg-[var(--color-canvas)] text-[var(--color-ink)]">
      <a
        href="#portal-results"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-[var(--color-ink)] focus:px-4 focus:py-2.5 focus:text-[13px] focus:font-semibold focus:text-white ${FOCUS_RING}`}
      >
        Skip to portals
      </a>

      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-hairline)] bg-white px-4 py-3.5 sm:px-6">
        <HamburgerTrigger />
        <div className="ml-1 min-w-0">
          <h1 className="truncate text-[15px] font-extrabold leading-tight text-[var(--color-ink)]">
            Job portals
          </h1>
          <p className="truncate text-[10.5px] font-medium text-[var(--color-faint)]">
            {TOTAL} portals · {PORTAL_CATEGORIES.length} regions
          </p>
        </div>
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-hairline)] bg-[var(--color-canvas)] px-3 py-1 text-[10.5px] font-bold text-[var(--color-faint)] sm:inline-flex">
          <Globe size={13} strokeWidth={2} className="text-[var(--color-cta)]" />
          {LIVE_SOURCES.length} live sources
        </span>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-4 pt-6 sm:px-6 sm:pt-[34px]">
          <p className="mb-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[var(--color-brand)]">
            Job portals
          </p>
          <h2 className="max-w-[720px] text-balance text-[clamp(27px,3.3vw,38px)] font-extrabold leading-[1.08] tracking-[-0.033em] text-[var(--color-ink)]">
            Every place worth applying.{' '}
            <span className="text-[var(--color-brand)]">
              {LIVE_SOURCES.length} of them apply for you.
            </span>
          </h2>
          <p className="mt-3.5 max-w-[640px] text-[14.5px] leading-[1.62] text-[var(--color-muted)]">
            <b className="font-semibold text-[var(--color-ink)]">
              {LIVE_SOURCES.length} live sources
            </b>{' '}
            are scraped continuously, deduplicated and scored against your master CV, so they land
            in your feed on their own. The rest are directories — go straight to the source and
            apply yourself.{' '}
            <b className="font-semibold text-[var(--color-ink)]">6,000+ company boards</b> are
            covered through Greenhouse, Lever and Ashby.
          </p>
        </div>

        {/* Fully opaque: content scrolling underneath must never bleed through. */}
        <div className="sticky top-0 z-20 bg-[var(--color-canvas)] shadow-[0_1px_0_var(--color-hairline)]">
          <div className="mx-auto max-w-[1180px] px-4 pb-3 pt-4 sm:px-6 sm:pb-[13px] sm:pt-[14px]">
            <div className="flex items-center gap-3">
              <div
                role="search"
                className="flex min-w-0 flex-1 cursor-text items-center gap-2.5 rounded-[14px] border-[1.5px] border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--color-brand)] focus-within:shadow-[0_0_0_4px_rgba(37,99,235,0.18)]"
              >
                <Search
                  size={17}
                  strokeWidth={2}
                  className="shrink-0 text-[var(--color-faint)]"
                  aria-hidden="true"
                />
                <input
                  ref={inputRef}
                  type="search"
                  autoComplete="off"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  aria-label="Search portals by name or region"
                  placeholder="Search by name or region — Japan, DevOps, Singapore…"
                  className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[var(--color-ink)] outline-none placeholder:text-[#94A3B8] [&::-webkit-search-cancel-button]:appearance-none"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    aria-label="Clear search"
                    title="Clear search"
                    className={`grid h-[22px] w-[22px] shrink-0 cursor-pointer place-items-center rounded-full text-[var(--color-faint)] transition-colors duration-150 hover:bg-[#F1F5F9] hover:text-[var(--color-ink)] ${FOCUS_RING}`}
                  >
                    <X size={13} strokeWidth={2.4} />
                  </button>
                )}
              </div>
              <span
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold tabular-nums text-[var(--color-faint)]"
              >
                {countLabel}
              </span>
            </div>

            <div
              role="group"
              aria-label="Filter portals by region, saved, or recommended"
              className="no-scrollbar mt-[11px] flex gap-[7px] overflow-x-auto pb-1"
            >
              {chips.map((chip) => {
                const active = filter === chip.id;
                const tone = chip.tone;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setFilter(chip.id)}
                    aria-pressed={active}
                    className={`inline-flex shrink-0 cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-full border px-[13px] py-[7px] text-[12px] font-semibold transition-colors duration-150 ${FOCUS_RING} ${
                      active
                        ? tone === 'saved'
                          ? 'border-[var(--color-amber)] bg-[var(--color-amber)] text-white'
                          : 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white'
                        : 'border-[var(--color-hairline)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:border-[#C3CDDB] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    {chip.label}
                    <span
                      className={`text-[10.5px] font-bold tabular-nums ${
                        active ? 'text-white/60' : 'text-[var(--color-faint)]'
                      }`}
                    >
                      {chip.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div
          id="portal-results"
          tabIndex={-1}
          className={`mx-auto max-w-[1180px] rounded-xl px-4 pb-24 pt-5 sm:px-6 ${FOCUS_RING}`}
        >
          <section
            aria-labelledby="liveband-h"
            className="mt-1 rounded-[14px] border border-[var(--color-cta-line)] bg-[linear-gradient(180deg,#F7FEFB_0%,#fff_100%)] px-3.5 pb-3.5 pt-3 sm:px-4 sm:pb-[15px] sm:pt-[14px]"
          >
            <div className="mb-[11px] flex items-center gap-2.5">
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-cta-line)] bg-[var(--color-cta-soft)] px-2 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[0.1em] text-[var(--color-cta)]">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-cta)]"
                />
                Live
              </span>
              <h2
                id="liveband-h"
                className="whitespace-nowrap text-[12px] font-extrabold uppercase tracking-[0.06em] text-[var(--color-ink)]"
              >
                {LIVE_SOURCES.length} sources feed your job feed
              </h2>
              <span aria-hidden="true" className="h-px flex-1 bg-[var(--color-cta-line)]" />
              <span className="hidden whitespace-nowrap text-[11px] font-semibold text-[var(--color-faint)] sm:inline">
                {LIVE_PORTAL_COUNT} of them appear below
              </span>
            </div>

            <ul
              id="live-sources"
              className={`flex list-none flex-wrap gap-[5px] ${
                sourcesExpanded
                  ? ''
                  : 'max-h-16 overflow-hidden [mask-image:linear-gradient(180deg,#000_62%,transparent)]'
              } sm:max-h-none sm:[mask-image:none]`}
            >
              {LIVE_SOURCES.map((source) => {
                const hasPortal = source.portal !== null;
                return (
                  <li
                    key={source.source}
                    title={source.portal ? `${source.portal} is in the directory` : undefined}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-[9px] py-[5px] text-[11.5px] font-semibold ${
                      hasPortal
                        ? 'border-[var(--color-cta-line)] bg-[var(--color-cta-soft)] text-[var(--color-ink)]'
                        : 'border-[var(--color-hairline)] bg-white text-[var(--color-muted)]'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--color-cta)]"
                    />
                    {source.source}
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              onClick={() => setSourcesExpanded((open) => !open)}
              aria-expanded={sourcesExpanded}
              aria-controls="live-sources"
              className={`mt-2.5 cursor-pointer text-[11.5px] font-bold tracking-[0.01em] text-[var(--color-cta)] hover:underline sm:hidden ${FOCUS_RING}`}
            >
              {sourcesExpanded ? 'Show fewer' : `Show all ${LIVE_SOURCES.length}`}
            </button>
          </section>

          {filtered.length === 0 && (
            <div
              role="status"
              className="mt-5 rounded-2xl border border-dashed border-[#CBD5E1] bg-[#FCFDFE] px-5 py-[60px] text-center"
            >
              <Search
                size={34}
                strokeWidth={1.6}
                className="mx-auto mb-3.5 text-[#CBD5E1]"
                aria-hidden="true"
              />
              <h2 className="mb-1.5 text-[15.5px] font-bold text-[var(--color-ink)]">
                {filter === SAVED ? 'Nothing saved yet.' : 'Nothing matches that search.'}
              </h2>
              <p className="mx-auto max-w-[390px] text-[13px] leading-[1.55] text-[var(--color-muted)]">
                {filter === SAVED
                  ? 'Tap the star on any portal to keep it here for later. Or try one of these searches:'
                  : `No portal name or region contains “${query.trim()}”. Try one of these instead:`}
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {SEARCH_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => applySuggestion(suggestion)}
                    className={`cursor-pointer rounded-full border border-[var(--color-hairline)] bg-white px-3 py-1.5 text-[12px] font-semibold text-[var(--color-muted)] transition-colors duration-150 hover:border-[#C3CDDB] hover:text-[var(--color-ink)] ${FOCUS_RING}`}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={resetFilters}
                className={`mt-4 cursor-pointer rounded-[9px] border border-[var(--color-hairline)] bg-white px-4 py-2 text-[12.5px] font-semibold text-[var(--color-ink)] transition-colors duration-150 hover:border-[#C3CDDB] ${FOCUS_RING}`}
              >
                Clear all filters
              </button>
            </div>
          )}

          {filtered.length > 0 && flatFilter && (
            <section aria-labelledby="flat-filter-heading" className="mt-1">
              <div className="mb-[11px] flex items-center gap-2.5">
                <Star
                  size={14}
                  strokeWidth={2}
                  className={
                    filter === SAVED
                      ? 'fill-[var(--color-amber)] text-[var(--color-amber)]'
                      : 'fill-[var(--color-brand)] text-[var(--color-brand)]'
                  }
                  aria-hidden="true"
                />
                <h2
                  id="flat-filter-heading"
                  className="whitespace-nowrap text-[12px] font-extrabold uppercase tracking-[0.1em] text-[var(--color-ink)]"
                >
                  {filter === SAVED ? 'Saved portals' : 'Recommended by us'}
                </h2>
                <span className="rounded-full border border-[var(--color-hairline)] bg-white px-2 py-0.5 text-[10.5px] font-bold tabular-nums text-[var(--color-faint)]">
                  {filtered.length}
                </span>
                <span aria-hidden="true" className="h-px flex-1 bg-[var(--color-hairline)]" />
              </div>

              {filter === RECOMMENDED && (
                <div className="mb-2.5 flex items-start gap-2.5 rounded-xl border border-[var(--color-brand-line)] bg-[var(--color-brand-soft)] px-3.5 py-2.5 text-[12px] leading-[1.5] text-[var(--color-muted)]">
                  <Star
                    size={14}
                    strokeWidth={2}
                    className="mt-px shrink-0 fill-[var(--color-brand)] text-[var(--color-brand)]"
                    aria-hidden="true"
                  />
                  <p>{RECOMMENDED_REASON}</p>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 md:grid-cols-[repeat(auto-fill,minmax(256px,1fr))]">
                {filtered.map((portal, index) => (
                  <PortalCard
                    key={`${portal.name}-${portal.category}-${index}`}
                    portal={portal}
                    saved={bookmarks.has(portal.name)}
                    onToggleSaved={toggleBookmark}
                  />
                ))}
              </div>
            </section>
          )}

          {filtered.length > 0 &&
            !flatFilter &&
            groups.map((group) => (
              <section
                key={group.category.id}
                aria-labelledby={`group-${group.category.id}`}
                className="mt-7 first:mt-2.5"
              >
                <div className="mb-[11px] flex items-center gap-2.5">
                  <h2
                    id={`group-${group.category.id}`}
                    className="min-w-0 whitespace-normal text-[11px] font-extrabold uppercase leading-snug tracking-[0.1em] text-[var(--color-ink)] sm:whitespace-nowrap sm:text-[12px]"
                  >
                    {group.category.label}
                  </h2>
                  <span className="shrink-0 rounded-full border border-[var(--color-hairline)] bg-white px-2 py-0.5 text-[10.5px] font-bold tabular-nums text-[var(--color-faint)]">
                    {group.items.length}
                  </span>
                  <span aria-hidden="true" className="hidden h-px min-w-3 flex-1 bg-[var(--color-hairline)] sm:block" />
                  <span className="hidden max-w-[290px] truncate whitespace-nowrap text-[11px] font-medium text-[var(--color-faint)] lg:block">
                    {group.category.description}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[repeat(auto-fill,minmax(256px,1fr))]">
                  {group.items.map((portal, index) => (
                    <PortalCard
                      key={`${portal.name}-${portal.category}-${index}`}
                      portal={portal}
                      saved={bookmarks.has(portal.name)}
                      onToggleSaved={toggleBookmark}
                    />
                  ))}
                </div>
              </section>
            ))}
        </div>
      </main>
    </div>
  );
};
