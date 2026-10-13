// CV date-range parsing/formatting — the stored display format must round-trip
// EXACTLY ("August 2024 – August 2026"): the CV renderers and PDFs consume
// these strings verbatim, so the picker may never change the data shape.
import { describe, it, expect } from 'vitest';
import { parseDateRange, formatDateRange, parseMonthYear } from '../../src/lib/dateRange';

describe('CV date range (month+year picker storage format)', () => {
  it('parses every stored variant (en dash, hyphen, Present)', () => {
    const a = parseDateRange('August 2024 – August 2026');
    expect(a.from?.getFullYear()).toBe(2024);
    expect(a.from?.getMonth()).toBe(7);
    expect(a.to?.getFullYear()).toBe(2026);
    expect(a.to?.getMonth()).toBe(7);
    expect(a.present).toBe(false);

    const b = parseDateRange('September 2019 - March 2022');
    expect(b.from?.getFullYear()).toBe(2019);
    expect(b.from?.getMonth()).toBe(8);
    expect(b.to?.getFullYear()).toBe(2022);
    expect(b.to?.getMonth()).toBe(2);

    const c = parseDateRange('August 2024 – Present');
    expect(c.present).toBe(true);
    expect(c.to).toBeNull();
    expect(c.from?.getFullYear()).toBe(2024);

    const none = parseDateRange('Nov 2023');
    expect(none.from).toBeNull();
    expect(parseDateRange('')).toEqual({ from: null, to: null, present: false });
  });

  it('round-trips to the exact stored display format', () => {
    expect(formatDateRange(parseDateRange('August 2024 – August 2026'))).toBe('August 2024 – August 2026');
    expect(formatDateRange(parseDateRange('September 2019 - March 2022'))).toBe('September 2019 – March 2022');
    expect(formatDateRange({ from: new Date(2024, 7, 1), to: null, present: true })).toBe('August 2024 – Present');
    expect(formatDateRange({ from: new Date(2024, 7, 1), to: null, present: false })).toBe('August 2024');
    expect(formatDateRange({ from: null, to: null, present: false })).toBe('');
  });

  it('parses abbreviated and punctuated month names from the market', () => {
    expect(parseMonthYear('Sept 2019')?.getMonth()).toBe(8);
    expect(parseMonthYear('jan. 2020')?.getMonth()).toBe(0);
    expect(parseMonthYear('Mar, 2021')?.getMonth()).toBe(2);
    expect(parseMonthYear('2019')).toBeNull();
    expect(parseMonthYear('Foo 2019')).toBeNull();
  });
});
