import type React from 'react';
import { useEffect, useRef, useState } from 'react';

// Live job-TITLE suggestions for search inputs — fetched from the real job
// corpus (/api/job-titles/suggest), never a hardcoded list. Titles only.
// Debounced; keyboard-navigable; falls back to silence on any failure.

export interface TitleSuggestState {
  suggestions: string[];
  open: boolean;
  active: number;
  setActive: (i: number) => void;
  /** Call from the input's onKeyDown; returns true when the event was consumed. */
  onKeyDown: (e: React.KeyboardEvent, apply: (value: string) => void) => boolean;
  close: () => void;
  /** Call from the input's onBlur (delay lets option clicks land). */
  onBlur: () => void;
}

export function useTitleSuggestions(value: string, minChars = 2): TitleSuggestState {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = String(value || '').trim();
    if (q.length < minChars) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/job-titles/suggest?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = await res.json();
        const titles: string[] = Array.isArray(data.titles) ? data.titles : [];
        setSuggestions(titles);
        setOpen(titles.length > 0);
        setActive(-1);
      } catch {
        /* suggestions are best-effort */
      }
    }, 180);
    return () => clearTimeout(t);
  }, [value, minChars]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent, apply: (value: string) => void): boolean => {
    if (!open || suggestions.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      return true;
    }
    if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      apply(suggestions[active]);
      close();
      return true;
    }
    if (e.key === 'Escape') {
      close();
      return true;
    }
    return false;
  };

  const onBlur = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(close, 150);
  };

  return { suggestions, open, active, setActive, onKeyDown, close, onBlur };
}
