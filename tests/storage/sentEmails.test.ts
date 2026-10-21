// EVERY email must be kept in the sent log — including direct sends to
// addresses that don't belong to a detected contact (reported gap: manual
// emails vanished because recording was gated on contactId).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-emails-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const { getDb, runWithUser, recordSentEmail, listSentEmails, listContactEmails } = await import('../../server/storage/fileStorage.js');

const USER = 'sent-emails-user';
const CONTACT_ID = 'hr-1';

describe('sent_emails — nothing sent goes missing', () => {
  beforeAll(() => {
    runWithUser(USER, () => {
      const d = getDb();
      d.prepare('INSERT OR IGNORE INTO users (id, name, email, is_guest) VALUES (?, ?, ?, 1)').run(USER, 'SE', 'se@test.local');
      d.prepare(
        `INSERT INTO hr_contacts (id, user_id, email, name, company, type, type_label, hidden, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, 'recruiter', 'Recruiter', 0, ?, ?)`
      ).run(CONTACT_ID, USER, 'conner@stripe.com', 'Conner Cotting', 'Stripe', new Date().toISOString(), new Date().toISOString());
    });
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('a DIRECT send (no contact) is still listed in the global log', () => {
    runWithUser(USER, () => {
      recordSentEmail({ recipient: 'hiring@acme-corp.com', subject: 'Intro', body: 'Hello', status: 'sent' });
      const all = listSentEmails(50);
      const direct = all.find((e) => e.recipient === 'hiring@acme-corp.com');
      expect(direct).toBeTruthy();
      expect(direct!.contactId).toBeNull();
      expect(direct!.status).toBe('sent');
    });
  });

  it('a direct send whose recipient IS a saved contact auto-links to that contact', () => {
    runWithUser(USER, () => {
      recordSentEmail({ recipient: 'Conner@Stripe.com', subject: 'Role chat', body: 'Hi Conner', status: 'sent' });
      const all = listSentEmails(50);
      const linked = all.find((e) => e.subject === 'Role chat');
      expect(linked?.contactId).toBe(CONTACT_ID);
      // and appears in the contact's own history
      const hist = listContactEmails(CONTACT_ID);
      expect(hist.some((e) => e.subject === 'Role chat')).toBe(true);
    });
  });

  it('contact-linked sends are recorded and readable per contact', () => {
    runWithUser(USER, () => {
      recordSentEmail({ contactId: CONTACT_ID, recipient: 'conner@stripe.com', subject: 'Tailored CV', body: 'Attached', attachmentName: 'Master CV', status: 'sent' });
      const hist = listContactEmails(CONTACT_ID);
      const row = hist.find((e) => e.subject === 'Tailored CV');
      expect(row?.attachmentName).toBe('Master CV');
      const all = listSentEmails(50);
      expect(all.find((e) => e.subject === 'Tailored CV')?.contactName).toBe('Conner Cotting');
    });
  });

  it('failed attempts are kept too (visible, not silent)', () => {
    runWithUser(USER, () => {
      recordSentEmail({ recipient: 'bounce@nowhere.io', subject: 'Bounce', body: 'Test', status: 'failed' });
      const all = listSentEmails(50);
      expect(all.find((e) => e.recipient === 'bounce@nowhere.io')?.status).toBe('failed');
    });
  });
});
