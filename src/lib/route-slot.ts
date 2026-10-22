// Slot de horário das rotas do app do promotor.
//
// Espelha backend/src/lib/route-time-window.js. Um promotor pode ter duas
// rotas no MESMO PDV no mesmo dia (07:00 e 13:00) e cada horário é um "slot"
// com check-in e checkout próprios.
//
// O slot é o HH:MM do horário agendado da rota. A visita (pdv_visits) guarda o
// slot em `slot_time` (TIME do Postgres) e o backend devolve `slot_key` já
// normalizado — mas o app também aceita a forma crua, por isso normalizamos
// aqui.

export const NO_SLOT = '00:00';

/** '07:00:00' | '07:00' | '7:00' -> 'HH:MM'. null se ausente/inválido. */
export function normalizeTimeToHHMM(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Slot de uma rota. Usa o `slot_key` que o backend já calculou quando
 * existe; senão cai em window_start -> scheduled_time -> '00:00'.
 */
export function routeSlotKey(route: any): string {
  if (!route) return NO_SLOT;
  const fromServer = normalizeTimeToHHMM(route.slot_key);
  if (fromServer) return fromServer;
  const explicit = normalizeTimeToHHMM(route.window_start);
  if (explicit) return explicit;
  const scheduled = normalizeTimeToHHMM(route.scheduled_time);
  if (scheduled) return scheduled;
  return NO_SLOT;
}

/** Slot de uma visita (pdv_visits). */
export function visitSlotKey(visit: any): string {
  if (!visit) return NO_SLOT;
  const fromServer = normalizeTimeToHHMM(visit.slot_key);
  if (fromServer) return fromServer;
  return normalizeTimeToHHMM(visit.slot_time) || NO_SLOT;
}

/**
 * A visita pertence ao slot da rota?
 *
 * O slot é o HORÁRIO, não a loja: duas rotas em lojas diferentes podem ter
 * o mesmo horário (e rotas sem horário caem todas no slot '00:00'). Por isso
 * o casamento precisa ser por PDV **e** por slot — casar só pelo horário
 * fazia o check-in de uma loja liberar as demais, pulando a geolocalização.
 */
export function isVisitOfSlot(visit: any, route: any): boolean {
  if (!visit || !route) return false;
  if (visitSlotKey(visit) !== routeSlotKey(route)) return false;
  // Sem PDV na rota não há como discriminar: mantém o casamento por slot.
  if (!route.pdv_id || !visit.pdv_id) return true;
  return String(visit.pdv_id) === String(route.pdv_id);
}

/** Existe visita COM check-in para o PDV e o slot da rota? */
export function hasCheckinForSlot(visits: any[] | undefined, route: any): boolean {
  if (!visits?.length) return false;
  return visits.some((v) => v.checkin_at && isVisitOfSlot(v, route));
}

/** Existe visita ABERTA (sem checkout) para o PDV e o slot da rota? */
export function hasOpenVisitForSlot(visits: any[] | undefined, route: any): boolean {
  if (!visits?.length) return false;
  return visits.some((v) => v.checkin_at && !v.checkout_at && isVisitOfSlot(v, route));
}

/** A rota já foi encerrada no PDV (visita do slot com checkout)? */
export function hasCheckoutForSlot(visits: any[] | undefined, route: any): boolean {
  if (!visits?.length) return false;
  return visits.some((v) => v.checkout_at && isVisitOfSlot(v, route));
}

/** 'HH:MM' -> minutos desde a meia-noite. */
export function hhmmToMinutes(value: unknown): number | null {
  const normalized = normalizeTimeToHHMM(value);
  if (!normalized) return null;
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

/**
 * A rota está dentro da janela de check-in agora?
 * Sem informação de horário (sem scheduled_time e sem window_start) => sempre
 * liberada — nunca trancar uma rota cujo horário não sabemos.
 */
export function isWithinCheckinWindow(route: any, nowMinutes: number): { allowed: boolean; message?: string } {
  const w = route?.time_window;
  const opensAt = hhmmToMinutes(w?.opens_at);
  const closesAt = hhmmToMinutes(w?.closes_at);
  if (opensAt === null || closesAt === null) return { allowed: true };
  if (nowMinutes < opensAt) {
    const hhmm = `${String(Math.floor(opensAt / 60)).padStart(2, '0')}:${String(opensAt % 60).padStart(2, '0')}`;
    return { allowed: false, message: `Check-in disponível a partir de ${hhmm}.` };
  }
  return { allowed: true };
}

/** Minutos desde a meia-noite em São Paulo (mesmo fuso do backend). */
export function currentSaoPauloMinutes(date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour === 24 ? 0 : hour) * 60 + minute;
}

/**
 * Avalia a janela de check-in de uma rota respeitando o toggle da
 * organização (`time_window.enforced`).
 *
 * Devolve `allowed: false` apenas quando o promotor chegou CEDO demais — o
 * atraso é só aviso (bloquear atraso quebraria a fila offline do app).
 * A mensagem já vem em português.
 */
export function evaluateCheckinWindow(route: any, nowMinutes: number): {
  allowed: boolean;
  tooEarly: boolean;
  late: boolean;
  enforced: boolean;
  opensAt: number | null;
  closesAt: number | null;
  message: string | null;
} {
  const w = route?.time_window;
  const enforced = w?.enforced === true;
  const opensAt = hhmmToMinutes(w?.opens_at);
  const closesAt = hhmmToMinutes(w?.closes_at);
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  if (!enforced || opensAt === null || closesAt === null) {
    return { allowed: true, tooEarly: false, late: false, enforced, opensAt, closesAt, message: null };
  }

  if (nowMinutes < opensAt) {
    return {
      allowed: false,
      tooEarly: true,
      late: false,
      enforced,
      opensAt,
      closesAt,
      message: `Fora do horário da rota. O check-in fica disponível a partir de ${hhmm(opensAt)}.`,
    };
  }

  if (nowMinutes > closesAt) {
    return {
      allowed: true,
      tooEarly: false,
      late: true,
      enforced,
      opensAt,
      closesAt,
      message: `Check-in registrado às ${hhmm(nowMinutes)}, após o horário da rota (${hhmm(opensAt)} — ${hhmm(closesAt)}).`,
    };
  }

  return { allowed: true, tooEarly: false, late: false, enforced, opensAt, closesAt, message: null };
}
