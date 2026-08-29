import React, { useEffect, useRef } from 'react';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

// Guided onboarding tour — highlights real UI elements via CSS selectors
// (driver.js spotlight + tooltips). OPT-IN ONLY (account menu → Take a
// tour): the tour overlay must never hijack navigation, so it never
// auto-starts on login.

const TOUR_FLAG = 'tailor_tour_seen_v1';

export function startTour(): void {
  const d = driver({
    showProgress: true,
    showButtons: ['next', 'previous', 'close'],
    steps: [
      {
        element: '#input-scrape-keywords',
        popover: {
          title: 'Search jobs from 19 sources',
          description: 'Type a role (e.g. "DevOps Engineer") and press <b>Search Jobs</b> — live postings come in from LinkedIn, Indeed, Naukri, Glassdoor, Greenhouse, Lever, Ashby and more.',
          side: 'bottom',
        },
      },
      {
        element: '#btn-scrape-submit',
        popover: {
          title: 'One search, many boards',
          description: 'Every search runs your keywords across the selected sources at once — with filters for Remote/Hybrid/On-site, posting window, level and contract.',
          side: 'bottom',
        },
      },
      {
        element: 'button[title*="LinkedIn — Global"]',
        popover: {
          title: 'Pick your sources',
          description: 'Each chip is a job source. Apify-powered sources (LinkedIn, Indeed, Naukri, Glassdoor, Upwork) work with your Apify key; built-in sources are free.',
          side: 'bottom',
        },
      },
      {
        element: 'button[aria-label="Open menu"]',
        popover: {
          title: 'Navigate with the menu',
          description: 'The hamburger menu is available on every screen. It holds <b>Home</b>, <b>Applications</b>, your <b>Applicant Profile</b> and <b>Master CV</b>, plus <b>Recruiters</b>, <b>Job Portals</b>, <b>LinkedIn Posts</b>, <b>AI Interview</b>, <b>Manual JD</b> and <b>Settings</b>.',
          side: 'bottom',
        },
      },
      {
        element: 'button[aria-label="Open menu"]',
        popover: {
          title: 'Everything lives here',
          description: 'After this step, open the menu and explore: Home is your job library, Applications tracks every application you start, and the Profile section keeps your identity and resume in one place.',
          side: 'bottom',
        },
      },
      {
        popover: {
          title: 'You are set 🎉',
          description: 'Match any job against your CV, tailor it in one click, apply with the Browser Companion — and replay this tour anytime from the account menu (Take a tour).',
          side: 'top',
        },
      },
    ],
    onDestroyed: () => localStorage.setItem(TOUR_FLAG, '1'),
  });
  d.drive();
}

function shouldShowTour(): boolean {
  return localStorage.getItem(TOUR_FLAG) !== '1';
}

// OPT-IN ONLY: the tour is launched exclusively from the account menu
// (Take a tour). It never auto-starts — the driver.js overlay would dim
// the global navigation and block every screen until dismissed.
export const OnboardingTour: React.FC<{ ready?: boolean }> = () => {
  return null;
};

// Keep the helper available (no-op auto-start) for API compatibility.
export { shouldShowTour };