import { format, isValid, parseISO } from 'date-fns';

/** Parses SQL DATE values as calendar dates, not UTC instants. */
export function parseCalendarDate(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? new Date(`${raw}T12:00:00`)
      : parseISO(raw);
    return isValid(date) ? date : null;
  } catch {
    return null;
  }
}

export function formatCalendarDate(value: unknown, pattern = 'dd/MM/yyyy', fallback = '—'): string {
  const date = parseCalendarDate(value);
  return date ? format(date, pattern) : fallback;
}
