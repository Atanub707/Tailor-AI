import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Search, CheckCircle2, Copy, Trash2, Mail, ExternalLink, Linkedin, Camera, Phone, AlertTriangle, Loader2, Sparkles, Send, FileText, Upload, PencilLine, Clock, BadgeCheck, Plus, Users, Building2, MessageCircle } from 'lucide-react';
import { filterByType, sortContacts, typeCounts, TYPE_LABELS } from '../lib/recruiters/filterUtils';
import { followupDue, followupDaysLeft } from '../lib/recruiters/followupUtils';

interface Contact {
  id: string;
  email: string | null;
  phone: string | null;
  whatsapp: boolean;
  recruiterName: string | null;
  recruiterUrl: string | null;
  name: string | null;
  type: string;
  typeLabel: string;
  company: string;
  jobRole: string;
  sourceJobId: string;
  sourceJobUrl: string;
  jobCount: number;
  notes: string;
  context: string;
  firstSeen: string;
  lastSeen: string;
  lastEmailSent?: string;
  emailStatus?: string;
  pipelineStatus?: string;
  followUpAt?: string;
  followedUp: boolean;
}

interface SentEmail { id: string; recipient: string; subject: string; body: string; attachmentName: string | null; status: string; sentAt: string; }

interface RecruitersScreenProps {
  isOpen: boolean;
  onClose: () => void;
  focusRecruiter?: { name?: string | null; url?: string | null } | null;
}

const PIPELINE: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'No status' },
  { value: 'replied', label: 'Replied' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
];

const waLink = (phone: string): string => {
  const digits = phone.replace(/[^\d]/g, '').replace(/^0+/, '');
  return `https://wa.me/${digits}`;
};

