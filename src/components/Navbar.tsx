import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { IdentificationBadge, SlidersHorizontal, FileText, SignOut, CaretDown, GlobeSimple, Question, Tray, ChatCircleDots, PaperPlaneTilt, UserCircle, SuitcaseSimple, List, House } from '@phosphor-icons/react';

interface NavbarProps {
  onOpenHome: () => void;
  onOpenMasterCv: () => void;
  onOpenApplicantProfile?: () => void;
  onOpenSettings: () => void;
  onOpenManualJd: () => void;
  onOpenJobPortals?: () => void;
  onOpenRecruiters?: () => void;
  onOpenChat?: () => void;
  onOpenLinkedInPosts?: () => void;
  onOpenApplications?: () => void;
  applicationsBadge?: number;
  onTour?: () => void;
  recruiterBadge?: number;
  user?: { id: string; email: string; name: string; isGuest: boolean } | null;
  installedVersion?: string;
  onLogout?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  onOpenHome,
  onOpenMasterCv,
  onOpenApplicantProfile,
  onOpenSettings,
  onOpenManualJd,
  onOpenJobPortals,
  onOpenRecruiters,
  onOpenChat,
  onOpenLinkedInPosts,
  onOpenApplications,
  applicationsBadge = 0,
  onTour,
  recruiterBadge = 0,
  user,
  installedVersion,
  onLogout,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  // Close when clicking outside or pressing Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Close the hamburger drawer on Escape
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // Keyboard shortcuts matching the hint labels in the menu
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'j') { e.preventDefault(); onOpenManualJd(); }
      if (e.key === ',') { e.preventDefault(); onOpenSettings(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onOpenManualJd, onOpenSettings]);

  if (!user) return null;

  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || user.email[0].toUpperCase();

  const closeAnd = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };

  // Keep the drawer open after navigation so users can shift between
  // screens quickly (it closes only via backdrop, Escape, or the X).
  const navigateFromDrawer = (fn: () => void) => () => fn();

  const ddItemCls =
    'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg border-none bg-transparent cursor-pointer font-inherit text-[13px] font-semibold text-slate-700 text-left transition-colors duration-150 hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-brand)]';
  const ddIconCls =
    'w-8 h-8 rounded-lg bg-[#F1F5F9] border border-[var(--color-hairline)] flex items-center justify-center text-[var(--color-faint)] shrink-0';

  // Hamburger navigation — everything that used to live in the app bar.
  const navItems: Array<{
    label: string; icon: React.ComponentType<{ size?: number; weight?: string; style?: React.CSSProperties }>;
    onClick: () => void; active: boolean; hint?: string; badge?: number; color?: string;
  }> = [
    { label: 'Home', icon: House, onClick: onOpenHome, active: pathname === '/', color: 'var(--color-brand)' },
    { label: 'Applications', icon: SuitcaseSimple, onClick: () => onOpenApplications?.(), active: pathname === '/applications' || pathname.startsWith('/applications/'), badge: applicationsBadge, color: 'var(--color-brand)' },
    { label: 'Job Portals', icon: GlobeSimple, onClick: () => onOpenJobPortals?.(), active: pathname === '/job-portals', hint: '190+', color: 'var(--color-brand)' },
    { label: 'LinkedIn Posts', icon: PaperPlaneTilt, onClick: () => onOpenLinkedInPosts?.(), active: pathname === '/linkedin-posts', color: '#7C3AED' },
    { label: 'Recruiters', icon: Tray, onClick: () => onOpenRecruiters?.(), active: pathname === '/recruiters', badge: recruiterBadge, color: 'var(--color-cta)' },
    { label: 'AI Interview', icon: ChatCircleDots, onClick: () => onOpenChat?.(), active: pathname === '/ai-interview', color: '#7C3AED' },
    { label: 'Master CV', icon: IdentificationBadge, onClick: onOpenMasterCv, active: pathname === '/master-cv', color: 'var(--color-brand)' },
    { label: 'Applicant Profile', icon: UserCircle, onClick: () => onOpenApplicantProfile?.(), active: pathname === '/applicant-profile', color: 'var(--color-brand)' },
    { label: 'Manual JD', icon: FileText, onClick: onOpenManualJd, active: pathname === '/manual-jd', hint: '⌘J', color: 'var(--color-brand)' },
    { label: 'Settings', icon: SlidersHorizontal, onClick: onOpenSettings, active: pathname === '/settings', hint: '⌘,', color: 'var(--color-brand)' },
  ];

  const workspaceItems = navItems.slice(1, 6);
  const prepareItems = navItems.slice(6, 9);
  const systemItems = navItems.slice(9);

  return (
    <header className="sticky top-0 z-30 bg-white" style={{ borderBottom: '1px solid var(--color-hairline)' }}>
      <div className="max-w-[1440px] mx-auto px-4 sm:px-8 lg:px-12 h-[74px] flex items-center justify-between gap-4">
        {/* Hamburger + brand lockup */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="Open menu"
            aria-expanded={drawerOpen}
            title="Menu"
            className="w-10 h-10 rounded-[10px] flex items-center justify-center border border-[var(--color-hairline)] bg-white transition-colors cursor-pointer hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)] shrink-0"
            style={{ color: 'var(--color-ink)' }}
          >
            <List size={19} weight="bold" />
          </button>
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-[13px] flex items-center justify-center text-white font-extrabold text-[21px] tracking-tight" style={{ background: 'var(--color-brand)' }}>
              T
            </div>
            <div className="flex flex-col justify-center leading-none min-w-0">
              <h1 className="text-[20px] sm:text-[23px] font-bold tracking-[-0.02em] leading-none truncate">Tailor AI</h1>
              <div className="mt-[6px] flex items-baseline gap-[8px]">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--color-faint)' }}>Created by</span>
                <span className="text-[11px]" style={{ color: 'var(--color-hairline2)' }}>|</span>
                <a
                  href="https://www.linkedin.com/in/atanu-biswas-006796239/"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Atanu on LinkedIn"
                  className="text-[20px] sm:text-[23px] font-semibold leading-none no-underline transition-opacity hover:opacity-70"
                  style={{ fontFamily: '"Snell Roundhand", "Brush Script MT", "Apple Chancery", cursive', color: 'var(--color-ink)' }}
                >
                  Atanu
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Account (all app-bar features live in the hamburger) */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative" ref={rootRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={`flex items-center gap-2 rounded-full border pl-1 pr-3 py-1 cursor-pointer transition-all duration-150 ${
                menuOpen ? 'border-[var(--color-brand-line)] ring-2 ring-[var(--color-brand)]/15' : 'border-[var(--color-hairline)]'
              } bg-white`}
            >
              <span className={`w-8 h-8 rounded-full flex items-center justify-center text-[11.5px] font-bold text-white ${user.isGuest ? 'bg-[#F59E0B]' : ''}`} style={user.isGuest ? undefined : { background: 'var(--color-brand)' }}>
                {initials}
              </span>
              <span className="hidden md:block text-xs font-bold max-w-28 truncate">{user.isGuest ? `Guest · ${user.name}` : user.name}</span>
              <CaretDown size={13} className={`transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--color-faint)' }} />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+8px)] w-72 bg-white border border-[var(--color-hairline)] rounded-2xl p-1.5 origin-top-right animate-[dd_.15s_ease-out]"
                style={{ boxShadow: '0 12px 32px rgba(30,27,75,0.12)' }}
              >
                {/* User card */}
                <div className="flex items-center gap-2.5 px-2.5 pb-3 pt-1.5 border-b border-[var(--color-hairline)] mb-1">
                  <span className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold text-white shrink-0 ${user.isGuest ? 'bg-[#F59E0B]' : ''}`} style={user.isGuest ? undefined : { background: 'var(--color-brand)' }}>
                    {initials}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold truncate">{user.name}</div>
                    <div className="text-[11px] truncate" style={{ color: 'var(--color-faint)' }}>{user.email}</div>
                    {user.isGuest && (
                      <span className="inline-flex items-center mt-1 text-[9.5px] font-bold uppercase tracking-wide bg-[#FFF7ED] text-[#C2410C] rounded-full px-2 py-0.5">
                        Guest account
                      </span>
                    )}
                  </div>
                </div>

                {/* Sign out */}
                <div className="my-1.5 h-px bg-[var(--color-hairline)]" />
                <button role="menuitem" onClick={closeAnd(() => onTour?.())} className={ddItemCls}>
                  <span className={ddIconCls}><Question size={16} weight="duotone" /></span>
                  Take a tour
                </button>
                <button
                  role="menuitem"
                  onClick={closeAnd(() => onLogout?.())}
                  className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg border-none bg-transparent cursor-pointer font-inherit text-[13px] font-semibold text-red-600 text-left transition-colors duration-150 hover:bg-red-50"
                >
                  <span className="w-8 h-8 rounded-lg bg-red-50 border border-red-100 flex items-center justify-center text-red-500 shrink-0">
                    <SignOut size={16} weight="duotone" />
                  </span>
                  Sign out
                </button>

                {/* Footer */}
                <div className="mt-1.5 border-t border-[var(--color-hairline)] px-2.5 pt-2 pb-1.5 flex justify-between text-[10.5px]" style={{ color: 'var(--color-faint)' }}>
                  <span>v{installedVersion || '2.4.0'} · local</span>
                  <span>Data stays on this machine</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Hamburger drawer ── */}
      <div
        className={`fixed inset-0 z-50 bg-slate-900/35 transition-opacity duration-200 ${drawerOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={`fixed top-0 left-0 bottom-0 z-[60] w-[300px] bg-white flex flex-col transition-transform duration-200 ${drawerOpen ? 'translate-x-0' : '-translate-x-full invisible'}`}
        style={{ borderRight: '1px solid var(--color-hairline)' }}
        role="dialog"
        aria-label="Menu"
        aria-hidden={!drawerOpen}
      >
        {/* Drawer header */}
        <div className="flex items-center gap-3 px-4 py-4" style={{ borderBottom: '1px solid var(--color-hairline)' }}>
          <div className="w-9 h-9 rounded-[10px] flex items-center justify-center text-white font-extrabold text-[16px]" style={{ background: 'var(--color-brand)' }}>T</div>
          <span className="text-[15px] font-bold tracking-[-0.01em]">Tailor AI</span>
          <button
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="ml-auto w-8 h-8 rounded-lg border border-[var(--color-hairline)] bg-white flex items-center justify-center transition-colors cursor-pointer hover:bg-[var(--color-brand-soft)]"
            style={{ color: 'var(--color-muted)' }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3l8 8M11 3l-8 8" /></svg>
          </button>
        </div>

        {/* Drawer nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          <div className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--color-faint)' }}>Main</div>
          <DrawerItem {...navItems[0]} onNavigate={navigateFromDrawer} />
          <div className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--color-faint)' }}>Workspace</div>
          {workspaceItems.map((item) => (
            <DrawerItem key={item.label} {...item} onNavigate={navigateFromDrawer} />
          ))}
          <div className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--color-faint)' }}>Prepare</div>
          {prepareItems.map((item) => (
            <DrawerItem key={item.label} {...item} onNavigate={navigateFromDrawer} />
          ))}
          <div className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--color-faint)' }}>System</div>
          {systemItems.map((item) => (
            <DrawerItem key={item.label} {...item} onNavigate={navigateFromDrawer} />
          ))}
        </nav>

        {/* Drawer footer */}
        <div className="px-4 py-3 flex items-center gap-3" style={{ borderTop: '1px solid var(--color-hairline)' }}>
          <span className={`w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0 ${user.isGuest ? 'bg-[#F59E0B]' : ''}`} style={user.isGuest ? undefined : { background: 'var(--color-brand)' }}>
            {initials}
          </span>
          <div className="min-w-0">
            <div className="text-[12.5px] font-bold truncate">{user.name}</div>
            <div className="text-[11px] truncate" style={{ color: 'var(--color-faint)' }}>Guest · data stays on this machine</div>
          </div>
        </div>
      </aside>

      <style>{`
        @keyframes dd { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
      `}</style>
    </header>
  );
};

