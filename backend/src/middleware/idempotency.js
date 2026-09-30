import crypto from 'node:crypto';
import { query } from '../db.js';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const REPLAYABLE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function stableValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function fingerprint(req, scopeKey) {
  const payload = JSON.stringify({
    method: req.method,
    path: req.baseUrl + req.path,
    query: stableValue(req.query || {}),
    body: stableValue(req.body || {}),
    scopeKey,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function scopeFor(req) {
  const user = req.userId || req.promotorId || req.user?.id || 'anonymous';
  const organization = req.orgId || req.organizationId || '';
  return `${user}:${organization}`;
}

/**
 * Idempotência opt-in: só atua quando o cliente envia X-Idempotency-Key.
 * Assim, endpoints antigos continuam compatíveis, enquanto a fila offline
 * recebe replay seguro após timeout, reload ou reconexão.
 */
export async function idempotency(req, res, next) {
  if (!REPLAYABLE_METHODS.has(req.method)) return next();

  const rawKey = req.get('X-Idempotency-Key');
  if (!rawKey) return next();
  const key = String(rawKey).trim();
  if (!KEY_PATTERN.test(key)) {
    return res.status(400).json({ error: 'X-Idempotency-Key inválida' });
  }

  const scopeKey = scopeFor(req);
  const requestFingerprint = fingerprint(req, scopeKey);
  const existing = await query(
    `SELECT * FROM api_idempotency_keys
     WHERE scope_key=$1 AND idempotency_key=$2
       AND expires_at > NOW()
     FOR UPDATE`,
    [scopeKey, key],
  );

  if (existing.rows.length) {
    const record = existing.rows[0];
    if (record.request_fingerprint !== requestFingerprint) {
      return res.status(409).json({ error: 'A chave de idempotência foi reutilizada com dados diferentes' });
    }
    if (record.status === 'completed' && record.response_status) {
      if (record.response_headers && typeof record.response_headers === 'object') {
        for (const [header, value] of Object.entries(record.response_headers)) res.setHeader(header, value);
      }
      return res.status(record.response_status).json(record.response_body);
    }
    if (record.status === 'in_progress') {
      return res.status(409).json({ error: 'Esta operação já está sendo processada', retryable: true });
    }
  } else {
    await query(
      `INSERT INTO api_idempotency_keys
       (scope_key, idempotency_key, request_fingerprint, status)
       VALUES ($1, $2, $3, 'in_progress')
       ON CONFLICT (scope_key, idempotency_key) DO NOTHING`,
      [scopeKey, key, requestFingerprint],
    );
  }

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  let completed = false;
  const persist = async (statusCode, body) => {
    if (completed) return;
    completed = true;
    const safeBody = body === undefined ? null : body;
    await query(
      `UPDATE api_idempotency_keys
       SET status='completed', response_status=$3, response_headers=$4::jsonb,
           response_body=$5::jsonb, updated_at=NOW()
       WHERE scope_key=$1 AND idempotency_key=$2 AND request_fingerprint=$6`,
      [scopeKey, key, statusCode, JSON.stringify({ 'content-type': 'application/json' }), JSON.stringify(safeBody), requestFingerprint],
    );
  };

  res.json = (body) => {
    void persist(res.statusCode, body).catch(() => {});
    return originalJson(body);
  };
  res.send = (body) => {
    if (typeof body === 'object' || body === null) void persist(res.statusCode, body).catch(() => {});
    return originalSend(body);
  };

  res.once('finish', () => {
    if (!completed && res.statusCode >= 400) {
      void query(
        `UPDATE api_idempotency_keys SET status='failed', updated_at=NOW()
         WHERE scope_key=$1 AND idempotency_key=$2`,
        [scopeKey, key],
      ).catch(() => {});
    }
  });
  return next();
}

export async function cleanupIdempotencyKeys() {
  await query(`DELETE FROM api_idempotency_keys WHERE expires_at <= NOW()`);
}
