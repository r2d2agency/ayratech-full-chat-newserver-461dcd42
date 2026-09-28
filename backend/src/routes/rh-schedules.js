// RH — Escalas de trabalho, Totem de ponto e Exportação AFD (Portaria 671/2021)
import express from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logError } from '../logger.js';

const router = express.Router();

async function getUserOrgId(userId) {
  const r = await query(
    `SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return r.rows[0]?.organization_id;
}

let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;

  await query(`
    CREATE TABLE IF NOT EXISTS work_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(120) NOT NULL,
      schedule_type VARCHAR(20) NOT NULL DEFAULT '5x2',
      -- 5x2, 6x1, 12x36, 4x2, livre, personalizado
      weekly_hours NUMERIC(6,2) DEFAULT 44,
      daily_hours NUMERIC(6,2) DEFAULT 8.8,
      break_minutes INTEGER DEFAULT 60,
      entry_time TIME DEFAULT '08:00',
      exit_time TIME DEFAULT '17:48',
      break_start TIME DEFAULT '12:00',
      break_end TIME DEFAULT '13:00',
      workdays INTEGER[] DEFAULT '{1,2,3,4,5}'::int[], -- 0=dom..6=sab
      dsr_day INTEGER DEFAULT 0, -- descanso semanal remunerado
      tolerance_minutes INTEGER DEFAULT 10,
      night_shift BOOLEAN DEFAULT false,
      pattern JSONB DEFAULT '{}'::jsonb, -- para 12x36 e escalas complexas
      active BOOLEAN DEFAULT true,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ws_org ON work_schedules(organization_id);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS employee_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      schedule_id UUID NOT NULL REFERENCES work_schedules(id) ON DELETE RESTRICT,
      pdv_id UUID,
      start_date DATE NOT NULL DEFAULT CURRENT_DATE,
      end_date DATE,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_es_emp ON employee_schedules(employee_id);
    CREATE INDEX IF NOT EXISTS idx_es_org ON employee_schedules(organization_id);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS totem_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(120) NOT NULL,
      pdv_id UUID,
      device_token VARCHAR(80) NOT NULL UNIQUE,
      require_face BOOLEAN DEFAULT true,
      require_geo BOOLEAN DEFAULT false,
      active BOOLEAN DEFAULT true,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_totem_org ON totem_devices(organization_id);
    CREATE INDEX IF NOT EXISTS idx_totem_token ON totem_devices(device_token);
  `);

  // AFD sequence tracking (NSR — número sequencial de registro)
  await query(`
    CREATE TABLE IF NOT EXISTS afd_sequence (
      organization_id UUID PRIMARY KEY,
      last_nsr BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  tablesReady = true;
}

// ============================================================
// SCHEDULES (auth)
// ============================================================
router.get('/schedules', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const r = await query(
      `SELECT ws.*,
        (SELECT COUNT(*) FROM employee_schedules es WHERE es.schedule_id = ws.id AND es.active) as assigned_count
       FROM work_schedules ws WHERE ws.organization_id = $1 ORDER BY ws.name`,
      [orgId]
    );
    res.json(r.rows);
  } catch (err) { logError('rh.schedules.list', err); res.status(500).json({ error: err.message }); }
});

