// Reading and resolving work schedules for the time clock.
//
// Two screens write `work_schedule` and they do not agree on the shape:
//
//   - Cadastro de colaboradores (RHColaboradores.tsx) stores a dayConfig keyed
//     by weekday NAME: { dayConfig: { seg: { entry, exit }, ... } }
//   - Painel de jornada global (WorkSchedulePanel.tsx) stores the same field
//     keyed by the Postgres DOW NUMBER: { dayConfig: { "1": { ... } } }
//
// Both live in the same column, and the punch app used to look for only the
// numeric spelling while the card looked for only the name. That is why a
// jornada of 07:00 could end up rejected at 07:05 and then printed as a
// 08:00-17:00 expected journey: neither side ever read what the other wrote.
//
// Everything here therefore accepts both spellings, and the resolver is shared
// by the punch app (promotor.js) and the card (rh.js) so the two can never
// disagree about a person's expected journey.

import { parseHHMMToMinutes, DEFAULT_ENTRY, DEFAULT_EXIT } from './time-calc.js';

// Indexed by ISO weekday (1 = Monday .. 7 = Sunday), which is what
// to_char(...,'F')-free JS code naturally has.
export const DOW_KEYS = { 1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab', 7: 'dom' };

/**
 * A day of the week, in either of the two conventions used in this codebase:
 * the ISO weekday (1 = Monday, JS getDay() + 1) or the Postgres EXTRACT(DOW)
 * value (0 = Sunday .. 6 = Saturday). Returns null when there is no day.
 */
export function normalizeDow(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Postgres DOW: 0 = Sunday. ISO: 7 = Sunday. Only 0 and 7 disambiguate.
  if (n === 0) return 7;
  if (n >= 1 && n <= 7) return n;
  return null;
}

// The dayConfig entry for one weekday, tolerating both key conventions.
function dayConfigFor(parsed, isoDow) {
  if (!parsed || !parsed.dayConfig) return null;
  if (isoDow == null) return null;
  const dow = normalizeDow(isoDow);
  if (dow == null) return null;
  const byName = parsed.dayConfig[DOW_KEYS[dow]];
  if (byName) return byName;
  // Numeric spelling. Postgres DOW puts Sunday at 0 and Monday at 1, so a
  // "1" is Monday under both readings; Sunday is "0" there and "7" here.
  const candidates = [String(dow), String(dow === 7 ? 0 : dow)];
  for (const key of candidates) {
    if (parsed.dayConfig[key]) return parsed.dayConfig[key];
  }
  return null;
}

// The day-of-week on/off flags, tolerating both key conventions.
function daysFlag(parsed, isoDow) {
  if (!parsed || !parsed.days) return undefined;
  const dow = normalizeDow(isoDow);
  if (dow == null) return undefined;
  return parsed.days[DOW_KEYS[dow]] ?? parsed.days[String(dow)] ?? parsed.days[String(dow === 7 ? 0 : dow)];
}

// lunch_start/lunch_end as a duration in minutes. Absent, partial or
// degenerate values mean no declared break rather than a zero-length one.
export function lunchMinutesOf(cfg) {
  if (!cfg) return 0;
  const s = parseHHMMToMinutes(cfg.lunch_start ?? cfg.break_start);
  const e = parseHHMMToMinutes(cfg.lunch_end ?? cfg.break_end);
  if (s == null || e == null) return 0;
  return e > s ? e - s : 0;
}

function readWindow(cfg) {
  return {
    entry: parseHHMMToMinutes(cfg.entry ?? cfg.start ?? cfg.work_start),
    exit: parseHHMMToMinutes(cfg.exit ?? cfg.end ?? cfg.work_end),
  };
}

/**
 * Reads a work_schedule value for one weekday.
 *
 * Accepts the legacy flat text "08:00-17:00", a flat JSON { entry, exit }, and
 * the per-weekday dayConfig in either key convention. isoDow selects the day;
 * omit it to read only the general entry/exit.
 *
 * Returns { entry, exit, breakMinutes, isWorkday }, all nullable. A null entry
 * means the source says nothing about this day -- it does NOT mean 08:00.
 * Callers fall through to the next source in that case.
 */
export function parseWorkSchedule(value, isoDow = null) {
  const out = { entry: null, exit: null, breakMinutes: null, isWorkday: null };
  if (value == null) return out;

  let parsed = value;
  if (typeof value === 'string') {
    const str = value.trim();
    if (!str) return out;
    // Legacy "08:00-17:00" / "08:00 até 17:00". Checked before JSON so a
    // string never gets read as an object.
    const range = str.match(/(\d{1,2}:\d{2})\s*(?:-|até|ate|ao)\s*(\d{1,2}:\d{2})/i);
    if (range) {
      out.entry = parseHHMMToMinutes(range[1]);
      out.exit = parseHHMMToMinutes(range[2]);
      return out;
    }
    if (!str.startsWith('{')) return out;
    try {
      parsed = JSON.parse(str);
    } catch {
      return out;
    }
  }
  if (!parsed || typeof parsed !== 'object') return out;

  const dow = normalizeDow(isoDow);
  const flag = daysFlag(parsed, isoDow);
  if (flag === false) out.isWorkday = false;
  else if (flag === true) out.isWorkday = true;
  else if (Array.isArray(parsed.work_days) && dow != null) {
    // A jornada that lists its workdays as a list rather than a map. The list
    // may spell them as ISO (1-7), Postgres DOW (0-6) or names, so it is
    // matched against every reading rather than assumed.
    const lists = new Set(parsed.work_days.map((d) => String(d).toLowerCase()));
    if (lists.has(DOW_KEYS[dow]) || lists.has(String(dow)) || lists.has(String(dow === 7 ? 0 : dow))) {
      out.isWorkday = true;
    } else {
      out.isWorkday = false;
    }
  }

  // A day switched off in the editor is a rest day even if it is a weekday.
  // A jornada configured per weekday. In this mode the top-level entry/exit is
  // a summary of the week, not a fallback: a day with no block of its own is a
  // day the person does not work. Reading it as the top-level window is what
  // made a Mon-Sat schedule also claim Sunday.
  const perDayMode = Boolean(parsed.useIndividualDays && parsed.dayConfig);
  const perDay = dayConfigFor(parsed, isoDow);
  if (perDay) {
    if (perDay.enabled === false) {
      out.isWorkday = false;
      return out;
    }
    const w = readWindow(perDay);
    if (w.entry != null && w.exit != null) {
      out.entry = w.entry;
      out.exit = w.exit;
      const lunch = lunchMinutesOf(perDay);
      if (lunch > 0) out.breakMinutes = lunch;
      return out;
    }
  }
  if (perDayMode && isoDow != null) {
    out.isWorkday = false;
    out.entry = null;
    out.exit = null;
    out.breakMinutes = null;
    return out;
  }

  const top = readWindow(parsed);
  out.entry = top.entry;
  out.exit = top.exit;
  const topLunch = lunchMinutesOf(parsed);
  if (topLunch > 0) out.breakMinutes = topLunch;
  return out;
}

/**
 * Resolves the expected journey for one day.
 *
 * Precedence matches the punch app: an explicit scale beats the employee's own
 * jornada, which beats the organization's global jornada, and only then the
 * built-in default. `scale` may be null when no escala row matched the date.
 *
 * `isWorkday` defaults to Monday-Friday, but a jornada that marks the day off
 * overrides that in either the individual or the global source -- an employee
 * off on a Saturday, or a company-wide rest day, must not be measured against
 * a workday.
 */
export function resolveDaySchedule({
  scale = null,
  employee = null,
  organizationSchedule = null,
  isoDow = null,
}) {
  const out = {
    entry: null,
    exit: null,
    breakMinutes: null,
    isWorkday: isoDow == null || (isoDow >= 1 && isoDow <= 5),
    source: 'PADRAO',
  };
  const scaleBreak = scale && scale.break_minutes != null ? Number(scale.break_minutes) : null;

  const scaleEntry = scale ? parseHHMMToMinutes(String(scale.entry_time ?? '').slice(0, 5)) : null;
  const scaleExit = scale ? parseHHMMToMinutes(String(scale.exit_time ?? '').slice(0, 5)) : null;
  if (scaleEntry != null && scaleExit != null) {
    out.entry = scaleEntry;
    out.exit = scaleExit;
    out.breakMinutes = scaleBreak;
    out.source = 'ESCALA';
    return out;
  }

  const individual = parseWorkSchedule(employee, isoDow);
  if (individual.entry != null && individual.exit != null) {
    out.entry = individual.entry;
    out.exit = individual.exit;
    out.breakMinutes = scaleBreak ?? individual.breakMinutes;
    if (individual.isWorkday != null) out.isWorkday = individual.isWorkday;
    out.source = 'JORNADA_FUNCIONARIO';
    return out;
  }
  // The individual's jornada may say nothing about this weekday yet still mark
  // it off. A rest day is a stronger statement than a missing jornada.
  if (individual.isWorkday === false) {
    out.isWorkday = false;
    out.source = 'JORNADA_FUNCIONARIO';
    return out;
  }

  const global = parseWorkSchedule(organizationSchedule, isoDow);
  if (global.entry != null && global.exit != null) {
    out.entry = global.entry;
    out.exit = global.exit;
    out.breakMinutes = scaleBreak ?? global.breakMinutes;
    if (global.isWorkday != null) out.isWorkday = global.isWorkday;
    out.source = 'JORNADA_GLOBAL';
    return out;
  }
  if (global.isWorkday === false) {
    out.isWorkday = false;
    out.source = 'JORNADA_GLOBAL';
    return out;
  }

  out.entry = parseHHMMToMinutes(DEFAULT_ENTRY);
  out.exit = parseHHMMToMinutes(DEFAULT_EXIT);
  out.breakMinutes = scaleBreak;
  return out;
}
