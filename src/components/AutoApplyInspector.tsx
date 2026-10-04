// Auto Apply — right-side LIVE EXECUTION inspector.
//
// HONEST LABELING: this is NOT an embedded browser. A web page cannot embed an
// interactive view of another origin's window (browser security). This panel
// shows the REAL execution: actual session events, actual read-back statuses
// and the actual attempt state reported by Tailor Browser.
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { closeInspector, useInspectorState } from '../lib/autoApplyInspector';
import { useDesktopTimeline } from '../lib/desktopTimeline';

interface InspectorEvent { eventType: string; reasonCode: string | null; createdAt: string }
interface InspectorField { name: string; status: string }
interface InspectorData {
  attempt: { id: string; status: string; provider: string; externalJobId: string };
  events: InspectorEvent[];
  fields: InspectorField[];
  readyForUserSubmission: boolean;
}

const EV_LABEL: Record<string, string> = {
  SESSION_OPENED: 'Browser session opened',
  PAGE_VERIFIED: 'Exact Lever posting verified',
  FORM_DISCOVERED: 'Application form discovered',
  FIELDS_FILLED: 'Approved fields filled',
  RESUME_ATTACHED: 'Resume attached',
  RESUME_ATTACHMENT_FAILED: 'Resume attachment failed',
  CHECKPOINT_CLEARED: 'Human checkpoint cleared',
  HUMAN_ACTION_REQUIRED: 'Action required',
  FORM_CHANGED: 'Form changed after verification',
  PAGE_IDENTITY_MISMATCH: 'Page identity mismatch',
  FILL_VERIFICATION_COMPLETED: 'Read-back verification',
  READY_FOR_USER_SUBMISSION: 'Ready for submission',
  SUBMISSION_INITIATED: 'Submission initiated',
  SUBMIT_CONTROL_ACTIVATED: 'Submit control activated',
  SUBMISSION_CONFIRMED: 'Submission confirmed',
  SUBMISSION_UNCONFIRMED: 'Submission unconfirmed',
  SUBMISSION_FAILED: 'Submission failed',
  SESSION_EXPIRED: 'Session expired',
  APPLICATION_STARTED: 'Application started',
  BROWSER_OPENED: 'Browser opened in Tailor Browser',
  LEVER_VERIFIED: 'Exact Lever posting verified',
  STATE: 'State',
  PLAN_REJECTED: 'Plan rejected',
  FILL_FAILED: 'Fill failed',
  RESUME_NOT_ATTACHED: 'Resume not attached',
  RESUME_SKIPPED: 'Resume skipped (none supplied)',
  JOB_MISMATCH: 'Job mismatch — execution stopped',
  NAVIGATION_BLOCKED: 'Navigation blocked by policy',
  EXTERNAL_OPEN_BLOCKED: 'External popup blocked',
  CHECKPOINT_TIMEOUT: 'Checkpoint timed out',
  FORM_GONE: 'Form disappeared',
  RUN_FAILED: 'Run failed',
  SESSION_CLOSED: 'Session closed',
};

const fieldMark = (status: string): string =>
  status === 'V' ? '✓' : status === 'A' ? '✓' : status === 'M' ? '✗' : status === 'N' ? '✗' : status === 'U' ? '?' : status === 'B' ? '✗' : '…';

const fieldColor = (status: string): string =>
  status === 'V' || status === 'A' ? 'text-emerald-700' : status === 'M' || status === 'N' || status === 'B' ? 'text-red-700' : 'text-amber-700';

const time = (iso: string): string => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
};

export const AutoApplyInspector: React.FC = () => {
  const { open, active } = useInspectorState();
  const [data, setData] = useState<InspectorData | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open || !active) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/auto-apply/${encodeURIComponent(active.attemptId)}/events`);
        if (res.ok && alive) setData((await res.json()) as InspectorData);
      } catch {
        /* transient — keep last snapshot */
      }
    };
    void tick();
    timerRef.current = window.setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [open, active?.attemptId]);

  if (!open || !active) return null;

  const desktopTimeline = useDesktopTimeline();

  const events = Array.isArray(data?.events) ? [...data.events].reverse() : [];
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  const human = events.find((e) => e.eventType === 'HUMAN_ACTION_REQUIRED');

  return (
    <aside
      aria-label="Auto Apply live execution"
      className="fixed right-0 top-0 h-screen w-[370px] max-w-[92vw] z-40 bg-white border-l border-[var(--color-border)] shadow-2xl flex flex-col"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div>
          <div className="text-sm font-bold">Auto Apply execution</div>
          <div className="text-[10.5px] text-[var(--color-muted)]">
            Live execution telemetry from Tailor Browser — not an embedded browser.
          </div>
        </div>
        <button
          type="button"
          onClick={closeInspector}
          aria-label="Hide execution inspector"
          className="p-1 rounded hover:bg-[var(--color-surface)] cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <div className="text-xs font-bold truncate">{active.jobTitle}</div>
        <div className="text-[10.5px] text-[var(--color-muted)] truncate">{active.company}</div>
        <div className="text-[10.5px] text-[var(--color-muted)] mt-1">
          Attempt {active.attemptId} · status {data?.attempt?.status ?? '…'}
        </div>
      </div>

      {human && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
          {human.reasonCode === 'CAPTCHA_REQUIRED'
            ? 'Action required: Complete CAPTCHA in the browser tab, then the run continues automatically.'
            : `Action required: ${human.reasonCode || 'manual step needed'} in the browser tab.`}
        </div>
      )}

      <div className="px-4 py-3 overflow-y-auto flex-1">
        {fields.length > 0 && (
          <section className="mb-4">
            <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-faint)] mb-1">
              Field verification (read-back)
            </div>
            <ul className="space-y-0.5">
              {fields.map((f) => (
                <li key={f.name} className="flex items-center justify-between text-[11px]">
                  <span className="truncate">{f.name}</span>
                  <span className={fieldColor(f.status)}>
                    {fieldMark(f.status)} {f.status === 'V' ? 'verified' : f.status === 'A' ? 'already correct' : f.status === 'M' ? 'mismatch' : f.status === 'N' ? 'not found' : f.status === 'U' ? 'unverifiable' : f.status === 'B' ? 'blocked' : 'pending'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {desktopTimeline.activeAttemptId === active.attemptId && desktopTimeline.events.length > 0 && (
          <section className="mb-4">
            <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-faint)] mb-1">
              Tailor Browser (desktop transport — real Chromium)
            </div>
            <ul className="space-y-1">
              {[...desktopTimeline.events].reverse().slice(0, 14).map((e, i) => (
                <li key={`${e.type}-${i}`} className="text-[11px] flex items-baseline gap-2">
                  <span className="text-[9.5px] text-[var(--color-faint)] tabular-nums">{time(e.at)}</span>
                  <span className="flex-1">
                    {EV_LABEL[e.type] || e.type}
                    {e.detail ? <span className="text-[var(--color-muted)]"> · {e.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-faint)] mb-1">
            Execution timeline (session events)
          </div>
          {events.length === 0 && <div className="text-[11px] text-[var(--color-muted)]">Waiting for the browser…</div>}
          <ul className="space-y-1">
            {events.slice(0, 14).map((e, i) => (
              <li key={`${e.eventType}-${i}`} className="text-[11px] flex items-baseline gap-2">
                <span className="text-[9.5px] text-[var(--color-faint)] tabular-nums">{time(e.createdAt)}</span>
                <span className="flex-1">
                  {EV_LABEL[e.eventType] || e.eventType}
                  {e.reasonCode ? <span className="text-[var(--color-muted)]"> · {e.reasonCode}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
};
