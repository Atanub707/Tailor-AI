// Application Experience V1 — append-only, non-sensitive event log.
import type { Database } from 'better-sqlite3';
import type { ApplicationEvent, ApplicationEventType } from './applicationStatus.js';

export function ensureEventSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reason_code TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_attempt ON application_events (user_id, attempt_id, created_at);
  `);
}

export function appendEvent(
  db: Database,
  input: {
    userId: string;
    attemptId: string;
    eventType: ApplicationEventType;
    reasonCode?: string;
    metadata?: Record<string, string>;
    idempotencyId?: string;
  },
): ApplicationEvent {
  ensureEventSchema(db);
  const id = input.idempotencyId
    ? `evt-${input.idempotencyId}`
    : `evt-${input.attemptId.slice(-10)}-${Date.now().toString(36)}`;
  const event: ApplicationEvent = {
    id,
    userId: input.userId,
    attemptId: input.attemptId,
    eventType: input.eventType,
    reasonCode: input.reasonCode,
    createdAt: new Date().toISOString(),
    metadata: input.metadata ?? {},
  };
  try {
    db.prepare('INSERT INTO application_events (id, user_id, attempt_id, event_type, reason_code, created_at, metadata_json) VALUES (?,?,?,?,?,?,?)')
      .run(event.id, event.userId, event.attemptId, event.eventType, event.reasonCode ?? null, event.createdAt, JSON.stringify(event.metadata));
  } catch (e: any) {
    if (String(e?.code || '').includes('SQLITE_CONSTRAINT')) {
      const existing = getEvent(db, input.userId, id);
      if (existing) return existing; // idempotent
    }
    throw e;
  }
  return event;
}

export function getEvent(db: Database, userId: string, eventId: string): ApplicationEvent | null {
  const row = db.prepare('SELECT * FROM application_events WHERE id = ? AND user_id = ?').get(eventId, userId) as any;
  return row ? eventFromRow(row) : null;
}

export function getEventsForAttempt(db: Database, userId: string, attemptId: string): ApplicationEvent[] {
  const rows = db.prepare('SELECT * FROM application_events WHERE user_id = ? AND attempt_id = ? ORDER BY created_at ASC').all(userId, attemptId) as any[];
  return rows.map(eventFromRow);
}

export function getEventTypesForAttempt(db: Database, userId: string, attemptId: string): Set<ApplicationEventType> {
  return new Set(getEventsForAttempt(db, userId, attemptId).map((e) => e.eventType));
}

function eventFromRow(row: any): ApplicationEvent {
  return {
    id: row.id,
    userId: row.user_id,
    attemptId: row.attempt_id,
    eventType: row.event_type as ApplicationEventType,
    reasonCode: row.reason_code ?? undefined,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}