router.post('/schedules', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const b = req.body || {};
    const r = await query(
      `INSERT INTO work_schedules
        (organization_id, name, schedule_type, weekly_hours, daily_hours, break_minutes,
         entry_time, exit_time, break_start, break_end, workdays, dsr_day, tolerance_minutes,
         night_shift, pattern, active, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [orgId, b.name, b.schedule_type || '5x2', b.weekly_hours || 44, b.daily_hours || 8.8,
       b.break_minutes ?? 60, b.entry_time || '08:00', b.exit_time || '17:48',
       b.break_start || '12:00', b.break_end || '13:00',
       b.workdays || [1,2,3,4,5], b.dsr_day ?? 0, b.tolerance_minutes ?? 10,
       !!b.night_shift, b.pattern || {}, b.active !== false, b.notes || null]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('rh.schedules.create', err); res.status(500).json({ error: err.message }); }
});

router.put('/schedules/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const b = req.body || {};
    const r = await query(
      `UPDATE work_schedules SET
        name=COALESCE($1,name), schedule_type=COALESCE($2,schedule_type),
        weekly_hours=COALESCE($3,weekly_hours), daily_hours=COALESCE($4,daily_hours),
        break_minutes=COALESCE($5,break_minutes), entry_time=COALESCE($6,entry_time),
        exit_time=COALESCE($7,exit_time), break_start=COALESCE($8,break_start),
        break_end=COALESCE($9,break_end), workdays=COALESCE($10,workdays),
        dsr_day=COALESCE($11,dsr_day), tolerance_minutes=COALESCE($12,tolerance_minutes),
        night_shift=COALESCE($13,night_shift), pattern=COALESCE($14,pattern),
        active=COALESCE($15,active), notes=COALESCE($16,notes), updated_at=NOW()
       WHERE id=$17 AND organization_id=$18 RETURNING *`,
      [b.name, b.schedule_type, b.weekly_hours, b.daily_hours, b.break_minutes,
       b.entry_time, b.exit_time, b.break_start, b.break_end, b.workdays,
       b.dsr_day, b.tolerance_minutes, b.night_shift, b.pattern, b.active, b.notes,
       req.params.id, orgId]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('rh.schedules.update', err); res.status(500).json({ error: err.message }); }
});

router.delete('/schedules/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    await query(`DELETE FROM work_schedules WHERE id=$1 AND organization_id=$2`, [req.params.id, orgId]);
    res.json({ success: true });
  } catch (err) { logError('rh.schedules.delete', err); res.status(500).json({ error: err.message }); }
});

// Current active schedule for an employee
router.get('/employees/:id/schedule', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const r = await query(
      `SELECT es.*, ws.name as schedule_name, ws.schedule_type, ws.entry_time, ws.exit_time, ws.workdays, ws.pattern
       FROM employee_schedules es
       JOIN work_schedules ws ON ws.id = es.schedule_id
       WHERE es.employee_id = $1 AND es.organization_id = $2 AND es.active = true
       ORDER BY es.start_date DESC LIMIT 1`,
      [req.params.id, orgId]
    );
    res.json(r.rows[0] || null);
  } catch (err) { logError('rh.employee.schedule', err); res.status(500).json({ error: err.message }); }
});


router.get('/schedules/:id/assignments', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const r = await query(
      `SELECT es.*, e.full_name, e.cpf, p.name as pdv_name
       FROM employee_schedules es
       JOIN employees e ON e.id = es.employee_id
       LEFT JOIN pdvs p ON p.id = es.pdv_id
       WHERE es.schedule_id = $1 AND es.organization_id = $2
       ORDER BY es.active DESC, e.full_name`,
      [req.params.id, orgId]
    );
    res.json(r.rows);
  } catch (err) { logError('rh.schedules.assignments', err); res.status(500).json({ error: err.message }); }
});

router.post('/employee-schedules', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const b = req.body || {};
    // Deactivate previous assignment
    await query(
      `UPDATE employee_schedules SET active=false, end_date=CURRENT_DATE
       WHERE employee_id=$1 AND organization_id=$2 AND active=true`,
      [b.employee_id, orgId]
    );
    const r = await query(
      `INSERT INTO employee_schedules (organization_id, employee_id, schedule_id, pdv_id, start_date)
       VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE)) RETURNING *`,
      [orgId, b.employee_id, b.schedule_id, b.pdv_id || null, b.start_date || null]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('rh.employee_schedules.create', err); res.status(500).json({ error: err.message }); }
});

router.delete('/employee-schedules/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    await query(
      `UPDATE employee_schedules SET active=false, end_date=CURRENT_DATE
       WHERE id=$1 AND organization_id=$2`,
      [req.params.id, orgId]
    );
    res.json({ success: true });
  } catch (err) { logError('rh.employee_schedules.delete', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
// TOTEM DEVICES (auth)
// ============================================================
router.get('/totem-devices', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const r = await query(
      `SELECT td.*, p.name as pdv_name FROM totem_devices td
       LEFT JOIN pdvs p ON p.id = td.pdv_id
       WHERE td.organization_id = $1 ORDER BY td.created_at DESC`,
      [orgId]
    );
    res.json(r.rows);
  } catch (err) { logError('rh.totem.list', err); res.status(500).json({ error: err.message }); }
});

router.post('/totem-devices', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const b = req.body || {};
    const token = crypto.randomBytes(24).toString('hex');
    const r = await query(
      `INSERT INTO totem_devices (organization_id, name, pdv_id, device_token, require_face, require_geo)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, b.name, b.pdv_id || null, token, b.require_face !== false, !!b.require_geo]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('rh.totem.create', err); res.status(500).json({ error: err.message }); }
});

