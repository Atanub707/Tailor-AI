import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HamburgerTrigger } from '../navigation';
import { X, Search, CheckCircle2, Copy, Trash2, Mail, ExternalLink, Linkedin, Loader2, Sparkles, Send, FileText, Upload, PencilLine, Clock, BadgeCheck, Plus, AlertTriangle, MessageCircle, UserPlus, Phone } from 'lucide-react';
import { filterByType, sortContacts, typeCounts, TYPE_LABELS } from '../lib/recruiters/filterUtils';
import { followupDue, followupDaysLeft } from '../lib/recruiters/followupUtils';
import { waLink, getWaMessage, setWaMessage, DEFAULT_WA_MESSAGE } from '../lib/recruiters/whatsapp';

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

const PAGE_SIZE = 24;

const PIPELINE: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'No status' },
  { value: 'replied', label: 'Replied' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
];

const fmtDay = (iso?: string | null): string => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; }
};

const fmtFull = (iso?: string | null): string => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; }
};

const isPersonish = (n: string): boolean => /^\p{Lu}[\p{L}'’-]*\s+\p{Lu}/u.test(n);

// Scraped context is sometimes raw HTML fragments or bare URLs — strip both
// before showing it as a quote, and hide the row when nothing meaningful remains.
const cleanContext = (s: string): string =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/g, ' ')
    .replace(/\b[\w-]+=["'][^"']*["']/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
  const [toast, setToast] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [waMessage, setWaMessageState] = useState<string>(DEFAULT_WA_MESSAGE);
  const [composeContact, setComposeContact] = useState<Contact | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [composeMsg, setComposeMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setWaMessageState(getWaMessage());
  }, []);
  const [attachMode, setAttachMode] = useState<'none' | 'master' | 'file'>('none');
  const [attachFile, setAttachFile] = useState<{ name: string; data: string } | null>(null);
  const [masterCvName, setMasterCvName] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [emailHistory, setEmailHistory] = useState<Record<string, SentEmail[]>>({});
  const [verifyMap, setVerifyMap] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

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

  // Manual email — same drawer, blank fields, no contact needed.
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

  const loadHistory = useCallback(async (c: Contact) => {
    try {
      const res = await fetch(`/api/contacts/${c.id}/emails`);
      const d = await res.json();
      setEmailHistory((h) => ({ ...h, [c.id]: d.emails || [] }));
    } catch { /* ignore */ }
  }, []);

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
      // Update the row status immediately.
      if (composeContact) {
        setContacts((prev) => prev.map((x) => x.id === composeContact.id
          ? { ...x, emailStatus: 'sent', lastEmailSent: new Date().toISOString() }
          : x));
        setEmailHistory((h) => { const n = { ...h }; delete n[composeContact.id]; return n; });
      }
      await load();
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
    if (hit) setSelectedId(hit.id);
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
    if (!value) return;
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

  const hideContact = async (id: string) => {
    const prev = contacts;
    setContacts((c) => c.filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
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
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const shown = visible.slice(pageStart, pageStart + PAGE_SIZE);
  const pageNums: Array<number | '…'> = (() => {
    const out: Array<number | '…'> = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 1) out.push(i);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  })();

  const selected = useMemo(() => contacts.find((c) => c.id === selectedId) || null, [contacts, selectedId]);
  const paneOpen = !!selected || composeOpen;

  useEffect(() => setPage(1), [typeFilter, company, q, pipelineFilter, sortBy]);

  useEffect(() => { rowsRef.current?.scrollTo({ top: 0 }); }, [currentPage]);

  // Auto-load email history for the selected record (feeds the Activity feed).
  useEffect(() => {
    if (selected && !emailHistory[selected.id]) loadHistory(selected);
  }, [selected, emailHistory, loadHistory]);

  // ⌘K focuses search, Esc closes the compose drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setComposeOpen((open) => { if (open) setComposeContact(null); return false; });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (focusedId) {
      const el = document.getElementById(`rc-row-${focusedId}`);
      el?.scrollIntoView({ block: 'center' });
    }
  }, [focusedId, visible.length]);

  // Proper designation for every contact — a real work function, never the
  // generic 'Company'/'Recruiter' placeholder. Derived from the person name
  // when present, otherwise from the email mailbox (careers@, jobs@, hr@…).
  const designationOf = (c: Contact): string => {
    if (c.name || c.recruiterName) return TYPE_LABELS[c.type] || c.typeLabel || 'Recruiter';
    const local = (c.email || '').split('@')[0].toLowerCase();
    if (/career/.test(local)) return 'Careers team';
    if (/(^|[._-])jobs?($|[._-])|hiring|apply|recruit(?!er)/.test(local)) return 'Hiring team';
    if (/recruit|talent|staffing|sourc/.test(local)) return 'Recruiting team';
    if (/(^|[._-])hr($|[._-])|people|humanresources/.test(local)) return 'HR / People team';
    if (/info|hello|contact|enquir|inquir|general|office/.test(local)) return 'General inquiries';
    return TYPE_LABELS[c.type] === 'Company' || !TYPE_LABELS[c.type] ? 'Hiring team' : (TYPE_LABELS[c.type] || c.typeLabel);
  };

  const displayName = (c: Contact): string => c.name || c.recruiterName || designationOf(c);

  const initialsOf = (c: Contact): string => {
    const n = displayName(c);
    if (isPersonish(n)) return n.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    if (c.company.includes(' ')) return c.company.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    return c.company.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  };

  const outreachBadge = (c: Contact) => {
    if (c.emailStatus === 'failed') {
      return (
        <span className="rc-status rc-st-bounce">
          <span className="rc-dot" />Failed{c.lastEmailSent ? <span className="rc-when">· {fmtDay(c.lastEmailSent)}</span> : null}
        </span>
      );
    }
    if (c.emailStatus === 'sent' && c.lastEmailSent) {
      return (
        <span className="rc-status rc-st-sent">
          <span className="rc-dot" />Sent <span className="rc-when">· {fmtDay(c.lastEmailSent)}</span>
        </span>
      );
    }
    return (
      <span className="rc-status rc-st-none">
        <span className="rc-dot" />Not contacted
      </span>
    );
  };

  const verifyPill = (v: string) => {
    if (v === 'valid') return <span className="rc-vpill ok">Valid</span>;
    if (v === 'invalid-format') return <span className="rc-vpill bad">Invalid</span>;
    if (v === 'no-mx') return <span className="rc-vpill warn">No MX</span>;
    return <span className="rc-vpill warn">Unknown</span>;
  };

  const activityFor = (c: Contact) => {
    const items: Array<{ kind: 'mail' | 'fail' | 'found'; title: string; sub: string; date: string }> = [];
    const hist = emailHistory[c.id] || [];
    hist.forEach((e) => items.push({
      kind: e.status === 'sent' ? 'mail' : 'fail',
      title: `You emailed ${e.recipient}`,
      sub: e.subject,
      date: fmtDay(e.sentAt),
    }));
    if (c.emailStatus === 'failed' && hist.length === 0) {
      items.push({ kind: 'fail', title: 'Delivery failed', sub: c.email ? `Mailbox rejected ${c.email}` : 'The address bounced', date: fmtDay(c.lastEmailSent) });
    }
    items.push({
      kind: 'found',
      title: 'Contact found',
      sub: c.jobCount > 1 ? `Seen in ${c.jobCount} job descriptions` : 'Extracted from the job description',
      date: fmtFull(c.firstSeen),
    });
    return items;
  };

  if (!isOpen) return null;

  return (
    <div className="rc-screen">
      {/* Header */}
      <header className="rc-hdr">
        <HamburgerTrigger />
        <div className="rc-ttl">
          <b>Recruiters</b>
          <span>Contact records pulled from the job descriptions you scrape</span>
        </div>
        <div className="rc-spacer" />
        {stats && (
          <div className="rc-summary">
            <span><b>{stats.total}</b> contacts</span>
            <span><b>{stats.withEmail}</b> with email</span>
            <span><b>{stats.withPhone}</b> with phone</span>
            <span><b>{stats.sent}</b> contacted</span>
          </div>
        )}
        <button className="rc-btn" onClick={openManualCompose} title="Compose a fresh email to any address — no contact needed">
          <Mail size={13} /> New email
        </button>
      </header>

      <div className="rc-main">
        <div className={`rc-workspace ${paneOpen ? "has-record" : ""}`}>
          {/* ═══ Directory list ═══ */}
          <section className="rc-list">
            <div className="rc-toolbar">
              <div className="rc-search">
                <Search size={14} />
                <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, or company" />
                <kbd>⌘K</kbd>
              </div>
              <div className="rc-seg">
                {['all', 'recruit', 'hr', 'careers', 'company'].map((t) => (
                  <button key={t} className={`rc-segbtn ${typeFilter === t ? 'on' : ''}`} onClick={() => setTypeFilter(t)}>
                    {t === 'all' ? 'All contacts' : TYPE_LABELS[t]}
                    <span>{t === 'all' ? contacts.length : typeCountsMap[t] || 0}</span>
                  </button>
                ))}
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
              <select className="rc-select" value={pipelineFilter} onChange={(e) => setPipelineFilter(e.target.value)}>
                <option value="">Pipeline: Any</option>
                {PIPELINE.filter((p) => p.value).map((p) => (
                  <option key={p.value} value={p.value!}>{p.label}</option>
                ))}
              </select>
            </div>

            <div className="rc-listhead">
              <span>Name</span><span>Company</span><span>Reach</span><span>Outreach</span>
            </div>

            <div className="rc-rows" ref={rowsRef}>
              {loading ? (
                <p className="rc-loading">Loading contacts…</p>
              ) : visible.length === 0 ? (
                <div className="rc-empty">
                  <div className="rc-empty-ico"><Mail size={22} /></div>
                  <b>{contacts.length === 0 ? 'No emails found yet' : 'No contacts match'}</b>
                  <p>{contacts.length === 0
                    ? 'Emails and phone numbers appear here automatically as jobs are scraped — HR, recruiting and company contacts found in descriptions.'
                    : 'Try a different search or clear the filters.'}</p>
                </div>
              ) : (
                <>
                  {shown.map((c) => (
                    <div
                      key={c.id}
                      id={`rc-row-${c.id}`}
                      className={`rc-row ${selectedId === c.id ? 'sel' : ''} ${focusedId === c.id ? 'focus' : ''}`}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <div className="rc-who">
                        <div className={`rc-ava ${isPersonish(displayName(c)) ? '' : 'gray'}`}>{initialsOf(c)}</div>
                        <div className="rc-whotxt">
                          <div className="rc-nm">
                            {displayName(c)}
                            {c.jobCount > 1 && <span className="rc-jobcount">{c.jobCount} jobs</span>}
                          </div>
                          <div className="rc-rl">
                            {(c.name || c.recruiterName)
                              ? [designationOf(c), c.jobRole].filter(Boolean).join(' · ')
                              : (c.jobRole || '')}
                          </div>
                        </div>
                      </div>
                      <div className="rc-co">{c.company}</div>
                      <div className="rc-reach" onClick={(e) => e.stopPropagation()}>
                        <button
                          className={`rc-ib in ${c.recruiterUrl ? '' : 'off'}`}
                          title={c.recruiterUrl ? 'Open LinkedIn profile' : 'No LinkedIn profile on file'}
                          aria-label="Open LinkedIn profile"
                          disabled={!c.recruiterUrl}
                          onClick={() => c.recruiterUrl && window.open(c.recruiterUrl, '_blank', 'noopener')}
                        >
                          <Linkedin size={13} />
                        </button>
                        <button
                          className={`rc-ib wa ${c.phone ? '' : 'off'}`}
                          title={c.phone ? 'WhatsApp chat (message pre-filled)' : 'No phone on file'}
                          aria-label="Open WhatsApp chat"
                          disabled={!c.phone}
                          onClick={() => c.phone && window.open(waLink(c.phone, waMessage), '_blank', 'noopener')}
                        >
                          <MessageCircle size={13} />
                        </button>
                        <button
                          className={`rc-ib mail ${c.email ? '' : 'off'}`}
                          title={c.email ? `Copy email — ${c.email}` : 'No email on file'}
                          aria-label="Copy email address"
                          disabled={!c.email}
                          onClick={() => c.email && copyValue(c.email)}
                        >
                          <Mail size={13} />
                        </button>
                        <button
                          className={`rc-ib tel ${c.phone ? '' : 'off'}`}
                          title={c.phone ? `Call ${c.phone}` : 'No phone on file'}
                          aria-label="Call contact"
                          disabled={!c.phone}
                          onClick={() => { if (c.phone) window.location.href = `tel:${c.phone.replace(/[^\d+]/g, '')}`; }}
                        >
                          <Phone size={13} />
                        </button>
                      </div>
                      <div>{outreachBadge(c)}</div>
                    </div>
                  ))}
                </>
              )}
            </div>
            {!loading && visible.length > 0 && (
              <div className="rc-pager">
                <span className="rc-pager-info">{pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, visible.length)} of {visible.length}</span>
                <span className="rc-spacer" />
                <button className="rc-pagebtn" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} aria-label="Previous page">‹</button>
                {pageNums.map((n, i) => n === '…'
                  ? <span key={`gap-${i}`} className="rc-pagedots">…</span>
                  : <button key={n} className={`rc-pagebtn ${n === currentPage ? 'on' : ''}`} onClick={() => setPage(n)}>{n}</button>)}
                <button className="rc-pagebtn" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} aria-label="Next page">›</button>
              </div>
            )}
          </section>

          {/* ═══ Record pane — hidden until a contact is picked ═══ */}
          {paneOpen && (
          <aside className="rc-record">
            {selected ? (
              <div className="rc-recbody">
                <div className="rc-rechead">
                  <div className="rc-bigava">{initialsOf(selected)}</div>
                  <div className="rc-rechtxt">
                    <div className="rc-recname">{displayName(selected)}</div>
                    <div className="rc-recmeta">{(selected.name || selected.recruiterName) ? `${designationOf(selected)} · ${selected.company}` : selected.company}</div>
                  </div>
                  <span className="rc-spacer" />
                  <button className="rc-pane-x" onClick={() => setSelectedId(null)} title="Close" aria-label="Close contact details">
                    <X size={15} />
                  </button>
                </div>

                <div className="rc-actions">
                  <button className="rc-btn primary" onClick={() => openCompose(selected)}>
                    <PencilLine size={13} /> Write email
                  </button>
                  <button className="rc-btn icon" title="Copy email or phone" onClick={() => copyEmail(selected)}>
                    {copiedId === selected.id ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                  </button>
                  {selected.email && (verifyMap[selected.id]
                    ? verifyPill(verifyMap[selected.id])
                    : (
                      <button className="rc-btn icon" title="Verify email (format + domain MX)" onClick={() => verifyEmail(selected)}>
                        <BadgeCheck size={15} />
                      </button>
                    ))}
                  {selected.sourceJobUrl && (
                    <a className="rc-btn icon" href={selected.sourceJobUrl} target="_blank" rel="noreferrer" title="Open job post">
                      <ExternalLink size={14} />
                    </a>
                  )}
                  {selected.phone && (
                    <a className="rc-btn icon rc-wa" href={waLink(selected.phone, waMessage)} target="_blank" rel="noreferrer" title={`Chat on WhatsApp (message pre-filled${selected.whatsapp ? '' : ' — number not marked WhatsApp in the posting'})`}>
                      <MessageCircle size={14} />
                    </a>
                  )}
                  {selected.phone && (
                    <button
                      className="rc-btn icon"
                      title="Edit the global WhatsApp message"
                      onClick={() => {
                        const next = window.prompt('WhatsApp message (global — used for every contact):', waMessage || DEFAULT_WA_MESSAGE);
                        if (next !== null && next.trim()) {
                          setWaMessage(next);
                          setWaMessageState(next.trim());
                        }
                      }}
                    >
                      <PencilLine size={14} />
                    </button>
                  )}
                  {selected.phone && (
                    <a
                      className="rc-btn icon"
                      href="/api/cv/master/download?format=pdf"
                      title="Download Master CV — attach it in the WhatsApp chat (deep links cannot attach files)"
                    >
                      <FileText size={14} />
                    </a>
                  )}
                  <span className="rc-spacer" />
                  <button className="rc-btn icon rc-danger" title="Dismiss contact" onClick={() => hideContact(selected.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>

                <div className="rc-reachrow">
                  {selected.recruiterUrl ? (
                    <a className="rc-rbtn" href={selected.recruiterUrl} target="_blank" rel="noreferrer" aria-label="Open LinkedIn profile">
                      <span className="ico in"><Linkedin size={15} /></span> LinkedIn
                    </a>
                  ) : (
                    <button className="rc-rbtn off" disabled aria-label="No LinkedIn profile"><span className="ico in"><Linkedin size={15} /></span> LinkedIn</button>
                  )}
                  {selected.phone ? (
                    <a className="rc-rbtn" href={waLink(selected.phone, waMessage)} target="_blank" rel="noreferrer" aria-label="Open WhatsApp chat">
                      <span className="ico wa"><MessageCircle size={15} /></span> WhatsApp
                    </a>
                  ) : (
                    <button className="rc-rbtn off" disabled aria-label="No phone on file"><span className="ico wa"><MessageCircle size={15} /></span> WhatsApp</button>
                  )}
                  {selected.email ? (
                    <button className="rc-rbtn" onClick={() => copyValue(selected.email!)} aria-label="Copy email address" title={selected.email}>
                      <span className="ico mail"><Mail size={15} /></span> Email
                    </button>
                  ) : (
                    <button className="rc-rbtn off" disabled aria-label="No email on file"><span className="ico mail"><Mail size={15} /></span> Email</button>
                  )}
                  {selected.phone ? (
                    <a className="rc-rbtn" href={`tel:${selected.phone.replace(/[^\d+]/g, '')}`} aria-label="Call contact">
                      <span className="ico tel"><Phone size={15} /></span> Phone
                    </a>
                  ) : (
                    <button className="rc-rbtn off" disabled aria-label="No phone on file"><span className="ico tel"><Phone size={15} /></span> Phone</button>
                  )}
                </div>

                <div className="rc-sect">Details</div>
                <div className="rc-props">
                  <div className="rc-prop"><div className="rc-k">Company</div><div className="rc-v">{selected.company}</div></div>
                  <div className="rc-prop"><div className="rc-k">Designation</div><div className="rc-v">{designationOf(selected)}</div></div>
                  <div className="rc-prop">
                    <div className="rc-k">Source</div>
                    <div className="rc-v">
                      {selected.jobRole || <span className="rc-none">—</span>}
                      {selected.sourceJobUrl && (
                        <a className="rc-src" href={selected.sourceJobUrl} target="_blank" rel="noreferrer">Open <ExternalLink size={11} /></a>
                      )}
                    </div>
                  </div>
                  <div className="rc-prop"><div className="rc-k">Added</div><div className="rc-v">{fmtFull(selected.firstSeen) || <span className="rc-none">—</span>}</div></div>
                  <div className="rc-prop"><div className="rc-k">Outreach</div><div className="rc-v">{outreachBadge(selected)}</div></div>
                  {(selected.followUpAt || selected.followedUp) && (
                    <div className="rc-prop">
                      <div className="rc-k">Follow-up</div>
                      <div className="rc-v rc-fu">
                        {selected.followUpAt && !selected.followedUp && (followupDue(selected.followUpAt, false)
                          ? <span className="rc-fuchip overdue"><AlertTriangle size={10} /> Due</span>
                          : <span className="rc-fuchip"><Clock size={10} /> in {followupDaysLeft(selected.followUpAt)}d</span>)}
                        {selected.followedUp && <span className="rc-fuchip done"><CheckCircle2 size={10} /> Followed up</span>}
                        {selected.followUpAt && !selected.followedUp && (
                          <button className="rc-fubtn" onClick={() => markFollowedUp(selected)}>Mark done</button>
                        )}
                        <button className="rc-fubtn" onClick={() => setFollowUp(selected, 0)}>Clear</button>
                      </div>
                    </div>
                  )}
                  <div className="rc-prop">
                    <div className="rc-k">Notes</div>
                    <div className="rc-v">
                      {editingNoteId === selected.id ? (
                        <div className="rc-noteedit">
                          <textarea
                            rows={3}
                            value={noteDrafts[selected.id] ?? selected.notes ?? ''}
                            onChange={(e) => setNoteDrafts((d) => ({ ...d, [selected.id]: e.target.value }))}
                            placeholder="Add a note…"
                          />
                          <div className="rc-noteacts">
                            <button className="rc-btn rc-small primary" onClick={() => saveNote(selected)}>Save</button>
                            <button className="rc-btn rc-small" onClick={() => setEditingNoteId(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : selected.notes ? (
                        <span className="rc-notetxt">
                          {selected.notes}
                          <button className="rc-copy" title="Edit note" onClick={() => setEditingNoteId(selected.id)}><PencilLine size={12} /></button>
                        </span>
                      ) : (
                        <button className="rc-noteadd" onClick={() => setEditingNoteId(selected.id)}><Plus size={11} /> Add note</button>
                      )}
                    </div>
                  </div>
                  {cleanContext(selected.context).length > 16 && (
                    <div className="rc-prop">
                      <div className="rc-k">Context</div>
                      <div className="rc-v rc-ctx">“{cleanContext(selected.context)}”</div>
                    </div>
                  )}
                </div>

                <div className="rc-sect">Activity</div>
                <div className="rc-timeline">
                  {activityFor(selected).map((a, i) => (
                    <div className="rc-tl-item" key={i}>
                      <div className={`rc-tl-ico ${i === 0 ? 'on' : ''}`}>
                        {a.kind === 'mail' ? <Mail size={12} /> : a.kind === 'fail' ? <AlertTriangle size={12} /> : <UserPlus size={12} />}
                      </div>
                      <div className="rc-tl-body">
                        <div className="rc-tl-title">{a.title}</div>
                        <div className="rc-tl-sub">{a.sub}</div>
                      </div>
                      <div className="rc-tl-date">{a.date}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ═══ Compose drawer (fills the record pane, as designed) ═══ */}
            <div className={`rc-drawer ${composeOpen ? 'open' : ''}`} aria-hidden={!composeOpen}>
              <div className="rc-drawer-head">
                <h3>{composeContact ? `Email — ${displayName(composeContact)}` : 'New email'}</h3>
                <button className="rc-drawer-x" onClick={closeCompose} disabled={draftBusy || sendBusy} aria-label="Close">
                  <X size={16} />
                </button>
              </div>
              <div className="rc-drawer-body">
                {composeContact && (
                  <div className="rc-recipient">
                    <div className="rc-recipient-av">{initialsOf(composeContact)}</div>
                    <div>
                      <b>{displayName(composeContact)}</b>
                      <span>{composeContact.email}{composeContact.company ? ` · ${composeContact.company}` : ''}</span>
                    </div>
                  </div>
                )}

                <div className="rc-field">
                  <label>To</label>
                  <input type="text" value={composeTo} onChange={(e) => setComposeTo(e.target.value)} />
                </div>
                <div className="rc-field">
                  <label>Subject</label>
                  <input type="text" value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)} />
                </div>
                <div className="rc-field">
                  <label>Message</label>
                  <textarea
                    rows={9}
                    value={composeBody}
                    onChange={(e) => setComposeBody(e.target.value)}
                    placeholder="Type your message… or click Draft with AI"
                  />
                </div>
                <div className="rc-field">
                  <label>Attach CV</label>
                  <div className="rc-attach">
                    <button
                      type="button"
                      onClick={() => { setAttachMode(attachMode === 'master' ? 'none' : 'master'); setAttachFile(null); setComposeMsg(null); }}
                      className={`rc-btn rc-small ${attachMode === 'master' ? 'on' : ''}`}
                    >
                      <FileText size={13} /> Master CV
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className={`rc-btn rc-small ${attachMode === 'file' ? 'on' : ''}`}
                    >
                      <Upload size={13} /> From file manager
                    </button>
                    <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.txt,.png,.jpg" style={{ display: 'none' }} onChange={pickAttachmentFile} />
                    {attachMode === 'master' && (
                      <span className="rc-attachchip">
                        <FileText size={12} /> <span className="rc-truncate">{masterCvName || 'Master CV'}</span>
                        <button type="button" onClick={() => setAttachMode('none')} aria-label="Remove attachment"><X size={12} /></button>
                      </span>
                    )}
                    {attachMode === 'file' && attachFile && (
                      <span className="rc-attachchip">
                        <FileText size={12} /> <span className="rc-truncate">{attachFile.name}</span>
                        <button type="button" onClick={() => { setAttachFile(null); setAttachMode('none'); }} aria-label="Remove attachment"><X size={12} /></button>
                      </span>
                    )}
                  </div>
                </div>

                {composeMsg && <p className={`rc-msg ${composeMsg.ok ? 'ok' : 'bad'}`}>{composeMsg.text}</p>}
              </div>
              <div className="rc-drawer-foot">
                <button className="rc-btn rc-draft" onClick={draftEmail} disabled={draftBusy || sendBusy}>
                  {draftBusy ? <Loader2 className="rc-spin" size={13} /> : <Sparkles size={13} />} Draft with AI
                </button>
                <span className="rc-spacer" />
                <button className="rc-btn" onClick={closeCompose} disabled={draftBusy || sendBusy}>Cancel</button>
                <button
                  className="rc-btn primary"
                  onClick={sendEmail}
                  disabled={sendBusy || draftBusy || !composeTo.trim() || !composeSubject.trim() || !composeBody.trim()}
                >
                  {sendBusy ? <Loader2 className="rc-spin" size={13} /> : <Send size={13} />} Send
                </button>
              </div>
            </div>
          </aside>
          )}

        </div>
      </div>

      {toast && (
        <div className="rc-toast">
          <CheckCircle2 size={14} /> {toast}
        </div>
      )}

      <style>{`
        .rc-screen {
          position: relative; height: 100vh; background: var(--color-canvas); color: var(--color-ink);
          display: flex; flex-direction: column;
          font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          -webkit-font-smoothing: antialiased;
          --rc-brand: var(--color-brand); --rc-brand-strong: var(--color-brand-strong); --rc-brand-soft: var(--color-brand-soft);
          --rc-line: var(--color-hairline); --rc-line2: var(--color-hairline2);
          --rc-muted: var(--color-muted); --rc-faint: var(--color-faint);
          --rc-surface: #fff; --rc-canvas: var(--color-canvas);
        }
        .rc-spacer { flex: 1; }
        .rc-hdr { display: flex; align-items: center; gap: 14px; padding: 0 24px; height: 60px; border-bottom: 1px solid var(--rc-line); background: var(--rc-surface); flex-shrink: 0; }
        .rc-ttl b { font-size: 15px; font-weight: 700; display: block; line-height: 1.2; }
        .rc-ttl span { font-size: 11px; color: var(--rc-faint); font-weight: 500; }
        .rc-summary { display: flex; gap: 14px; align-items: center; font-size: 12.5px; color: var(--rc-faint); }
        .rc-summary b { color: var(--color-ink); font-weight: 700; }
        .rc-main { flex: 1; min-height: 0; width: 100%; max-width: 1440px; margin: 0 auto; padding: 20px 24px 22px; display: flex; flex-direction: column; }
        .rc-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); background: var(--rc-surface); border: 1px solid var(--rc-line); border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
.rc-workspace.has-record { grid-template-columns: minmax(0, 1fr) 408px; }
        /* toolbar */
        .rc-toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--rc-line); flex-wrap: wrap; }
        .rc-search { flex: 1; min-width: 170px; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; background: var(--rc-canvas); border: 1px solid var(--rc-line); border-radius: 8px; color: var(--rc-faint); }
        .rc-search:focus-within { border-color: var(--rc-brand); box-shadow: 0 0 0 3px rgba(37, 99, 235, .09); }
        .rc-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--color-ink); font-size: 13px; font-family: inherit; }
        .rc-search input::placeholder { color: var(--rc-faint); }
        .rc-search kbd { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 10.5px; color: var(--rc-faint); border: 1px solid var(--rc-line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 5px; background: var(--rc-surface); }
        .rc-seg { display: inline-flex; border: 1px solid var(--rc-line); border-radius: 8px; overflow: hidden; flex-shrink: 0; }
        .rc-segbtn { display: inline-flex; align-items: center; border: 0; background: var(--rc-surface); padding: 0 12px; height: 34px; font-size: 12.5px; font-weight: 600; color: var(--rc-muted); border-right: 1px solid var(--rc-line); cursor: pointer; font-family: inherit; }
        .rc-segbtn:last-child { border-right: 0; }
        .rc-segbtn.on { background: var(--rc-brand-soft); color: var(--rc-brand-strong); }
        .rc-segbtn span { color: var(--rc-faint); font-weight: 500; margin-left: 5px; font-size: 11.5px; }
        .rc-segbtn.on span { color: var(--rc-brand); }
        .rc-select { height: 34px; border: 1px solid var(--rc-line); border-radius: 8px; background: var(--rc-surface); color: var(--rc-muted); font-size: 12.5px; font-weight: 600; font-family: inherit; padding: 0 8px; outline: none; cursor: pointer; max-width: 150px; }
        .rc-select:focus { border-color: var(--rc-brand); }
        /* list */
        .rc-list { min-width: 0; display: flex; flex-direction: column; }
        .rc-listhead { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr) 168px 104px; gap: 12px; padding: 9px 16px 9px 18px; border-bottom: 1px solid var(--rc-line); font-size: 10.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--rc-faint); }
        .rc-rows { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
        .rc-loading { padding: 26px 18px; color: var(--rc-faint); font-size: 13px; }
        .rc-row { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr) 168px 104px; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--rc-line); cursor: pointer; position: relative; }
        .rc-row:hover { background: #F8FAFC; }
        .rc-row.sel { background: var(--rc-brand-soft); }
        .rc-row.sel::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--rc-brand); }

        /* ── icon-first reach (LinkedIn / WhatsApp / Email / Phone) ── */
        .rc-reach { display: flex; align-items: center; gap: 6px; }
        .rc-ib { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--rc-line); background: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--rc-muted); padding: 0; transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; }
        .rc-ib:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(15, 23, 42, .10); border-color: #CBD5E1; }
        .rc-ib:focus-visible { outline: 2px solid var(--rc-brand); outline-offset: 2px; }
        .rc-ib.in { background: #0A66C2; border-color: #0A66C2; color: #fff; }
        .rc-ib.wa { background: #25D366; border-color: #25D366; color: #fff; }
        .rc-ib.mail { color: var(--rc-brand); }
        .rc-ib.tel { color: #0F766E; }
        .rc-ib.off { opacity: .34; cursor: default; filter: grayscale(1); }
        .rc-ib.off:hover { transform: none; box-shadow: none; border-color: var(--rc-line); }

        .rc-reachrow { display: flex; gap: 8px; margin: 12px 0 2px; }
        .rc-rbtn { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 6px; border-radius: 10px; border: 1px solid var(--rc-line); background: #fff; cursor: pointer; color: var(--rc-muted); text-decoration: none; font-family: inherit; font-size: 10.5px; font-weight: 650; transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; }
        .rc-rbtn:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(15, 23, 42, .07); border-color: #CBD5E1; }
        .rc-rbtn:focus-visible { outline: 2px solid var(--rc-brand); outline-offset: 2px; }
        .rc-rbtn .ico { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
        .rc-rbtn .ico.in { background: #0A66C2; color: #fff; }
        .rc-rbtn .ico.wa { background: #25D366; color: #fff; }
        .rc-rbtn .ico.mail { background: var(--rc-brand-soft); color: var(--rc-brand); }
        .rc-rbtn .ico.tel { background: #ECFDF5; color: #0F766E; }
        .rc-rbtn.off { opacity: .4; cursor: default; }
        .rc-rbtn.off:hover { border-color: var(--rc-line); box-shadow: none; transform: none; }


        .rc-row.focus { box-shadow: inset 0 0 0 1px var(--rc-brand); }
        .rc-who { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .rc-ava { width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; letter-spacing: .02em; background: var(--rc-brand-soft); color: var(--rc-brand-strong); }
        .rc-ava.gray { background: #F1F5F9; color: var(--rc-muted); }
        .rc-whotxt { min-width: 0; }
        .rc-nm { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
        .rc-jobcount { font-size: 10px; font-weight: 700; color: var(--rc-faint); background: var(--rc-canvas); border: 1px solid var(--rc-line); border-radius: 20px; padding: 1px 6px; flex-shrink: 0; }
        .rc-rl { font-size: 12px; color: var(--rc-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rc-co { font-size: 12.5px; color: var(--rc-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rc-mail, .rc-phone { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-ink); }
        .rc-phone a, .rc-prop a.rc-mono { color: inherit; text-decoration: none; }
        .rc-phone a:hover, .rc-prop a.rc-mono:hover { color: var(--rc-brand); text-decoration: underline; }
        .rc-phone { color: var(--rc-muted); }
        .rc-mail:hover, .rc-phone:hover { color: var(--rc-brand-strong); }
        .rc-dash { color: var(--rc-line2); }
        .rc-status { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; white-space: nowrap; }
        .rc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .rc-st-sent { color: #047857; } .rc-st-sent .rc-dot { background: #10B981; }
        .rc-st-none { color: var(--rc-faint); font-weight: 500; } .rc-st-none .rc-dot { background: var(--rc-line2); }
        .rc-st-bounce { color: var(--color-danger); } .rc-st-bounce .rc-dot { background: var(--color-danger); }
        .rc-when { color: var(--rc-faint); font-weight: 500; margin-left: 2px; }
        .rc-pager { display: flex; align-items: center; gap: 6px; padding: 10px 16px; border-top: 1px solid var(--rc-line); flex-shrink: 0; }
        .rc-pager-info { font-size: 12px; color: var(--rc-faint); }
        .rc-pagebtn { min-width: 30px; height: 30px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--rc-line); background: var(--rc-surface); color: var(--rc-muted); font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; }
        .rc-pagebtn:hover:not(:disabled) { border-color: var(--rc-brand); color: var(--rc-brand-strong); }
        .rc-pagebtn:disabled { opacity: .45; cursor: not-allowed; }
        .rc-pagebtn.on { background: var(--rc-brand); border-color: var(--rc-brand); color: #fff; }
        .rc-pagedots { color: var(--rc-faint); font-size: 12.5px; padding: 0 2px; }
        .rc-pane-x { border: 0; background: none; color: var(--rc-faint); cursor: pointer; padding: 5px; border-radius: 8px; display: inline-flex; flex-shrink: 0; }
        .rc-pane-x:hover { color: var(--color-ink); background: var(--rc-canvas); }
        .rc-empty { text-align: center; padding: 60px 20px; }
        .rc-empty-ico { width: 52px; height: 52px; border-radius: 14px; background: var(--rc-brand-soft); border: 1px solid var(--color-brand-line); color: var(--rc-brand); display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; }
        .rc-empty b { font-size: 14px; }
        .rc-empty p { font-size: 12.5px; color: var(--rc-muted); margin-top: 5px; line-height: 1.6; max-width: 380px; margin-left: auto; margin-right: auto; }
        /* record */
        .rc-record { border-left: 1px solid var(--rc-line); display: flex; flex-direction: column; min-width: 0; position: relative; background: var(--rc-surface); }
        .rc-recbody { padding: 22px 22px 26px; overflow-y: auto; flex: 1; }
        .rc-rechead { display: flex; gap: 14px; align-items: center; }
        .rc-bigava { width: 46px; height: 46px; border-radius: 12px; flex-shrink: 0; background: var(--rc-brand-soft); color: var(--rc-brand-strong); display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; }
        .rc-rechtxt { min-width: 0; }
        .rc-recname { font-size: 16.5px; font-weight: 700; letter-spacing: -.01em; }
        .rc-recmeta { font-size: 12.5px; color: var(--rc-faint); margin-top: 2px; }
        .rc-actions { display: flex; gap: 8px; margin: 16px 0 4px; align-items: center; flex-wrap: wrap; }
        .rc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--rc-line); background: var(--rc-surface); color: var(--color-ink); font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; text-decoration: none; transition: background .15s ease, border-color .15s ease; }
        .rc-btn:hover { background: var(--rc-canvas); }
        .rc-btn:disabled { opacity: .5; cursor: not-allowed; }
        .rc-btn.primary { background: var(--rc-brand); border-color: var(--rc-brand); color: #fff; }
        .rc-btn.primary:hover { background: var(--rc-brand-strong); }
        .rc-btn.icon { width: 34px; padding: 0; color: var(--rc-muted); }
        .rc-btn.icon:hover { color: var(--color-ink); }
        .rc-btn.rc-wa:hover { color: #25D366; border-color: #25D366; }
        .rc-btn.rc-danger:hover { color: var(--color-danger); border-color: var(--color-danger); }
        .rc-btn.rc-small { height: 30px; padding: 0 12px; font-size: 12px; }
        .rc-btn.on { background: var(--rc-brand); border-color: var(--rc-brand); color: #fff; }
        .rc-vpill { display: inline-flex; align-items: center; font-size: 11.5px; font-weight: 700; padding: 4px 10px; border-radius: 8px; }
        .rc-vpill.ok { background: #ECFDF5; color: #047857; border: 1px solid #A7F3D0; }
        .rc-vpill.bad { background: var(--color-danger-soft); color: var(--color-danger); border: 1px solid #FECACA; }
        .rc-vpill.warn { background: #FFFBEB; color: #92400E; border: 1px solid #FDE68A; }
        .rc-sect { margin-top: 22px; font-size: 10.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--rc-faint); padding-bottom: 8px; border-bottom: 1px solid var(--rc-line); }
        .rc-props { display: flex; flex-direction: column; }
        .rc-prop { display: flex; align-items: flex-start; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--rc-line); font-size: 13px; }
        .rc-k { width: 88px; flex-shrink: 0; font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--rc-faint); padding-top: 2px; }
        .rc-v { flex: 1; min-width: 0; color: var(--color-ink); }
        .rc-v a { color: var(--rc-brand-strong); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; word-break: break-all; }
        .rc-v a:hover { text-decoration: underline; }
        .rc-mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12.5px; }
        .rc-none { color: var(--rc-line2); }
        .rc-copy { border: 0; background: none; color: var(--rc-faint); padding: 0 2px; cursor: pointer; vertical-align: middle; }
        .rc-copy:hover { color: var(--rc-brand); }
        .rc-src { margin-left: 8px; font-size: 12px; font-weight: 600; }
        .rc-ctx { font-style: italic; color: var(--rc-muted); font-size: 12.5px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .rc-fu { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .rc-fuchip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; background: #FFFBEB; color: #92400E; border: 1px solid #FDE68A; }
        .rc-fuchip.overdue { background: var(--color-danger-soft); color: var(--color-danger); border-color: #FECACA; }
        .rc-fuchip.done { background: var(--color-cta-soft); color: #047857; border-color: var(--color-cta-line); }
        .rc-fubtn { font-size: 11px; font-weight: 700; border: 1px solid var(--rc-line); background: var(--rc-surface); color: var(--rc-muted); border-radius: 6px; padding: 3px 8px; cursor: pointer; font-family: inherit; }
        .rc-fubtn:hover { border-color: var(--rc-brand); color: var(--rc-brand-strong); }
        .rc-notetxt { display: flex; align-items: flex-start; gap: 6px; line-height: 1.55; }
        .rc-noteadd { display: inline-flex; align-items: center; gap: 5px; border: 1px dashed var(--rc-line2); background: none; color: var(--rc-faint); font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 8px; cursor: pointer; font-family: inherit; }
        .rc-noteadd:hover { color: var(--rc-brand); border-color: var(--rc-brand); }
        .rc-noteedit { display: flex; flex-direction: column; gap: 8px; }
        .rc-noteedit textarea { width: 100%; border: 1px solid var(--rc-line); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; font-family: inherit; color: var(--color-ink); outline: none; resize: vertical; }
        .rc-noteedit textarea:focus { border-color: var(--rc-brand); box-shadow: 0 0 0 3px rgba(37, 99, 235, .09); }
        .rc-noteacts { display: flex; gap: 8px; }
        /* timeline */
        .rc-timeline { padding-top: 4px; }
        .rc-tl-item { display: flex; gap: 12px; padding: 10px 0; }
        .rc-tl-ico { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; border: 1px solid var(--rc-line); background: var(--rc-surface); display: flex; align-items: center; justify-content: center; color: var(--rc-faint); }
        .rc-tl-ico.on { background: var(--rc-brand-soft); border-color: var(--color-brand-line); color: var(--rc-brand-strong); }
        .rc-tl-body { flex: 1; min-width: 0; }
        .rc-tl-title { font-size: 13px; font-weight: 600; }
        .rc-tl-sub { font-size: 12px; color: var(--rc-faint); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        .rc-tl-date { font-size: 11.5px; color: var(--rc-faint); white-space: nowrap; font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
        /* record empty */
        /* drawer */
        .rc-drawer { position: absolute; inset: 0; background: var(--rc-surface); z-index: 5; display: none; flex-direction: column; }
        .rc-drawer.open { display: flex; }
        .rc-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--rc-line); }
        .rc-drawer-head h3 { font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rc-drawer-x { border: 0; background: none; color: var(--rc-faint); cursor: pointer; padding: 2px 6px; border-radius: 6px; }
        .rc-drawer-x:hover { color: var(--color-ink); background: var(--rc-canvas); }
        .rc-drawer-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; flex: 1; }
        .rc-field label { display: block; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--rc-faint); margin-bottom: 6px; }
        .rc-field input[type=text], .rc-field textarea { width: 100%; border: 1px solid var(--rc-line); border-radius: 8px; padding: 9px 11px; font-size: 13px; color: var(--color-ink); background: var(--rc-surface); outline: none; font-family: inherit; }
        .rc-field input:focus, .rc-field textarea:focus { border-color: var(--rc-brand); box-shadow: 0 0 0 3px rgba(37, 99, 235, .09); }
        .rc-field textarea { min-height: 170px; resize: vertical; line-height: 1.6; }
        .rc-recipient { display: flex; align-items: center; gap: 10px; background: var(--rc-canvas); border: 1px solid var(--rc-line); border-radius: 10px; padding: 10px 12px; }
        .rc-recipient-av { width: 34px; height: 34px; border-radius: 10px; background: var(--rc-brand-soft); color: var(--rc-brand-strong); font-weight: 700; font-size: 12.5px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .rc-recipient b { display: block; font-size: 12.5px; font-weight: 700; color: var(--color-ink); }
        .rc-recipient span { font-size: 11px; color: var(--rc-faint); font-family: ui-monospace, 'SF Mono', Menlo, monospace; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
        .rc-attach { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .rc-attachchip { display: inline-flex; align-items: center; gap: 6px; background: var(--rc-brand-soft); border: 1px solid var(--color-brand-line); color: var(--rc-brand-strong); border-radius: 8px; padding: 5px 9px; font-size: 11.5px; font-weight: 600; max-width: 100%; }
        .rc-attachchip button { border: 0; background: none; color: var(--rc-brand); cursor: pointer; display: inline-flex; padding: 0; }
        .rc-attachchip button:hover { color: var(--color-danger); }
        .rc-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
        .rc-msg { font-size: 12px; font-weight: 600; }
        .rc-msg.ok { color: #047857; } .rc-msg.bad { color: var(--color-danger); }
        .rc-drawer-foot { border-top: 1px solid var(--rc-line); padding: 12px 18px; display: flex; align-items: center; gap: 8px; }
        .rc-draft { color: var(--rc-brand-strong); background: var(--rc-brand-soft); border-color: var(--color-brand-line); }
        .rc-draft:hover { background: #DBEAFE; }
        .rc-spin { animation: rc-spin 1s linear infinite; }
        @keyframes rc-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
        /* toast */
        .rc-toast { position: fixed; bottom: 74px; left: 50%; transform: translateX(-50%); background: var(--color-ink); color: #fff; font-size: 12.5px; font-weight: 600; padding: 9px 16px; border-radius: 8px; display: flex; align-items: center; gap: 8px; box-shadow: 0 10px 30px rgba(0, 0, 0, .25); z-index: 70; }
        @media (max-width: 1080px) {
          .rc-workspace, .rc-workspace.has-record { grid-template-columns: 1fr; }
          .rc-record { border-left: 0; border-top: 1px solid var(--rc-line); }
        }
      `}</style>
    </div>
  );
};
