import React, { useEffect, useRef, useState } from 'react';
import { IdentificationBadge, SlidersHorizontal, FileText, SignOut, CaretDown, GlobeSimple, Question, Tray, ChatCircleDots, PaperPlaneTilt, UserCircle, SuitcaseSimple } from '@phosphor-icons/react';

interface NavbarProps {
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
  const rootRef = useRef<HTMLDivElement>(null);

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

  const ddItemCls =
    'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg border-none bg-transparent cursor-pointer font-inherit text-[13px] font-semibold text-slate-700 text-left transition-colors duration-150 hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-brand)]';
  const ddIconCls =
    'w-8 h-8 rounded-lg bg-[#F1F5F9] border border-[var(--color-hairline)] flex items-center justify-center text-[var(--color-faint)] shrink-0';

  return (
    <header className="sticky top-0 z-30 bg-white" style={{ borderBottom: '1px solid var(--color-hairline)' }}>
      <div className="max-w-[1440px] mx-auto px-6 sm:px-8 lg:px-12 h-[74px] flex items-center justify-between gap-4">
        {/* Brand lockup: [T] Tailor AI / CREATED BY | Atanu */}
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

        {/* App-bar actions + account */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onOpenJobPortals?.()}
            className="hidden sm:inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[12.5px] font-semibold border border-[var(--color-hairline)] bg-white transition-colors cursor-pointer hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)]"
            title="Browse 190+ job portals worldwide"
            style={{ color: 'var(--color-muted)' }}
          >
            <GlobeSimple size={15} style={{ color: 'var(--color-brand)' }} weight="duotone" />
            Job Portals
          </button>

          <button
            onClick={() => onOpenChat?.()}
            className="hidden sm:inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[12.5px] font-semibold border border-[var(--color-hairline)] bg-white transition-colors cursor-pointer hover:bg-[var(--color-violet-soft,#F5F3FF)] hover:border-[var(--color-violet-line,#E9D5FF)]"
            title="AI Interview — mock interview based on your scraped jobs"
            style={{ color: 'var(--color-muted)' }}
          >
            <ChatCircleDots size={15} weight="duotone" style={{ color: '#7C3AED' }} />
            AI Interview
          </button>

          <button
            onClick={() => onOpenLinkedInPosts?.()}
            className="hidden sm:inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[12.5px] font-semibold border border-[var(--color-hairline)] bg-white transition-colors cursor-pointer hover:bg-[#F5F3FF] hover:border-[#E9D5FF]"
            title="LinkedIn Posts — job openings recruiters share as posts (last 24h)"
            style={{ color: 'var(--color-muted)' }}
          >
            <PaperPlaneTilt size={15} weight="duotone" style={{ color: '#7C3AED' }} />
            LinkedIn Posts
          </button>

          <button
            onClick={() => onOpenApplications?.()}
            className="relative hidden sm:inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[12.5px] font-semibold border border-[var(--color-hairline)] bg-white transition-colors cursor-pointer hover:bg-[var(--color-brand-soft)] hover:border-[var(--color-brand-line)]"
            title="Applications you are applying to"
            style={{ color: 'var(--color-muted)' }}
          >
            <SuitcaseSimple size={15} weight="duotone" style={{ color: 'var(--color-brand)' }} />
            Applications
            {applicationsBadge > 0 && (
              <span className="absolute -top-2 -right-2 min-w-[17px] h-[17px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                {applicationsBadge > 99 ? '99+' : applicationsBadge}
              </span>
            )}
          </button>

          <button
            onClick={() => onOpenRecruiters?.()}
            className="relative hidden sm:inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[12.5px] font-semibold border border-[var(--color-hairline)] bg-white transition-colors cursor-pointer hover:bg-[var(--color-cta-soft)] hover:border-[var(--color-cta-line)]"
            title="HR & recruiting emails found in job descriptions"
            style={{ color: 'var(--color-muted)' }}
          >
            <Tray size={15} weight="duotone" style={{ color: 'var(--color-cta)' }} />
            Recruiters
            {recruiterBadge > 0 && (
              <span className="absolute -top-2 -right-2 min-w-[17px] h-[17px] px-1 rounded-full bg-[var(--color-danger)] text-white text-[10px] font-bold flex items-center justify-center">
                {recruiterBadge > 99 ? '99+' : recruiterBadge}
              </span>
            )}
          </button>

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

                {/* Workspace */}
                <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--color-faint)' }}>
                  Workspace
                </div>
                <button role="menuitem" onClick={closeAnd(() => onOpenApplications?.())} className={ddItemCls}>
                  <span className={ddIconCls}><SuitcaseSimple size={16} weight="duotone" /></span>
                  Applications
                  {applicationsBadge > 0 && <span className="ml-auto min-w-[18px] px-1 h-[18px] rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">{applicationsBadge > 99 ? '99+' : applicationsBadge}</span>}
                </button>
                <button role="menuitem" onClick={closeAnd(onOpenMasterCv)} className={ddItemCls}>
                  <span className={ddIconCls}><IdentificationBadge size={16} weight="duotone" /></span>
                  Master Candidate CV
                </button>
                <button role="menuitem" onClick={closeAnd(() => onOpenApplicantProfile?.())} className={ddItemCls}>
                  <span className={ddIconCls}><UserCircle size={16} weight="duotone" /></span>
                  Applicant Profile
                </button>
                <button role="menuitem" onClick={closeAnd(onOpenManualJd)} className={ddItemCls}>
                  <span className={ddIconCls}><FileText size={16} weight="duotone" /></span>
                  Manual JD
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: 'var(--color-faint)' }}>⌘J</span>
                </button>
                <button role="menuitem" onClick={closeAnd(() => onOpenJobPortals?.())} className={ddItemCls}>
                  <span className={ddIconCls}><GlobeSimple size={16} weight="duotone" /></span>
                  Job Portals
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: 'var(--color-faint)' }}>190+</span>
                </button>
                <button role="menuitem" onClick={closeAnd(() => onOpenRecruiters?.())} className={ddItemCls}>
                  <span className={ddIconCls}><Tray size={16} weight="duotone" /></span>
                  Recruiters
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: 'var(--color-faint)' }}>HR emails</span>
                </button>

                {/* System */}
                <div className="px-2.5 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--color-faint)' }}>
                  System
                </div>
                <button role="menuitem" onClick={closeAnd(onOpenSettings)} className={ddItemCls}>
                  <span className={ddIconCls}><SlidersHorizontal size={16} weight="duotone" /></span>
                  Settings
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: 'var(--color-faint)' }}>⌘,</span>
                </button>

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
                  <span>v{installedVersion || '2.2.0'} · local</span>
                  <span>Data stays on this machine</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes dd { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
      `}</style>
    </header>
  );
};
