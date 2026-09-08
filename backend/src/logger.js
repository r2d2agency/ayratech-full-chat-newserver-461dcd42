import crypto from 'crypto';
import { getRequestContext } from './request-context.js';

const LOG_BUFFER_MAX = 500;
const runtimeLogBuffer = []; // newest first

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    // Fallback in case of circular refs
    return JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'logger.stringify_failed' });
  }
}

function pushRuntimeLog(line) {
  runtimeLogBuffer.unshift(line);
  if (runtimeLogBuffer.length > LOG_BUFFER_MAX) runtimeLogBuffer.length = LOG_BUFFER_MAX;
}

// Erros e falhas ("error"/"fatal") também são persistidos no banco. O buffer
// acima é pequeno (500 linhas) e compartilhado por TODOS os níveis — sob
// volume normal de logs de rotina (http.request/http.response, sync, etc.),
// um erro visto agora pode sumir da lista em poucos minutos, e some de vez
// quando o servidor reinicia. Persistir só error/fatal evita esse acúmulo de
// escrita para os níveis mais barulhentos (info/debug), que continuam só em
// memória.
let ensuredErrorLogsTable = false;
async function ensureSystemErrorLogsTable(pool) {
  if (ensuredErrorLogsTable) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_error_logs (
      id UUID PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      level VARCHAR(10) NOT NULL,
      event TEXT,
      user_id UUID,
      user_email TEXT,
      employee_id UUID,
      employee_name TEXT,
      ip TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_error_logs_ts ON system_error_logs(ts DESC)`);
  ensuredErrorLogsTable = true;
}

// Usa pool.query() diretamente (não o query() envolto de db.js) de propósito:
// se a própria escrita de persistência falhar, db.js chamaria logError() de
// volta, o que tentaria persistir de novo — risco de loop. Com pool.query()
// direto, uma falha aqui só cai no catch abaixo e vira um console.error simples.
async function persistIfSevere(line) {
  if (line.level !== 'error' && line.level !== 'fatal') return;
  try {
    const { pool } = await import('./db.js');
    await ensureSystemErrorLogsTable(pool);
    await pool.query(
      `INSERT INTO system_error_logs (id, ts, level, event, user_id, user_email, employee_id, employee_name, ip, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        line.id,
        line.ts,
        line.level,
        line.event || null,
        line.user_id || line.userId || null,
        line.user_email || null,
        line.employee_id || null,
        line.employee_name || null,
        line.ip || null,
        safeJson(line),
      ]
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[logger] falha ao persistir log de erro:', err?.message);
  }
}

export function getRecentLogs({ limit = 100, eventPrefixes = [], level = null } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), LOG_BUFFER_MAX);
  return runtimeLogBuffer
    .filter((entry) => {
      const levelOk = !level || entry.level === level;
      const eventOk = !Array.isArray(eventPrefixes) || eventPrefixes.length === 0
        ? true
        : eventPrefixes.some((prefix) => String(entry.event || '').startsWith(prefix));
      return levelOk && eventOk;
    })
    .slice(0, safeLimit);
}

export function log(level, event, payload = {}) {
  const ctx = getRequestContext();
  const line = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level,
    event,
    ...(ctx || {}),
    ...payload,
  };

  pushRuntimeLog(line);
  void persistIfSevere(line);

  // Always write structured logs as single-line JSON
  // eslint-disable-next-line no-console
  console.log(safeJson(line));
}

// Special function to log from the frontend
export function logFromClient(level, event, payload = {}) {
  const line = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level,
    event,
    source: 'client',
    ...payload,
  };

  pushRuntimeLog(line);
  void persistIfSevere(line);
  // eslint-disable-next-line no-console
  console.log(safeJson(line));
}

export function logInfo(event, payload) {
  log('info', event, payload);
}

export function logWarn(event, payload) {
  log('warn', event, payload);
}

export function logError(event, error, payload = {}) {
  const err = error || {};
  log('error', event, {
    ...payload,
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
      detail: err.detail,
      hint: err.hint,
      where: err.where,
      schema: err.schema,
      table: err.table,
      column: err.column,
      constraint: err.constraint,
      position: err.position,
      routine: err.routine,
    },
  });
}
