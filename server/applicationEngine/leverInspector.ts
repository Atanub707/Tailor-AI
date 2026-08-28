// Lever Inspection Adapter — READ-ONLY.
// GET-only public application-page inspection → normalized requirements.
// Hard boundaries: URL allowlist, SSRF defense (DNS + private-IP), redirect
// validation, timeout, size cap, content-type check. NO mutations.

import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ApplicationField, ApplicationRequirements, ApplicationTarget, DetectionResult, Provider } from './contract.js';
import {
  classifyTarget, detectProvider, normalizeFieldLabel, requirementsFingerprint,
  type FieldCategory, type FieldType,
} from './contract.js';
import type { ApplicationInspectionAdapter } from './fixtureAdapter.js';

export const LEVER_INSPECTOR_VERSION = 'lever-inspector-v1';
export const LEVER_ALLOWED_HOSTS = ['jobs.lever.co'];

export class InspectionFailure extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
    this.name = 'InspectionFailure';
  }
}

// ── Network safety ───────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] >= 224) return true; // multicast/reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.replace('::ffff:', ''));
    return false;
  }
  return true;
}

/** SSRF defense: hostname allowlist + DNS resolution + private-IP rejection. */
async function assertSafeHost(url: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new InspectionFailure('INVALID_TARGET', 'Lever inspection requires HTTPS.');
  const host = u.hostname.toLowerCase();
  if (!LEVER_ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    throw new InspectionFailure('UNSUPPORTED_TARGET', `Host ${host} not allowed for Lever inspection.`);
  }
  const addresses = await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new InspectionFailure('PROVIDER_UNAVAILABLE', 'DNS resolution failed.');
  for (const a of addresses) {
    if (isPrivateIp(a.address)) throw new InspectionFailure('BLOCKED_PRIVATE_IP', `Resolved address ${a.address} is private/loopback.`);
  }
  return u.toString();
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // conservative upper bound
const INSPECTION_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

/** GET-only client — structurally rejects any mutating method. */
export async function httpGetOnly(url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<{ finalUrl: string; contentType: string; html: string }> {
  let current = await assertSafeHost(url);
  const timeoutMs = opts.timeoutMs ?? INSPECTION_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'TailorAI-ApplicationEngine/1.0 (read-only inspection)' },
      });
    } catch (err: any) {
      throw new InspectionFailure('INSPECTION_TIMEOUT', err?.name === 'AbortError' ? 'Inspection timed out.' : `Network failure: ${String(err?.message || err).slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new InspectionFailure('FORM_CHANGED', 'Redirect without location.');
      current = await assertSafeHost(new URL(loc, current).toString()); // validate EVERY hop
      continue;
    }
    if (res.status === 404) throw new InspectionFailure('TARGET_NOT_FOUND', 'Application page not found (404).');
    if (res.status === 403) throw new InspectionFailure('PROVIDER_BLOCKED', 'Provider blocked the request (403).');
    if (res.status === 429) throw new InspectionFailure('RATE_LIMITED', 'Provider rate-limited (429).');
    if (res.status >= 500) throw new InspectionFailure('PROVIDER_UNAVAILABLE', `Provider error (${res.status}).`);
    if (!res.ok) throw new InspectionFailure('FORM_CHANGED', `Unexpected status ${res.status}.`);
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) throw new InspectionFailure('FORM_CHANGED', `Unexpected content type: ${contentType}`);
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new InspectionFailure('FORM_CHANGED', 'Response exceeds size limit.');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new InspectionFailure('FORM_CHANGED', 'Response exceeds size limit.');
    return { finalUrl: current, contentType, html: Buffer.from(buf).toString('utf8') };
  }
  throw new InspectionFailure('FORM_CHANGED', 'Too many redirects.');
}

// ── Classification ───────────────────────────────────────────────────────

const EEO_RE = /(gender|race|ethnicity|veteran|disability|sexual orientation|demographic)/i;
const CONSENT_RE = /(privacy|terms of use|terms and conditions|consent|data processing|background check|candidate agreement|acknowledg|declare)/i;
const AUTH_RE = /(authorized to work|work authorization|work eligibility|right to work|work permit|visa status)/i;
const SPONSOR_RE = /(sponsorship|sponsor)/i;
const COMP_RE = /(salary|compensation|expected pay|desired salary)/i;

function classifyCategory(label: string): FieldCategory {
  if (EEO_RE.test(label)) return 'EEO';
  if (CONSENT_RE.test(label)) return 'CONSENT';
  if (AUTH_RE.test(label)) return 'WORK_AUTHORIZATION';
  if (SPONSOR_RE.test(label)) return 'SPONSORSHIP';
  if (COMP_RE.test(label)) return 'COMPENSATION';
  return 'CUSTOM';
}

function fieldTypeFrom(htmlType: string | undefined, name: string): FieldType {
  const t = String(htmlType || '').toLowerCase();
  if (t === 'file') return 'FILE';
  if (t === 'checkbox') return name === 'consent' ? 'CONSENT' : 'MULTI_SELECT';
  if (t === 'radio') return 'SINGLE_SELECT';
  if (t === 'email') return 'EMAIL';
  if (t === 'tel') return 'PHONE';
  if (t === 'number') return 'NUMBER';
  if (t === 'date') return 'DATE';
  if (t === 'url') return 'URL';
  if (name.startsWith('urls[')) return 'URL';
  return 'TEXT';
}

function cleanLabel(s: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ── Parser ───────────────────────────────────────────────────────────────

const STANDARD_FIELDS: Array<{ name: string; label: string; canonical: string }> = [
  { name: 'name', label: 'Name', canonical: 'fullName' },
  { name: 'email', label: 'Email', canonical: 'email' },
  { name: 'phone', label: 'Phone', canonical: 'phone' },
  { name: 'location', label: 'Location', canonical: 'currentCity' },
  { name: 'urls[LinkedIn]', label: 'LinkedIn URL', canonical: 'linkedinUrl' },
  { name: 'urls[GitHub]', label: 'GitHub URL', canonical: 'githubUrl' },
  { name: 'urls[Portfolio]', label: 'Portfolio URL', canonical: 'portfolioUrl' },
  { name: 'urls[Other]', label: 'Website URL', canonical: 'websiteUrl' },
];

/** Parse the normalized application form from real Lever HTML. */
export function parseLeverForm(html: string): { fields: ApplicationField[]; providerMetadata: Record<string, string>; consentPresent: boolean } {
  const $ = cheerio.load(html);
  const form = $('#application-form').first().length
    ? $('#application-form').first()
    : $('form[enctype="multipart/form-data"]').first();
  if (!form.length) throw new InspectionFailure('FORM_CHANGED', 'No application form found.');

  const fields: ApplicationField[] = [];
  const providerMetadata: Record<string, string> = {};

  // Standard fields
  for (const s of STANDARD_FIELDS) {
    const el = form.find(`[name="${s.name}"]`).first();
    if (!el.length) continue;
    const required = el.attr('required') !== undefined || el.attr('aria-required') === 'true';
    const type = s.name.startsWith('urls[') ? 'URL' : el.attr('type') === 'file' ? 'FILE' : (el.attr('type') === 'email' ? 'EMAIL' : el.attr('type') === 'tel' ? 'PHONE' : 'TEXT');
    fields.push({
      providerFieldId: s.name,
      normalizedKey: s.canonical,
      label: s.label,
      type: type as FieldType,
      required,
      category: s.canonical === 'resume' ? 'RESUME' : s.name.startsWith('urls') ? 'CONTACT' : 'IDENTITY',
    });
  }
  // Resume (file input, separate)
  const resumeEl = form.find('input[name="resume"]').first();
  if (resumeEl.length) {
    fields.push({ providerFieldId: 'resume', normalizedKey: 'resume', label: 'Resume', type: 'FILE', required: true, category: 'RESUME' });
  }

  // Custom questions: authoritative JSON template on the hidden baseTemplate
  const templateJson = form.find('input[name$="[baseTemplate]"]').first().attr('value');
  if (templateJson) {
    // Real Lever pages entity-encode the embedded JSON (&quot; etc.)
    const decoded = templateJson.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&amp;/g, '&');
    const jsonText = decoded;
    try {
      const template = JSON.parse(jsonText);
      const cardId = template.id || 'card';
      for (const q of template.fields || []) {
        const type = String(q.type || '').toLowerCase();
        const fType: FieldType =
          type === 'textarea' ? 'TEXTAREA' :
          type === 'multiple-select' ? 'MULTI_SELECT' :
          type === 'multiple-choice' ? 'SINGLE_SELECT' :
          type === 'dropdown' ? 'SINGLE_SELECT' :
          type === 'number' ? 'NUMBER' :
          type === 'date' ? 'DATE' :
          type === 'boolean' ? 'SINGLE_SELECT' : 'TEXT';
        const label = cleanLabel(q.text || 'Unknown question');
        const fieldId = `cards[${cardId}][field${template.fields.indexOf(q)}]`;
        const category = classifyCategory(label);
        if (category === 'CONSENT') {
          fields.push({ providerFieldId: fieldId, label, type: 'CONSENT', required: !!q.required, category: 'CONSENT' });
          continue;
        }
        fields.push({
          providerFieldId: fieldId,
          normalizedKey: normalizeFieldLabel(label) || undefined,
          label,
          type: fType,
          required: !!q.required,
          options: (q.options || []).map((o: any) => String(o.text || o.optionId || '')),
          category,
        });
      }
    } catch {
      // template JSON malformed — fall back to rendered field markup
    }
  } else {
    // fallback: rendered card inputs
    form.find('input[name^="cards["], select[name^="cards["], textarea[name^="cards["]').each((_, el) => {
      const $el = $(el);
      const name = $el.attr('name') || '';
      if (name.endsWith('baseTemplate]')) return;
      const label = cleanLabel($el.closest('.card-field, .application-form-field').find('label').first().text() || name);
      const required = $el.attr('required') !== undefined || $el.attr('aria-required') === 'true';
      const type = fieldTypeFrom($el.attr('type'), name);
      const category = classifyCategory(label);
      if (category === 'CONSENT') {
        fields.push({ providerFieldId: name, label, type: 'CONSENT', required, category: 'CONSENT' });
        return;
      }
      fields.push({ providerFieldId: name, label, type, required, category, options: type === 'SINGLE_SELECT' || type === 'MULTI_SELECT' ? [] : undefined });
    });
  }

  // Consent section
  if (form.find('[data-qa="consent-section"]').length) {
    fields.push({ providerFieldId: 'consent', label: 'Consent / legal acknowledgement', type: 'CONSENT', required: true, category: 'CONSENT' });
  }

  // Transport metadata — never applicant fields
  for (const hidden of form.find('input[type="hidden"]')) {
    const name = $(hidden).attr('name') || '';
    if (/^(accountId|origin|referer|source|timezone|selectedLocation|linkedInData|urlToken|organizationSlug)$/.test(name) || name.startsWith('cards[')) {
      providerMetadata[name] = String($(hidden).attr('value') || '').slice(0, 200);
    }
  }
  providerMetadata['form'] = String(form.attr('action') || '');

  // Structural sanity: a non-empty page must yield fields.
  if (fields.length === 0) throw new InspectionFailure('FORM_CHANGED', 'No application fields parsed from the form.');

  return { fields, providerMetadata, consentPresent: fields.some((f) => f.category === 'CONSENT') };
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class LeverInspectionAdapter implements ApplicationInspectionAdapter {
  readonly provider: Provider = 'lever';
  readonly version = LEVER_INSPECTOR_VERSION;

  detect(target: ApplicationTarget): DetectionResult {
    const d = detectProvider(undefined, target.applyUrl, target.jobUrl);
    return d;
  }

  async inspect(target: ApplicationTarget): Promise<ApplicationRequirements> {
    const url = target.applyUrl;
    if (!url) throw new InspectionFailure('INVALID_TARGET', 'No apply URL for Lever inspection.');
    // Ensure the URL is the apply form (not the job page)
    const targetUrl = url.includes('/apply') ? url : `${url.replace(/\/+$/, '')}/apply`;
    const { html, finalUrl } = await httpGetOnly(targetUrl);
    const parsed = parseLeverForm(html);
    const hostname = new URL(finalUrl).hostname.toLowerCase();
    const fp = requirementsFingerprint(this.provider, hostname, parsed.fields);
    return {
      provider: this.provider,
      target: { ...target, hostname, redirectKind: classifyTarget(finalUrl, 'lever') },
      fields: parsed.fields,
      discoveredAt: new Date().toISOString(),
      fingerprint: fp,
    };
  }
}