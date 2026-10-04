'use strict';
// Tailor Browser — PURE layout math (no Electron imports; fully unit-tested).
//
// Contract (Phase 3-16):
//  - Tailor UI is PERMANENT: always attached, always width>0/height>0 when the
//    window has size, never hidden, never zeroed.
//  - The ATS browser pane visibility is LAYOUT STATE ONLY: it never touches the
//    session, attempt, URL or fill state.
//  - Invalid/NaN/negative geometry can never produce a blank window: the
//    fallback is always Tailor full width + browser hidden.

const MIN_TAILOR_WIDTH = 480;
const MIN_BROWSER_WIDTH = 200;
const DEFAULT_SPLIT = 0.45;

function clampSize(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function computeLayout({ width, height, split = DEFAULT_SPLIT, paneVisible = false, minTailorWidth = MIN_TAILOR_WIDTH } = {}) {
  const w = clampSize(width);
  const h = clampSize(height);
  const full = { x: 0, y: 0, width: w, height: h };
  if (w === 0 || h === 0) {
    return { tailor: full, browser: { x: w, y: 0, width: 0, height: 0, visible: false } };
  }
  const s = typeof split === 'number' && Number.isFinite(split) && split > 0.2 && split < 0.8 ? split : DEFAULT_SPLIT;
  const tailorWidth = Math.floor(w * s);
  const browserWidth = w - tailorWidth;
  const canSplit = paneVisible === true && tailorWidth >= minTailorWidth && browserWidth >= MIN_BROWSER_WIDTH;
  if (!canSplit) {
    // Browser moved safely OUT of the viewport at zero size — never destroyed.
    return { tailor: full, browser: { x: w, y: 0, width: 0, height: 0, visible: false } };
  }
  return {
    tailor: { x: 0, y: 0, width: tailorWidth, height: h },
    browser: { x: tailorWidth, y: 0, width: browserWidth, height: h, visible: true },
  };
}

/** Layout that can never blank the product: any error → Tailor full width. */
function safeLayout(input, { fallbackWidth = 1200, fallbackHeight = 800 } = {}) {
  try {
    const width = Number(input && input.width);
    const height = Number(input && input.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      throw new Error('INVALID_WINDOW_SIZE');
    }
    const plan = computeLayout(input);
    if (width > 0 && height > 0 && (!(plan.tailor.width > 0) || !(plan.tailor.height > 0))) {
      throw new Error('TAILOR_BOUNDS_INVALID');
    }
    return plan;
  } catch (e) {
    try {
      console.error('TAILOR_BROWSER_LAYOUT_FALLBACK', (e && e.message) || String(e));
    } catch { /* logging must never throw */ }
    return {
      tailor: { x: 0, y: 0, width: fallbackWidth, height: fallbackHeight },
      browser: { x: fallbackWidth, y: 0, width: 0, height: 0, visible: false },
    };
  }
}

module.exports = { computeLayout, safeLayout, MIN_TAILOR_WIDTH, MIN_BROWSER_WIDTH, DEFAULT_SPLIT };
