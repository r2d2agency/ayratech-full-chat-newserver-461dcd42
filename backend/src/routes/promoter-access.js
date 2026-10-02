// =============================================================================
// External Promoter Access Portal
//
// Two flows for external companies that don't use Ayratech:
//   1) Public agency self-signup -> Network approval -> creates agency + login
//   2) Promoter PWA: login (CPF+password) -> scan FIXED PDV QR ->
//      validations (docs, schedule window, GPS) -> check-in / check-out
//
// All tables created lazily via ensureSchema() (project standard).
// =============================================================================

import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { query } from '../db.js';
import { logError, logInfo } from '../logger.js';
import { validatePdvLocation, recordGeofenceAttempt } from '../lib/geofence.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_PROMOTER_APP = 'promoter-app';

// ---------------------------------------------------------------------------
// Schema bootstrap (just-in-time)
// ---------------------------------------------------------------------------
let schemaReady = null;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    // 1) Agency self-signup queue
    await query(`CREATE TABLE IF NOT EXISTS agency_signup_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID,
      network_id UUID,
      company_name VARCHAR(255) NOT NULL,
      cnpj VARCHAR(20),
      responsible_name VARCHAR(255) NOT NULL,
      responsible_phone VARCHAR(30),
      responsible_email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      city VARCHAR(120),
      state VARCHAR(2),
      desired_networks JSONB DEFAULT '[]',
      message TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      review_notes TEXT,
      reviewed_by UUID,
      reviewed_at TIMESTAMPTZ,
      created_agency_id UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_asr_status ON agency_signup_requests(status, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_asr_network ON agency_signup_requests(network_id, status)`);

    // 2) Fixed QR per PDV (one active token per unit)
    await query(`CREATE TABLE IF NOT EXISTS pdv_fixed_qrcodes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      supermarket_unit_id UUID NOT NULL,
      organization_id UUID,
      network_id UUID,
      token VARCHAR(64) NOT NULL UNIQUE,
      active BOOLEAN DEFAULT true,
      created_by UUID,
      printed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pfq_active
      ON pdv_fixed_qrcodes(supermarket_unit_id) WHERE active = true`).catch(() => {});

    // 3) Promoter app users (login for external agency promoters)
    await query(`CREATE TABLE IF NOT EXISTS promoter_app_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agency_promoter_id UUID NOT NULL UNIQUE,
      agency_id UUID NOT NULL,
      organization_id UUID,
      cpf VARCHAR(14) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      last_login TIMESTAMPTZ,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // 4) Promoter schedules
    await query(`CREATE TABLE IF NOT EXISTS promoter_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agency_promoter_id UUID NOT NULL,
      agency_id UUID NOT NULL,
      supermarket_unit_id UUID NOT NULL,
      brand_id UUID,
      scheduled_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      tolerance_min INTEGER DEFAULT 30,
      notes TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ps_promoter_date ON promoter_schedules(agency_promoter_id, scheduled_date)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ps_unit_date ON promoter_schedules(supermarket_unit_id, scheduled_date)`);

    // 5) Promoter visits (check-in/check-out journal)
    await query(`CREATE TABLE IF NOT EXISTS promoter_visits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agency_promoter_id UUID NOT NULL,
      agency_id UUID NOT NULL,
      supermarket_unit_id UUID NOT NULL,
      schedule_id UUID,
      qr_token VARCHAR(64),
      checkin_at TIMESTAMPTZ,
      checkout_at TIMESTAMPTZ,
      checkin_lat NUMERIC(10,7),
      checkin_lng NUMERIC(10,7),
      checkin_accuracy NUMERIC(8,2),
      checkin_distance_m INTEGER,
      checkout_lat NUMERIC(10,7),
      checkout_lng NUMERIC(10,7),
      validations_snapshot JSONB DEFAULT '{}',
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      denied_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pv_promoter ON promoter_visits(agency_promoter_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pv_unit ON promoter_visits(supermarket_unit_id, created_at DESC)`);
    // CREATE TABLE IF NOT EXISTS does not add columns to a table that already
    // exists, so environments provisioned before this feature need the ALTER.
    await query(`ALTER TABLE supermarket_units ADD COLUMN IF NOT EXISTS geofence_polygon JSONB`).catch(() => {});
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pv_one_open
      ON promoter_visits(agency_promoter_id) WHERE status='open'`).catch(() => {});
  })();
  try { await schemaReady; } catch (e) { schemaReady = null; throw e; }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// Sao Paulo "today" date string YYYY-MM-DD
