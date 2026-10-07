// Auto Apply — browser execution transport abstraction (Phase 30/31/32).
//
// Auto Apply business logic consumes a TRANSPORT, never implementation details:
//   - tailor_browser : first-party Electron Chromium view (Tailor Browser)
//   - extension      : LEGACY Chrome extension companion (kept functional)
//
// Selection: if the Tailor Browser bridge is present (we are inside the desktop
// app), it wins; otherwise the legacy extension path is used unchanged.

export type TransportKind = 'extension' | 'tailor_browser';

export interface TailorBrowserEvent {
  type: string;
  detail?: string;
  state?: string;
  at: string;
}

export interface TailorBrowserBridge {
  version: number;
  transport: 'tailor_browser';
  available: true;
  createSession(userId: string): Promise<unknown>;
  runFill(payload: unknown): Promise<unknown>;
  resumeAfterCheckpoint(): Promise<unknown>;
  getState(): Promise<unknown>;
  show(): Promise<unknown>;
  hide(): Promise<unknown>;
  close(): Promise<unknown>;
  onEvent(cb: (ev: TailorBrowserEvent) => void): () => void;
}

/** Narrow probe: only the exact bridge shape injected by our preload counts. */
export function tailorBrowserBridge(
  probe: () => unknown = () => (typeof window !== 'undefined' ? (window as unknown as { tailorBrowser?: unknown }).tailorBrowser : undefined)
): TailorBrowserBridge | null {
  try {
    const b = probe() as Partial<TailorBrowserBridge> | null | undefined;
    if (!b || b.transport !== 'tailor_browser' || b.available !== true || typeof b.runFill !== 'function') return null;
    return b as TailorBrowserBridge;
  } catch {
    return null;
  }
}

export function selectBrowserTransport(
  probe?: () => unknown
): TransportKind {
  return tailorBrowserBridge(probe) ? 'tailor_browser' : 'extension';
}

// ─────────────────────────────────────────────────────────────────────────
// Chrome → Tailor Browser handoff (execution lives in the desktop app).
// Google Chrome NEVER navigates to the ATS: it mints a backend token, hands
// it to the loopback desktop bridge, and only displays status afterward.
// ─────────────────────────────────────────────────────────────────────────

export const DESKTOP_BRIDGE_BASE = 'http://127.0.0.1:45451';

export interface DesktopHealth {
  available: boolean;
  /** Something answered on the port but is NOT Tailor Browser (Phase 18). */
  appMismatch?: boolean;
  bootId?: string;
  /** Live desktop sessions (executionId + state) for liveness checks. */
  sessions?: Array<{
    executionId: string;
    state: string;
    pageUrl?: string;
    crashed?: boolean;
    /** Agent-loop pause reason ('QUESTIONS_REQUIRED' | 'CAPTCHA_REQUIRED' | …). */
    waitReason?: string;
    /** Pending human questions with the form's options (for the answer chat). */
    asks?: Array<{ label: string; reason: string; options: string[]; human: boolean }>;
  }>;
}

/** PURE: only the real Tailor Browser identity counts as available (Phase 17). */
export function interpretHealth(data: unknown, httpOk: boolean): DesktopHealth {
  const d = data as { available?: unknown; app?: unknown; bootId?: unknown; sessions?: unknown } | null;
  if (!httpOk || !d || d.available !== true) return { available: false };
  if (d.app !== 'tailor-browser') return { available: false, appMismatch: true };
  const sessions = Array.isArray(d.sessions)
    ? (d.sessions as Array<{ executionId?: unknown; state?: unknown; pageUrl?: unknown; crashed?: unknown; waitReason?: unknown; asks?: unknown }>)
        .map((s) => ({
          executionId: String(s?.executionId || ''),
          state: String(s?.state || ''),
          pageUrl: String(s?.pageUrl || ''),
          crashed: s?.crashed === true,
          waitReason: typeof s?.waitReason === 'string' ? s.waitReason : undefined,
          asks: Array.isArray(s?.asks)
            ? (s.asks as Array<{ label?: unknown; reason?: unknown; options?: unknown; human?: unknown }>)
                .map((a) => ({
                  label: String(a?.label || ''),
                  reason: String(a?.reason || ''),
                  options: Array.isArray(a?.options) ? (a.options as unknown[]).map((o) => String(o)) : [],
                  human: a?.human === true,
                }))
                .filter((a) => a.label)
            : undefined,
        }))
        .filter((s) => s.executionId)
    : undefined;
  return { available: true, bootId: typeof d.bootId === 'string' ? d.bootId : '', sessions };
}

