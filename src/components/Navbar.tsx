import React, { useEffect, useRef, useState } from 'react';
import { SignOut, CaretDown, Question } from '@phosphor-icons/react';
import { HamburgerTrigger } from '../navigation';

interface NavbarProps {
  onOpenHome: () => void;
  onTour?: () => void;
  user?: { id: string; email: string; name: string; isGuest: boolean } | null;
  installedVersion?: string;
  onLogout?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  onOpenHome,
  onTour,
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

  // Keyboard shortcut for Settings (works from Home)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === ',') { e.preventDefault(); onOpenHome && onOpenHome(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onOpenHome]);

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
      <div className="max-w-[1440px] mx-auto px-4 sm:px-8 lg:px-12 h-[74px] flex items-center justify-between gap-4">
        {/* Hamburger + brand lockup */}
        <div className="flex items-center gap-3 min-w-0">
          <HamburgerTrigger />
          <div className="flex items-center gap-4 min-w-0">
            <button onClick={onOpenHome} title="Go to Home" aria-label="Go to Home" className="flex items-center gap-4 min-w-0 cursor-pointer bg-transparent border-none text-left" style={{ fontFamily: 'inherit' }}>
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-[13px] flex items-center justify-center text-white font-extrabold text-[21px] tracking-tight shrink-0" style={{ background: 'var(--color-brand)' }}>
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
            </button>
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