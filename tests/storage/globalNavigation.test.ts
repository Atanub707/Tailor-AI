// Global hamburger navigation — one shell, one config, every screen.
// Static + config-driven audits: trigger presence, single drawer, route
// coverage, active-state rules, no internal hard reloads.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const NAVBAR = fs.readFileSync(path.join(process.cwd(), 'src/components/Navbar.tsx'), 'utf8');
const APP = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
const NAV = fs.readFileSync(path.join(process.cwd(), 'src/navigation.ts'), 'utf8');

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

describe('One global shell — Navbar', () => {
  it('renders exactly one hamburger trigger and one drawer', () => {
    expect(NAVBAR.match(/aria-label="Open menu"/g)?.length ?? 0).toBe(1);
    expect(NAVBAR.match(/aria-label="Close menu"/g)?.length ?? 0).toBe(1);
    expect(NAVBAR.match(/role="dialog"/g)?.length ?? 0).toBe(1);
    // Items are rendered from the shared config via a single DrawerItem
    // component inside the group map — one component, ten config entries.
    expect(NAVBAR.match(/<DrawerItem/g)?.length ?? 0).toBe(1);
    expect(NAV).toContain("id: 'settings'");
  });

  it('the trigger is accessible: aria-expanded + Escape close + backdrop close', () => {
    expect(NAVBAR).toContain('aria-expanded={drawerOpen}');
    expect(NAVBAR).toContain("e.key === 'Escape'");
    expect(NAVBAR).toContain('aria-hidden={!drawerOpen}');
  });

  it('drawer navigation uses the shared config, not per-item literals', () => {
    expect(NAVBAR).toContain("import { NAV_GROUPS, NAV_ITEMS, activeNavId } from '../navigation'");
    expect(NAVBAR).toContain('activeNavId(pathname)');
    expect(NAVBAR).toContain('itemsByGroup');
  });

  it('has no internal hard navigation (window.location.href)', () => {
    expect(NAVBAR).not.toContain('window.location.href');
    expect(NAVBAR).not.toContain('window.location.assign');
  });

  it('brand/logo navigates to Home', () => {
    expect(NAVBAR).toContain('onClick={onOpenHome}');
  });
});

describe('App shell — Navbar above every screen, no overlay screens', () => {
  it('Navbar renders once in App.tsx before screens', () => {
    expect(APP.match(/<Navbar/g)?.length ?? 0).toBe(1);
    const navIdx = APP.indexOf('<Navbar');
    const screenRenderIdx = APP.lastIndexOf('isApplicationsOpen &&');
    expect(navIdx).toBeGreaterThan(-1);
    expect(navIdx).toBeLessThan(screenRenderIdx);
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

  it('no screen-level Back buttons remain (hamburger is the navigation)', () => {
    for (const file of ['SettingsModal.tsx', 'JobPortalsScreen.tsx', 'ManualJdScreen.tsx', 'RecruitersScreen.tsx', 'LinkedInPostsScreen.tsx', 'ApplicantProfileScreen.tsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/components', file), 'utf8');
      expect(src).not.toContain('>Back<');
      expect(src).not.toContain('← Back');
    }
  });
});