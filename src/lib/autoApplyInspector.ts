// Auto Apply — live execution inspector store.
//
// The inspector shows REAL extension events for the active attempt. Toggling
// it is pure UI state: it never starts, stops, or alters an execution.
import { useSyncExternalStore } from 'react';

export interface ActiveExecution {
  attemptId: string;
  jobId: string;
  jobTitle: string;
  company: string;
  sessionId?: string;
}

interface InspectorSnapshot {
  open: boolean;
  active: ActiveExecution | null;
}

let active: ActiveExecution | null = null;
let open = false;
let snapshot: InspectorSnapshot = { open, active };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { open, active };
  for (const l of listeners) l();
}

export function getInspectorState(): InspectorSnapshot {
  return snapshot;
}

export function subscribeInspector(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setActiveExecution(exec: ActiveExecution): void {
  active = exec;
  emit();
}

/** Show the inspector for this execution (AA start path). */
export function openInspectorFor(exec: ActiveExecution): void {
  active = exec;
  open = true;
  emit();
}

/** Eye button: pure show/hide — execution is untouched either way. */
export function toggleInspectorFor(exec?: ActiveExecution): void {
  if (exec) active = exec;
  open = !open;
  emit();
}

export function closeInspector(): void {
  open = false;
  emit();
}

export function useInspectorState(): InspectorSnapshot {
  return useSyncExternalStore(subscribeInspector, getInspectorState, getInspectorState);
}
