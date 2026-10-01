// Canonical time calculation for the time-clock module.
//
// This is the single source of truth for "how many minutes did this person
// work on this day". It was extracted from the inline algorithm that used to
// live in routes/rh.js (GET /consolidated-timesheet) so that the Cartão de
// Ponto and the consolidated timesheet cannot drift apart — they used to be
// two independent implementations, which is how day/total mismatches got in.
//
// The module is intentionally pure: no database access, no Date.now() for
// civil dates. Callers pass the punches already grouped by day.

export const TZ = 'America/Sao_Paulo';

export const DEFAULT_ENTRY = '08:00';
export const DEFAULT_EXIT = '17:00';
export const DEFAULT_LATE_TOLERANCE = 10;
export const DEFAULT_EARLY_TOLERANCE = 10;

export function formatHHMM(minutes) {
  const m = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function parseHHMMToMinutes(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// Postgres TIME columns come back as 'HH:MM:SS' strings.
export function timeColumnToMinutes(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Postgres TIME WITH TIME ZONE / timestamptz come back as Date. For a punch we
// want the wall-clock time in São Paulo, not the server clock.
export function instantToSaoPauloMinutes(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Classifies a civil date. Priority is deliberate: a holiday that falls on a
// Saturday is still a holiday, and a scheduled rest day is never a workday.
export function classifyDay({ date, isHoliday, isWorkday }) {
  if (isHoliday) return 'feriado';
  if (!isWorkday) return 'folga';
  return 'util';
}

function punchMinutes(punch) {
  if (!punch) return null;
  if (punch.minutes != null) return punch.minutes;
  if (punch.time) return parseHHMMToMinutes(punch.time);
  return instantToSaoPauloMinutes(punch.punched_at);
}

function byType(punches, type) {
  return punches.find((p) => p && p.punch_type === type) || null;
}

/**
 * Minutes actually worked on a single day.
 *
 * Primary path pairs entrada→saida_intervalo and retorno_intervalo→saida, which
 * already excludes the break without needing to know how long it was. The
 * fallbacks cover punch sequences that don't follow that shape (a two-punch day
 * with no break marks, or an odd number of punches) and only then subtract the
 * break explicitly, so we never subtract it twice.
 */
export function workedMinutes(punches, { tolerance = 0, expectedEntry = null, expectedExit = null } = {}) {
  const list = (punches || []).slice().sort(
    (a, b) => new Date(a.punched_at || 0) - new Date(b.punched_at || 0)
  );
  if (list.length < 2) return 0;

  const entrada = byType(list, 'entrada');
  const saidaInt = byType(list, 'saida_intervalo');
  const retorno = byType(list, 'retorno_intervalo');
  const saida = byType(list, 'saida');

  let total = 0;

  // 1. Two clean periods: entrada → saida_intervalo, retorno_intervalo → saida.
  if (entrada && saidaInt && retorno && saida) {
    const a = punchMinutes(entrada);
    const b = punchMinutes(saidaInt);
    const c = punchMinutes(retorno);
    const d = punchMinutes(saida);
    if (a != null && b != null && b > a) total += b - a;
    if (c != null && d != null && d > c) total += d - c;
    return total;
  }

  // 2. entrada → saida with no break marks.
  if (entrada && saida) {
    const a = punchMinutes(entrada);
    const d = punchMinutes(saida);
    if (a != null && d != null && d > a) return d - a;
  }

  // 3. A full four-punch sequence missing one of the middle marks: subtract the
  //    interval between the two middle punches, capped so a missing mark can
  //    never invent a negative or absurd day.
  if (list.length >= 3) {
    const a = punchMinutes(list[0]);
    const d = punchMinutes(list[list.length - 1]);
    if (a != null && d != null && d > a) {
      const b = punchMinutes(list[1]);
      const c = punchMinutes(list[list.length - 2]);
      if (b != null && c != null && c > b) return Math.max(0, d - a - (c - b));
      return d - a;
    }
  }

  // 4. Last resort: first → last, but only when the day actually ends on an exit
  //    punch. A day whose last punch is an interval break is not closed.
  if (list.length >= 2) {
    const lastType = list[list.length - 1]?.punch_type;
    if (lastType === 'saida' || lastType === 'extraordinaria') {
      const a = punchMinutes(list[0]);
      const d = punchMinutes(list[list.length - 1]);
      if (a != null && d != null && d > a) return d - a;
    }
  }

  return total;
}

/**
 * Credit / debit for a day, in minutes.
 *
 * Credit is worked time beyond the expected workday. Debit is time short of it,
 * but only after the late/early-leave tolerance is consumed — arriving two
 * minutes late is not a two-minute debit.
 */
export function dayBalance({ punches, schedule = {}, dayType = 'util', tolerance = {} }) {
  const worked = workedMinutes(punches, schedule);
  const result = {
    workedMinutes: worked,
    creditMinutes: 0,
    debitMinutes: 0,
    dayType,
  };

  if (dayType !== 'util') return result;

  const expected = schedule.expectedMinutes
    ?? (() => {
      const e = schedule.entryMinutes ?? null;
      const x = schedule.exitMinutes ?? null;
      if (e == null || x == null) return 0;
      const span = x - e;
      return span > 0 ? span : 0;
    })();
  if (!expected) return result;

  const lateTol = tolerance.late ?? DEFAULT_LATE_TOLERANCE;
  const earlyTol = tolerance.early ?? DEFAULT_EARLY_TOLERANCE;
  const allowance = Math.max(0, lateTol) + Math.max(0, earlyTol);

  const delta = worked - expected;
  if (delta > 0) {
    result.creditMinutes = delta;
  } else {
    const short = Math.abs(delta) - allowance;
    if (short > 0) result.debitMinutes = short;
  }
  return result;
}

/**
 * Accumulates day results into period totals. Kept here so the totals row on
 * the screen and the totals row in the PDF come from one implementation.
 */
export function accumulate(days) {
  const totals = {
    workedMinutes: 0,
    creditMinutes: 0,
    debitMinutes: 0,
    balanceMinutes: 0,
    daysWorked: 0,
    daysAbsent: 0,
  };
  for (const day of days || []) {
    totals.workedMinutes += day.workedMinutes || 0;
    totals.creditMinutes += day.creditMinutes || 0;
    totals.debitMinutes += day.debitMinutes || 0;
    if (day.dayType === 'util') {
      if ((day.workedMinutes || 0) > 0) totals.daysWorked += 1;
      else totals.daysAbsent += 1;
    }
  }
  totals.balanceMinutes = totals.creditMinutes - totals.debitMinutes;
  totals.worked = formatHHMM(totals.workedMinutes);
  totals.credit = formatHHMM(totals.creditMinutes);
  totals.debit = formatHHMM(totals.debitMinutes);
  return totals;
}
