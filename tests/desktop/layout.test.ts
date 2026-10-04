// Tailor Browser — pure layout tests (Phase 18, cases 1-28).
// The Eye button must only toggle the ATS pane; Tailor UI can never blank.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeLayout, safeLayout, MIN_TAILOR_WIDTH } = require('../../desktop/main/layout.cjs') as {
  computeLayout: (i: {
    width?: number;
    height?: number;
    split?: number;
    paneVisible?: boolean;
    minTailorWidth?: number;
  }) => { tailor: { x: number; y: number; width: number; height: number }; browser: { x: number; y: number; width: number; height: number; visible: boolean } };
  safeLayout: (i: unknown, o?: { fallbackWidth?: number; fallbackHeight?: number }) => {
    tailor: { x: number; y: number; width: number; height: number };
    browser: { x: number; y: number; width: number; height: number; visible: boolean };
  };
  MIN_TAILOR_WIDTH: number;
};

const W = 1480;
const H = 940;

describe('Layout — split, hide, restore (cases 1-8)', () => {
  it('1. initial split: ~45% Tailor / 55% browser', () => {
    const p = computeLayout({ width: W, height: H, paneVisible: true });
    expect(p.tailor.width).toBe(Math.floor(W * 0.45));
    expect(p.browser.x).toBe(p.tailor.width);
    expect(p.browser.width).toBe(W - p.tailor.width);
    expect(p.browser.visible).toBe(true);
  });

  it('2/3/4/5. hide browser: Tailor stays visible and expands full width; browser hidden', () => {
    const p = computeLayout({ width: W, height: H, paneVisible: false });
    expect(p.tailor.width).toBe(W);
    expect(p.tailor.height).toBe(H);
    expect(p.tailor.width).toBeGreaterThan(0);
    expect(p.browser.visible).toBe(false);
    expect(p.browser.width).toBe(0);          // moved out of viewport, never destroyed
    expect(p.browser.x).toBeGreaterThanOrEqual(W);
  });

  it('6/7. show again: exact split restored', () => {
    const hidden = computeLayout({ width: W, height: H, paneVisible: false });
    const shown = computeLayout({ width: W, height: H, paneVisible: true });
    expect(shown.tailor.width).toBe(Math.floor(W * 0.45));
    expect(shown.browser.width).toBe(W - shown.tailor.width);
    expect(hidden.tailor.width).toBeGreaterThan(shown.tailor.width);
  });

  it('8. repeated toggles are stable (idempotent, 20 rapid toggles)', () => {
    let last = computeLayout({ width: W, height: H, paneVisible: true });
    for (let i = 0; i < 20; i++) {
      const p = computeLayout({ width: W, height: H, paneVisible: i % 2 === 0 });
      expect(p.tailor.width).toBeGreaterThan(0);
      expect(p.tailor.height).toBeGreaterThan(0);
      last = p;
    }
    expect(last.tailor.width).toBe(W); // ended hidden (i=19 odd → paneVisible false)
  });
});

describe('Layout — resize & window states (cases 15-19)', () => {
  it('15/16. resize while hidden and while visible', () => {
    for (const [w, h] of [[900, 700], [1920, 1080], [2560, 1440]]) {
      const visible = computeLayout({ width: w, height: h, paneVisible: true });
      expect(visible.tailor.width + visible.browser.width).toBe(w);
      const hidden = computeLayout({ width: w, height: h, paneVisible: false });
      expect(hidden.tailor.width).toBe(w);
    }
  });

  it('17/18. maximize while hidden and while visible', () => {
    const hiddenMax = computeLayout({ width: 2560, height: 1440, paneVisible: false });
    expect(hiddenMax.tailor.width).toBe(2560);
    expect(hiddenMax.browser.visible).toBe(false);
    const visibleMax = computeLayout({ width: 2560, height: 1440, paneVisible: true });
    expect(visibleMax.browser.visible).toBe(true);
    expect(visibleMax.browser.width).toBeGreaterThan(MIN_TAILOR_WIDTH);
  });

  it('19. minimum window size: split degrades safely, Tailor keeps the width', () => {
    const tiny = computeLayout({ width: 400, height: 300, paneVisible: true });
    expect(tiny.tailor.width).toBe(400);   // full width — split suppressed
    expect(tiny.browser.visible).toBe(false);
    const boundary = computeLayout({ width: 1067, height: 800, paneVisible: true });
    expect(boundary.tailor.width).toBe(Math.floor(1067 * 0.45));
    expect(boundary.browser.visible).toBe(true);
  });
});

describe('Layout — blank-screen guards (cases 20-28)', () => {
  it('20/21. never zero or negative Tailor bounds for any sane geometry', () => {
    for (const [w, h] of [[320, 200], [800, 600], [1480, 940], [3840, 2160]]) {
      for (const paneVisible of [true, false]) {
        const p = computeLayout({ width: w, height: h, paneVisible });
        expect(p.tailor.width).toBeGreaterThan(0);
        expect(p.tailor.height).toBeGreaterThan(0);
        expect(p.browser.width).toBeGreaterThanOrEqual(0);
        expect(p.browser.x).toBeGreaterThanOrEqual(0);
        expect(Number.isNaN(p.tailor.width)).toBe(false);
        expect(Number.isFinite(p.browser.x)).toBe(true);
      }
    }
  });

  it('fractional and garbage geometry is floored/clamped, never NaN', () => {
    const p = computeLayout({ width: 1479.7, height: 939.2, paneVisible: true });
    expect(p.tailor.width).toBe(Math.floor(Math.floor(1479.7) * 0.45));
    expect(Number.isInteger(p.browser.width)).toBe(true);
    const badSplit = computeLayout({ width: W, height: H, paneVisible: true, split: 42 });
    expect(badSplit.tailor.width).toBe(Math.floor(W * 0.45));
  });

  it('28. fallback restores Tailor full width on layout error (never blank)', () => {
    for (const bad of [{ width: NaN, height: NaN }, { width: -100, height: 900 }, { width: Infinity, height: 900 }, {}]) {
      const p = safeLayout(bad, { fallbackWidth: 1200, fallbackHeight: 800 });
      expect(p.tailor.width).toBeGreaterThan(0);
      expect(p.tailor.height).toBeGreaterThan(0);
      expect(p.tailor.x).toBe(0);
      expect(p.browser.visible).toBe(false);
    }
  });

  it('safeLayout passes valid geometry through unchanged', () => {
    const p = safeLayout({ width: W, height: H, paneVisible: true });
    expect(p.tailor.width).toBe(Math.floor(W * 0.45));
    expect(p.browser.visible).toBe(true);
  });

  it('minimized window (0 size) yields zero-size plan without throwing', () => {
    const p = computeLayout({ width: 0, height: 0, paneVisible: true });
    expect(p.tailor).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(p.browser.visible).toBe(false);
  });
});
