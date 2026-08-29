// Single source of truth for global navigation.
// Drives: hamburger items, active states, and navigation tests.
import type { Icon } from '@phosphor-icons/react';
import { House, SuitcaseSimple, UserCircle, IdentificationBadge, Tray, GlobeSimple, PaperPlaneTilt, ChatCircleDots, FileText, SlidersHorizontal } from '@phosphor-icons/react';

export type NavGroupId = 'library' | 'profile' | 'tools';

export interface NavigationItem {
  id: string;
  label: string;
  icon: Icon;
  route: string;
  group: NavGroupId;
  hint?: string;
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
  { id: 'applications', label: 'Applications', icon: SuitcaseSimple, route: '/applications', group: 'library', badgeKey: 'applications', activeFor: (p) => p === '/applications' || p.startsWith('/applications/') },
  { id: 'applicant-profile', label: 'Applicant Profile', icon: UserCircle, route: '/applicant-profile', group: 'profile', activeFor: (p) => p === '/applicant-profile' },
  { id: 'master-cv', label: 'Master CV', icon: IdentificationBadge, route: '/master-cv', group: 'profile', activeFor: (p) => p === '/master-cv' },
  { id: 'recruiters', label: 'Recruiters', icon: Tray, route: '/recruiters', group: 'tools', badgeKey: 'recruiters', activeFor: (p) => p === '/recruiters' },
  { id: 'job-portals', label: 'Job Portals', icon: GlobeSimple, route: '/job-portals', group: 'tools', hint: '190+', activeFor: (p) => p === '/job-portals' },
  { id: 'linkedin-posts', label: 'LinkedIn Posts', icon: PaperPlaneTilt, route: '/linkedin-posts', group: 'tools', activeFor: (p) => p === '/linkedin-posts' },
  { id: 'ai-interview', label: 'AI Interview', icon: ChatCircleDots, route: '/ai-interview', group: 'tools', activeFor: (p) => p === '/ai-interview' },
  { id: 'manual-jd', label: 'Manual JD', icon: FileText, route: '/manual-jd', group: 'tools', hint: '⌘J', activeFor: (p) => p === '/manual-jd' },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal, route: '/settings', group: 'tools', hint: '⌘,', activeFor: (p) => p === '/settings' },
];

/** Resolve the active navigation item id for a pathname (null = no match). */
export function activeNavId(pathname: string): string | null {
  const match = NAV_ITEMS.find((i) => i.activeFor(pathname));
  return match ? match.id : null;
}