// Month+year range parsing/formatting for CV dates ("August 2024 – Present").
// Kept separate from the React picker so it is unit-testable without a DOM,
// and so the stored display format stays exactly what the CV renderers
// consume (no data model changes).

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_LOOKUP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export interface ParsedRange {
  from: Date | null;
  to: Date | null;
  present: boolean;
}

/** "August 2024" / "Aug 2024" / "aug. 2024" -> Date(2024, 7, 1) */
export function parseMonthYear(token: string): Date | null {
  const m = String(token || '').trim().match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (!m) return null;
  const idx = MONTH_LOOKUP[m[1].toLowerCase()];
  if (idx === undefined) return null;
  return new Date(Number(m[2]), idx, 1);
}

/** Parse a stored display string: "September 2019 - March 2022",
 *  "August 2024 – Present", "August 2024 – August 2026". */
export function parseDateRange(value: string): ParsedRange {
  const match = String(value || '').trim().match(/^(.+?)\s*[-–]\s*(.+)$/);
  if (!match) return { from: null, to: null, present: false };
  const from = parseMonthYear(match[1]);
  const endRaw = match[2].trim();
  if (/^present$/i.test(endRaw)) return { from, to: null, present: true };
  return { from, to: parseMonthYear(endRaw), present: false };
}

/** Canonical display string — the exact format the CV renderers consume. */
export function formatDateRange(range: ParsedRange): string {
  const fmt = (d: Date | null) => (d ? `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` : '');
  if (!range.from) return '';
  if (range.present) return `${fmt(range.from)} – Present`;
  if (!range.to) return fmt(range.from);
  return `${fmt(range.from)} – ${fmt(range.to)}`;
}
