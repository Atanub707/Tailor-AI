import React, { useEffect, useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { X, CalendarDays, Check } from 'lucide-react';
import { parseDateRange, formatDateRange, type ParsedRange } from '../lib/dateRange';

// Month+year range picker built on react-day-picker (the open-source standard,
// also the engine behind shadcn/ui's Calendar) with the market-standard
// month/year dropdown caption — so jumping from 2019 to 2026 is two dropdown
// picks instead of ~80 prev/next arrow clicks. Values stay display strings
// like "August 2024 – Present" (exact format the CV renderers consume).

const TODAY = new Date();
const START_MONTH = new Date(1980, 0);
const END_MONTH = new Date(TODAY.getFullYear() + 6, 11);

interface DateRangePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({ value, onChange, placeholder = 'Pick start & end date' }) => {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseDateRange(value), [value]);
  const [draft, setDraft] = useState<ParsedRange>(parsed);
  const [draftPresent, setDraftPresent] = useState(parsed.present);

  const openPicker = () => {
    setDraft(parsed);
    setDraftPresent(parsed.present);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const apply = () => {
    onChange(formatDateRange({ ...draft, present: draftPresent }));
    setOpen(false);
  };

  const clear = () => {
    onChange('');
    setOpen(false);
  };

  const preview = formatDateRange({ ...draft, present: draftPresent });
  const canApply = !!draft.from;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={openPicker}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)] text-left cursor-pointer hover:border-[var(--color-brand)] transition-colors"
      >
        <span className={value ? 'text-[var(--color-ink)]' : 'text-[var(--color-faint)]'}>{value || placeholder}</span>
        <CalendarDays className="w-3.5 h-3.5 text-[var(--color-faint)] shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Pick start and end month"
            className="absolute left-0 top-full mt-1.5 z-50 bg-white border border-[var(--color-hairline)] rounded-xl shadow-xl p-3 w-[324px]"
            style={{
              ['--rdp-accent-color' as string]: 'var(--color-brand)',
              ['--rdp-accent-background-color' as string]: 'var(--color-brand-soft)',
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-faint)]">
                Pick start date, then end date
              </p>
              <p className="text-[10px] text-[var(--color-faint)]">Jump years via the dropdowns</p>
            </div>
            <DayPicker
              mode="range"
              captionLayout="dropdown"
              startMonth={START_MONTH}
              endMonth={END_MONTH}
              reverseYears
              defaultMonth={draft.from || draft.to || new Date(TODAY.getFullYear() - 2, 0)}
              selected={
                draft.from && draft.to
                  ? { from: draft.from, to: draft.to }
                  : draft.from
                    ? { from: draft.from, to: draft.from }
                    : undefined
              }
              onSelect={(range) => {
                setDraft({ from: range?.from ?? null, to: range?.to ?? null, present: false });
                if (range?.to) setDraftPresent(false);
              }}
            />
            <label className="flex items-center gap-2 mt-2 text-[12px] font-semibold text-[var(--color-ink)] cursor-pointer">
              <input
                type="checkbox"
                checked={draftPresent}
                onChange={(e) => setDraftPresent(e.target.checked)}
                className="w-3.5 h-3.5 cursor-pointer accent-[var(--color-brand)]"
              />
              Currently working here (Present)
            </label>
            <div className="mt-2 px-2 py-1.5 rounded bg-[var(--color-brand-soft)] text-[11px] font-medium text-[var(--color-ink)] min-h-[26px]">
              {preview || <span className="text-[var(--color-faint)]">No dates selected yet</span>}
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                type="button"
                onClick={apply}
                disabled={!canApply}
                className="flex-1 inline-flex items-center justify-center gap-1.5 bg-[var(--color-ink)] hover:bg-[#14113B] text-white rounded-lg px-3 py-1.5 text-[12px] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Check className="w-3.5 h-3.5" /> Apply
              </button>
              <button
                type="button"
                onClick={clear}
                className="inline-flex items-center justify-center gap-1 text-[var(--color-faint)] hover:text-[var(--color-danger)] rounded-lg px-2.5 py-1.5 text-[12px] font-semibold cursor-pointer transition-colors"
              >
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
