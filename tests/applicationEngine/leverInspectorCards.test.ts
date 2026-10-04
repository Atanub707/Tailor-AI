// Regression: Lever renders EACH custom question as its own card with its own
// hidden baseTemplate. Parsing only the first dropped real questions
// (e.g. "What is your desired salary range?") from every plan.
import { describe, it, expect } from 'vitest';
import { parseLeverForm } from '../../server/applicationEngine/leverInspector.js';

const enc = (o: unknown) => JSON.stringify(o).replace(/"/g, '&quot;').replace(/{/g, '&#123;').replace(/}/g, '&#125;');

const HTML = `
<html><body>
<form id="application-form" enctype="multipart/form-data">
  <input name="name" required />
  <input name="email" type="email" required />
  <input name="resume" type="file" required />
  <input name="cards[cardAAA][baseTemplate]" value="${enc({ id: 'cardAAA', fields: [{ text: 'Applicants selected may be subject to a background check. Are you able to meet this requirement? y/n', type: 'text', required: true }] })}" />
  <input name="cards[cardBBB][baseTemplate]" value="${enc({ id: 'cardBBB', fields: [{ text: 'What is your desired salary range?', type: 'text', required: true }] })}" />
  <input name="cards[cardCCC][baseTemplate]" value="${enc({ id: 'cardCCC', fields: [{ text: 'Are you okay with working onsite in Rockville, Maryland?', type: 'dropdown', required: true, options: [{ text: 'Yes' }, { text: 'No' }] }] })}" />
</fieldset></form></body></html>`;

describe('Lever inspector — multi-card custom questions', () => {
  it('parses EVERY question card, with per-card providerFieldIds', () => {
    const { fields } = parseLeverForm(HTML);
    const ids = fields.map((f) => f.providerFieldId);
    expect(ids).toContain('cards[cardAAA][field0]');
    expect(ids).toContain('cards[cardBBB][field0]');
    expect(ids).toContain('cards[cardCCC][field0]');

    const salary = fields.find((f) => /desired salary range/i.test(f.label));
    expect(salary, 'salary question must be inspected').toBeTruthy();
    expect(salary?.providerFieldId).toBe('cards[cardBBB][field0]');
    expect(salary?.required).toBe(true);

    const onsite = fields.find((f) => /onsite in Rockville/i.test(f.label));
    expect(onsite?.type).toBe('SINGLE_SELECT');
    expect(onsite?.options).toEqual(['Yes', 'No']);
  });
});

describe('Consent truth (the Binance false-blocker)', () => {
  const wrap = (inner: string) => `<html><body><form id="application-form" enctype="multipart/form-data"><input name="name" required />${inner}</form></body></html>`;
  it('informational privacy text NEVER becomes a blocking consent', () => {
    const html = wrap('<div data-qa="consent-section"><p>By applying for this position, your data will be processed as per Binance Privacy Policy.</p></div>');
    const { fields } = parseLeverForm(html);
    expect(fields.filter((f) => f.category === 'CONSENT')).toHaveLength(0);
  });
  it('a consent section WITH a real control still counts', () => {
    const html = wrap('<div data-qa="consent-section"><label><input type="checkbox" role="checkbox" name="agree" /> I agree</label></div>');
    const { fields } = parseLeverForm(html);
    expect(fields.filter((f) => f.category === 'CONSENT').length).toBeGreaterThan(0);
  });
});
