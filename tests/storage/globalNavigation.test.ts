// Global hamburger navigation — one shell, one config, every screen.
// Static + config-driven audits: trigger presence, single drawer, route
// coverage, active-state rules, no internal hard reloads.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const NAVBAR = fs.readFileSync(path.join(process.cwd(), 'src/components/Navbar.tsx'), 'utf8');
const APP = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
const NAV = fs.readFileSync(path.join(process.cwd(), 'src/navigation.tsx'), 'utf8');

// Config-driven inventory — mirrors src/navigation.ts without React imports.
const EXPECTED_ITEMS: Array<{ id: string; label: string; route: string; group: 'library' | 'profile' | 'tools' }> = [
  { id: 'home', label: 'Home', route: '/', group: 'library' },
  { id: 'applications', label: 'Applications', route: '/applications', group: 'library' },
  { id: 'applicant-profile', label: 'Applicant Profile', route: '/applicant-profile', group: 'profile' },
  { id: 'master-cv', label: 'Master CV', route: '/master-cv', group: 'profile' },
  { id: 'recruiters', label: 'Recruiters', route: '/recruiters', group: 'tools' },
  { id: 'job-portals', label: 'Job Portals', route: '/job-portals', group: 'tools' },
  { id: 'linkedin-posts', label: 'LinkedIn Posts', route: '/linkedin-posts', group: 'tools' },
  { id: 'ai-interview', label: 'AI Interview', route: '/ai-interview', group: 'tools' },
  { id: 'manual-jd', label: 'Manual JD', route: '/manual-jd', group: 'tools' },
  { id: 'settings', label: 'Settings', route: '/settings', group: 'tools' },
];

describe('Single source of truth — src/navigation.ts', () => {
  it('defines every expected navigation item with a route and group', () => {
    for (const item of EXPECTED_ITEMS) {
      expect(NAV).toContain(`id: '${item.id}'`);
      expect(NAV).toContain(`label: '${item.label}'`);
      expect(NAV).toContain(`route: '${item.route}'`);
      expect(NAV).toContain(`group: '${item.group}'`);
    }
  });

  it('every item route exists in App.tsx known paths/prefixes', () => {
    for (const item of EXPECTED_ITEMS) {
      if (item.route === '/') {
        expect(APP).toContain("knownPaths = ['/'");
      } else if (item.route.startsWith('/applications')) {
        expect(APP).toContain("pathname.startsWith('/applications/')");
        expect(APP).toContain("'/applications'");
      } else {
        expect(APP).toContain(`'${item.route}'`);
      }
    }
  });

  it('active-state rules: applications detail keeps Applications active; settings exact', () => {
    expect(NAV).toContain("p === '/applications' || p.startsWith('/applications/')");
    expect(NAV).toContain("p === '/settings'");
    expect(NAV).toContain('activeNavId');
  });
});

describe('Global navigation system — navigation.tsx', () => {
  it('exactly ONE drawer (provider) and ONE shared trigger component', () => {
    expect(NAV).toContain('export function NavigationProvider');
    expect(NAV).toContain('export function HamburgerTrigger');
    expect(NAV.match(/role="dialog"/g)?.length ?? 0).toBe(1);
    expect(NAV.match(/aria-label="Close menu"/g)?.length ?? 0).toBe(1);
    // one drawer per provider render — never per screen
    expect(NAV.match(/<aside/g)?.length ?? 0).toBe(1);
  });

  it('trigger accessibility: aria-expanded, Escape close, backdrop close, aria-hidden when closed', () => {
    expect(NAV).toContain('aria-expanded={isOpen}');
    expect(NAV).toContain('onClick={close}');
    expect(NAV).toContain('aria-hidden={!isOpen}');
    expect(NAV).toContain("key === 'Escape'");
  });

  it('drawer items render from the shared config (NAV_ITEMS + NAV_GROUPS), never per-item literals', () => {
    expect(NAV).toContain('NAV_ITEMS.filter');
    expect(NAV).toContain('NAV_GROUPS.map');
    expect(NAV).toContain('activeNavId');
    expect(NAV).toContain("id: 'settings'");
    // drawer rows read labels from the config, never hand-written rows
    expect(NAV).toContain('{item.label}');
  });

  it('has no internal hard navigation (window.location.href)', () => {
    expect(NAV).not.toContain('window.location.href');
    expect(NAV).not.toContain('window.location.assign');
    expect(NAV).not.toContain("location.href");
  });

  it('Home Navbar brand navigates to Home and keeps the shared trigger', () => {
    expect(NAVBAR).toContain('onClick={onOpenHome}');
    expect(NAVBAR).toContain('<HamburgerTrigger />');
  });

  it('navigating via the drawer closes it (conventional) and the trigger remains', () => {
    expect(NAV).toContain('close();');
    expect(NAV).toContain('onNavigate(item.id)');
  });
});