export async function desktopHealth(timeoutMs = 1500): Promise<DesktopHealth> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${DESKTOP_BRIDGE_BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json().catch(() => null);
    return interpretHealth(data, res.ok);
  } catch {
    return { available: false };
  }
}

export async function waitForDesktop(maxMs = 8000, stepMs = 500): Promise<DesktopHealth> {
  const deadline = Date.now() + maxMs;
  let health = await desktopHealth();
  // Never keep polling a wrong process — surface the conflict.
  while (!health.available && !health.appMismatch && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    health = await desktopHealth();
  }
  return health;
}

/** Launch intent only — tailor-ai:// carries no job data or tokens (Phase 10). */
export function launchTailorBrowser(): void {
  try {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = 'tailor-ai://launch';
    document.body.appendChild(frame);
    setTimeout(() => {
      try {
        frame.remove();
      } catch { /* ignore */ }
    }, 1500);
  } catch { /* protocol unavailable — the UI shows explicit instructions */ }
}

export async function createDesktopHandoff(jobId: string): Promise<{ ok: boolean; executionToken?: string; message?: string }> {
  try {
    const res = await fetch('/api/auto-apply/desktop-handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.executionToken) {
      const code = String(data?.error || '');
      const message = code === 'MISSING_USER' ? 'Sign in to Tailor AI, then try AA again.' : (code || 'Tailor Browser handoff failed.');
      return { ok: false, message };
    }
    return { ok: true, executionToken: String(data.executionToken) };
  } catch {
    return { ok: false, message: 'Could not reach the Auto Apply service.' };
  }
}

export interface DesktopStartResult {
  accepted: boolean;
  busy?: boolean;
  current?: { executionId?: string; attemptId?: string } | null;
  attemptId?: string;
  desktopExecutionId?: string;
  /** Real reason when the run was refused (READINESS_*, RESUME_*, CAPTCHA_*, …). */
  code?: string;
  blockers?: string[];
  message?: string;
}

export async function startDesktopExecution(jobId: string, executionToken: string): Promise<DesktopStartResult> {
  try {
    const res = await fetch(`${DESKTOP_BRIDGE_BASE}/auto-apply/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, executionToken }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 409 && data?.error === 'BUSY') return { accepted: false, busy: true, current: data.current || null };
    if (res.status === 409 && data?.error === 'ALREADY_ACTIVE') return { accepted: false, code: 'ALREADY_ACTIVE', current: data.current || null };
    if (!res.ok || data?.accepted !== true) {
      return {
        accepted: false,
        code: String(data?.error || 'START_FAILED'),
        blockers: Array.isArray(data?.blockers) ? data.blockers.map(String) : [],
        message: typeof data?.message === 'string' && data.message ? data.message : undefined,
      };
    }
    return { accepted: true, attemptId: data.attemptId, desktopExecutionId: data.desktopExecutionId };
  } catch {
    return { accepted: false };
  }
}

export interface DesktopSubmitResult {
  ok: boolean;
  verified?: boolean;
  code?: string;
  error?: string;
}

/** Explicit approval — the SERVER authorizes; the desktop performs ONE click. */
export async function submitDesktopExecution(executionId: string): Promise<DesktopSubmitResult> {
  try {
    const res = await fetch(`${DESKTOP_BRIDGE_BASE}/auto-apply/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, code: String(data?.error || 'SUBMIT_BLOCKED') };
    return { ok: data?.ok === true, verified: data?.verified === true, code: data?.code };
  } catch {
    return { ok: false, code: 'DESKTOP_UNREACHABLE' };
  }
}