function spTodayDate() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

// Sao Paulo current HH:MM:SS
function spNowTime() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  return fmt.format(new Date());
}

function authPromoterApp(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const d = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    if (d.type !== JWT_PROMOTER_APP) return res.status(403).json({ error: 'Acesso restrito' });
    req.promoterAppUserId = d.userId;
    req.agencyPromoterId = d.agencyPromoterId;
    req.agencyId = d.agencyId;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

function authNetwork(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const d = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    if (d.type !== 'network') return res.status(403).json({ error: 'Acesso restrito a rede' });
    req.networkUserId = d.userId; req.networkId = d.networkId; req.orgId = d.orgId;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

// =============================================================================
// 1) PUBLIC: Agency self-signup
// =============================================================================
router.post('/agency-signup', async (req, res) => {
  await ensureSchema();
  try {
    const {
      company_name, cnpj, responsible_name, responsible_phone, responsible_email,
      password, city, state, desired_networks = [], message,
    } = req.body || {};

    if (!company_name || !responsible_name || !responsible_email || !password) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    }

    const exists = await query(
      `SELECT id FROM agency_users WHERE email=$1 LIMIT 1`,
      [responsible_email]
    ).catch(() => ({ rows: [] }));
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Já existe um login com este e-mail' });
    }

    // Resolve a network (and its organization) for the new agency.
    // The signup form sends `desired_networks` as an array of supermarket_networks.id.
    let networkId = null;
    let organizationId = null;
    const firstUuid = (Array.isArray(desired_networks) ? desired_networks : [])
      .find((v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v));
    if (firstUuid) {
      const n = await query(
        `SELECT id, organization_id FROM supermarket_networks WHERE id = $1 AND active = true LIMIT 1`,
        [firstUuid]
      ).catch(() => ({ rows: [] }));
      if (n.rows.length) {
        networkId = n.rows[0].id;
        organizationId = n.rows[0].organization_id;
      }
    }
    if (!organizationId) {
      // Fallback: first network available (single-tenant scenario)
      const fb = await query(
        `SELECT id, organization_id FROM supermarket_networks WHERE active = true ORDER BY created_at ASC LIMIT 1`
      ).catch(() => ({ rows: [] }));
      if (fb.rows.length) {
        networkId = networkId || fb.rows[0].id;
        organizationId = fb.rows[0].organization_id;
      }
    }
    if (!organizationId) {
      return res.status(400).json({ error: 'Nenhuma rede disponível para cadastro' });
    }

    const hash = await bcrypt.hash(password, 10);

    // Create agency immediately (active, no approval gate)
    const agencyR = await query(
      `INSERT INTO agencies (organization_id, name, cnpj, responsible_name, responsible_phone,
        responsible_email, city, state, max_promoters, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10) RETURNING id`,
      [organizationId, company_name, onlyDigits(cnpj) || null, responsible_name,
       responsible_phone || null, responsible_email, city || null, state || null,
       10, message || null]
    );
    const agencyId = agencyR.rows[0].id;

    // Create login
    await query(
      `INSERT INTO agency_users (agency_id, email, password_hash, name, role, active)
       VALUES ($1,$2,$3,$4,'admin',true)`,
      [agencyId, responsible_email, hash, responsible_name]
    );

    // Keep a record of the self-signup for audit, already marked approved
    await query(
      `INSERT INTO agency_signup_requests
       (organization_id, network_id, company_name, cnpj, responsible_name, responsible_phone,
        responsible_email, password_hash, city, state, desired_networks, message,
        status, created_agency_id, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,'approved',$13, NOW())`,
      [organizationId, networkId, company_name, onlyDigits(cnpj) || null, responsible_name,
       responsible_phone || null, responsible_email, hash, city || null, state || null,
       JSON.stringify(desired_networks), message || null, agencyId]
    ).catch(() => {});

    res.json({ ok: true, agency_id: agencyId, login_ready: true });
  } catch (err) {
    logError('promoter-access.agency-signup', err);
    res.status(500).json({ error: 'Erro ao registrar cadastro' });
  }
});


