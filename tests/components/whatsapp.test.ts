// WhatsApp click-to-chat helpers — number normalization + pre-filled message.
// The global message ships as a constant and is editable at runtime; the
// link must open the user's OWN WhatsApp with the text pre-filled (files
// cannot be attached via deep links — the UI pairs a CV download instead).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waNumber, waLink, DEFAULT_WA_MESSAGE, getWaMessage, setWaMessage, resetWaMessage } from '../../src/lib/recruiters/whatsapp';

describe('WhatsApp click-to-chat helpers', () => {
  beforeEach(() => {
    // Node has no localStorage — provide a minimal one so the editable-message
    // path is exercised for real.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    });
    resetWaMessage();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes numbers to wa.me digits', () => {
    expect(waNumber('+91 84202 05661')).toBe('918420205661');
    expect(waNumber('08420205661')).toBe('918420205661'); // trunk zero → +91
    expect(waNumber('8420205661')).toBe('918420205661'); // bare 10-digit → +91
    expect(waNumber('+1 (555) 000-0000')).toBe('15550000000');
    expect(waNumber('555.000.0000')).toBe('915550000000'); // formatted without + → default country code
    expect(waNumber('+49 30 123456')).toBe('4930123456');
    expect(waNumber('')).toBe('');
    expect(waNumber('not a phone')).toBe('');
  });

  it('builds the deep link with the message URL-encoded', () => {
    const link = waLink('+91 84202 05661', 'Hi there! Are you hiring?');
    expect(link.startsWith('https://wa.me/918420205661?text=')).toBe(true);
    expect(decodeURIComponent(link.split('?text=')[1])).toBe('Hi there! Are you hiring?');
  });

  it('ships the user-approved global message as the default', () => {
    expect(DEFAULT_WA_MESSAGE).toContain("I'm exploring remote DevSecOps opportunities");
    expect(DEFAULT_WA_MESSAGE).toContain('SOC 2 & ISO 27001 compliance readiness');
    expect(DEFAULT_WA_MESSAGE.endsWith('Thank you!')).toBe(true);
    expect(getWaMessage()).toBe(DEFAULT_WA_MESSAGE);
  });

  it('the global message is editable and resettable', () => {
    setWaMessage('  Custom outreach message  ');
    expect(getWaMessage()).toBe('Custom outreach message');
    resetWaMessage();
    expect(getWaMessage()).toBe(DEFAULT_WA_MESSAGE);
    expect(waLink('8420205661')).toContain(encodeURIComponent(DEFAULT_WA_MESSAGE.slice(0, 20)));
  });

  it('an empty message produces a plain chat link', () => {
    expect(waLink('8420205661', '')).toBe('https://wa.me/918420205661');
    expect(waLink('', 'Hi')).toBe('');
  });
});
