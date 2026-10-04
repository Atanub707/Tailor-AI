// Phase 22 — AA desktop gating + the live inspector's honesty/independence
// contracts. (The companion transport was removed with the Tailor Browser
// pivot; only the desktop-transport contracts remain.)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getInspectorState,
  openInspectorFor,
  toggleInspectorFor,
  closeInspector,
} from '../../src/lib/autoApplyInspector.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const button = read('src/components/AutoApplyButton.tsx');
const inspector = read('src/components/AutoApplyInspector.tsx');

describe('AA desktop gating', () => {
  it('1. the AA row carries NO companion UI at all (deprecated transport)', () => {
    expect(button).not.toMatch(/Companion/);
    expect(button).not.toContain('useCompanionState');
    expect(button).not.toContain('BrowserCompanionPanel');
    expect(button).not.toContain('ensureBrowserCompanion(');
  });

  it('11. AA routes to Tailor Browser handoff — no extension gating, no fill/start', () => {
    expect(button).not.toContain('ensureCompanionConnected');
    expect(button).not.toContain("fetch('/api/auto-apply/fill/start'");
    const healthAt = button.indexOf('await desktopHealth()');
    const startAt = button.indexOf('startDesktopExecution(job.id');
    expect(healthAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(healthAt);
  });
});

describe('Phase 22 — live inspector contracts', () => {
  it('13. ONE attention control: amber button focuses the exact session; no eye/companion clutter', () => {
    expect(button).toContain('handleAttentionClick');
    expect(button).toContain('focusTailorBrowser(currentExecution.executionId)');
    expect(button).not.toContain('handleEyeClick');
    expect(button).not.toContain("aria-label=\"Show Tailor Browser\"");
    expect(button).not.toMatch(/Companion/);
  });

  it('14/15. hiding does not stop execution; reopening shows the SAME attempt', () => {
    openInspectorFor({ attemptId: 'att-1', jobId: 'j1', jobTitle: 'T', company: 'C' });
    expect(getInspectorState().open).toBe(true);
    closeInspector();
    expect(getInspectorState().open).toBe(false);
    expect(getInspectorState().active?.attemptId).toBe('att-1');
    toggleInspectorFor();
    expect(getInspectorState().open).toBe(true);
    expect(getInspectorState().active?.attemptId).toBe('att-1');
    expect(inspector).not.toMatch(/fill\/stop|CANCEL_FILL|abort/i);
  });

  it('16/17. inspector renders REAL telemetry only (no fake browser surface)', () => {
    expect(inspector).toContain('/events');
    expect(inspector).toContain('EV_LABEL');
    expect(inspector).toContain('session events');
    expect(inspector).not.toMatch(/iframe|srcdoc|mock data|placeholder data/i);
    expect(inspector).toContain('not an embedded browser');
  });

  it('18/19/20. field, resume and CAPTCHA states come from actual events/statuses', () => {
    expect(inspector).toContain('FILL_VERIFICATION_COMPLETED');
    expect(inspector).toContain('RESUME_ATTACHED');
    expect(inspector).toContain('CAPTCHA_REQUIRED');
    expect(inspector).toContain('Complete CAPTCHA in the browser tab');
  });
});
