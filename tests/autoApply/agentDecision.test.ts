// Phase 2 — agent decision core (pure): observation + resolved values → primitives.
import { describe, it, expect } from 'vitest';
import { composeDecision, type ObservedState } from '../../server/autoApply/agentDecision.js';

const base = (over: Partial<ObservedState> = {}): ObservedState => ({
  url: 'https://jobs.lever.co/x/y/apply',
  formPresent: true,
  captchaPresent: false,
  fields: [],
  buttons: [],
  submitControl: { ref: 'ta9', label: 'Submit Application', disabled: false, visible: true },
  ...over,
});

describe('Agent decision core (one layer, pure)', () => {
  it('CAPTCHA pauses — never an action, never a submit', () => {
    const d = composeDecision(
      base({ captchaPresent: true, fields: [{ ref: 'ta1', kind: 'text', label: 'Name', value: '' }] }),
      new Map([['ta1', 'Atanu']]),
    );
    expect(d.pause).toBe('CAPTCHA_REQUIRED');
    expect(d.actions).toEqual([]);
    expect(d.asks).toEqual([]);
    expect(d.submit).toBe(false);
  });

  it('asks carry the form options so the answer chat can render chips', () => {
    const d = composeDecision(
      base({ fields: [{ ref: 'ta1', kind: 'select', label: 'Notice period', required: true, options: [{ option: 'Immediately' }, { option: '30 days' }] }] }),
      new Map(),
    );
    expect(d.asks).toEqual([
      expect.objectContaining({ label: 'Notice period', human: false, options: ['Immediately', '30 days'] }),
    ]);
  });

  it('resolves a saved text answer into exactly one type action', () => {    const d = composeDecision(
      base({ fields: [{ ref: 'ta1', kind: 'text', label: 'Current company', value: '' }] }),
      new Map([['ta1', 'Human Managed']]),
    );
    expect(d.actions).toEqual([{ action: 'type', ref: 'ta1', value: 'Human Managed' }]);
    expect(d.submit).toBe(false); // act first, decide again after observing
  });

  it('select answers must match a real option; otherwise ask with the allowed list', () => {
    const field = { ref: 'ta1', kind: 'select', label: 'Shifts', value: '', required: true, options: [{ option: 'Days' }, { option: 'Nights' }] };
    const ok = composeDecision(base({ fields: [field] }), new Map([['ta1', 'days']]));
    expect(ok.actions).toEqual([{ action: 'select', ref: 'ta1', value: 'Days' }]);
    const bad = composeDecision(base({ fields: [field] }), new Map([['ta1', 'Mornings']]));
    expect(bad.actions).toEqual([]);
    expect(bad.asks[0]?.reason).toContain('allowed: Days | Nights');
  });

  it('consent is classified: legal pauses, marketing opt-ins are skipped; unanswered EEO stays untouched', () => {
    const d = composeDecision(
      base({
        fields: [
          { ref: 'ta1', kind: 'checkbox', label: 'I agree to the Candidate Privacy Policy', value: '', consent: true },
          { ref: 'ta2', kind: 'checkbox', label: 'Send me marketing emails', value: '', consent: true },
          { ref: 'ta3', kind: 'select', label: 'Gender', value: '', options: [{ option: 'Male' }] },
        ],
      }),
      new Map([['ta1', 'true'], ['ta2', 'true']]),
    );
    expect(d.actions).toEqual([]);
    expect(d.asks.map((a) => a.human)).toEqual([true]); // legal consent only
    expect(d.notes.join(' ')).toContain('optional opt-in left untouched');
    expect(d.notes.join(' ')).toContain('voluntary EEO left untouched');
  });

  it('optional unanswered questions are skipped, never blocking', () => {
    const d = composeDecision(base({ fields: [{ ref: 'ta1', kind: 'text', label: 'Portfolio (optional)', value: '', required: false }] }), new Map());
    expect(d.asks).toEqual([]);
    expect(d.actions).toEqual([]);
    expect(d.submit).toBe(true);
    expect(d.notes.join(' ')).toContain('optional question left unanswered');
  });

  it('a clean form submits', () => {
    const d = composeDecision(base(), new Map());
    expect(d.submit).toBe(true);
    expect(d.asks).toEqual([]);
    expect(d.actions).toEqual([]);
  });

  it('the resume upload is an artifact action, never a typed value', () => {
    const d = composeDecision(base({ fields: [{ ref: 'ta1', kind: 'file', label: 'Resume/CV', value: '' }] }), new Map());
    expect(d.actions).toEqual([{ action: 'upload_resume', ref: 'ta1' }]);
  });

  it('checkbox-group options are checked individually by option label', () => {
    const d = composeDecision(
      base({ fields: [{ ref: 'ta1', kind: 'checkbox-group', label: 'Days', value: '', options: [{ option: 'Monday - Friday' }, { option: 'Weekends' }, { option: 'Any' }] }] }),
      new Map([['ta1', 'Any']]),
    );
    expect(d.actions).toEqual([{ action: 'check', ref: 'ta1', option: 'Any' }]);
  });

  it('custom dropdowns post the option text through their hidden input (type action)', () => {
    const d = composeDecision(
      base({ fields: [{ ref: 'ta1', kind: 'custom-select', label: 'How many core values?', value: '', required: true, options: [{ option: '3' }, { option: '5' }] }] }),
      new Map([['ta1', '5']]),
    );
    expect(d.actions).toEqual([{ action: 'type', ref: 'ta1', value: '5' }]);
  });

  it('option matching is tolerant: parentheticals and veteran synonyms', () => {
    const race = composeDecision(
      base({ fields: [{ ref: 'ta1', kind: 'select', label: 'Race', required: false, options: [{ option: 'Asian (Not Hispanic or Latino)' }] }] }),
      new Map([['ta1', 'Asian']]),
    );
    expect(race.actions).toEqual([{ action: 'select', ref: 'ta1', value: 'Asian (Not Hispanic or Latino)' }]);

    const vet = composeDecision(
      base({ fields: [{ ref: 'ta1', kind: 'select', label: 'Veteran status', required: false, options: [{ option: 'I am a veteran' }, { option: 'I am not a veteran' }, { option: 'Decline to self-identify' }] }] }),
      new Map([['ta1', 'I am not a protected veteran']]),
    );
    expect(vet.actions).toEqual([{ action: 'select', ref: 'ta1', value: 'I am not a veteran' }]);
  });

  it('a location validation error self-heals by re-asserting the value', () => {
    const d = composeDecision(
      base({
        fields: [{ ref: 'ta1', kind: 'text', label: 'Current location ✱', value: 'Kolkata, India' }],
        errors: ['✱ Please select a location from the dropdown menu and try again.'],
      }),
      new Map([['ta1', 'Kolkata, India']]),
    );
    expect(d.actions).toEqual([{ action: 'type', ref: 'ta1', value: 'Kolkata, India' }]);
    expect(d.notes.join(' ')).toContain('re-asserting location');
    expect(d.submit).toBe(false); // act first, then re-observe
  });
});