function DrawerItem({
  label,
  icon: Icon,
  onClick,
  active,
  hint,
  badge,
  color,
  onNavigate,
}: {
  key?: React.Key;
  label: string;
  icon: React.ComponentType<{ size?: number; weight?: string; style?: React.CSSProperties }>;
  onClick: () => void;
  active: boolean;
  hint?: string;
  badge?: number;
  color?: string;
  onNavigate: (fn: () => void) => () => void;
}) {
  return (
    <button
      onClick={onNavigate(onClick)}
      className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-[10px] text-[13px] font-semibold text-left transition-colors duration-150 border cursor-pointer ${
        active
          ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)] border-[var(--color-brand-line)]'
          : 'border-transparent hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-brand)]'
      }`}
      style={!active ? { color: 'var(--color-muted)' } : undefined}
      aria-current={active ? 'page' : undefined}
    >
      <span className="shrink-0" style={{ color: active ? 'var(--color-brand)' : color || 'var(--color-faint)' }}>
        <Icon size={17} weight="duotone" />
      </span>
      <span className="truncate">{label}</span>
      {badge && badge > 0 && (
        <span className="ml-auto min-w-[18px] px-1 h-[18px] rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {hint && !badge && <span className="ml-auto text-[10.5px] font-semibold" style={{ color: 'var(--color-faint)' }}>{hint}</span>}
    </button>
  );
}