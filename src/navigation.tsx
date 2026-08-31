// Global navigation system — ONE drawer, ONE config, MANY triggers.
// NavigationProvider owns the drawer state and renders the single drawer;
// any screen header can place a <HamburgerTrigger /> that opens it.
import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { List } from '@phosphor-icons/react';
// Single source of truth for global navigation.
// Drives: hamburger items, active states, and navigation tests.
import type { Icon } from '@phosphor-icons/react';
import { House, UserCircle, IdentificationBadge, Tray, GlobeSimple, PaperPlaneTilt, ChatCircleDots, FileText } from '@phosphor-icons/react';

export type NavGroupId = 'library' | 'profile' | 'tools';

export interface NavigationItem {
  id: string;
  label: string;
  icon: Icon;
  route: string;
  group: NavGroupId;
  badgeKey?: 'applications' | 'recruiters';
  activeFor: (pathname: string) => boolean;
}

export const NAV_GROUPS: Array<{ id: NavGroupId; label: string }> = [
  { id: 'library', label: 'Library' },
  { id: 'profile', label: 'Profile' },
  { id: 'tools', label: 'Tools' },
];

export const NAV_ITEMS: NavigationItem[] = [
  { id: 'home', label: 'Home', icon: House, route: '/', group: 'library', activeFor: (p) => p === '/' },
  { id: 'master-cv', label: 'Master CV', icon: IdentificationBadge, route: '/master-cv', group: 'profile', activeFor: (p) => p === '/master-cv' },
  { id: 'recruiters', label: 'Recruiters', icon: Tray, route: '/recruiters', group: 'tools', badgeKey: 'recruiters', activeFor: (p) => p === '/recruiters' },
  { id: 'job-portals', label: 'Job Portals', icon: GlobeSimple, route: '/job-portals', group: 'tools', activeFor: (p) => p === '/job-portals' },
  { id: 'linkedin-posts', label: 'LinkedIn Posts', icon: PaperPlaneTilt, route: '/linkedin-posts', group: 'tools', activeFor: (p) => p === '/linkedin-posts' },
  { id: 'ai-interview', label: 'AI Interview', icon: ChatCircleDots, route: '/ai-interview', group: 'tools', activeFor: (p) => p === '/ai-interview' },
  { id: 'manual-jd', label: 'Manual JD', icon: FileText, route: '/manual-jd', group: 'tools', activeFor: (p) => p === '/manual-jd' },
];

/** Resolve the active navigation item id for a pathname (null = no match). */
export function activeNavId(pathname: string): string | null {
  const match = NAV_ITEMS.find((i) => i.activeFor(pathname));
  return match ? match.id : null;
}

interface NavigationContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const NavigationContext = createContext<NavigationContextValue>({
  isOpen: false,
  open: () => {},
  close: () => {},
});

export function useNavigation(): NavigationContextValue {
  return useContext(NavigationContext);
}

/** Consistent hamburger trigger — integrate into any screen header. */
export function HamburgerTrigger({ className = '' }: { className?: string }) {
  const { isOpen, open } = useNavigation();
  return (
    <button
      onClick={open}
      aria-label="Open menu"
      aria-expanded={isOpen}
      title="Menu"
      className={`w-10 h-10 rounded-[10px] flex items-center justify-center border border-[var(--color-hairline)] bg-white transition-colors cursor-pointer hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)] shrink-0 ${className}`}
      style={{ color: 'var(--color-ink)' }}
    >
      <List size={19} weight="bold" />
    </button>
  );
}

interface NavigationProviderProps {
  onNavigate: (itemId: string) => void;
  badges?: Record<string, number>;
  user?: { id: string; email: string; name: string; isGuest: boolean } | null;
  installedVersion?: string;
  children: React.ReactNode;
}

