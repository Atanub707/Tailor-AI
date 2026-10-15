// WhatsApp outreach helpers — click-to-chat deep links with a pre-filled,
// globally editable message. Pure and deterministic where it matters:
// number normalization is fully tested; message storage degrades to the
// default whenever localStorage is unavailable.
//
// NOTE: WhatsApp deep links (wa.me) CANNOT attach files — no attachment
// parameter exists. The UI pairs the link with a one-click Master CV
// download so attaching in WhatsApp takes two taps.

/** The global default message — one generic message for every recruiter. */
export const DEFAULT_WA_MESSAGE =
  "Hi there! Hope you're doing well. I'm exploring remote DevSecOps opportunities and also help startups with SOC 2 & ISO 27001 compliance readiness, cloud security, and CI/CD security. If you're hiring or need these services, I'd be happy to connect. Thank you!";

const STORAGE_KEY = 'tailor.wa.message';

export function getWaMessage(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_WA_MESSAGE;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && stored.trim() ? stored : DEFAULT_WA_MESSAGE;
  } catch {
    return DEFAULT_WA_MESSAGE;
  }
}

export function setWaMessage(message: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const trimmed = String(message || '').trim();
    if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    /* best-effort */
  }
}

export function resetWaMessage(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

/** Normalize any displayed phone into wa.me digits:
 *  - strips spaces/dashes/parens/dots;
 *  - a leading '+' keeps the international form as-is;
 *  - otherwise leading trunk zeros are removed; a bare 10-digit national
 *    number gets the default country code (India by default). */
export function waNumber(phone: string, defaultCountry = '91'): string {
  let d = String(phone || '').trim();
  const hasPlus = d.startsWith('+');
  d = d.replace(/\D/g, '');
  if (!d) return '';
  if (!hasPlus) {
    d = d.replace(/^0+/, '');
    if (d.length === 10) d = defaultCountry + d;
  }
  return d;
}

/** The click-to-chat link: opens the user's OWN WhatsApp with the chat and
 *  the message pre-filled. Empty message → plain chat link. */
export function waLink(phone: string, message: string = getWaMessage()): string {
  const n = waNumber(phone);
  if (!n) return '';
  const text = String(message || '').trim();
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
