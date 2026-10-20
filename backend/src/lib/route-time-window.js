// Janela de horário das rotas do app do promotor interno.
//
// Uma rota do app de merchandising é identificada pela combinação
// (PDV, horário agendado). Um promotor pode ter duas rotas no MESMO PDV no
// mesmo dia — por exemplo 07:00 e 13:00 — e cada uma tem seu próprio
// check-in/check-out.
//
// Antes, "visita" era uma unidade por PDV por dia (UNIQUE em
// pdv_visits: promoter_id, pdv_id, visit_date) e o check-in era replicado
// para todas as rotas do PDV. Com isso o check-in das 07:00 validava também
// a rota das 13:00 e o promotor ficava travado.
//
// Aqui separamos os três conceitos:
//   rota  -> já existe em merch_routes
//   slot  -> rota + horário agendado (HH:MM)
//   visita-> o slot que foi check-inado
//
// O módulo é puro: sem banco, sem Date.now() implícito para o calendário
// civil. O chamador passa o instante atual.

export const TZ = 'America/Sao_Paulo';

// Tolerância padrão de check-in (mesma semântica de employee.punch_tolerance_minutes
// usada em routes/promotor.js:657-662). 0 é um valor válido, então nunca usar
// `||` aqui.
export const DEFAULT_CHECKIN_TOLERANCE_MIN = 15;

// Duração estimada padrão da rota, quando merch_routes.estimated_duration_min
// não foi preenchido.
export const DEFAULT_ESTIMATED_DURATION_MIN = 60;

export const NO_SLOT = '00:00';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Normaliza um valor TIME do Postgres ('07:00:00', '07:00', '7:00') para
 * 'HH:MM'. Retorna null quando o valor é ausente/inválido.
 */
export function normalizeTimeToHHMM(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    // pg devolve TIME como string, mas DATE/TIMESTAMP como Date.
    return null;
  }
  const raw = String(value).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

/** 'HH:MM' -> minutos desde a meia-noite. null se inválido. */
export function hhmmToMinutes(value) {
  const normalized = normalizeTimeToHHMM(value);
  if (!normalized) return null;
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

/** minutos desde a meia-noite -> 'HH:MM' (aceita > 24h sem quebrar). */
export function minutesToHHMM(minutes) {
  const total = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

/**
 * Chave do slot de uma rota: o horário agendado (ou a janela explícita, se
 * existir). Rotas sem horário caem em '00:00' — elas continuam funcionando,
 * apenas não ganham janela de check-in.
 */
export function routeSlotKey(route) {
  if (!route) return NO_SLOT;
  const explicit = normalizeTimeToHHMM(route.window_start);
  if (explicit) return explicit;
  const scheduled = normalizeTimeToHHMM(route.scheduled_time);
  if (scheduled) return scheduled;
  return NO_SLOT;
}

/**
 * Janela de check-in de uma rota.
 *
 *   abre  = scheduled_time - tolerancia
 *   fecha = scheduled_time + estimated_duration_min
 *
 * Quando a rota tem window_start/window_end explícitos, eles delimitam a
 * janela; a tolerância só antecipa a abertura.
 *
 * Retorna { hasWindow: false } quando não há informação suficiente de
 * horário — nesse caso o check-in é sempre liberado (nunca trancar uma rota
 * que não sabemos quando acontece).
 */
export function computeRouteWindow(route, options = {}) {
  const toleranceMin = options.toleranceMin ?? DEFAULT_CHECKIN_TOLERANCE_MIN;
  const durationMin = route?.estimated_duration_min ?? DEFAULT_ESTIMATED_DURATION_MIN;

  const scheduledMin = hhmmToMinutes(route?.scheduled_time);
  const windowStartMin = hhmmToMinutes(route?.window_start);
  const windowEndMin = hhmmToMinutes(route?.window_end);

  let startMin = windowStartMin;
  if (startMin === null) startMin = scheduledMin;
  if (startMin === null) {
    return { hasWindow: false, toleranceMin, opensAt: null, closesAt: null, slotKey: routeSlotKey(route) };
  }

  let endMin = windowEndMin;
  if (endMin === null) {
    const base = scheduledMin !== null ? scheduledMin : startMin;
    endMin = base + (Number(durationMin) || DEFAULT_ESTIMATED_DURATION_MIN);
  }
  if (endMin < startMin) endMin = startMin;

  return {
    hasWindow: true,
    toleranceMin,
    opensAt: startMin - toleranceMin,
    closesAt: endMin,
    slotKey: routeSlotKey(route),
  };
}

/**
 * Minutos desde a meia-noite de um instante, no fuso de São Paulo.
 */
export function instantToSaoPauloMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

/**
 * Avalia um check-in contra a janela da rota.
 *
 * Só o check-in cedo demais é bloqueado. Atraso é apenas aviso: bloquear
 * atraso quebraria a fila offline do app (4xx é terminal lá e a chamada
 * morreria em silêncio).
 */
export function evaluateCheckinTime(route, nowMinutes, options = {}) {
  const toleranceMin = options.toleranceMin ?? DEFAULT_CHECKIN_TOLERANCE_MIN;
  const window = computeRouteWindow(route, { toleranceMin });

  if (!window.hasWindow) {
    return {
      allowed: true, tooEarly: false, late: false, hasWindow: false,
      toleranceMin, opensAt: null, closesAt: null, slotKey: window.slotKey, message: null,
    };
  }

  const now = Number(nowMinutes);
  const opensAt = window.opensAt;
  const closesAt = window.closesAt;

  if (now < opensAt) {
    return {
      allowed: false, tooEarly: true, late: false, hasWindow: true,
      toleranceMin, opensAt, closesAt, slotKey: window.slotKey,
      message: `Check-in disponível a partir de ${minutesToHHMM(opensAt)}.`,
    };
  }

  if (now > closesAt) {
    return {
      allowed: true, tooEarly: false, late: true, hasWindow: true,
      toleranceMin, opensAt, closesAt, slotKey: window.slotKey,
      message: `Check-in registrado ${minutesToHHMM(now)} (após o horário da rota).`,
    };
  }

  return {
    allowed: true, tooEarly: false, late: false, hasWindow: true,
    toleranceMin, opensAt, closesAt, slotKey: window.slotKey, message: null,
  };
}

/**
 * Descrição serializável da janela, para enviar ao app.
 */
export function describeRouteWindow(route, options = {}) {
  const window = computeRouteWindow(route, options);
  return {
    has_window: window.hasWindow,
    opens_at: window.hasWindow ? minutesToHHMM(window.opensAt) : null,
    closes_at: window.hasWindow ? minutesToHHMM(window.closesAt) : null,
    tolerance_minutes: window.toleranceMin,
    slot_key: window.slotKey,
    scheduled_time: normalizeTimeToHHMM(route?.scheduled_time),
  };
}