export async function continueDesktopExecution(executionId: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${DESKTOP_BRIDGE_BASE}/auto-apply/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function focusTailorBrowser(executionId?: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${DESKTOP_BRIDGE_BASE}/auto-apply/focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(executionId ? { executionId } : {}),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function stopDesktopExecution(executionId: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${DESKTOP_BRIDGE_BASE}/auto-apply/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function fetchDesktopExecutionStatus(attemptId: string): Promise<{ state: string; event: string; updatedAt: string } | null> {
  try {
    const res = await fetch(`/api/auto-apply/desktop-execution/${encodeURIComponent(attemptId)}/status`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface ActiveDesktopExecution {
  executionId: string;
  attemptId: string;
  jobId: string;
  state: string;
  lastEvent?: string;
  updatedAt?: string;
}

// Shared short cache: every job row adopts live executions on mount — one
// fetch answers them all within the TTL window.
let activeExecCache: { at: number; promise: Promise<ActiveDesktopExecution[]> } | null = null;

export async function fetchActiveExecutions(maxAgeMs = 10_000): Promise<ActiveDesktopExecution[]> {
  const now = Date.now();
  if (activeExecCache && now - activeExecCache.at < maxAgeMs) return activeExecCache.promise;
  const promise = (async () => {
    try {
      const res = await fetch('/api/auto-apply/active-executions');
      if (!res.ok) return [];
      const data = await res.json().catch(() => null);
      const list = Array.isArray(data?.executions) ? (data.executions as Array<Record<string, unknown>>) : [];
      return list
        .map((e) => ({
          executionId: String(e?.executionId || ''),
          attemptId: String(e?.attemptId || ''),
          jobId: String(e?.jobId || ''),
          state: String(e?.state || ''),
          lastEvent: typeof e?.lastEvent === 'string' ? e.lastEvent : undefined,
          updatedAt: typeof e?.updatedAt === 'string' ? e.updatedAt : undefined,
        }))
        .filter((e) => e.executionId && e.jobId);
    } catch {
      return [];
    }
  })();
  activeExecCache = { at: now, promise };
  return promise;
}

export interface DesktopRowView {
  state: import('./autoApply').AaRowState;
  message: string;
  terminal: boolean;
}

/** PURE: backend execution state → Chrome row state (unit-tested). */
export function mapDesktopStateToRow(state: unknown): DesktopRowView | null {
  switch (String(state)) {
    case 'DESKTOP_STARTING': return { state: 'STARTING', message: 'Starting Tailor Browser…', terminal: false };
    case 'DESKTOP_CONNECTED': return { state: 'STARTING', message: 'Tailor Browser connected…', terminal: false };
    case 'NAVIGATING': return { state: 'WAITING_FOR_BROWSER', message: 'Opening application…', terminal: false };
    case 'INSPECTING':
    case 'FILLING': return { state: 'FILLING', message: 'Filling…', terminal: false };
    case 'ATTACHING_RESUME': return { state: 'FILLING', message: 'Attaching resume…', terminal: false };
    case 'VERIFYING': return { state: 'VERIFYING', message: 'Verifying…', terminal: false };
    case 'SUBMITTING': return { state: 'SUBMITTING', message: 'Submitting…', terminal: false };
    case 'WAITING_FOR_USER': return { state: 'USER_ACTION_REQUIRED', message: 'Action required in Tailor Browser', terminal: false };
    // NOT terminal: submit-time CAPTCHAs and unconfirmed submissions happen
    // AFTER ready — the row must keep polling to surface them.
    case 'READY_FOR_REVIEW': return { state: 'READY_FOR_REVIEW', message: 'Ready for review in Tailor Browser.', terminal: false };
    case 'FAILED': return { state: 'NEEDS_REVIEW', message: 'Auto Apply needs review — open Tailor Browser.', terminal: true };
    case 'SUBMITTED_VERIFIED': return { state: 'APPLIED', message: 'Applied ✓ — confirmed by the job board.', terminal: true };
    default: return null;
  }
}