export const RecruitersScreen: React.FC<RecruitersScreenProps> = ({ isOpen, onClose, focusRecruiter }) => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [companies, setCompanies] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [company, setCompany] = useState('');
  const [stats, setStats] = useState<{ total: number; withEmail: number; withPhone: number; sent: number; companies: number } | null>(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [pipelineFilter, setPipelineFilter] = useState('');
  const [sortBy, setSortBy] = useState('last_seen');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [composeContact, setComposeContact] = useState<Contact | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [composeMsg, setComposeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [attachMode, setAttachMode] = useState<'none' | 'master' | 'file'>('none');
  const [attachFile, setAttachFile] = useState<{ name: string; data: string } | null>(null);
  const [masterCvName, setMasterCvName] = useState<string | null>(null);
  const [shownCount, setShownCount] = useState(24);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [emailHistory, setEmailHistory] = useState<Record<string, SentEmail[]>>({});
  const [historyFor, setHistoryFor] = useState<Contact | null>(null);
  const [verifyMap, setVerifyMap] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load the saved Master CV's filename so the attachment chip shows the
  // real CV name (validated on the Master CV screen), not a generic label.
  const loadMasterCvName = async () => {
    try {
      const res = await fetch('/api/cv/master');
      if (!res.ok) return;
      const mc = await res.json();
      if (mc?.fullName) {
        setMasterCvName(`${mc.downloadFilename || mc.fullName.replace(/\s+/g, '_') + '_CV'}.pdf`);
      }
    } catch { /* ignore */ }
  };

  const pickAttachmentFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '').split(',')[1] || '';
      setAttachFile({ name: file.name, data });
      setAttachMode('file');
      setComposeMsg(null);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const openCompose = (c: Contact) => {
    setComposeContact(c);
    setComposeTo(c.email || '');
    setComposeSubject('');
    setComposeBody('');
    setComposeMsg(null);
    setAttachMode('none');
    setAttachFile(null);
    setComposeOpen(true);
    loadMasterCvName();
  };

  // Manual email — same slide-in panel, blank fields, no contact needed.
  const openManualCompose = () => {
    setComposeContact(null);
    setComposeTo('');
    setComposeSubject('');
    setComposeBody('');
    setComposeMsg(null);
    setAttachMode('none');
    setAttachFile(null);
    setComposeOpen(true);
    loadMasterCvName();
  };

  const openHistory = async (c: Contact) => {
    setHistoryFor(c);
    if (!emailHistory[c.id]) {
      try {
        const res = await fetch(`/api/contacts/${c.id}/emails`);
        const d = await res.json();
        setEmailHistory((h) => ({ ...h, [c.id]: d.emails || [] }));
      } catch { /* ignore */ }
    }
  };

  const draftEmail = async () => {
    if (!composeTo.trim()) { setComposeMsg({ ok: false, text: 'Add a recipient email first.' }); return; }
    setDraftBusy(true); setComposeMsg(null);
    try {
      const res = await fetch('/api/emails/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: composeContact?.id ?? null, to: composeTo }),
      });
      const data = await res.json();
      if (!res.ok) { setComposeMsg({ ok: false, text: data.error || 'Draft failed.' }); return; }
      setComposeSubject(data.draft.subject);
      setComposeBody(data.draft.body);
    } catch (e: any) {
      setComposeMsg({ ok: false, text: e.message || 'Draft failed.' });
    } finally {
      setDraftBusy(false);
    }
  };

  const closeCompose = () => {
    setComposeOpen(false);
    setComposeContact(null);
  };

  const sendEmail = async () => {
    setSendBusy(true); setComposeMsg(null);
    try {
      const res = await fetch('/api/emails/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: composeContact?.id ?? null,
          to: composeTo,
          subject: composeSubject,
          body: composeBody,
          attachMaster: attachMode === 'master',
          attachment: attachMode === 'file' && attachFile ? { filename: attachFile.name, data: attachFile.data } : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setComposeMsg({ ok: false, text: data.error || 'Send failed.' }); return; }
      setComposeMsg({ ok: true, text: 'Sent ✓' });
      // Update the card status immediately.
      if (composeContact) {
        setContacts((prev) => prev.map((x) => x.id === composeContact.id
          ? { ...x, emailStatus: 'sent', lastEmailSent: new Date().toISOString() }
          : x));
        setEmailHistory((h) => { const n = { ...h }; delete n[composeContact.id]; return n; });
      }
      setTimeout(() => closeCompose(), 1200);
    } catch (e: any) {
      setComposeMsg({ ok: false, text: e.message || 'Send failed.' });
    } finally {
      setSendBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/contacts');
      const data = await res.json();
      if (res.ok) {
        setContacts(data.contacts || []);
        setCompanies(data.companies || []);
      }
      fetch('/api/contacts/stats').then((r) => r.json()).then((d) => setStats(d.stats)).catch(() => {});
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refetch every time the screen opens — contacts scraped since the app
  // loaded (or since the last visit) must appear immediately.
  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  // Deep-link: badge click on a job card focuses that recruiter.
  useEffect(() => {
    if (focusRecruiter?.name) setQ(focusRecruiter.name);
  }, [focusRecruiter?.name]);

  useEffect(() => {
    if (!focusRecruiter) { setFocusedId(null); return; }
    const qn = (focusRecruiter.name || '').trim().toLowerCase();
    const qu = (focusRecruiter.url || '').trim();
    const hit = contacts.find(
      (c) =>
        (qn && ((c.name || '').toLowerCase() === qn || (c.recruiterName || '').toLowerCase() === qn || (c.name || '').toLowerCase().includes(qn))) ||
        (qu && c.recruiterUrl === qu)
    );
    setFocusedId(hit ? hit.id : null);
  }, [contacts, focusRecruiter]);

  const showToast = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 2000);
  };

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast(`${value} copied`);
    } catch { showToast('Could not copy'); }
  };

  const copyEmail = async (c: Contact) => {
    const value = c.email || c.phone || c.recruiterUrl || '';
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(c.id);
      setTimeout(() => setCopiedId(null), 1400);
      showToast(`${value} copied`);
    } catch { showToast('Could not copy — select manually'); }
  };

  const verifyEmail = async (c: Contact) => {
    if (!c.email) return;
    try {
      const res = await fetch('/api/contacts/verify-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c.email }),
      });
      const d = await res.json();
      if (!res.ok) { setVerifyMap((m) => ({ ...m, [c.id]: 'unknown' })); return; }
      setVerifyMap((m) => ({ ...m, [c.id]: d.detail }));
    } catch { setVerifyMap((m) => ({ ...m, [c.id]: 'unknown' })); }
  };

  const copyAll = async () => {
    const emails = contacts.map((c) => c.email).filter((e): e is string => !!e);
    if (emails.length === 0) return;
    try {
      await navigator.clipboard.writeText(emails.join('\n'));
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1800);
      showToast(`${emails.length} emails copied to clipboard`);
    } catch { showToast('Could not copy'); }
  };

  const hideContact = async (id: string) => {
    const prev = contacts;
    setContacts((c) => c.filter((x) => x.id !== id));
    try {
      await fetch(`/api/contacts/${id}/hide`, { method: 'POST' });
      showToast('Contact dismissed');
    } catch {
      setContacts(prev);
      showToast('Could not dismiss');
    }
  };

  const setFollowUp = async (c: Contact, days: number) => {
    const date = days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString();
    await fetch(`/api/contacts/${c.id}/followup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) });
    setContacts((prev) => prev.map((x) => (x.id === c.id ? { ...x, followUpAt: date || undefined, followedUp: false } : x)));
    showToast(days === 0 ? 'Follow-up cleared' : `Follow-up in ${days} day${days === 1 ? '' : 's'}`);
  };

  const markFollowedUp = async (c: Contact) => {
    await fetch(`/api/contacts/${c.id}/followedup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: !c.followedUp }) });
    setContacts((prev) => prev.map((x) => (x.id === c.id ? { ...x, followedUp: !x.followedUp } : x)));
  };

  const saveNote = async (c: Contact) => {
    const note = (noteDrafts[c.id] ?? c.notes ?? '').trim();
    await fetch(`/api/contacts/${c.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    setContacts((prev) => prev.map((x) => (x.id === c.id ? { ...x, notes: note } : x)));
    setEditingNoteId(null);
  };

  const ql = q.trim().toLowerCase();
  const visibleRaw = contacts.filter(
    (c) =>
      (!company || c.company === company) &&
      (!pipelineFilter || c.pipelineStatus === pipelineFilter) &&
      (!ql || (c.name || '').toLowerCase().includes(ql) || (c.recruiterName || '').toLowerCase().includes(ql) || (c.email || '').toLowerCase().includes(ql) || (c.phone || '').includes(ql) || c.company.toLowerCase().includes(ql))
  );
  const typeCountsMap = typeCounts(contacts);
  const visible = sortContacts<Contact>(visibleRaw.filter((c: Contact) => filterByType(c, typeFilter)), sortBy);
  const shown = visible.slice(0, shownCount);
  const canLoadMore = shownCount < visible.length;

  useEffect(() => setShownCount(24), [typeFilter, company, q, pipelineFilter]);

  useEffect(() => {
    if (focusedId) {
      const el = document.getElementById(`rc-card-${focusedId}`);
      el?.scrollIntoView({ block: 'center' });
    }
  }, [focusedId, visible.length]);

  if (!isOpen) return null;

  return (
    <div className="rc-screen">
      {/* Header */}
      <header className="rc-hdr">
        <div className="rc-ttl">
          <b>Recruiters</b>
          <span>Identity cards — emails, phones & LinkedIn from job descriptions.</span>
        </div>
        <div className="rc-spacer" />
        <button className="rc-btn2 manual" onClick={openManualCompose} title="Compose a fresh email to any address — no contact needed">
          <Mail size={13} /> Create Email
        </button>
      </header>

      {/* Content */}
      <div className="rc-wrap">
        {stats && (
          <div className="rc-stats">
            <span className="rc-stat brand"><Users size={13} /><b>{stats.total}</b> contacts</span>
            <span className="rc-stat brand"><Mail size={13} /><b>{stats.withEmail}</b> with email</span>
            <span className="rc-stat violet"><Phone size={13} /><b>{stats.withPhone}</b> with phone</span>
            <span className="rc-stat cta"><Send size={13} /><b>{stats.sent}</b> sent</span>
            <span className="rc-stat amber"><Building2 size={13} /><b>{stats.companies}</b> companies</span>
          </div>
        )}
        <div className="rc-toolbar">
          <div className="rc-search">
            <Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, or company…" />
          </div>
          <select className="rc-select" value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All companies</option>
            {companies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="rc-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="last_seen">Sort: newest</option>
            <option value="name">Sort: name</option>
            <option value="company">Sort: company</option>
            <option value="job_count">Sort: most jobs</option>
            <option value="last_email_sent">Sort: recently emailed</option>
          </select>
        </div>
        <div className="rc-toolbar2">
          <div className="rc-typeseg">
            {['all', 'recruit', 'hr', 'careers', 'company'].map((t) => (
              <button key={t} className={`rc-tseg ${typeFilter === t ? 'on' : ''}`} onClick={() => setTypeFilter(t)}>
                {t === 'all' ? 'All' : TYPE_LABELS[t]}
                <span className="rc-tseg-n">{t === 'all' ? contacts.length : typeCountsMap[t] || 0}</span>
              </button>
            ))}
          </div>
          <select className="rc-select rc-pipefilter" value={pipelineFilter} onChange={(e) => setPipelineFilter(e.target.value)}>
            <option value="">Pipeline: Any</option>
            {PIPELINE.filter((p) => p.value).map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="rc-note">
          <Mail size={13} />
          Cards fill the screen — no long scrolling. Click any chip to copy.
        </div>

        {loading ? (
          <p className="rc-empty-text">Loading contacts…</p>
        ) : visible.length === 0 ? (
          <div className="rc-empty">
            <div className="rc-empty-ico"><Mail size={24} /></div>
            <b>{contacts.length === 0 ? 'No emails found yet' : 'No contacts match'}</b>
            <p>{contacts.length === 0
              ? 'Emails and phone numbers appear here automatically as jobs are scraped — HR, recruiting and company contacts found in descriptions.'
              : 'Try a different search or clear the filters.'}</p>
          </div>
        ) : (
          <>
          <div className="rc-grid">
            {shown.map((c, i) => {
              const displayName = c.name || c.recruiterName || '';
              const hasPhoto = !!displayName;
              return (
                <div key={c.id} id={`rc-card-${c.id}`} className={`rc-idcard ${focusedId === c.id ? 'rc-focus' : ''}`}>
                  <div className="rc-row1">
                    <div className={`rc-photo ${hasPhoto ? `has ${i % 3 === 1 ? 'alt1' : i % 3 === 2 ? 'alt2' : ''}` : ''}`}>
                      {hasPhoto ? displayName.charAt(0).toUpperCase() : <Camera size={18} />}
                    </div>
                    <div className="rc-idn">
                      <div className="rc-nm">
                        {displayName ? <b>{displayName}</b> : <span className="rc-notscraped">Not found</span>}
                        <span className={`rc-tag rc-tag-${c.type}`}>{c.typeLabel}</span>
                      </div>
                      <div className="rc-co-line">
                        <span className="rc-co-txt">
                          {c.company}
                          {c.jobRole && <><span className="rc-sep">·</span>{c.jobRole}</>}
                        </span>
                        {c.sourceJobUrl && (
                          <a className="rc-srcjob" href={c.sourceJobUrl} target="_blank" rel="noreferrer">
                            <ExternalLink size={10} /> Job
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="rc-right">
                      <button className="rc-ghost" title="Dismiss" onClick={() => hideContact(c.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  <div className="rc-chips">
                    {c.email ? (
                      <span className="rc-chip email" title="Copy email" onClick={() => copyValue(c.email!)}>
                        <Mail size={11} /> <span className="rc-chip-txt">{c.email}</span>
                      </span>
                    ) : (
                      <span className="rc-chip none">Email not found</span>
                    )}
                    {c.phone ? (
                      <>
                        <span className="rc-chip phone" title="Copy phone" onClick={() => copyValue(c.phone!)}>
                          <Phone size={11} /> <span className="rc-chip-txt">{c.phone}</span>
                        </span>
                        {c.whatsapp && (
                          <a className="rc-chip wa" href={waLink(c.phone)} target="_blank" rel="noreferrer" title="Chat on WhatsApp">
                            <MessageCircle size={11} /> WhatsApp
                          </a>
                        )}
                      </>
                    ) : (
                      <span className="rc-chip none">Phone not found</span>
                    )}
                    {c.recruiterUrl ? (
                      <a className="rc-chip li" href={c.recruiterUrl} target="_blank" rel="noreferrer">
                        <Linkedin size={11} /> LinkedIn
                      </a>
                    ) : (
                      <span className="rc-chip none">LinkedIn not found</span>
                    )}
                  </div>

                  {c.context && <div className="rc-ctx">"{c.context}"</div>}

                  {(c.followUpAt || c.emailStatus === 'sent' || c.emailStatus === 'failed') && (
                    <div className="rc-furow">
                      {c.followUpAt && !c.followedUp && followupDue(c.followUpAt, false) && (
                        <span className="rc-fuchip overdue"><AlertTriangle size={10} /> Follow up <span className="rc-fu-mini">due</span></span>
                      )}
                      {c.followUpAt && !c.followedUp && !followupDue(c.followUpAt, false) && (
                        <span className="rc-fuchip"><Clock size={10} /> Follow up <span className="rc-fu-mini">{followupDaysLeft(c.followUpAt)}d</span></span>
                      )}
                      {c.followedUp && <span className="rc-fuchip done"><CheckCircle2 size={10} /> Followed up</span>}
                      {c.followUpAt && !c.followedUp && (
                        <button className="rc-fubtn" onClick={() => markFollowedUp(c)}>Mark done</button>
                      )}
                      {c.followUpAt && (
                        <button className="rc-fubtn" onClick={() => setFollowUp(c, 0)}>Clear</button>
                      )}
                      <span className="rc-fu-spacer" />
                      {c.emailStatus === 'sent' && c.lastEmailSent && (
                        <button className="rc-emailchip sent clickable" onClick={() => openHistory(c)}>
                          <CheckCircle2 size={11} /> Sent {new Date(c.lastEmailSent).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </button>
                      )}
                      {c.emailStatus === 'failed' && (
                        <button className="rc-emailchip failed clickable" onClick={() => openHistory(c)}>
                          <AlertTriangle size={11} /> Failed — resend
                        </button>
                      )}
                    </div>
                  )}

                  {editingNoteId === c.id ? (
                    <div className="rc-note-edit">
                      <textarea
                        className="rc-note-ta"
                        rows={2}
                        placeholder="Add a note…"
                        value={noteDrafts[c.id] ?? c.notes ?? ''}
                        onChange={(e) => setNoteDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                      />
                      <div className="rc-note-acts">
                        <button className="rc-note-btn primary" onClick={() => saveNote(c)}>Save</button>
                        <button className="rc-note-btn" onClick={() => setEditingNoteId(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="rc-noterow">
                      {c.notes ? (
                        <span className="rc-note-pill">
                          <span className="rc-note-txt">{c.notes}</span>
                          <button className="rc-note-editbtn" onClick={() => setEditingNoteId(c.id)} title="Edit note"><PencilLine size={11} /></button>
                        </span>
                      ) : null}
                      <button className="rc-note-add" onClick={() => setEditingNoteId(c.id)}><Plus size={11} /> Note</button>
                    </div>
                  )}

                  <div className="rc-cact">
                    <button className={`rc-btn ${copiedId === c.id ? 'copied' : ''}`} onClick={() => copyEmail(c)}>
                      {copiedId === c.id ? <><CheckCircle2 size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                    </button>
                    {c.email && (
                      <button className="rc-ghost" title="Compose cold email" onClick={() => openCompose(c)}>
                        <Mail size={14} />
                      </button>
                    )}
                    <button className="rc-ghost" title="Email history" onClick={() => openHistory(c)}>
                      <Clock size={14} />
                    </button>
                    <span className="rc-fu-spacer" />
                    {verifyMap[c.id] && (
                      <span className={`rc-verifystate ${verifyMap[c.id] === 'valid' ? 'ok' : verifyMap[c.id] === 'invalid-format' ? 'bad' : 'warn'}`}>
                        {verifyMap[c.id] === 'valid' ? 'Valid' : verifyMap[c.id] === 'invalid-format' ? 'Invalid' : verifyMap[c.id] === 'no-mx' ? 'No MX' : 'Unknown'}
                      </span>
                    )}
                    {!verifyMap[c.id] && c.email && (
                      <button className="rc-verify" title="Check email validity (format + domain MX)" onClick={() => verifyEmail(c)}>
                        <BadgeCheck size={13} /> Verify
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {canLoadMore && (
            <div className="rc-morewrap">
              <button className="rc-more" onClick={() => setShownCount((s) => s + 24)}>
                Show {Math.min(24, visible.length - shownCount)} more ({visible.length - shownCount} left)
              </button>
            </div>
          )}
          </>
        )}
      </div>

      {/* ═══ Compose email — slide-in panel (right) ═══ */}
      <div className={`rc-overlay ${composeOpen ? 'open' : ''}`} onClick={() => !draftBusy && !sendBusy && closeCompose()}></div>
      <aside
        className={`rc-emailpanel ${composeOpen ? 'open' : ''}`}
        aria-label="Email workflow"
        aria-hidden={!composeOpen}
      >
        <div className="rc-email-head">
          <span className="rc-email-ico">
            <Mail size={17} />
          </span>
          <b>Email workflow</b>
          <button onClick={closeCompose} className="rc-email-x" aria-label="Close">
            <X size={17} />
          </button>
        </div>

        <div className="rc-email-body">
          {composeContact && (
            <div className="rc-recipient">
              <div className="rc-recipient-av">
                {(composeContact.name || composeContact.company || '?').charAt(0).toUpperCase()}
              </div>
              <div>
                <b>{composeContact.name || composeContact.company || 'Contact'}</b>
                <span>{composeContact.email}{composeContact.company ? ` · ${composeContact.company}` : ''}</span>
              </div>
            </div>
          )}

          <div>
            <label className="rc-email-flabel">To</label>
            <input type="text" value={composeTo} onChange={(e) => setComposeTo(e.target.value)} className="rc-email-input" />
          </div>

          <div>
            <label className="rc-email-flabel">Subject</label>
            <input type="text" value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)} className="rc-email-input" />
          </div>

          <div>
            <label className="rc-email-flabel">Body</label>
            <textarea value={composeBody} onChange={(e) => setComposeBody(e.target.value)} rows={9}
              className="rc-email-input rc-email-body-input" placeholder="Type your message… or click Draft with AI" />
          </div>

          <div>
            <label className="rc-email-flabel">Attach CV</label>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => { setAttachMode(attachMode === 'master' ? 'none' : 'master'); setAttachFile(null); setComposeMsg(null); }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold border transition-colors cursor-pointer ${
                  attachMode === 'master' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-blue-300'
                }`}
              >
                <FileText size={13} /> Master CV
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold border transition-colors cursor-pointer ${
                  attachMode === 'file' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-blue-300'
                }`}
              >
                <Upload size={13} /> From file manager
              </button>
              <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.txt,.png,.jpg" className="hidden" onChange={pickAttachmentFile} />
              {attachMode === 'master' && (
                <span className="inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200 text-blue-700 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold max-w-full">
                  <FileText size={12} /> <span className="truncate max-w-[180px]">{masterCvName || 'Master CV'}</span>
                  <button type="button" onClick={() => setAttachMode('none')} className="text-blue-400 hover:text-red-600 cursor-pointer shrink-0" aria-label="Remove attachment">
                    <X size={12} />
                  </button>
                </span>
              )}
              {attachMode === 'file' && attachFile && (
                <span className="inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200 text-blue-700 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold max-w-full">
                  <FileText size={12} /> <span className="truncate max-w-[180px]">{attachFile.name}</span>
                  <button type="button" onClick={() => { setAttachFile(null); setAttachMode('none'); }} className="text-blue-400 hover:text-red-600 cursor-pointer shrink-0" aria-label="Remove attachment">
                    <X size={12} />
                  </button>
                </span>
              )}
            </div>
          </div>

          {composeMsg && (
            <p className={`text-[12px] font-semibold ${composeMsg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{composeMsg.text}</p>
          )}
        </div>

        <div className="rc-email-foot">
          <button onClick={draftEmail} disabled={draftBusy || sendBusy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 cursor-pointer transition-colors">
            {draftBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Draft with AI
          </button>
          <div className="flex-1" />
          <button onClick={closeCompose} disabled={draftBusy || sendBusy}
            className="px-3.5 py-2 rounded-lg text-[12.5px] font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-50 cursor-pointer">
            Cancel
          </button>
          <button onClick={sendEmail} disabled={sendBusy || draftBusy || !composeTo.trim() || !composeSubject.trim() || !composeBody.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12.5px] font-bold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 cursor-pointer transition-colors">
            {sendBusy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send
          </button>
        </div>
      </aside>

      {/* Email history modal */}
      {historyFor && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={() => setHistoryFor(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200">
              <h3 className="text-sm font-extrabold text-slate-900">Email history — {historyFor.name || historyFor.email}</h3>
              <button onClick={() => setHistoryFor(null)} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 cursor-pointer"><X size={16} /></button>
            </div>
            <div className="p-4 space-y-3 overflow-y-auto">
              {(emailHistory[historyFor.id] || []).length === 0 ? (
                <p className="text-[12px] text-slate-500">No emails sent to this contact yet.</p>
              ) : (
                (emailHistory[historyFor.id] || []).map((e) => (
                  <div key={e.id} className="border border-slate-200 rounded-xl p-3">
                    <div className="flex items-center gap-2 text-[11px] font-bold text-slate-700">
                      <span className={`px-2 py-0.5 rounded-full ${e.status === 'sent' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{e.status}</span>
                      <span className="truncate">{new Date(e.sentAt).toLocaleString()}</span>
                    </div>
                    <p className="text-[12.5px] font-bold text-slate-800 mt-1.5">{e.subject}</p>
                    <p className="text-[11.5px] text-slate-500 whitespace-pre-wrap leading-relaxed mt-1 line-clamp-4">{e.body}</p>
                    {e.attachmentName && <p className="text-[10.5px] text-blue-600 mt-1">📎 {e.attachmentName}</p>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sticky action bar */}
      <div className="rc-actbar">
        <span className="rc-note-text">Emails are pulled from job descriptions you already scrape.</span>
        <div className="rc-spacer" />
        <button className={`rc-btn2 primary ${copiedAll ? 'copied' : ''}`} onClick={copyAll} disabled={!contacts.some((c) => c.email)}>
          {copiedAll ? <><CheckCircle2 size={14} /> Emails copied ✓</> : <><Copy size={14} /> Copy all emails</>}
        </button>
      </div>

      {toast && (
        <div className="rc-toast">
          <CheckCircle2 size={14} /> {toast}
        </div>
      )}

      <style>{`
        .rc-screen {
          --bg: #FAFAF9; --card: #FFFFFF; --border: var(--color-hairline); --text: var(--color-ink);
          --muted: var(--color-muted); --faint: var(--color-faint); --blue: var(--color-brand); --blue-soft: var(--color-brand-soft);
          --blue-border: var(--color-brand-line); --linkedin: #0A66C2; --green: #059669; --green-soft: var(--color-cta-soft); --green-border: var(--color-cta-line);
          --amber: #D97706; --amber-soft: #FFFBEB; --amber-border: #FDE68A; --red: var(--color-danger);
          --shadow: 0 1px 3px rgba(15,23,42,.06);
          position: fixed; inset: 0; z-index: 60; background: var(--bg); color: var(--text);
          display: flex; flex-direction: column; font-family: 'Inter', system-ui, -apple-system, sans-serif;
          -webkit-font-smoothing: antialiased;
        }
        .rc-hdr { display: flex; align-items: center; gap: 12px; padding: 0 28px; height: 60px; border-bottom: 1px solid var(--border); background: var(--card); flex-shrink: 0; }
        .rc-back { display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--muted); font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all .15s ease; }
        .rc-back:hover { color: var(--text); border-color: var(--blue-border); background: var(--blue-soft); }
        .rc-ttl b { font-size: 15px; font-weight: 700; display: block; line-height: 1.2; }
        .rc-ttl span { font-size: 11px; color: var(--faint); font-weight: 500; }
        .rc-spacer { flex: 1; }
        .rc-count { display: inline-flex; align-items: center; font-size: 12px; font-weight: 700; color: var(--blue); background: var(--blue-soft); border: 1px solid var(--blue-border); padding: 6px 13px; border-radius: 20px; flex-shrink: 0; }
        .rc-wrap { max-width: 920px; width: 100%; margin: 0 auto; padding: 26px 28px 40px; flex: 1; overflow-y: auto; }
        .rc-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 9px; }
        .rc-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
        .rc-stat { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--muted); background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 6px 12px; }
        .rc-stat svg { width: 13px; height: 13px; opacity: .85; }
        .rc-stat b { color: var(--ink); font-size: 13px; }
        .rc-stat.brand svg { color: var(--blue); }
        .rc-stat.cta svg { color: var(--green); }
        .rc-stat.amber svg { color: var(--amber); }
        .rc-stat.violet svg { color: #7C3AED; }
        .rc-toolbar2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .rc-typeseg { display: inline-flex; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 3px; gap: 2px; }
        .rc-tseg { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; color: var(--muted); border: 0; background: none; border-radius: 7px; padding: 5px 11px; cursor: pointer; font-family: inherit; transition: all .15s ease; }
        .rc-tseg:hover { color: var(--blue); }
        .rc-tseg.on { background: var(--blue); color: #fff; }
        .rc-tseg-n { font-size: 10px; font-weight: 800; background: rgba(15,23,42,.08); color: inherit; border-radius: 20px; padding: 1px 6px; }
        .rc-tseg.on .rc-tseg-n { background: rgba(255,255,255,.22); color: #fff; }
        .rc-pipefilter { height: 34px; }
        .rc-search { flex: 1; display: flex; align-items: center; gap: 9px; height: 40px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 0 13px; color: var(--faint); }
        .rc-search:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.09); }
        .rc-search input { flex: 1; border: 0; outline: none; background: none; font-size: 13px; font-family: inherit; color: var(--text); }
        .rc-search input::placeholder { color: var(--faint); }
        .rc-select { height: 40px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); color: var(--muted); font-size: 12.5px; font-weight: 600; font-family: inherit; padding: 0 10px; outline: none; cursor: pointer; }
        .rc-select:focus { border-color: var(--blue); }
        .rc-note { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--faint); margin-bottom: 14px; }
        .rc-note b { color: var(--muted); font-weight: 600; }
        .rc-empty-text { color: var(--faint); font-size: 13px; padding: 30px 0; }
        .rc-empty { text-align: center; padding: 60px 20px; }
        .rc-empty-ico { width: 56px; height: 56px; border-radius: 16px; background: var(--blue-soft); border: 1px solid var(--blue-border); color: var(--blue); display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; }
        .rc-empty b { font-size: 14px; }
        .rc-empty p { font-size: 12.5px; color: var(--muted); margin-top: 5px; line-height: 1.6; max-width: 380px; margin-left: auto; margin-right: auto; }
        .rc-list { display: flex; flex-direction: column; gap: 10px; }
        .rc-contact { display: flex; align-items: center; gap: 14px; background: var(--card); border: 1px solid var(--border); border-radius: 13px; padding: 14px 16px; box-shadow: var(--shadow); }
        .rc-avatar { width: 40px; height: 40px; border-radius: 11px; color: #fff; font-weight: 700; font-size: 15px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .rc-cinfo { flex: 1; min-width: 0; }
        .rc-name { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 700; flex-wrap: wrap; }
        .rc-tag { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: 2px 7px; border-radius: 20px; }
        .rc-tag-recruit { background: var(--blue-soft); color: var(--blue); border: 1px solid var(--blue-border); }
        .rc-tag-hr { background: var(--amber-soft); color: var(--amber); border: 1px solid var(--amber-border); }
        .rc-tag-careers { background: #F0FDF4; color: var(--green); border: 1px solid var(--green-border); }
        .rc-tag-company { background: var(--color-hairline); color: var(--muted); border: 1px solid var(--border); }
        .rc-email { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); margin-top: 4px; }
        .rc-phone code { color: #7C3AED; background: #FAF5FF; border-color: #E9D5FF; }
        .rc-email code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 2px 7px; font-size: 12px; }
        .rc-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--faint); margin-top: 6px; flex-wrap: wrap; }
        .rc-sep { color: var(--color-faint); }
        .rc-context { font-size: 11px; color: var(--faint); font-style: italic; margin-top: 5px; max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rc-acts { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .rc-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 9px; border: 1px solid var(--border); background: #fff; color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all .15s ease; }
        .rc-btn:hover { border-color: var(--blue-border); color: var(--blue); }
        .rc-btn.copied { border-color: var(--green-border); color: var(--green); background: var(--green-soft); }
        .rc-linkedin { border-color: #B3C7F0; color: #0A66C2; background: #F5F8FE; }
        .rc-linkedin:hover { background: #E9F0FC; border-color: #0A66C2; }
        .rc-open { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: var(--blue); text-decoration: none; padding: 4px 6px; border-radius: 7px; }
        .rc-open:hover { background: var(--blue-soft); }
        .rc-ghost { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--faint); cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .rc-ghost:hover { color: var(--red); background: var(--color-danger-soft); }
        .rc-actbar { position: sticky; bottom: 0; background: rgba(255,255,255,.92); backdrop-filter: blur(10px); border-top: 1px solid var(--border); padding: 12px 28px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
        .rc-note-text { font-size: 11.5px; color: var(--faint); }
        .rc-btn2 { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 18px; border-radius: 10px; border: 1px solid var(--border); background: var(--card); color: var(--text); font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all .15s ease; }
        .rc-btn2:hover { border-color: var(--blue-border); }
        .rc-btn2.primary { background: linear-gradient(135deg, var(--color-brand), var(--color-brand-strong)); border-color: transparent; color: #fff; box-shadow: 0 2px 6px rgba(37,99,235,.3); }
        .rc-btn2.primary:hover { filter: brightness(1.07); }
        .rc-btn2.copied { background: var(--green-soft); border-color: var(--green-border); color: var(--green); }
        .rc-btn2.manual { background: var(--blue-soft); border-color: var(--blue-border); color: var(--blue); font-weight: 700; }
        .rc-hdr .rc-btn2.manual { padding: 8px 14px; font-size: 12px; }
        .rc-btn2.manual:hover { background: #DBEAFE; }
        .rc-btn2:disabled { opacity: .55; cursor: not-allowed; }
        .rc-toast { position: fixed; bottom: 82px; left: 50%; transform: translateX(-50%); background: var(--text); color: #FAFAF9; font-size: 12.5px; font-weight: 600; padding: 11px 18px; border-radius: 12px; display: flex; align-items: center; gap: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.3); z-index: 70; }
        .rc-wrap { max-width: 1360px; }
        .rc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; align-content: start; }
        .rc-idcard { background: var(--card); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 1px 2px rgba(11,18,32,.05); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; transition: box-shadow .15s ease, transform .15s ease; position: relative; }
        .rc-idcard:hover { box-shadow: 0 6px 18px -6px rgba(11,18,32,.14); transform: translateY(-1px); }
        .rc-idcard.rc-focus { box-shadow: 0 0 0 2px var(--blue), 0 6px 18px -6px rgba(37,99,235,.25); }
        .rc-row1 { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .rc-idn { flex: 1; min-width: 0; }
        .rc-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .rc-nm { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .rc-nm b { font-size: 14px; font-weight: 700; letter-spacing: -.01em; }
        .rc-co-line { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: 2px; }
        .rc-co-txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--faint); }
        .rc-co-txt .rc-sep { margin: 0 5px; color: var(--color-faint); }
        .rc-co-line .rc-srcjob { flex-shrink: 0; }
        .rc-notscraped { font-size: 11px; font-weight: 500; font-style: italic; color: var(--faint); }
        .rc-chips { display: flex; gap: 5px; flex-wrap: wrap; min-width: 0; }
        .rc-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700; border-radius: 7px; padding: 3px 8px; border: 1px solid var(--border); color: var(--muted); background: #fff; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; text-decoration: none; transition: all .15s ease; }
        .rc-chip svg { width: 11px; height: 11px; flex-shrink: 0; opacity: .8; }
        .rc-chip:hover { filter: brightness(.97); }
        .rc-chip-txt { overflow: hidden; text-overflow: ellipsis; }
        .rc-chip.email { border-color: #CBD5E1; background: #F8FAFC; }
        .rc-chip.phone { border-color: #E9D5FF; color: #7C3AED; background: #FAF5FF; }
        .rc-chip.li { border-color: var(--linkedin-line); color: var(--linkedin); background: var(--linkedin-soft); }
        .rc-chip.wa { border-color: var(--wa-line); color: var(--wa); background: var(--wa-soft); }
        .rc-chip.none { font-style: italic; color: var(--faint); font-weight: 500; border-style: dashed; background: none; cursor: default; }
        .rc-verify { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; border: 1px solid var(--border); background: var(--card); color: var(--faint); cursor: pointer; padding: 3px 8px; border-radius: 7px; }
        .rc-verify:hover { color: var(--green); border-color: var(--green-border); }
        .rc-verifystate { font-size: 9px; font-weight: 800; border-radius: 20px; padding: 2px 8px; }
        .rc-verifystate.ok { color: #15803D; background: #F0FDF4; border: 1px solid #BBF7D0; }
        .rc-verifystate.bad { color: var(--color-danger); background: var(--color-danger-soft); border: 1px solid #FECACA; }
        .rc-verifystate.warn { color: var(--amber); background: var(--amber-soft); border: 1px solid var(--amber-border); }
        .rc-photo { width: 38px; height: 38px; border-radius: 11px; background: linear-gradient(135deg, var(--color-hairline), var(--color-faint)); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; color: var(--color-muted); flex-shrink: 0; overflow: hidden; }
        .rc-photo svg { width: 16px; height: 16px; opacity: .55; }
        .rc-photo.has { background: linear-gradient(135deg, var(--color-brand), #7C3AED); color: #fff; font-weight: 800; font-size: 15px; border: 0; }
        .rc-photo.has.alt1 { background: linear-gradient(135deg, #F59E0B, #EF4444); }
        .rc-photo.has.alt2 { background: linear-gradient(135deg, var(--color-cta), #0EA5E9); }
        .rc-srcjob { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700; color: var(--blue); text-decoration: none; padding: 2px 7px; border-radius: 6px; background: var(--blue-soft); border: 1px solid var(--blue-border); }
        .rc-srcjob:hover { filter: brightness(.96); }
        .rc-ctx { font-size: 10.5px; color: var(--faint); font-style: italic; line-height: 1.45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rc-noterow { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .rc-note-pill { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 600; color: var(--amber); background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 7px; padding: 3px 8px; max-width: 100%; }
        .rc-note-txt { flex: 1; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rc-note-editbtn { border: 0; background: none; color: var(--amber); cursor: pointer; padding: 1px; display: inline-flex; flex-shrink: 0; }
        .rc-note-editbtn:hover { color: var(--rose); }
        .rc-note-add { display: inline-flex; align-items: center; gap: 4px; border: 1px dashed var(--border); background: none; color: var(--faint); font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 7px; cursor: pointer; font-family: inherit; flex-shrink: 0; }
        .rc-note-add svg { width: 10px; height: 10px; }
        .rc-note-add:hover { color: var(--blue); border-color: var(--blue-border); }
        .rc-note-edit { display: flex; flex-direction: column; gap: 6px; }
        .rc-note-ta { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; font-size: 11.5px; font-family: inherit; color: var(--text); outline: none; resize: vertical; }
        .rc-note-ta:focus { border-color: var(--blue); }
        .rc-note-acts { display: flex; gap: 6px; }
        .rc-note-btn { font-size: 10.5px; font-weight: 700; border: 1px solid var(--border); background: var(--card); color: var(--muted); border-radius: 7px; padding: 4px 10px; cursor: pointer; font-family: inherit; }
        .rc-note-btn.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
        .rc-cact { display: flex; align-items: center; gap: 7px; margin-top: auto; padding-top: 8px; border-top: 1px dashed var(--border); }
        .rc-cact .rc-btn { height: 28px; padding: 0 10px; font-size: 11px; }
        .rc-emailchip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 800; }
        .rc-emailchip.sent { background: var(--color-cta-soft); color: #059669; border: 1px solid var(--color-cta-line); }
        .rc-emailchip.failed { background: var(--color-danger-soft); color: var(--color-danger); border: 1px solid #FECACA; }
        .rc-emailchip.clickable { cursor: pointer; }
        .rc-emailchip.clickable:hover { filter: brightness(.97); }
        .rc-morewrap { text-align: center; padding: 18px 0 4px; }
        .rc-more { padding: 9px 20px; border-radius: 10px; border: 1px solid var(--blue-border); background: var(--blue-soft); color: var(--blue); font-size: 12.5px; font-weight: 700; cursor: pointer; font-family: inherit; transition: all .15s ease; }
        .rc-more:hover { filter: brightness(.97); }
        .rc-furow { display: flex; align-items: center; gap: 6px; }
        .rc-fuchip { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: var(--amber-soft); color: var(--amber); border: 1px solid var(--amber-border); }
        .rc-fuchip.overdue { background: var(--color-danger-soft); color: var(--color-danger); border: 1px solid #FECACA; }
        .rc-fuchip.done { background: var(--color-cta-soft); color: var(--green); border: 1px solid var(--color-cta-line); }
        .rc-fu-mini { background: rgba(15,23,42,.06); border-radius: 20px; padding: 0 5px; font-weight: 800; }
        .rc-fu-spacer { flex: 1; }
        .rc-fubtn { font-size: 10px; font-weight: 700; border: 1px solid var(--border); background: var(--card); color: var(--muted); border-radius: 6px; padding: 3px 8px; cursor: pointer; font-family: inherit; }
        .rc-fubtn:hover { border-color: var(--blue-border); color: var(--blue); }
        .rc-fubtn.ghost { border: 0; background: none; color: var(--faint); }

        /* ── Email workflow — slide-in panel ── */
        .rc-overlay{position:fixed; inset:0; background:rgba(15,23,42,.32); opacity:0; pointer-events:none; transition:opacity .25s ease; z-index:70;}
        .rc-overlay.open{opacity:1; pointer-events:auto;}
        .rc-emailpanel{position:fixed; top:0; right:0; bottom:0; width:480px; max-width:94vw; background:#fff; z-index:71; display:flex; flex-direction:column;
          transform:translateX(102%); transition:transform .3s cubic-bezier(.22,.68,0,1); box-shadow:-18px 0 50px -18px rgba(15,23,42,.3);}
        .rc-emailpanel.open{transform:translateX(0);}
        .rc-email-head{display:flex; align-items:center; gap:11px; padding:17px 20px; border-bottom:1px solid var(--border);}
        .rc-email-ico{width:36px; height:36px; border-radius:11px; background:var(--blue-soft); color:var(--blue); border:1px solid var(--blue-border); display:inline-flex; align-items:center; justify-content:center;}
        .rc-email-head b{font-size:14.5px; font-weight:800; flex:1; color:var(--text);}
        .rc-email-x{width:34px; height:34px; border-radius:10px; border:0; background:none; color:var(--faint); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:all .2s ease;}
        .rc-email-x:hover{background:#F1F5F9; color:var(--text);}
        .rc-email-body{flex:1; overflow-y:auto; padding:18px 20px; display:flex; flex-direction:column; gap:14px;}
        .rc-recipient{display:flex; align-items:center; gap:10px; background:#FAFAF9; border:1px solid var(--border); border-radius:12px; padding:10px 12px;}
        .rc-recipient-av{width:34px; height:34px; border-radius:10px; background:linear-gradient(135deg,var(--blue),#7C3AED); color:#fff; font-weight:800; font-size:12.5px; display:flex; align-items:center; justify-content:center; flex-shrink:0;}
        .rc-recipient b{display:block; font-size:12.5px; font-weight:800; color:var(--text);}
        .rc-recipient span{font-size:11px; color:var(--faint);}
        .rc-email-flabel{display:block; font-size:10.5px; font-weight:800; color:var(--faint); text-transform:uppercase; letter-spacing:.07em; margin-bottom:6px;}
        .rc-email-input{width:100%; border:1.5px solid var(--border); border-radius:11px; padding:11px 13px; font-size:13px; color:var(--text); outline:none;
          transition:border-color .18s ease, box-shadow .18s ease; background:#fff; font-family:inherit;}
        .rc-email-input:focus{border-color:var(--blue); box-shadow:0 0 0 4px rgba(37,99,235,.1);}
        .rc-email-body-input{resize:vertical; line-height:1.65; min-height:150px;}
        .rc-email-foot{display:flex; align-items:center; gap:10px; padding:15px 20px; border-top:1px solid var(--border); background:#FBFCFE;}
      `}</style>
    </div>
  );
};
