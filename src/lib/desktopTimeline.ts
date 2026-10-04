// Tailor Browser — value-free live timeline (desktop transport events).
//
// Events come from the Electron main process (real Chromium observations).
// Toggling the inspector never touches this store's contents for a run.
import { useSyncExternalStore } from 'react';
import type { TailorBrowserEvent } from './browserExecutionTransport';

interface DesktopTimelineSnapshot {
  activeAttemptId: string | null;
  events: TailorBrowserEvent[];
}

const MAX_EVENTS = 60;
let events: TailorBrowserEvent[] = [];
let activeAttemptId: string | null = null;
let snapshot: DesktopTimelineSnapshot = { activeAttemptId, events };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { activeAttemptId, events };
  for (const l of listeners) l();
}

export function resetDesktopTimeline(attemptId: string | null): void {
  activeAttemptId = attemptId;
  events = [];
  emit();
}

export function pushDesktopEvent(attemptId: string | null, ev: TailorBrowserEvent): void {
  if (attemptId) activeAttemptId = attemptId;
  events = [...events.slice(-(MAX_EVENTS - 1)), ev];
  emit();
}

export function getDesktopTimeline(): DesktopTimelineSnapshot {
  return snapshot;
}

export function subscribeDesktopTimeline(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useDesktopTimeline(): DesktopTimelineSnapshot {
  return useSyncExternalStore(subscribeDesktopTimeline, getDesktopTimeline, getDesktopTimeline);
}