// Public list of networks (for the signup form)
router.get('/public/networks', async (_req, res) => {
  await ensureSchema();
  try {
    const r = await query(
      `SELECT id, name FROM supermarket_networks WHERE active = true ORDER BY name`
    ).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch { res.json([]); }
});

// =============================================================================
// 2) NETWORK: Manage agency signup requests
// =============================================================================
router.get('/network-portal/agency-signups', authNetwork, async (req, res) => {
  await ensureSchema();
  try {
    const { status = 'pending' } = req.query;
    const r = await query(
      `SELECT id, company_name, cnpj, responsible_name, responsible_phone, responsible_email,
              city, state, desired_networks, message, status, review_notes, created_at, reviewed_at
       FROM agency_signup_requests
       WHERE status = $1 AND (network_id IS NULL OR network_id = $2)
       ORDER BY created_at DESC LIMIT 200`,
      [status, req.networkId]
    );
    res.json(r.rows);
  } catch (err) {
    logError('promoter-access.signups.list', err);
    res.status(500).json({ error: 'Erro ao listar' });
  }
});

router.post('/network-portal/agency-signups/:id/approve', authNetwork, async (req, res) => {
  await ensureSchema();
  try {
    const { id } = req.params;
    const { notes, max_promoters = 10 } = req.body || {};
    const reqR = await query(
      `SELECT * FROM agency_signup_requests WHERE id=$1 AND status='pending'`,
      [id]
    );
    if (!reqR.rows.length) return res.status(404).json({ error: 'Solicitação não encontrada' });
    const sr = reqR.rows[0];

    // Create agency
    const agencyR = await query(
      `INSERT INTO agencies (organization_id, name, cnpj, responsible_name, responsible_phone,
        responsible_email, city, state, max_promoters, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active') RETURNING id`,
      [req.orgId || null, sr.company_name, sr.cnpj, sr.responsible_name, sr.responsible_phone,
       sr.responsible_email, sr.city, sr.state, max_promoters]
    );
    const agencyId = agencyR.rows[0].id;

    // Create agency_users login
    await query(
      `INSERT INTO agency_users (agency_id, email, password_hash, name, role)
       VALUES ($1,$2,$3,$4,'admin')`,
      [agencyId, sr.responsible_email, sr.password_hash, sr.responsible_name]
    ).catch(async () => {
      // email already taken
    });

    await query(
      `UPDATE agency_signup_requests
       SET status='approved', review_notes=$1, reviewed_by=$2, reviewed_at=NOW(),
           created_agency_id=$3, updated_at=NOW()
       WHERE id=$4`,
      [notes || null, req.networkUserId, agencyId, id]
    );

    res.json({ ok: true, agency_id: agencyId });
  } catch (err) {
    logError('promoter-access.signups.approve', err);
    res.status(500).json({ error: 'Erro ao aprovar' });
  }
});

router.post('/network-portal/agency-signups/:id/reject', authNetwork, async (req, res) => {
  await ensureSchema();
  try {
    const { id } = req.params;
    const { notes } = req.body || {};
    await query(
      `UPDATE agency_signup_requests
       SET status='rejected', review_notes=$1, reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
       WHERE id=$3 AND status='pending'`,
      [notes || null, req.networkUserId, id]
    );
    res.json({ ok: true });
  } catch (err) {
    logError('promoter-access.signups.reject', err);
    res.status(500).json({ error: 'Erro ao rejeitar' });
  }
});

// =============================================================================
// 3) NETWORK: Fixed QR per PDV (generate / list / print payload)
// =============================================================================
router.get('/network-portal/pdv-qrcodes', authNetwork, async (req, res) => {
  await ensureSchema();
  try {
    const r = await query(
      `SELECT su.id AS unit_id, su.name AS unit_name, su.city, su.state, su.address,
              q.id AS qr_id, q.token, q.active, q.created_at, q.printed_at
       FROM supermarket_units su
       LEFT JOIN pdv_fixed_qrcodes q ON q.supermarket_unit_id = su.id AND q.active = true
       WHERE su.network_id = $1 AND su.active = true
       ORDER BY su.name`,
      [req.networkId]
    );
    res.json(r.rows);
  } catch (err) {
    logError('promoter-access.qr.list', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.post('/network-portal/pdv-qrcodes/:unitId/generate', authNetwork, async (req, res) => {
  await ensureSchema();
  try {
    const { unitId } = req.params;
    const unitR = await query(
      `SELECT id, network_id, organization_id FROM supermarket_units WHERE id=$1 AND network_id=$2`,
      [unitId, req.networkId]
    );
    if (!unitR.rows.length) return res.status(404).json({ error: 'PDV não encontrado nesta rede' });

    // Revoke existing
    await query(`UPDATE pdv_fixed_qrcodes SET active=false, revoked_at=NOW()
                 WHERE supermarket_unit_id=$1 AND active=true`, [unitId]);

    const token = `pdv_${crypto.randomBytes(20).toString('hex')}`;
    const r = await query(
      `INSERT INTO pdv_fixed_qrcodes (supermarket_unit_id, organization_id, network_id, token, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, token, created_at`,
      [unitId, unitR.rows[0].organization_id, req.networkId, token, req.networkUserId]
    );
    res.json(r.rows[0]);
  } catch (err) {
    logError('promoter-access.qr.generate', err);
    res.status(500).json({ error: 'Erro ao gerar QR' });
  }
});

router.get('/network-portal/pdv-qrcodes/:unitId/print', authNetwork, async (req, res) => {
  await ensureSchema();
  try {
    const { unitId } = req.params;
    const r = await query(
      `SELECT su.id, su.name, su.address, su.city, su.state, q.token
       FROM supermarket_units su
       JOIN pdv_fixed_qrcodes q ON q.supermarket_unit_id = su.id AND q.active = true
       WHERE su.id = $1 AND su.network_id = $2`,
      [unitId, req.networkId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'QR não encontrado, gere um primeiro' });
    const row = r.rows[0];
    const dataUrl = await QRCode.toDataURL(row.token, { width: 600, margin: 2 });
    await query(`UPDATE pdv_fixed_qrcodes SET printed_at=NOW() WHERE supermarket_unit_id=$1 AND active=true`, [unitId]);
    res.json({
      unit: { id: row.id, name: row.name, address: row.address, city: row.city, state: row.state },
      token: row.token,
      qr_image: dataUrl,
    });
  } catch (err) {
    logError('promoter-access.qr.print', err);
    res.status(500).json({ error: 'Erro ao gerar imagem' });
  }
});

// =============================================================================
// 4) AGENCY: Manage promoter app credentials & schedules
// =============================================================================
function authAgency(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const d = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    if (d.type !== 'agency') return res.status(403).json({ error: 'Acesso restrito a agência' });
    req.agencyUserId = d.userId; req.agencyId = d.agencyId; req.orgId = d.orgId;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

// Set/reset promoter app credentials (CPF auto from agency_promoters)
router.post('/agency/promoter-credentials/:promoterId', authAgency, async (req, res) => {
  await ensureSchema();
  try {
    const { promoterId } = req.params;
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
    }
    const pR = await query(
      `SELECT id, cpf, agency_id FROM agency_promoters WHERE id=$1 AND agency_id=$2`,
      [promoterId, req.agencyId]
    );
    if (!pR.rows.length) return res.status(404).json({ error: 'Promotor não encontrado' });
    const cpf = onlyDigits(pR.rows[0].cpf);
    const hash = await bcrypt.hash(password, 10);
    await query(
      `INSERT INTO promoter_app_users (agency_promoter_id, agency_id, organization_id, cpf, password_hash)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agency_promoter_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, updated_at=NOW(), active=true`,
      [promoterId, req.agencyId, req.orgId || null, cpf, hash]
    );
    res.json({ ok: true, cpf });
  } catch (err) {
    logError('promoter-access.credentials.set', err);
    res.status(500).json({ error: 'Erro ao definir credenciais' });
  }
});

// Schedules
router.get('/agency/schedules', authAgency, async (req, res) => {
  await ensureSchema();
  try {
    const { from, to } = req.query;
    const params = [req.agencyId];
    let sql = `SELECT ps.*, ap.name AS promoter_name, su.name AS unit_name
               FROM promoter_schedules ps
               JOIN agency_promoters ap ON ap.id = ps.agency_promoter_id
               JOIN supermarket_units su ON su.id = ps.supermarket_unit_id
               WHERE ps.agency_id = $1`;
    if (from) { params.push(from); sql += ` AND ps.scheduled_date >= $${params.length}`; }
    if (to)   { params.push(to);   sql += ` AND ps.scheduled_date <= $${params.length}`; }
    sql += ` ORDER BY ps.scheduled_date DESC, ps.start_time LIMIT 500`;
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) {
    logError('promoter-access.schedules.list', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.post('/agency/schedules', authAgency, async (req, res) => {
  await ensureSchema();
  try {
    const {
      agency_promoter_id, supermarket_unit_id, brand_id,
      scheduled_date, start_time, end_time, tolerance_min, notes,
    } = req.body || {};
    if (!agency_promoter_id || !supermarket_unit_id || !scheduled_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }
    const r = await query(
      `INSERT INTO promoter_schedules
       (agency_promoter_id, agency_id, supermarket_unit_id, brand_id,
        scheduled_date, start_time, end_time, tolerance_min, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [agency_promoter_id, req.agencyId, supermarket_unit_id, brand_id || null,
       scheduled_date, start_time, end_time, tolerance_min || 30, notes || null, req.agencyUserId]
    );
    res.json(r.rows[0]);
  } catch (err) {
    logError('promoter-access.schedules.create', err);
    res.status(500).json({ error: 'Erro ao criar escala' });
  }
});

router.delete('/agency/schedules/:id', authAgency, async (req, res) => {
  await ensureSchema();
  try {
    await query(`DELETE FROM promoter_schedules WHERE id=$1 AND agency_id=$2`, [req.params.id, req.agencyId]);
    res.json({ ok: true });
  } catch (err) {
    logError('promoter-access.schedules.delete', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================================================
// 5) PROMOTER APP (PWA): auth + scan + check-in / check-out
// =============================================================================
router.post('/promoter-app/login', async (req, res) => {
  await ensureSchema();
  try {
    const { cpf, password } = req.body || {};
    const cpfDigits = onlyDigits(cpf);
    if (!cpfDigits || !password) return res.status(400).json({ error: 'CPF e senha obrigatórios' });

    const r = await query(
      `SELECT pau.*, ap.name AS promoter_name, ap.phone, ap.photo_url, ap.status AS promoter_status,
              a.name AS agency_name
       FROM promoter_app_users pau
       JOIN agency_promoters ap ON ap.id = pau.agency_promoter_id
       JOIN agencies a ON a.id = pau.agency_id
       WHERE pau.cpf = $1 AND pau.active = true LIMIT 1`,
      [cpfDigits]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'CPF ou senha inválidos' });
    const u = r.rows[0];
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) return res.status(401).json({ error: 'CPF ou senha inválidos' });

    await query(`UPDATE promoter_app_users SET last_login=NOW() WHERE id=$1`, [u.id]);

    const token = jwt.sign(
      { type: JWT_PROMOTER_APP, userId: u.id, agencyPromoterId: u.agency_promoter_id, agencyId: u.agency_id },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({
      token,
      user: {
        id: u.id,
        agency_promoter_id: u.agency_promoter_id,
        name: u.promoter_name,
        cpf: u.cpf,
        agency_name: u.agency_name,
        photo_url: u.photo_url,
        status: u.promoter_status,
      },
    });
  } catch (err) {
    logError('promoter-access.app.login', err);
    res.status(500).json({ error: 'Erro no login' });
  }
});

router.get('/promoter-app/me', authPromoterApp, async (req, res) => {
  await ensureSchema();
  try {
    const today = spTodayDate();
    const userR = await query(
      `SELECT pau.id, pau.cpf, ap.name, ap.phone, ap.photo_url, ap.status AS doc_status,
              a.id AS agency_id, a.name AS agency_name
       FROM promoter_app_users pau
       JOIN agency_promoters ap ON ap.id = pau.agency_promoter_id
       JOIN agencies a ON a.id = pau.agency_id
       WHERE pau.id = $1`, [req.promoterAppUserId]
    );

    const schedR = await query(
      `SELECT ps.id, ps.scheduled_date, ps.start_time, ps.end_time, ps.tolerance_min,
              su.name AS unit_name, su.city, su.state, su.id AS unit_id
       FROM promoter_schedules ps
       JOIN supermarket_units su ON su.id = ps.supermarket_unit_id
       WHERE ps.agency_promoter_id = $1 AND ps.scheduled_date = $2::date
       ORDER BY ps.start_time`,
      [req.agencyPromoterId, today]
    );

    const openR = await query(
      `SELECT pv.*, su.name AS unit_name
       FROM promoter_visits pv
       JOIN supermarket_units su ON su.id = pv.supermarket_unit_id
       WHERE pv.agency_promoter_id = $1 AND pv.status = 'open' LIMIT 1`,
      [req.agencyPromoterId]
    );

    res.json({
      user: userR.rows[0] || null,
      today: today,
      schedules: schedR.rows,
      open_visit: openR.rows[0] || null,
    });
  } catch (err) {
    logError('promoter-access.app.me', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// The PWA runs the same geofence check in the browser before it will call
// /promoter-app/checkin, so a promoter standing outside the area is turned away
// without the server ever hearing about it. That refusal used to leave no trace
// at all -- nothing in the tracking journal, nothing to answer "why could he
// not check in". This endpoint records the attempt the client blocked.
router.post('/promoter-app/geo-attempt', authPromoterApp, async (req, res) => {
  try {
    const { lat, lng, accuracy, pdv_id, pdv_name, mode, distance_meters, radius_meters } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Localização (GPS) obrigatória' });
    }
    // The PDV coordinates are read from the server, never taken from the body:
    // the client is the party being judged here, so its version of the
    // perimeter is not evidence.
    let unit = null;
    if (pdv_id) {
      // Same guard as the check-in route: an environment provisioned before the
      // polygon feature may not have the column, and asking for it blindly
      // would abort the whole insert.
      let hasUnitPolygon = false;
      try {
        const colR = await query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_name = 'supermarket_units' AND column_name = 'geofence_polygon' LIMIT 1`
        );
        hasUnitPolygon = colR.rows.length > 0;
      } catch (_) { hasUnitPolygon = false; }
      const r = await query(
        `SELECT su.id AS unit_id, su.name AS unit_name, su.organization_id,
                su.latitude, su.longitude, su.radius_meters,
                ${hasUnitPolygon ? 'su.geofence_polygon' : 'NULL::jsonb'} AS geofence_polygon
           FROM supermarket_units su
          WHERE su.id = $1`,
        [pdv_id]
      );
      unit = r.rows[0] || null;
    }
    let linkedEmployeeId = null;
    try {
      const empR = await query(
        `SELECT employee_id FROM agency_promoters WHERE id = $1`, [req.agencyPromoterId]
      );
      linkedEmployeeId = empR.rows[0]?.employee_id || null;
    } catch (_) { /* promoter without employee link */ }
    await recordGeofenceAttempt(query, {
      organizationId: unit?.organization_id || null,
      promoterId: linkedEmployeeId || req.agencyPromoterId,
      pdvId: unit?.unit_id || pdv_id || null,
      latitude: lat,
      longitude: lng,
      accuracyMeters: accuracy ?? null,
      accepted: false,
      matchedBy: null,
      mode: mode === 'polygon' ? 'polygon' : 'radius',
      distanceMeters: distance_meters ?? null,
      radiusMeters: radius_meters ?? null,
      polygonVertices: Array.isArray(unit?.geofence_polygon) ? unit.geofence_polygon.length : null,
      reasonCode: 'CLIENT_BLOCKED',
      reason: pdv_name
        ? `Tentativa de check-in fora da área autorizada — ${pdv_name}.`
        : 'Tentativa de check-in fora da área autorizada.',
      action: 'checkin',
      deviceInfo: req.headers['user-agent'] || null,
    });
    res.json({ ok: true });
  } catch (err) {
    // Never fail the promoter flow over a diagnostic write.
    logError('promoter-access.app.geo-attempt', err);
    res.status(200).json({ ok: false });
  }
});

router.post('/promoter-app/checkin', authPromoterApp, async (req, res) => {
  await ensureSchema();
  try {
    const { qr_token, lat, lng, accuracy } = req.body || {};
    if (!qr_token) return res.status(400).json({ error: 'QR Code não informado' });
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Localização (GPS) obrigatória' });
    }

    const snapshot = { gps: false, schedule: false, docs: false, qr: false };
    let deniedReason = null;

    // ---- 1) QR -> resolve unit
    // The polygon column may not exist on an environment provisioned before
    // this feature, and a missing column aborts the whole query -- including
    // the check-in itself. Ask for it only once it is known to be there.
    let hasUnitPolygon = false;
    try {
      const colR = await query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'supermarket_units' AND column_name = 'geofence_polygon' LIMIT 1`
      );
      hasUnitPolygon = colR.rows.length > 0;
    } catch (_) { hasUnitPolygon = false; }

    const qrR = await query(
      `SELECT q.token, q.active, su.id AS unit_id, su.name AS unit_name, su.latitude, su.longitude,
              su.radius_meters, su.network_id, su.organization_id,
              ${hasUnitPolygon ? 'su.geofence_polygon' : 'NULL::jsonb'} AS geofence_polygon
       FROM pdv_fixed_qrcodes q
       JOIN supermarket_units su ON su.id = q.supermarket_unit_id
       WHERE q.token = $1 LIMIT 1`,
      [qr_token]
    );
    if (!qrR.rows.length || !qrR.rows[0].active) {
      deniedReason = 'QR Code inválido ou desativado';
    } else {
      snapshot.qr = true;
    }

    let unit = qrR.rows[0];

    // ---- 2) Docs (agency_promoters.status must be 'active')
    let docOk = false;
    if (!deniedReason) {
      const docR = await query(
        `SELECT status FROM agency_promoters WHERE id=$1`,
        [req.agencyPromoterId]
      );
      docOk = docR.rows[0]?.status === 'active';
      snapshot.docs = docOk;
      if (!docOk) deniedReason = 'Documentação do promotor pendente ou bloqueada';
    }

    // ---- 3) Schedule window
    let scheduleId = null;
    if (!deniedReason) {
      const today = spTodayDate();
      const now = spNowTime();
      const sR = await query(
        `SELECT id, start_time, end_time, tolerance_min
         FROM promoter_schedules
         WHERE agency_promoter_id=$1 AND supermarket_unit_id=$2 AND scheduled_date=$3::date`,
        [req.agencyPromoterId, unit.unit_id, today]
      );
      const matching = sR.rows.find((s) => {
        const tol = (s.tolerance_min || 30) * 60 * 1000;
        const toMs = (hms) => {
          const [h, m, sec] = hms.split(':').map(Number);
          return ((h * 60 + m) * 60 + (sec || 0)) * 1000;
        };
        const nowMs = toMs(now);
        return nowMs >= toMs(s.start_time) - tol && nowMs <= toMs(s.end_time) + tol;
      });
      if (matching) {
        scheduleId = matching.id;
        snapshot.schedule = true;
      } else {
        deniedReason = 'Sem escala válida para este PDV neste horário';
      }
    }

    // ---- 4) GPS
    //
    // This used to compute the radius inline, so a PDV with a drawn polygon was
    // judged by the radius alone while the punch endpoint honoured the polygon.
    // The same person standing in the same place was accepted by one and
    // refused by the other. validatePdvLocation accepts either rule, which is
    // what makes the two agree.
    let distance = null;
    let geoMode = null;
    let geoMatchedBy = null;
    if (!deniedReason) {
      const check = validatePdvLocation({
        userLat: lat, userLng: lng,
        pdvLat: unit.latitude, pdvLng: unit.longitude,
        radiusMeters: unit.radius_meters,
        polygon: unit.geofence_polygon || null,
      });
      distance = check.distance;
      geoMode = check.mode;
      if (check.status === 'inside') {
        snapshot.gps = true;
        geoMatchedBy = check.mode;
      } else if (check.status === 'unknown') {
        // No PDV coordinates and no polygon: nothing to check against.
        snapshot.gps = true;
      } else {
        const radius = unit.radius_meters || 200;
        const where = geoMode === 'polygon' ? 'do polígono' : 'do centro';
        deniedReason = `Você está a ${Math.round(distance)}m ${where} do PDV (máx. ${radius}m)`;
      }
    }

    // Block second open visit
    if (!deniedReason) {
      const openR = await query(
        `SELECT id FROM promoter_visits WHERE agency_promoter_id=$1 AND status='open' LIMIT 1`,
        [req.agencyPromoterId]
      );
      if (openR.rows.length) deniedReason = 'Já existe um check-in em andamento. Faça check-out antes.';
    }

    const status = deniedReason ? 'denied' : 'open';
    const insR = await query(
      `INSERT INTO promoter_visits
       (agency_promoter_id, agency_id, supermarket_unit_id, schedule_id, qr_token,
        checkin_at, checkin_lat, checkin_lng, checkin_accuracy, checkin_distance_m,
        validations_snapshot, status, denied_reason)
       VALUES ($1,$2,$3,$4,$5, ${deniedReason ? 'NULL' : 'NOW()'}, $6,$7,$8,$9,$10::jsonb,$11,$12)
       RETURNING *`,
      [req.agencyPromoterId, req.agencyId, unit?.unit_id || null, scheduleId, qr_token,
       lat, lng, accuracy || null, distance, JSON.stringify(snapshot), status, deniedReason]
    );

    // Log the attempt either way. A refused check-in is the row an operator
    // needs when the promoter calls saying they were standing right there.
    //
    // The RH tracks people through employees.id, but req.agencyPromoterId is
    // agency_promoters.id. Those are different ids for the same person, and
    // writing the promoter id here left every row invisible to the tracking
    // screen even though the insert succeeded. Resolve the employee link.
    let linkedEmployeeId = null;
    try {
      const empR = await query(
        `SELECT employee_id FROM agency_promoters WHERE id = $1`, [req.agencyPromoterId]
      );
      linkedEmployeeId = empR.rows[0]?.employee_id || null;
    } catch (_) { /* promoter without employee link */ }

    await recordGeofenceAttempt(query, {
      organizationId: unit?.organization_id || null,
      // Fall back to the promoter id when there is no employee link: an
      // external promoter has no employee record, and losing the attempt would
      // be worse than storing an id the RH filter will not match.
      promoterId: linkedEmployeeId || req.agencyPromoterId,
      pdvId: unit?.unit_id || null,
      latitude: lat,
      longitude: lng,
      accuracyMeters: accuracy ?? null,
      accepted: !deniedReason,
      matchedBy: geoMatchedBy,
      mode: geoMode,
      distanceMeters: distance,
      radiusMeters: unit?.radius_meters ?? null,
      polygonVertices: Array.isArray(unit?.geofence_polygon) ? unit.geofence_polygon.length : null,
      reasonCode: deniedReason ? 'DENIED' : 'ACCEPTED',
      reason: deniedReason,
      action: 'checkin',
      deviceInfo: req.headers['user-agent'] || null,
    });

    if (deniedReason) return res.status(403).json({ ok: false, reason: deniedReason, visit: insR.rows[0] });
    res.json({ ok: true, visit: insR.rows[0], unit: { id: unit.unit_id, name: unit.unit_name } });
  } catch (err) {
    logError('promoter-access.app.checkin', err);
    res.status(500).json({ error: 'Erro no check-in' });
  }
});

router.post('/promoter-app/checkout', authPromoterApp, async (req, res) => {
  await ensureSchema();
  try {
    const { lat, lng } = req.body || {};
    const r = await query(
      `UPDATE promoter_visits SET status='closed', checkout_at=NOW(),
        checkout_lat=$1, checkout_lng=$2, updated_at=NOW()
       WHERE agency_promoter_id=$3 AND status='open'
       RETURNING *`,
      [lat ?? null, lng ?? null, req.agencyPromoterId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nenhuma visita em andamento' });
    res.json({ ok: true, visit: r.rows[0] });
  } catch (err) {
    logError('promoter-access.app.checkout', err);
    res.status(500).json({ error: 'Erro no check-out' });
  }
});

router.get('/promoter-app/visits', authPromoterApp, async (req, res) => {
  await ensureSchema();
  try {
    const r = await query(
      `SELECT pv.id, pv.checkin_at, pv.checkout_at, pv.status, pv.denied_reason,
              pv.checkin_distance_m, pv.validations_snapshot, su.name AS unit_name
       FROM promoter_visits pv
       JOIN supermarket_units su ON su.id = pv.supermarket_unit_id
       WHERE pv.agency_promoter_id = $1
       ORDER BY pv.created_at DESC LIMIT 100`,
      [req.agencyPromoterId]
    );
    res.json(r.rows);
  } catch (err) {
    logError('promoter-access.app.visits', err);
    res.status(500).json({ error: 'Erro' });
  }
});

export default router;