router.delete('/totem-devices/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    await query(`DELETE FROM totem_devices WHERE id=$1 AND organization_id=$2`, [req.params.id, orgId]);
    res.json({ success: true });
  } catch (err) { logError('rh.totem.delete', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
// TOTEM PUBLIC API (device_token auth)
// ============================================================
async function totemAuth(req, res, next) {
  try {
    await ensureTables();
    const token = req.headers['x-totem-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'Token de totem ausente' });
    const r = await query(
      `SELECT td.*, o.id as org_id FROM totem_devices td
       JOIN organizations o ON o.id = td.organization_id
       WHERE td.device_token = $1 AND td.active = true LIMIT 1`,
      [token]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Totem inválido' });
    req.totem = r.rows[0];
    await query(`UPDATE totem_devices SET last_seen_at=NOW() WHERE id=$1`, [r.rows[0].id]);
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// Totem: lookup employee by CPF and return face descriptor
router.post('/totem/lookup', totemAuth, async (req, res) => {
  try {
    const cpf = String(req.body?.cpf || '').replace(/\D/g, '');
    if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido' });
    const r = await query(
      `SELECT id, full_name, face_descriptor, face_photo_url, status
       FROM employees WHERE organization_id=$1 AND regexp_replace(cpf,'[^0-9]','','g')=$2 LIMIT 1`,
      [req.totem.organization_id, cpf]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Colaborador não encontrado' });
    const e = r.rows[0];
    if (e.status && String(e.status).toLowerCase() === 'desligado') {
      return res.status(403).json({ error: 'Colaborador desligado' });
    }
    res.json({
      employee_id: e.id,
      full_name: e.full_name,
      face_photo_url: e.face_photo_url,
      face_descriptor: typeof e.face_descriptor === 'string' ? JSON.parse(e.face_descriptor) : e.face_descriptor,
      require_face: req.totem.require_face,
    });
  } catch (err) { logError('rh.totem.lookup', err); res.status(500).json({ error: err.message }); }
});

// Totem: face-only roster (returns employees with facial descriptor for 1:N match)
router.post('/totem/roster', totemAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, full_name, face_descriptor, face_photo_url
       FROM employees
       WHERE organization_id=$1
         AND (status IS NULL OR lower(status) <> 'desligado')
         AND face_descriptor IS NOT NULL`,
      [req.totem.organization_id]
    );
    const rows = r.rows.map(e => ({
      employee_id: e.id,
      full_name: e.full_name,
      face_photo_url: e.face_photo_url,
      face_descriptor: typeof e.face_descriptor === 'string' ? JSON.parse(e.face_descriptor) : e.face_descriptor,
    })).filter(e => Array.isArray(e.face_descriptor) && e.face_descriptor.length > 0);
    res.json({ employees: rows, require_face: req.totem.require_face });
  } catch (err) { logError('rh.totem.roster', err); res.status(500).json({ error: err.message }); }
});

// Totem: register punch
router.post('/totem/punch', totemAuth, async (req, res) => {
  try {
    const { employee_id, punch_type, latitude, longitude, face_match_score } = req.body || {};
    if (!employee_id) return res.status(400).json({ error: 'employee_id obrigatório' });
    const employee = await query(`SELECT employment_type FROM employees WHERE id = $1 AND organization_id = $2`, [employee_id, req.totem.organization_id]);
    const employmentType = String(employee.rows[0]?.employment_type || 'clt').trim().toLowerCase();
    if (['pj', 'freelance', 'freelancer'].includes(employmentType)) {
      return res.status(403).json({ error: 'O registro de ponto não está disponível para este tipo de contratação.', code: 'EMPLOYMENT_TYPE_NOT_ELIGIBLE' });
    }

    // Determine punch_type automatically if not provided (alternate entrada/saida)
    let type = punch_type;
    if (!type) {
      const today = new Date().toISOString().slice(0,10);
      const last = await query(
        `SELECT punch_type FROM time_punches
         WHERE employee_id=$1 AND punched_at::date=$2
         ORDER BY punched_at DESC LIMIT 1`,
        [employee_id, today]
      );
      const order = ['entrada','saida_intervalo','retorno_intervalo','saida'];
      const idx = last.rows.length ? order.indexOf(last.rows[0].punch_type) : -1;
      type = order[(idx + 1) % order.length];
    }

    const r = await query(
      `INSERT INTO time_punches
        (organization_id, employee_id, punch_type, punched_at, latitude, longitude, pdv_id,
         geo_status, device_info, sync_status)
       VALUES ($1,$2,$3,NOW(),$4,$5,$6,'dentro_area',$7,'synced') RETURNING *`,
      [req.totem.organization_id, employee_id, type,
       latitude || null, longitude || null, req.totem.pdv_id || null,
       JSON.stringify({ totem: req.totem.name, face_score: face_match_score })]
    );
    res.json({ success: true, punch: r.rows[0] });
  } catch (err) { logError('rh.totem.punch', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
// AFD EXPORT (Portaria MTE 671/2021)
// ============================================================
// Formato NSR|Tipo|Conteúdo — usamos o layout REP-P simplificado

function pad(s, n, ch = '0') { s = String(s || ''); return s.length >= n ? s.slice(0,n) : ch.repeat(n - s.length) + s; }
function padR(s, n, ch = ' ') { s = String(s || ''); return s.length >= n ? s.slice(0,n) : s + ch.repeat(n - s.length); }
function onlyDigits(s) { return String(s || '').replace(/\D/g,''); }
function afdDate(d) {
  const dt = new Date(d);
  return `${pad(dt.getDate(),2)}${pad(dt.getMonth()+1,2)}${dt.getFullYear()}`;
}
function afdTime(d) {
  const dt = new Date(d);
  return `${pad(dt.getHours(),2)}${pad(dt.getMinutes(),2)}`;
}

router.get('/afd/export', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgId = await getUserOrgId(req.userId);
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start e end são obrigatórios (YYYY-MM-DD)' });

    const org = await query(`SELECT name, cnpj FROM organizations WHERE id=$1`, [orgId]);
    const punches = await query(
      `SELECT tp.*, e.cpf, e.pis, e.full_name
       FROM time_punches tp
       JOIN employees e ON e.id = tp.employee_id
       WHERE tp.organization_id = $1
         AND tp.punched_at::date BETWEEN $2 AND $3
       ORDER BY tp.punched_at ASC`,
      [orgId, start, end]
    );

    const now = new Date();
    const lines = [];
    let nsr = 1;
    const cnpj = pad(onlyDigits(org.rows[0]?.cnpj), 14);
    const empName = padR(org.rows[0]?.name || 'EMPREGADOR', 150);

    // Header (tipo 1)
    lines.push(
      pad(nsr++, 9) + '1' + '2' + cnpj + pad('',12) +
      empName + afdDate(start) + afdDate(end) + afdDate(now) + afdTime(now)
    );

    // Registros de marcação (tipo 3)
    for (const p of punches.rows) {
      const cpf = pad(onlyDigits(p.cpf), 11);
      const pis = pad(onlyDigits(p.pis), 12);
      lines.push(
        pad(nsr++, 9) + '3' + afdDate(p.punched_at) + afdTime(p.punched_at) + pis + cpf
      );
    }

    // Trailer (tipo 9)
    lines.push(pad(nsr, 9) + '9' + pad(punches.rows.length, 9) + pad(0,9) + pad(0,9) + pad(0,9));

    // Update NSR sequence
    await query(
      `INSERT INTO afd_sequence (organization_id, last_nsr, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (organization_id) DO UPDATE SET last_nsr=EXCLUDED.last_nsr, updated_at=NOW()`,
      [orgId, nsr]
    );

    const content = lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="AFD_${cnpj}_${start}_${end}.txt"`);
    res.send(content);
  } catch (err) { logError('rh.afd.export', err); res.status(500).json({ error: err.message }); }
});

export default router;