export function NavigationProvider({ onNavigate, badges = {}, user, installedVersion, children }: NavigationProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // Escape closes the drawer from anywhere.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  const { pathname } = useLocationShim();
  const activeId = activeNavId(pathname);

  const pick = (item: NavigationItem) => () => {
    // Conventional behavior: navigating closes the drawer; the trigger
    // remains available in the destination screen header.
    close();
    onNavigate(item.id);
  };

  return (
    <NavigationContext.Provider value={{ isOpen, open, close }}>
      {children}
      {/* Backdrop + single drawer — rendered once, above every screen. */}
      <div
        className={`fixed inset-0 z-50 bg-slate-900/35 transition-opacity duration-200 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={close}
        aria-hidden="true"
      />
      <aside
        className={`fixed top-0 left-0 bottom-0 z-[60] w-[300px] bg-white flex flex-col transition-transform duration-200 ${isOpen ? 'translate-x-0' : '-translate-x-full invisible'}`}
        style={{ borderRight: '1px solid var(--color-hairline)' }}
        role="dialog"
        aria-label="Menu"
        aria-hidden={!isOpen}
      >
        <div className="flex items-center gap-3 px-4 py-4" style={{ borderBottom: '1px solid var(--color-hairline)' }}>
          <div className="w-9 h-9 rounded-[10px] flex items-center justify-center text-white font-extrabold text-[16px]" style={{ background: 'var(--color-brand)' }}>T</div>
          <span className="text-[15px] font-bold tracking-[-0.01em]">Tailor AI</span>
          <button
            onClick={close}
            aria-label="Close menu"
            className="ml-auto w-8 h-8 rounded-lg border border-[var(--color-hairline)] bg-white flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--color-brand-soft)]"
            style={{ color: 'var(--color-muted)' }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3l8 8M11 3l-8 8" /></svg>
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          {NAV_GROUPS.map((group) => (
            <React.Fragment key={group.id}>
              <div className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--color-faint)' }}>{group.label}</div>
              {NAV_ITEMS.filter((i) => i.group === group.id).map((item) => (
                <button
                  key={item.id}
                  onClick={pick(item)}
                  className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-[10px] text-[13px] font-semibold text-left transition-colors duration-150 border cursor-pointer ${
                    activeId === item.id
                      ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)] border-[var(--color-brand-line)]'
                      : 'border-transparent hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-brand)]'
                  }`}
                  style={activeId !== item.id ? { color: 'var(--color-muted)' } : undefined}
                  aria-current={activeId === item.id ? 'page' : undefined}
                >
                  <span className="shrink-0" style={{ color: activeId === item.id ? 'var(--color-brand)' : item.id === 'recruiters' ? 'var(--color-cta)' : item.id === 'ai-interview' || item.id === 'linkedin-posts' ? '#7C3AED' : 'var(--color-faint)' }}>
                    <item.icon size={17} weight="duotone" />
                  </span>
                  <span className="truncate">{item.label}</span>
                  {item.badgeKey && (badges[item.badgeKey] ?? 0) > 0 && (
                    <span className="ml-auto min-w-[18px] px-1 h-[18px] rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                      {badges[item.badgeKey]! > 99 ? '99+' : badges[item.badgeKey]}
                    </span>
                  )}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        {user && (
          <div className="px-4 py-3 flex items-center gap-3" style={{ borderTop: '1px solid var(--color-hairline)' }}>
            <span className={`w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0 ${user.isGuest ? 'bg-[#F59E0B]' : ''}`} style={user.isGuest ? undefined : { background: 'var(--color-brand)' }}>
              {user.name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || user.email[0]?.toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-bold truncate">{user.name}</div>
              <div className="text-[11px] truncate" style={{ color: 'var(--color-faint)' }}>v{installedVersion || '2.4.0'} · data stays on this machine</div>
            </div>
          </div>
        )}
      </aside>
    </NavigationContext.Provider>
  );
}

// Minimal location shim so the provider can highlight the active item
// without depending on the screen's router setup.
function useLocationShim() {
  return useLocation();
}

/** Lightweight contextual screen header: trigger + title + actions. */
export function ScreenHeader({
  title,
  subtitle,
  actions,
  className = '',
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 sm:px-6 py-3 shrink-0 ${className}`} style={{ borderBottom: '1px solid var(--color-hairline)', background: '#fff' }}>
      <HamburgerTrigger />
      <div className="min-w-0">
        <h1 className="text-[15px] font-bold leading-tight" style={{ color: 'var(--color-ink)' }}>{title}</h1>
        {subtitle && <p className="text-[11px] font-medium" style={{ color: 'var(--color-faint)' }}>{subtitle}</p>}
      </div>
      {actions && <div className="ml-auto flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}