describe('App shell — navigation system', () => {
  it('the full Home Navbar renders on Home only', () => {
    expect(APP).toContain("{pathname === '/' && (");
    expect(APP).toContain('<Navbar');
    // Home dashboard content (ScraperBar + JobMatrix <main>) is wrapped in the
    // same Home-only branch so it never pushes feature screens below the fold.
    expect(APP).toContain('{/* Live Job Search Bar */}');
    const homeBranchStart = APP.indexOf("pathname === '/' && (");
    const mainIdx = APP.indexOf('<main>', homeBranchStart);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(APP.indexOf('</main>', mainIdx)).toBeGreaterThan(mainIdx);
    // Feature screens never render the full Home bar (Navbar has no route condition inside it)
    for (const file of ['SettingsModal.tsx', 'ManualJdScreen.tsx', 'ApplicationsScreen.tsx', 'ApplicantProfileScreen.tsx', 'MasterCvScreen.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/components', file), 'utf8');
      expect(src).not.toContain('Created by');
      expect(src).not.toContain('<Navbar');
    }
  });

  it('NavigationProvider (one drawer) wraps the authenticated app and every screen integrates the shared trigger', () => {
    expect(APP).toContain('<NavigationProvider');
    expect(APP).toContain('onNavigate=');
    expect(APP).toContain('</NavigationProvider>');
    for (const file of ['SettingsModal.tsx', 'ManualJdScreen.tsx', 'ApplicationsScreen.tsx', 'ApplicantProfileScreen.tsx', 'MasterCvScreen.tsx', 'RecruitersScreen.tsx', 'JobPortalsScreen.tsx', 'LinkedInPostsScreen.tsx', 'AiSystemScreen.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/components', file), 'utf8');
      expect(src).toContain('HamburgerTrigger');
    }
  });

  it('every normal screen renders in-flow (no full-viewport overlay covering the app bar)', () => {
    for (const file of ['JobPortalsScreen.tsx', 'ManualJdScreen.tsx', 'ApplicantProfileScreen.tsx', 'MasterCvScreen.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/components', file), 'utf8');
      const topLevel = src.slice(0, 1200);
      expect(topLevel).not.toMatch(/fixed inset-0 z-(3[0-9]|4[0-9]|5[0-9])/);
    }
    // Same guard for the CSS-defined screens: Settings, Recruiters, LinkedIn Posts, AI Interview.
    for (const file of ['SettingsModal.tsx', 'RecruitersScreen.tsx', 'LinkedInPostsScreen.tsx', 'AiSystemScreen.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/components', file), 'utf8');
      expect(src).not.toMatch(/position:fixed;? ?inset:0;? z-index:(3[0-9]|4[0-9]|5[0-9]|6[0-9])/);
    }
  });

  it('the onboarding tour is opt-in — its overlay must never auto-hijack navigation', () => {
    const tour = fs.readFileSync(path.join(process.cwd(), 'src/components/OnboardingTour.tsx'), 'utf8');
    // No auto-start: the tour effect must not call startTour on login.
    expect(tour).not.toMatch(/if \(!shouldShowTour\(\)\) return;[\s\S]*startTour\(\)/);
    expect(tour).toContain('OPT-IN ONLY');
    // Tour steps target the current UI: the hamburger trigger, not dead selectors.
    expect(tour).toContain('button[aria-label="Open menu"]');
  });
});

describe('No stale duplicate navigation surfaces', () => {
  it('screens do not render their own hamburger or nav menus', () => {
    for (const file of ['SettingsModal.tsx', 'JobPortalsScreen.tsx', 'ManualJdScreen.tsx', 'RecruitersScreen.tsx', 'LinkedInPostsScreen.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/components', file), 'utf8');
      expect(src).not.toContain('aria-label="Open menu"');
      expect(src).not.toContain('aria-label="Open navigation"');
    }
  });

  it('screens keep their contextual headers — no full Home app bar, one trigger each', () => {
    for (const file of ['SettingsModal.tsx', 'JobPortalsScreen.tsx', 'ManualJdScreen.tsx', 'RecruitersScreen.tsx', 'LinkedInPostsScreen.tsx', 'ApplicantProfileScreen.tsx', 'AiSystemScreen.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/components', file), 'utf8');
      expect(src.match(/<HamburgerTrigger/g)?.length ?? 0).toBe(1);
      expect(src).not.toContain('Created by');
    }
  });
});