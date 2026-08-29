# Global Hamburger Navigation Audit

Route × layout matrix, hamburger inventory, and shell architecture — read from
the actual code at this commit.

## Shell architecture

- Router: `BrowserRouter` (src/main.tsx) + URL-driven screen switching in
  `src/App.tsx` (`pathname` booleans; unknown paths → `<Navigate to="/">`).
- Global shell = **App layout in App.tsx**: `<Navbar />` (one shared header,
  one hamburger trigger, one drawer) renders above EVERY screen; screens
  render in normal flow below the 74px app bar. No per-screen navigation
  copies. Single source of truth: `src/navigation.ts` (`NAV_ITEMS`,
  `NAV_GROUPS`, `activeNavId`) — consumed by Navbar and by tests.
- Settings is NOT a modal anymore: it renders in-flow under the app bar on
  `/settings`, so the hamburger is present (root cause of the old bug: four
  screens used `fixed inset-0` overlays that covered the app bar — fixed in
  `cd08bca`).

## Route × layout matrix

| ROUTE | SCREEN | LAYOUT | HAMBURGER | HEADER | BACK BUTTON | USES SHELL |
|---|---|---|---|---|---|---|
| `/` | Job Library (Home) | in-flow below app bar | ✅ | ✅ | — (home) | ✅ |
| `/applications` | Applications | in-flow | ✅ | ✅ | — | ✅ |
| `/applications/:applicationId` | Application Detail (drawer auto-open) | in-flow + drawer | ✅ | ✅ | contextual Close | ✅ |
| `/applicant-profile` | Applicant Profile | in-flow (was overlay) | ✅ | ✅ | removed (hamburger is nav) | ✅ |
| `/master-cv` | Master CV | in-flow (was overlay) | ✅ | ✅ | removed | ✅ |
| `/recruiters` | Recruiters | in-flow | ✅ | ✅ | removed | ✅ |
| `/job-portals` | Job Portals | in-flow (was overlay) | ✅ | ✅ | removed | ✅ |
| `/linkedin-posts` | LinkedIn Posts | in-flow | ✅ | ✅ | removed | ✅ |
| `/ai-interview` | AI Interview | in-flow | ✅ | ✅ | — | ✅ |
| `/manual-jd` | Manual JD | in-flow (was overlay) | ✅ | ✅ | removed | ✅ |
| `/settings` | Settings | in-flow (SettingsModal, no overlay) | ✅ | ✅ | removed | ✅ |
| `/login`-ish / guest chooser | pre-auth views | standalone (no shell — intentional: no user yet) | — | — | — | ❌ intentional |

## Hamburger inventory (from src/navigation.ts)

| # | LABEL | ICON | ROUTE | GROUP | BADGE | ACTIVE RULE |
|---|---|---|---|---|---|---|
| 1 | Home | House | `/` | Library | — | `pathname === '/'` |
| 2 | Applications | SuitcaseSimple | `/applications` | Library | applications | exact or `/applications/` prefix |
| 3 | Applicant Profile | UserCircle | `/applicant-profile` | Profile | — | exact |
| 4 | Master CV | IdentificationBadge | `/master-cv` | Profile | — | exact |
| 5 | Recruiters | Tray | `/recruiters` | Tools | recruiters | exact |
| 6 | Job Portals | GlobeSimple | `/job-portals` | Tools | hint 190+ | exact |
| 7 | LinkedIn Posts | PaperPlaneTilt | `/linkedin-posts` | Tools | — | exact |
| 8 | AI Interview | ChatCircleDots | `/ai-interview` | Tools | — | exact |
| 9 | Manual JD | FileText | `/manual-jd` | Tools | hint ⌘J | exact |
| 10 | Settings | SlidersHorizontal | `/settings` | Tools | hint ⌘, | exact |

All destinations exist in App.tsx `knownPaths`/`knownPrefixes` (no dead
routes). No duplicate hamburgers anywhere (one trigger, one drawer).
Duplicates removed in earlier commits: app-bar buttons (Job Portals / AI
Interview / LinkedIn Posts / Applications / Recruiters), user-menu Workspace
items, per-screen Back buttons, Home "Add jobs" row.

## Behavior

- Drawer stays open after navigation (user preference — quick screen
  shifting); closes via backdrop click, Escape, or the X.
- Active item follows the route (`activeNavId`), incl. `/applications/:id`.
- Navigation uses `navigate()` (react-router) — no `window.location.href`.
- Logo (brand lockup) navigates to Home.
- Keyboard: trigger is a native button (Enter/Space), Escape closes drawer,
  `aria-expanded` + `aria-label="Open menu"`, `aria-hidden` when closed.
- Apply workflow intact: `/applications/:applicationId` refresh-recovery +
  auto-open preserved (Application Detail lives under the same shell).

## Intentionally excluded from the shell

- Pre-auth screens (login / guest chooser) — no user session, no navigation.
- Modal sub-states inside screens (job detail, save menus, confirm dialogs)
  are overlays within their screen, never navigation replacements.