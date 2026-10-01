import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logInfo, logError } from '../logger.js';
import { triggerValidation } from './promoter-validations.js';

const router = express.Router();

// ============ HELPER: get org from authenticated user ============
async function getOrgId(req) {
  // If orgId is already in the request (from auth middleware), use it
  if (req.orgId) return req.orgId;

  // Fallback to database lookup
  if (req.userId) {
    const r = await query('SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1', [req.userId]);
    return r.rows[0]?.organization_id;
  }
  return null;
}


const onlyDigits = (value) => String(value || '').replace(/\D/g, '');
const tableExists = async (tableName) => {
  const result = await query('SELECT to_regclass($1) AS regclass', [tableName]);
  return Boolean(result.rows[0]?.regclass);
};
const normalizePhotoUrl = (value) => {
  if (typeof value !== 'string') return value || null;
  const trimmed = value.trim();
  return trimmed || null;
};

const DEFAULT_TOTEM_BRANDING = {
  totem_primary_color: '#3b82f6',
  totem_secondary_color: '#1e293b',
  totem_bg_color: '#0f172a',
  totem_button_color: '#3b82f6',
  totem_button_text_color: '#ffffff',
  totem_header_text: 'Controle de Acesso',
  totem_slogan: '',
  totem_pdv_name: '',
};

let supermarketPortalSchemaReadyPromise = null;
async function ensureSupermarketPortalSchema() {
  if (supermarketPortalSchemaReadyPromise) return supermarketPortalSchemaReadyPromise;

  supermarketPortalSchemaReadyPromise = (async () => {
    await query(`
      ALTER TABLE supermarket_units
        ADD COLUMN IF NOT EXISTS logo_url TEXT,
        ADD COLUMN IF NOT EXISTS totem_primary_color TEXT,
        ADD COLUMN IF NOT EXISTS totem_secondary_color TEXT,
        ADD COLUMN IF NOT EXISTS totem_bg_color TEXT,
        ADD COLUMN IF NOT EXISTS totem_button_color TEXT,
        ADD COLUMN IF NOT EXISTS totem_button_text_color TEXT,
        ADD COLUMN IF NOT EXISTS totem_header_text TEXT,
        ADD COLUMN IF NOT EXISTS totem_slogan TEXT,
        ADD COLUMN IF NOT EXISTS totem_pdv_name TEXT
    `);
  })();

  try {
    await supermarketPortalSchemaReadyPromise;
  } catch (error) {
    supermarketPortalSchemaReadyPromise = null;
    throw error;
  }
}

let promoterConformitySchemaReadyPromise = null;
async function ensurePromoterConformitySchema() {
  if (promoterConformitySchemaReadyPromise) return promoterConformitySchemaReadyPromise;

  promoterConformitySchemaReadyPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS promoter_conformity (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        agency_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE CASCADE,
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        network_id UUID REFERENCES supermarket_networks(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        reason TEXT,
        photo_quality_score NUMERIC(5,2),
        photo_resolution_ok BOOLEAN DEFAULT false,
        photo_frontal_ok BOOLEAN DEFAULT false,
        photo_illumination_ok BOOLEAN DEFAULT false,
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        notified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT chk_conformity_promoter CHECK (agency_promoter_id IS NOT NULL OR employee_id IS NOT NULL)
      )
    `);

    await query('CREATE INDEX IF NOT EXISTS idx_conformity_org ON promoter_conformity(organization_id, status)');

    await query(`
      CREATE TABLE IF NOT EXISTS facial_comparison_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supermarket_unit_id UUID REFERENCES supermarket_units(id) ON DELETE SET NULL,
        agency_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE SET NULL,
        employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
        entry_log_id UUID REFERENCES pdv_entry_logs(id) ON DELETE SET NULL,
        comparison_type VARCHAR(30) NOT NULL DEFAULT 'entry_vs_base',
        base_image_url TEXT,
        captured_image_url TEXT,
        confidence_score NUMERIC(5,2),
        result VARCHAR(20) NOT NULL DEFAULT 'pending',
        processing_time_ms INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query('CREATE INDEX IF NOT EXISTS idx_facial_logs_org ON facial_comparison_logs(organization_id, created_at)');

    await query(`
      CREATE TABLE IF NOT EXISTS conformity_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
        agency_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE CASCADE,
        employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
        network_id UUID NOT NULL REFERENCES supermarket_networks(id) ON DELETE CASCADE,
        notification_type VARCHAR(30) NOT NULL DEFAULT 'photo_non_conform',
        message TEXT,
        channel VARCHAR(20) DEFAULT 'system',
        sent_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query('CREATE INDEX IF NOT EXISTS idx_conformity_notif_agency ON conformity_notifications(agency_id, read_at)');

    await query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY agency_promoter_id, employee_id, network_id
                 ORDER BY updated_at DESC NULLS LAST, checked_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
               ) AS rn
        FROM promoter_conformity
      )
      DELETE FROM promoter_conformity pc
      USING ranked r
      WHERE pc.id = r.id
        AND r.rn > 1
    `);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_promoter_conformity_agency_network_unique
      ON promoter_conformity (agency_promoter_id, network_id)
      WHERE agency_promoter_id IS NOT NULL
    `);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_promoter_conformity_employee_network_unique
      ON promoter_conformity (employee_id, network_id)
      WHERE employee_id IS NOT NULL
    `);
  })();

  try {
    await promoterConformitySchemaReadyPromise;
  } catch (error) {
    promoterConformitySchemaReadyPromise = null;
    throw error;
  }
}
const isValidPhone = (value) => {
  if (!value) return true;
  const digits = onlyDigits(value);
  return digits.length === 10 || digits.length === 11;
};
const isValidCpf = (value) => {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)+$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(cpf[i]) * (10 - i);
  let remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(cpf[i]) * (11 - i);
  remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  return remainder === Number(cpf[10]);
};
const isValidCnpj = (value) => {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || /^(\d)+$/.test(cnpj)) return false;
  const calcDigit = (base, factors) => {
    const total = factors.reduce((acc, factor, index) => acc + Number(base[index]) * factor, 0);
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const base = cnpj.slice(0, 12);
  const firstDigit = calcDigit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const secondDigit = calcDigit(`${base}${firstDigit}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return cnpj === `${base}${firstDigit}${secondDigit}`;
};

// ============ MIDDLEWARE: Totem auth ============
const authenticateTotem = async (req, res, next) => {
  const token = req.headers['x-totem-token'];
  if (!token) return res.status(401).json({ error: 'Token do totem não fornecido' });
  try {
    const r = await query(
      `SELECT su.id as unit_id, su.organization_id FROM supermarket_units su
       WHERE su.totem_token = $1 AND su.totem_enabled = true AND su.active = true`,
      [token]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Totem não autorizado' });
    req.unitId = r.rows[0].unit_id;
    req.orgId = r.rows[0].organization_id;
    next();
  } catch (err) {
    logError('totem.auth_failed', err);
    res.status(500).json({ error: 'Erro de autenticação do totem' });
  }
};

// ============ MIDDLEWARE: Agency auth ============
const authenticateAgency = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
    if (decoded.type !== 'agency') return res.status(403).json({ error: 'Acesso restrito a agências' });
    req.agencyUserId = decoded.userId;
    req.agencyId = decoded.agencyId;
    req.orgId = decoded.orgId;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// ============ MIDDLEWARE: Supermarket auth ============
const authenticateSupermarket = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
    if (decoded.type !== 'supermarket') return res.status(403).json({ error: 'Acesso restrito a supermercados' });
    req.supermarketUserId = decoded.userId;
    req.unitId = decoded.unitId;
    req.networkId = decoded.networkId;
    req.canViewAllNetwork = decoded.canViewAllNetwork;
    req.orgId = decoded.orgId;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// =====================================================================
// ADMIN ROUTES (authenticated Ayratech users)
// =====================================================================

// --- Supermarket Networks CRUD ---
router.get('/networks', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const r = await query('SELECT * FROM supermarket_networks WHERE organization_id = $1 ORDER BY name', [orgId]);
    res.json(r.rows);
  } catch (err) { logError('access.networks.list', err); res.status(500).json({ error: 'Erro ao listar redes' }); }
});

router.post('/networks', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { name, cnpj, contact_name, contact_phone, contact_email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
    const r = await query(
      `INSERT INTO supermarket_networks (organization_id, name, cnpj, contact_name, contact_phone, contact_email, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId, name, cnpj || null, contact_name || null, contact_phone || null, contact_email || null, notes || null]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('access.networks.create', err); res.status(500).json({ error: 'Erro ao criar rede' }); }
});

router.put('/networks/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { name, cnpj, contact_name, contact_phone, contact_email, notes, active } = req.body;
    const r = await query(
      `UPDATE supermarket_networks SET name=COALESCE($1,name), cnpj=$2, contact_name=$3, contact_phone=$4,
       contact_email=$5, notes=$6, active=COALESCE($7,active), updated_at=NOW()
       WHERE id=$8 AND organization_id=$9 RETURNING *`,
      [name, cnpj||null, contact_name||null, contact_phone||null, contact_email||null, notes||null, active, req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Rede não encontrada' });
    res.json(r.rows[0]);
  } catch (err) { logError('access.networks.update', err); res.status(500).json({ error: 'Erro ao atualizar rede' }); }
});

router.delete('/networks/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await query('DELETE FROM supermarket_networks WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    res.json({ ok: true });
  } catch (err) { logError('access.networks.delete', err); res.status(500).json({ error: 'Erro ao excluir rede' }); }
});

// --- Supermarket Units CRUD ---
router.get('/units', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { network_id } = req.query;
    let sql = `SELECT su.*, sn.name as network_name FROM supermarket_units su
               LEFT JOIN supermarket_networks sn ON sn.id = su.network_id
               WHERE su.organization_id = $1`;
    const params = [orgId];
    if (network_id) { sql += ' AND su.network_id = $2'; params.push(network_id); }
    sql += ' ORDER BY su.name';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.units.list', err); res.status(500).json({ error: 'Erro ao listar unidades' }); }
});

router.post('/units', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { name, cnpj, network_id, pdv_id, address, city, state, zip_code, neighborhood, latitude, longitude,
            radius_meters, opening_time, closing_time, operating_days, operational_requirements, totem_enabled } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
    if (cnpj && !isValidCnpj(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' });
    const totemToken = totem_enabled ? crypto.randomBytes(32).toString('hex') : null;
    const r = await query(
      `INSERT INTO supermarket_units (organization_id, name, cnpj, network_id, pdv_id, address, city, state, zip_code,
       neighborhood, latitude, longitude, radius_meters, opening_time, closing_time, operating_days,
       operational_requirements, totem_enabled, totem_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [orgId, name, onlyDigits(cnpj) || null, network_id||null, pdv_id||null, address||null, city||null, state||null, zip_code||null,
       neighborhood||null, latitude||null, longitude||null, radius_meters||200, opening_time||'06:00', closing_time||'22:00',
       JSON.stringify(operating_days || [1,2,3,4,5,6]), operational_requirements||null, totem_enabled||false, totemToken]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('access.units.create', err); res.status(500).json({ error: 'Erro ao criar unidade' }); }
});

router.put('/units/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { name, cnpj, network_id, pdv_id, address, city, state, zip_code, neighborhood, latitude, longitude,
            radius_meters, opening_time, closing_time, operating_days, operational_requirements, totem_enabled, active } = req.body;
    if (cnpj && !isValidCnpj(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' });
    let totemToken = undefined;
    if (totem_enabled) {
        const existing = await query('SELECT totem_token FROM supermarket_units WHERE id=$1', [req.params.id]);
       if (!existing.rows[0]?.totem_token) totemToken = crypto.randomBytes(32).toString('hex');
    }
    const r = await query(
      `UPDATE supermarket_units SET name=COALESCE($1,name), cnpj=$2, network_id=$3, pdv_id=$4, address=$5,
       city=$6, state=$7, zip_code=$8, neighborhood=$9, latitude=$10, longitude=$11, radius_meters=COALESCE($12,radius_meters),
       opening_time=COALESCE($13,opening_time), closing_time=COALESCE($14,closing_time),
       operating_days=COALESCE($15,operating_days), operational_requirements=$16,
       totem_enabled=COALESCE($17,totem_enabled), totem_token=COALESCE($18,totem_token),
       active=COALESCE($19,active), updated_at=NOW()
       WHERE id=$20 AND organization_id=$21 RETURNING *`,
      [name, onlyDigits(cnpj) || null, network_id||null, pdv_id||null, address||null, city||null, state||null, zip_code||null,
       neighborhood||null, latitude||null, longitude||null, radius_meters, opening_time, closing_time,
       operating_days ? JSON.stringify(operating_days) : undefined, operational_requirements||null,
       totem_enabled, totemToken, active, req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unidade não encontrada' });
    res.json(r.rows[0]);
  } catch (err) { logError('access.units.update', err); res.status(500).json({ error: 'Erro ao atualizar unidade' }); }
});

router.delete('/units/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await query('DELETE FROM supermarket_units WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    res.json({ ok: true });
  } catch (err) { logError('access.units.delete', err); res.status(500).json({ error: 'Erro ao excluir unidade' }); }
});

// Regenerate totem token
router.post('/units/:id/regenerate-token', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const newToken = crypto.randomBytes(32).toString('hex');
    const r = await query(
      'UPDATE supermarket_units SET totem_token=$1, totem_enabled=true, updated_at=NOW() WHERE id=$2 AND organization_id=$3 RETURNING totem_token',
      [newToken, req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unidade não encontrada' });
    res.json({ totem_token: r.rows[0].totem_token });
  } catch (err) { logError('access.units.regen_token', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/units/:id/supermarket-user', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const r = await query(
      `SELECT su_user.id, su_user.email, su_user.name, su_user.role, su_user.can_view_all_network,
              su_user.active, su_user.supermarket_unit_id, su_user.network_id, su_user.created_at
       FROM supermarket_users su_user
       JOIN supermarket_units su ON su.id = su_user.supermarket_unit_id
       WHERE su_user.supermarket_unit_id = $1 AND su.organization_id = $2
       ORDER BY su_user.created_at DESC
       LIMIT 1`,
      [req.params.id, orgId]
    );
    res.json(r.rows[0] || null);
  } catch (err) { logError('access.supermarket_user.get', err); res.status(500).json({ error: 'Erro ao carregar acesso do supermercado' }); }
});

// --- Agencies CRUD ---
router.get('/agencies', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const r = await query(
      `SELECT a.*, s.plan_id, s.promoter_count as contracted_promoters,
              (SELECT COUNT(*) FROM agency_promoters ap WHERE ap.agency_id = a.id AND ap.status = 'active') as promoter_count
       FROM agencies a
       LEFT JOIN agency_subscriptions s ON s.agency_id = a.id
       WHERE a.organization_id = $1
       ORDER BY a.name`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('access.agencies.list', err); res.status(500).json({ error: 'Erro ao listar agências' }); }
});

router.post('/agencies', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { name, cnpj, responsible_name, responsible_cpf, responsible_phone, responsible_email, address, city, state,
            plan_name, max_promoters, price_per_promoter, auto_block_on_overdue, notes, plan_id, contracted_promoters } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
    if (cnpj && !isValidCnpj(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' });
    if (responsible_cpf && !isValidCpf(responsible_cpf)) return res.status(400).json({ error: 'CPF do responsável inválido' });
    if (responsible_phone && !isValidPhone(responsible_phone)) return res.status(400).json({ error: 'Telefone inválido' });

    // If plan_id provided, fetch plan to get price
    let finalPrice = price_per_promoter || 0;
    let finalPlanName = plan_name || null;
    let finalMax = max_promoters || 10;
    if (plan_id) {
      const plan = await query('SELECT * FROM agency_billing_plans WHERE id=$1 AND organization_id=$2', [plan_id, orgId]);
      if (plan.rows.length) {
        finalPrice = plan.rows[0].price_per_promoter;
        finalPlanName = plan.rows[0].name;
        if (plan.rows[0].max_promoters) finalMax = plan.rows[0].max_promoters;
      }
    }
    const contractedCount = contracted_promoters || finalMax;

    const r = await query(
      `INSERT INTO agencies (organization_id, name, cnpj, responsible_name, responsible_cpf, responsible_phone, responsible_email,
       address, city, state, plan_name, max_promoters, price_per_promoter, auto_block_on_overdue, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [orgId, name, onlyDigits(cnpj) || null, responsible_name||null, onlyDigits(responsible_cpf) || null, onlyDigits(responsible_phone) || null, responsible_email?.trim().toLowerCase() || null,
       address||null, city||null, state||null, finalPlanName, contractedCount, finalPrice,
       auto_block_on_overdue||false, notes||null]
    );
    const agency = r.rows[0];

    // Auto-create subscription if plan_id provided
    if (plan_id) {
      const amount = contractedCount * parseFloat(finalPrice);
      await query(
        `INSERT INTO agency_subscriptions (agency_id, plan_id, promoter_count, amount_due)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [agency.id, plan_id, contractedCount, amount]
      );
    }

    res.json(agency);
  } catch (err) { logError('access.agencies.create', err); res.status(500).json({ error: 'Erro ao criar agência' }); }
});

router.put('/agencies/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { name, cnpj, responsible_name, responsible_cpf, responsible_phone, responsible_email, address, city, state,
            plan_name, max_promoters, price_per_promoter, auto_block_on_overdue, status, billing_status, notes, plan_id, contracted_promoters } = req.body;
    if (cnpj && !isValidCnpj(cnpj)) return res.status(400).json({ error: 'CNPJ inválido' });
    if (responsible_cpf && !isValidCpf(responsible_cpf)) return res.status(400).json({ error: 'CPF do responsável inválido' });
    if (responsible_phone && !isValidPhone(responsible_phone)) return res.status(400).json({ error: 'Telefone inválido' });

    let finalPrice = price_per_promoter || null;
    let finalPlanName = plan_name || null;
    let finalMax = max_promoters || null;

    if (plan_id) {
      const plan = await query('SELECT * FROM agency_billing_plans WHERE id=$1 AND organization_id=$2', [plan_id, orgId]);
      if (!plan.rows.length) return res.status(400).json({ error: 'Plano inválido para esta organização' });
      finalPrice = plan.rows[0].price_per_promoter;
      finalPlanName = plan.rows[0].name;
      finalMax = contracted_promoters || plan.rows[0].max_promoters || max_promoters || 10;
    }

    const r = await query(
      `UPDATE agencies SET name=COALESCE($1,name), cnpj=$2, responsible_name=$3, responsible_cpf=$4, responsible_phone=$5,
       responsible_email=$6, address=$7, city=$8, state=$9, plan_name=COALESCE($10, plan_name), max_promoters=COALESCE($11,max_promoters),
       price_per_promoter=COALESCE($12,price_per_promoter), auto_block_on_overdue=COALESCE($13,auto_block_on_overdue),
       status=COALESCE($14,status), billing_status=COALESCE($15,billing_status), notes=$16, updated_at=NOW()
       WHERE id=$17 AND organization_id=$18 RETURNING *`,
      [name, onlyDigits(cnpj) || null, responsible_name||null, onlyDigits(responsible_cpf) || null, onlyDigits(responsible_phone) || null,
       responsible_email?.trim().toLowerCase() || null, address||null, city||null, state||null, finalPlanName, finalMax, finalPrice,
       auto_block_on_overdue, status, billing_status, notes||null, req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agência não encontrada' });

    if (plan_id) {
      const count = finalMax || contracted_promoters || 10;
      const amount = (parseFloat(finalPrice) || 0) * (parseInt(count) || 0);
      const sub = await query('SELECT id FROM agency_subscriptions WHERE agency_id=$1', [req.params.id]);
      if (!sub.rows.length) {
        await query(
          'INSERT INTO agency_subscriptions (agency_id, plan_id, promoter_count, amount_due) VALUES ($1,$2,$3,$4)',
          [req.params.id, plan_id, count, amount]
        );
      } else {
        await query(
          'UPDATE agency_subscriptions SET plan_id=$1, promoter_count=$2, amount_due=$3, updated_at=NOW() WHERE agency_id=$4',
          [plan_id, count, amount, req.params.id]
        );
      }
    }

    const result = await query(
      `SELECT a.*, s.plan_id, s.promoter_count as contracted_promoters
       FROM agencies a
       LEFT JOIN agency_subscriptions s ON s.agency_id = a.id
       WHERE a.id=$1 AND a.organization_id=$2`,
      [req.params.id, orgId]
    );

    res.json(result.rows[0]);
  } catch (err) { logError('access.agencies.update', err); res.status(500).json({ error: 'Erro ao atualizar agência' }); }
});

router.delete('/agencies/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await query('DELETE FROM agencies WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    res.json({ ok: true });
  } catch (err) { logError('access.agencies.delete', err); res.status(500).json({ error: 'Erro ao excluir agência' }); }
});

// --- Agency Allowed Units ---
router.get('/agencies/:id/allowed-units', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT aau.*, su.name as unit_name, su.city, su.state FROM agency_allowed_units aau
       JOIN supermarket_units su ON su.id = aau.supermarket_unit_id
       WHERE aau.agency_id = $1 ORDER BY su.name`, [req.params.id]);
    res.json(r.rows);
  } catch (err) { logError('access.agency_units.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.put('/agencies/:id/allowed-units', authenticate, async (req, res) => {
  try {
    const { unit_ids } = req.body;
    await query('DELETE FROM agency_allowed_units WHERE agency_id = $1', [req.params.id]);
    for (const uid of (unit_ids || [])) {
      await query('INSERT INTO agency_allowed_units (agency_id, supermarket_unit_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, uid]);
    }
    res.json({ ok: true });
  } catch (err) { logError('access.agency_units.update', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Agency Users CRUD (create login for agency) ---
router.post('/agencies/:id/users', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const agency = await query('SELECT id FROM agencies WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    if (!agency.rows.length) return res.status(404).json({ error: 'Agência não encontrada' });
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Email, senha e nome são obrigatórios' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      'INSERT INTO agency_users (agency_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role',
      [req.params.id, String(email).trim().toLowerCase(), hash, String(name).trim(), role || 'admin']
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email já cadastrado' });
    logError('access.agency_users.create', err); res.status(500).json({ error: 'Erro ao criar usuário da agência' });
  }
});

router.get('/agencies/:id/users', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT id, email, name, role, active, last_login, created_at FROM agency_users WHERE agency_id=$1 ORDER BY name', [req.params.id]);
    res.json(r.rows);
  } catch (err) { logError('access.agency_users.list', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Agency Promoters CRUD ---
router.get('/agencies/:id/promoters', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT ap.*, e.full_name as employee_name FROM agency_promoters ap
       LEFT JOIN employees e ON e.id = ap.employee_id
       WHERE ap.agency_id = $1 ORDER BY ap.name`, [req.params.id]);
    res.json(r.rows);
  } catch (err) { logError('access.agency_promoters.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/agencies/:id/promoters', authenticate, async (req, res) => {
  try {
    const { name, cpf, phone, photo_url, document_url, employee_id } = req.body;
    if (!name || !cpf) return res.status(400).json({ error: 'Nome e CPF são obrigatórios' });
    const cleanCpf = onlyDigits(cpf);
    if (!isValidCpf(cleanCpf)) return res.status(400).json({ error: 'CPF inválido' });
    if (phone && !isValidPhone(phone)) return res.status(400).json({ error: 'Telefone inválido' });
    // Check agency limit
    const agency = await query('SELECT max_promoters FROM agencies WHERE id=$1', [req.params.id]);
    const count = await query('SELECT COUNT(*) as c FROM agency_promoters WHERE agency_id=$1 AND status=\'active\'', [req.params.id]);
    if (agency.rows[0] && parseInt(count.rows[0].c) >= agency.rows[0].max_promoters) {
      return res.status(400).json({ error: 'Limite de promotores atingido para esta agência' });
    }
    const r = await query(
      `INSERT INTO agency_promoters (agency_id, name, cpf, phone, photo_url, document_url, employee_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, name, cleanCpf, onlyDigits(phone) || null, photo_url||null, document_url||null, employee_id||null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'CPF já cadastrado nesta agência' });
    logError('access.agency_promoters.create', err); res.status(500).json({ error: 'Erro' });
  }
});

router.put('/agencies/:agencyId/promoters/:id', authenticate, async (req, res) => {
  try {
    const { name, cpf, phone, photo_url, document_url, employee_id, status } = req.body;
    const r = await query(
      `UPDATE agency_promoters SET name=COALESCE($1,name), cpf=COALESCE($2,cpf), phone=$3,
       photo_url=$4, document_url=$5, employee_id=$6, status=COALESCE($7,status), updated_at=NOW()
       WHERE id=$8 AND agency_id=$9 RETURNING *`,
      [name, cpf, phone||null, photo_url||null, document_url||null, employee_id||null, status, req.params.id, req.params.agencyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Promotor não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { logError('access.agency_promoters.update', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Access Rules CRUD ---
router.get('/access-rules', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { unit_id, agency_promoter_id, employee_id } = req.query;
      let sql = `SELECT ar.*, su.name as unit_name, ap.name as promoter_name, ap.cpf,
                a.name as agency_name, e.full_name as employee_name,
               COALESCE(json_agg(json_build_object('id', bp.id, 'brand_id', bp.brand_id, 'brand_name', b.name))
               FILTER (WHERE bp.id IS NOT NULL), '[]') as brands
               FROM pdv_access_rules ar
               LEFT JOIN supermarket_units su ON su.id = ar.supermarket_unit_id
               LEFT JOIN agency_promoters ap ON ap.id = ar.agency_promoter_id
               LEFT JOIN agencies a ON a.id = ap.agency_id
               LEFT JOIN employees e ON e.id = ar.employee_id
               LEFT JOIN promoter_brand_permissions bp ON bp.access_rule_id = ar.id
               LEFT JOIN brands b ON b.id = bp.brand_id
               WHERE ar.organization_id = $1`;
    const params = [orgId];
    if (unit_id) { params.push(unit_id); sql += ` AND ar.supermarket_unit_id = $${params.length}`; }
    if (agency_promoter_id) { params.push(agency_promoter_id); sql += ` AND ar.agency_promoter_id = $${params.length}`; }
    if (employee_id) { params.push(employee_id); sql += ` AND ar.employee_id = $${params.length}`; }
    sql += ' GROUP BY ar.id, su.name, ap.name, ap.cpf, a.name, e.full_name ORDER BY su.name, ap.name';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.rules.list', err); res.status(500).json({ error: 'Erro ao listar regras' }); }
});

router.post('/access-rules', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { agency_promoter_id, employee_id, supermarket_unit_id, allowed_weekdays, start_time, end_time,
            max_duration_minutes, require_active_route, require_prior_approval, brand_ids, notes } = req.body;
    if (!supermarket_unit_id) return res.status(400).json({ error: 'Unidade é obrigatória' });
    if (!agency_promoter_id && !employee_id) return res.status(400).json({ error: 'Promotor ou colaborador é obrigatório' });
    const approvalStatus = require_prior_approval ? 'pending' : 'approved';
    const r = await query(
      `INSERT INTO pdv_access_rules (organization_id, agency_promoter_id, employee_id, supermarket_unit_id,
       allowed_weekdays, start_time, end_time, max_duration_minutes, require_active_route,
       require_prior_approval, approval_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [orgId, agency_promoter_id||null, employee_id||null, supermarket_unit_id,
       JSON.stringify(allowed_weekdays || [1,2,3,4,5]), start_time||'08:00', end_time||'18:00',
       max_duration_minutes||null, require_active_route||false, require_prior_approval||false, approvalStatus, notes||null]
    );
    // Add brand permissions
    if (brand_ids?.length) {
      for (const bid of brand_ids) {
        await query('INSERT INTO promoter_brand_permissions (access_rule_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.rows[0].id, bid]);
      }
    }
    // Audit
    await query(
      `INSERT INTO access_audit_logs (organization_id, action, entity_type, entity_id, agency_promoter_id, employee_id, supermarket_unit_id, performed_by, performed_by_type, details)
       VALUES ($1,'rule_created','rule',$2,$3,$4,$5,$6,'admin',$7)`,
      [orgId, r.rows[0].id, agency_promoter_id||null, employee_id||null, supermarket_unit_id, req.userId, JSON.stringify({ brand_ids })]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('access.rules.create', err); res.status(500).json({ error: 'Erro ao criar regra' }); }
});

router.put('/access-rules/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { allowed_weekdays, start_time, end_time, max_duration_minutes, require_active_route,
            require_prior_approval, approval_status, active, brand_ids, notes } = req.body;
    const r = await query(
      `UPDATE pdv_access_rules SET allowed_weekdays=COALESCE($1,allowed_weekdays), start_time=COALESCE($2,start_time),
       end_time=COALESCE($3,end_time), max_duration_minutes=$4, require_active_route=COALESCE($5,require_active_route),
       require_prior_approval=COALESCE($6,require_prior_approval), approval_status=COALESCE($7,approval_status),
       active=COALESCE($8,active), notes=$9, updated_at=NOW()
       WHERE id=$10 AND organization_id=$11 RETURNING *`,
      [allowed_weekdays ? JSON.stringify(allowed_weekdays) : undefined, start_time, end_time, max_duration_minutes??null,
       require_active_route, require_prior_approval, approval_status, active, notes||null, req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });
    // Update brands
    if (brand_ids !== undefined) {
      await query('DELETE FROM promoter_brand_permissions WHERE access_rule_id=$1', [req.params.id]);
      for (const bid of (brand_ids || [])) {
        await query('INSERT INTO promoter_brand_permissions (access_rule_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, bid]);
      }
    }
    res.json(r.rows[0]);
  } catch (err) { logError('access.rules.update', err); res.status(500).json({ error: 'Erro ao atualizar regra' }); }
});

router.delete('/access-rules/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    await query('DELETE FROM pdv_access_rules WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    res.json({ ok: true });
  } catch (err) { logError('access.rules.delete', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Entry Logs (admin view) ---
router.get('/entry-logs', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { unit_id, date, status } = req.query;
    let sql = `SELECT el.*, su.name as unit_name, ap.name as promoter_name, ap.cpf, ap.photo_url,
               a.name as agency_name, e.full_name as employee_name
               FROM pdv_entry_logs el
               LEFT JOIN supermarket_units su ON su.id = el.supermarket_unit_id
               LEFT JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
               LEFT JOIN agencies a ON a.id = ap.agency_id
               LEFT JOIN employees e ON e.id = el.employee_id
               WHERE el.organization_id = $1`;
    const params = [orgId];
    if (unit_id) { params.push(unit_id); sql += ` AND el.supermarket_unit_id = $${params.length}`; }
    if (date) { params.push(date); sql += ` AND el.entry_at::date = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND el.status = $${params.length}`; }
    sql += ' ORDER BY el.entry_at DESC LIMIT 200';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.entry_logs.list', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Audit Logs ---
router.get('/audit-logs', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { unit_id, action, limit: lim } = req.query;
    let sql = 'SELECT * FROM access_audit_logs WHERE organization_id = $1';
    const params = [orgId];
    if (unit_id) { params.push(unit_id); sql += ` AND supermarket_unit_id = $${params.length}`; }
    if (action) { params.push(action); sql += ` AND action = $${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT ${parseInt(lim) || 100}`;
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.audit.list', err); res.status(500).json({ error: 'Erro' }); }
});

// =====================================================================
// TOTEM ROUTES (public-facing, authenticated by totem token)
// =====================================================================

// Totem login — supermarket user authenticates, returns totem_token + unit config
router.post('/totem/login', async (req, res) => {
  try {
    await ensureSupermarketPortalSchema();
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const r = await query(
      `SELECT su_user.*, su.organization_id as org_id, su.name as unit_name,
              su.totem_token, su.totem_enabled, su.logo_url as unit_logo,
              su.totem_primary_color, su.totem_secondary_color, su.totem_bg_color,
              su.totem_button_color, su.totem_button_text_color, su.totem_header_text,
              su.totem_slogan, su.totem_pdv_name,
              su.city, su.state, su.id as unit_id
       FROM supermarket_users su_user
       JOIN supermarket_units su ON su.id = su_user.supermarket_unit_id
        WHERE (su_user.email = $1 OR su_user.username = $1) AND su_user.active = true`, [normalizedEmail]);
    if (!r.rows.length) {
      console.log(`[Totem Login] User not found: ${normalizedEmail}`);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      console.log(`[Totem Login] Invalid password for: ${normalizedEmail}`);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    let totemToken = user.totem_token;
    if (!totemToken || !user.totem_enabled) {
      totemToken = totemToken || crypto.randomBytes(32).toString('hex');
      await query(
        'UPDATE supermarket_units SET totem_token=$1, totem_enabled=true WHERE id=$2',
        [totemToken, user.unit_id]
      );
    }

    await query('UPDATE supermarket_users SET last_login=NOW() WHERE id=$1', [user.id]);

    res.json({
      totem_token: totemToken,
      unit: {
        id: user.unit_id,
        name: user.unit_name,
        logo_url: user.unit_logo,
        city: user.city,
        state: user.state,
        totem_primary_color: user.totem_primary_color || DEFAULT_TOTEM_BRANDING.totem_primary_color,
        totem_secondary_color: user.totem_secondary_color || DEFAULT_TOTEM_BRANDING.totem_secondary_color,
        totem_bg_color: user.totem_bg_color || DEFAULT_TOTEM_BRANDING.totem_bg_color,
        totem_button_color: user.totem_button_color || DEFAULT_TOTEM_BRANDING.totem_button_color,
        totem_button_text_color: user.totem_button_text_color || DEFAULT_TOTEM_BRANDING.totem_button_text_color,
        totem_header_text: user.totem_header_text || DEFAULT_TOTEM_BRANDING.totem_header_text,
        totem_slogan: user.totem_slogan || DEFAULT_TOTEM_BRANDING.totem_slogan,
        totem_pdv_name: user.totem_pdv_name || user.unit_name || DEFAULT_TOTEM_BRANDING.totem_pdv_name,
      },
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) { logError('totem.login', err); res.status(500).json({ error: 'Erro no login do totem' }); }
});

// Validate CPF at totem
router.post('/totem/validate', authenticateTotem, async (req, res) => {
  try {
    const { cpf } = req.body;
    if (!cpf) return res.status(400).json({ error: 'CPF é obrigatório' });
    const cleanCpf = cpf.replace(/\D/g, '');
    if (cleanCpf.length !== 11) return res.status(400).json({ authorized: false, reason: 'CPF inválido' });

    // Horário do Brasil, não do servidor. `new Date()` usa o fuso da máquina
    // (frequentemente UTC no servidor), o que deslocava a comparação em 3 horas
    // e recusava batidas válidas como "fora do horário".
    const nowParts = await query(
      `SELECT EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int AS dow,
              TO_CHAR(NOW() AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS time_str`
    );
    const currentDay = Number(nowParts.rows[0]?.dow ?? 0);
    const currentTime = nowParts.rows[0]?.time_str || '00:00';

    // Find promoter by CPF (agency promoter or internal employee)
    const promoter = await query(
      `SELECT ap.id as agency_promoter_id, ap.name, ap.photo_url, ap.status as promoter_status,
              ap.agency_id, a.name as agency_name, a.status as agency_status, a.billing_status,
              NULL as employee_id
       FROM agency_promoters ap
       JOIN agencies a ON a.id = ap.agency_id
       WHERE ap.cpf = $1
       UNION ALL
       SELECT NULL as agency_promoter_id, e.full_name, e.photo_url, 'active' as promoter_status,
              NULL as agency_id, NULL as agency_name, 'active' as agency_status, 'active' as billing_status,
              e.id as employee_id
       FROM employees e WHERE e.cpf = $1
       LIMIT 1`,
      [cleanCpf]
    );

    if (!promoter.rows.length) {
      await logEntry(req.orgId, req.unitId, null, null, cleanCpf, 'blocked', 'cadastro_inexistente');
      return res.json({ authorized: false, reason: 'Cadastro não encontrado', reason_code: 'cadastro_inexistente' });
    }

    const p = promoter.rows[0];

    // Check promoter status
    if (p.promoter_status !== 'active') {
      await logEntry(req.orgId, req.unitId, p.agency_promoter_id, p.employee_id, cleanCpf, 'blocked', 'promotor_inativo');
      return res.json({ authorized: false, reason: 'Promotor inativo', reason_code: 'promotor_inativo' });
    }

    // Check agency status
    if (p.agency_id && (p.agency_status !== 'active' || p.billing_status === 'blocked')) {
      await logEntry(req.orgId, req.unitId, p.agency_promoter_id, p.employee_id, cleanCpf, 'blocked', 'agencia_bloqueada');
      return res.json({ authorized: false, reason: 'Agência bloqueada ou inadimplente', reason_code: 'agencia_bloqueada' });
    }

    // Find access rules for this unit
    const ruleCondition = p.agency_promoter_id
      ? 'ar.agency_promoter_id = $1'
      : 'ar.employee_id = $1';
    const ruleParam = p.agency_promoter_id || p.employee_id;

    const rules = await query(
      `SELECT ar.* FROM pdv_access_rules ar
       WHERE ${ruleCondition} AND ar.supermarket_unit_id = $2 AND ar.active = true AND ar.approval_status = 'approved'`,
      [ruleParam, req.unitId]
    );

    if (!rules.rows.length) {
      await logEntry(req.orgId, req.unitId, p.agency_promoter_id, p.employee_id, cleanCpf, 'blocked', 'sem_autorizacao');
      return res.json({ authorized: false, reason: 'Sem autorização para este PDV', reason_code: 'sem_autorizacao' });
    }

    // Check any rule that matches current day and time
    const matchingRule = rules.rows.find(r => {
      const weekdays = Array.isArray(r.allowed_weekdays) ? r.allowed_weekdays : JSON.parse(r.allowed_weekdays || '[]');
      if (!weekdays.includes(currentDay)) return false;
      if (currentTime < r.start_time || currentTime > r.end_time) return false;
      return true;
    });

    if (!matchingRule) {
      await logEntry(req.orgId, req.unitId, p.agency_promoter_id, p.employee_id, cleanCpf, 'blocked', 'fora_horario');
      return res.json({ authorized: false, reason: 'Fora do horário permitido', reason_code: 'fora_horario' });
    }

    // Get brands for the matching rule
    const brands = await query(
      `SELECT b.id, b.name FROM promoter_brand_permissions bp
       JOIN brands b ON b.id = bp.brand_id WHERE bp.access_rule_id = $1`,
      [matchingRule.id]
    );

    // Register entry
    const entry = await query(
      `INSERT INTO pdv_entry_logs (organization_id, supermarket_unit_id, agency_promoter_id, employee_id, cpf, status, origin)
       VALUES ($1,$2,$3,$4,$5,'authorized','totem') RETURNING id`,
      [req.orgId, req.unitId, p.agency_promoter_id, p.employee_id, cleanCpf]
    );

    // Audit
    await query(
      `INSERT INTO access_audit_logs (organization_id, action, supermarket_unit_id, agency_promoter_id, employee_id, agency_id, performed_by_type, details)
       VALUES ($1,'entry_authorized',$2,$3,$4,$5,'totem',$6)`,
      [req.orgId, req.unitId, p.agency_promoter_id, p.employee_id, p.agency_id, JSON.stringify({ entry_id: entry.rows[0].id, brands: brands.rows.map(b => b.name) })]
    );

    // Update daily brand presence
    for (const b of brands.rows) {
      await query(
        `INSERT INTO daily_brand_presence (supermarket_unit_id, brand_id, presence_date, agency_id, promoter_count, first_entry)
         VALUES ($1,$2,CURRENT_DATE,$3,1,NOW())
         ON CONFLICT (supermarket_unit_id, brand_id, presence_date)
         DO UPDATE SET promoter_count = daily_brand_presence.promoter_count + 1`,
        [req.unitId, b.id, p.agency_id]
      );
    }

    res.json({
      authorized: true,
      entry_id: entry.rows[0].id,
      promoter: { name: p.name, photo_url: p.photo_url, agency: p.agency_name },
      brands: brands.rows,
      max_duration_minutes: matchingRule.max_duration_minutes,
    });
  } catch (err) { logError('totem.validate', err); res.status(500).json({ error: 'Erro na validação' }); }
});

// Lookup promoter by CPF (no entry registered — just preview)
router.post('/totem/lookup', authenticateTotem, async (req, res) => {
  try {
    const { cpf } = req.body;
    if (!cpf) return res.status(400).json({ error: 'CPF é obrigatório' });
    const cleanCpf = cpf.replace(/\D/g, '');
    if (cleanCpf.length !== 11) return res.status(400).json({ found: false, reason: 'CPF inválido' });

    const promoter = await query(
      `SELECT ap.id as agency_promoter_id, ap.name, ap.photo_url, ap.status as promoter_status,
              ap.agency_id, a.name as agency_name, a.status as agency_status, a.billing_status,
              NULL as employee_id
       FROM agency_promoters ap
       JOIN agencies a ON a.id = ap.agency_id
       WHERE ap.cpf = $1
       UNION ALL
       SELECT NULL as agency_promoter_id, e.full_name, e.photo_url, 'active' as promoter_status,
              NULL as agency_id, NULL as agency_name, 'active' as agency_status, 'active' as billing_status,
              e.id as employee_id
       FROM employees e WHERE e.cpf = $1
       LIMIT 1`,
      [cleanCpf]
    );

    if (!promoter.rows.length) {
      return res.json({ found: false, reason: 'Cadastro não encontrado' });
    }

    const p = promoter.rows[0];

    // Check if there's an open entry (checked in but not checked out) at this unit
    const openEntry = await query(
      `SELECT id, entry_at FROM pdv_entry_logs
       WHERE cpf = $1 AND supermarket_unit_id = $2 AND exit_at IS NULL AND status = 'authorized'
       ORDER BY entry_at DESC LIMIT 1`,
      [cleanCpf, req.unitId]
    );

    const hasOpenEntry = openEntry.rows.length > 0;

    // Fetch today's authorized brands for this promoter at this unit
    const ruleCondition = p.agency_promoter_id
      ? 'ar.agency_promoter_id = $1'
      : 'ar.employee_id = $1';
    const ruleParam = p.agency_promoter_id || p.employee_id;

    let brands = [];
    if (ruleParam) {
      const now = new Date();
      const currentDay = now.getDay();
      const currentTime = now.toTimeString().slice(0, 5);

      const rules = await query(
        `SELECT ar.id, ar.allowed_weekdays, ar.start_time, ar.end_time FROM pdv_access_rules ar
         WHERE ${ruleCondition} AND ar.supermarket_unit_id = $2 AND ar.active = true AND ar.approval_status = 'approved'`,
        [ruleParam, req.unitId]
      );

      for (const r of rules.rows) {
        const weekdays = Array.isArray(r.allowed_weekdays) ? r.allowed_weekdays : JSON.parse(r.allowed_weekdays || '[]');
        if (!weekdays.includes(currentDay)) continue;
        if (currentTime < r.start_time || currentTime > r.end_time) continue;
        const b = await query(
          `SELECT b.id, b.name FROM promoter_brand_permissions bp
           JOIN brands b ON b.id = bp.brand_id WHERE bp.access_rule_id = $1`,
          [r.id]
        );
        brands.push(...b.rows);
      }
      // Deduplicate
      const seen = new Set();
      brands = brands.filter(b => { if (seen.has(b.id)) return false; seen.add(b.id); return true; });
    }

    res.json({
      found: true,
      has_open_entry: hasOpenEntry,
      open_entry_id: hasOpenEntry ? openEntry.rows[0].id : null,
      entry_at: hasOpenEntry ? openEntry.rows[0].entry_at : null,
      brands,
      promoter: {
        name: p.name,
        photo_url: p.photo_url,
        agency_name: p.agency_name,
        status: p.promoter_status,
        agency_status: p.agency_status,
        billing_status: p.billing_status,
      },
    });
  } catch (err) { logError('totem.lookup', err); res.status(500).json({ error: 'Erro na busca' }); }
});

// Totem checkout
router.post('/totem/checkout', authenticateTotem, async (req, res) => {
  try {
    const { cpf, entry_id } = req.body;
    let condition = 'id = $1';
    let param = entry_id;
    if (!entry_id && cpf) {
      condition = `cpf = $1 AND supermarket_unit_id = $2 AND exit_at IS NULL AND status = 'authorized'`;
      param = cpf.replace(/\D/g, '');
    }
    const sql = entry_id
      ? `UPDATE pdv_entry_logs SET exit_at=NOW(), duration_minutes=EXTRACT(EPOCH FROM (NOW()-entry_at))/60
         WHERE id=$1 AND exit_at IS NULL RETURNING *`
      : `UPDATE pdv_entry_logs SET exit_at=NOW(), duration_minutes=EXTRACT(EPOCH FROM (NOW()-entry_at))/60
         WHERE cpf=$1 AND supermarket_unit_id=$2 AND exit_at IS NULL AND status='authorized'
         RETURNING *`;
    const params = entry_id ? [entry_id] : [cpf.replace(/\D/g, ''), req.unitId];
    const r = await query(sql, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Entrada não encontrada' });
    res.json(r.rows[0]);
  } catch (err) { logError('totem.checkout', err); res.status(500).json({ error: 'Erro no checkout' }); }
});

// Helper: log blocked/authorized entry
async function logEntry(orgId, unitId, agencyPromoterId, employeeId, cpf, status, blockReason) {
  try {
    await query(
      `INSERT INTO pdv_entry_logs (organization_id, supermarket_unit_id, agency_promoter_id, employee_id, cpf, status, block_reason, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'totem')`,
      [orgId, unitId, agencyPromoterId||null, employeeId||null, cpf, status, blockReason||null]
    );
    await query(
      `INSERT INTO access_audit_logs (organization_id, action, supermarket_unit_id, agency_promoter_id, employee_id, performed_by_type, details)
       VALUES ($1,$2,$3,$4,$5,'totem',$6)`,
      [orgId, `entry_${status}`, unitId, agencyPromoterId||null, employeeId||null, JSON.stringify({ reason: blockReason, cpf })]
    );
  } catch { /* silent */ }
}

// =====================================================================
// AGENCY LOGIN & ROUTES
// =====================================================================

router.post('/agency/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const r = await query(
      `SELECT au.*, a.organization_id as org_id, a.status as agency_status, a.name as agency_name FROM agency_users au
       JOIN agencies a ON a.id = au.agency_id WHERE au.email = $1 AND au.active = true`, [normalizedEmail]);
    if (!r.rows.length) return res.status(401).json({ error: 'Credenciais inválidas' });
    const user = r.rows[0];
    if (user.agency_status !== 'active') return res.status(403).json({ error: 'Agência bloqueada' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });
    const token = jwt.sign({ userId: user.id, agencyId: user.agency_id, orgId: user.org_id, type: 'agency' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    await query('UPDATE agency_users SET last_login=NOW() WHERE id=$1', [user.id]);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, agency_id: user.agency_id, agency_name: user.agency_name } });
  } catch (err) { logError('agency.login', err); res.status(500).json({ error: 'Erro no login' }); }
});

router.get('/agency/me', authenticateAgency, async (req, res) => {
  try {
    const r = await query(
      `SELECT au.id, au.email, au.name, au.role, au.agency_id, a.name as agency_name, a.organization_id
       FROM agency_users au
       JOIN agencies a ON a.id = au.agency_id
       WHERE au.id = $1 AND au.active = true`,
      [req.agencyUserId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ user: r.rows[0] });
  } catch (err) { logError('agency.me', err); res.status(500).json({ error: 'Erro ao carregar usuário' }); }
});

// Agency: dashboard stats
router.get('/agency/stats', authenticateAgency, async (req, res) => {
  try {
    const [totalP, activeP, blockedP, allowedUnits, entriesToday, blockedToday, subscription] = await Promise.all([
      query('SELECT COUNT(*) as c FROM agency_promoters WHERE agency_id=$1', [req.agencyId]),
      query("SELECT COUNT(*) as c FROM agency_promoters WHERE agency_id=$1 AND status='active'", [req.agencyId]),
      query("SELECT COUNT(*) as c FROM agency_promoters WHERE agency_id=$1 AND status='blocked'", [req.agencyId]),
      query('SELECT COUNT(*) as c FROM agency_allowed_units WHERE agency_id=$1', [req.agencyId]),
      query(
        `SELECT COUNT(*) as c
         FROM pdv_entry_logs el
         JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
         WHERE ap.agency_id = $1
           AND el.entry_at::date = CURRENT_DATE
           AND el.status = 'authorized'`,
        [req.agencyId]
      ),
      query(
        `SELECT COUNT(*) as c
         FROM pdv_entry_logs el
         JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
         WHERE ap.agency_id = $1
           AND el.entry_at::date = CURRENT_DATE
           AND el.status = 'blocked'`,
        [req.agencyId]
      ),
      query(
        `SELECT s.plan_id, s.promoter_count, a.max_promoters
         FROM agencies a
         LEFT JOIN agency_subscriptions s ON s.agency_id = a.id
         WHERE a.id = $1
         ORDER BY s.created_at DESC NULLS LAST
         LIMIT 1`,
        [req.agencyId]
      ).catch(() => ({ rows: [] }))
    ]);

    const subscriptionRow = subscription.rows[0] || {};
    res.json({
      total_promoters: parseInt(totalP.rows[0]?.c || 0, 10),
      active_promoters: parseInt(activeP.rows[0]?.c || 0, 10),
      blocked_promoters: parseInt(blockedP.rows[0]?.c || 0, 10),
      units_authorized: parseInt(allowedUnits.rows[0]?.c || 0, 10),
      entries_today: parseInt(entriesToday.rows[0]?.c || 0, 10),
      blocked_today: parseInt(blockedToday.rows[0]?.c || 0, 10),
      plan_limit: subscriptionRow.promoter_count ?? subscriptionRow.max_promoters ?? 0,
      plan_usage: parseInt(activeP.rows[0]?.c || 0, 10),
      plan_id: subscriptionRow.plan_id || null,
    });
  } catch (err) { logError('agency.stats', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: recent entries
router.get('/agency/recent-entries', authenticateAgency, async (req, res) => {
  try {
    const r = await query(
      `SELECT el.*, ap.name as promoter_name, su.name as unit_name,
              COALESCE(dbp.brands, ARRAY[]::text[]) as brands_attending,
              CASE
                WHEN el.status = 'authorized' AND el.exit_at IS NULL
                  THEN GREATEST(ROUND(EXTRACT(EPOCH FROM (NOW() - el.entry_at)) / 60.0), 0)::int
                ELSE COALESCE(el.duration_minutes, 0)
              END as duration_so_far
       FROM pdv_entry_logs el
       JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
       JOIN supermarket_units su ON su.id = el.supermarket_unit_id
       LEFT JOIN (
         SELECT dbp.supermarket_unit_id, dbp.agency_id, ARRAY_AGG(DISTINCT b.name ORDER BY b.name) as brands
         FROM daily_brand_presence dbp
         JOIN brands b ON b.id = dbp.brand_id
         WHERE dbp.presence_date = CURRENT_DATE
         GROUP BY dbp.supermarket_unit_id, dbp.agency_id
       ) dbp ON dbp.supermarket_unit_id = el.supermarket_unit_id AND dbp.agency_id = ap.agency_id
       WHERE ap.agency_id = $1
       ORDER BY el.entry_at DESC
       LIMIT 20`,
      [req.agencyId]
    );
    res.json(r.rows);
  } catch (err) { logError('agency.recent_entries', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: list own promoters
router.get('/agency/promoters', authenticateAgency, async (req, res) => {
  try {
    const r = await query('SELECT * FROM agency_promoters WHERE agency_id=$1 ORDER BY name', [req.agencyId]);
    res.json(r.rows);
  } catch (err) { logError('agency.promoters.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: create promoter
router.post('/agency/promoters', authenticateAgency, async (req, res) => {
  try {
    const { name, cpf, phone, photo_url, document_url, employee_id, email, whatsapp, birth_date, rg, gender,
            address, city, state, emergency_contact, emergency_phone, notes,
            promoter_type, mei_cnpj, hourly_rate, is_available,
            cnh_url, contrato_url, comprovante_endereco_url, ctps_url, selfie_url } = req.body;
    if (!name || !cpf) return res.status(400).json({ error: 'Nome e CPF são obrigatórios' });
    if (!isValidCpf(cpf)) return res.status(400).json({ error: 'CPF inválido' });
    if (phone && !isValidPhone(phone)) return res.status(400).json({ error: 'Telefone inválido' });
    if (whatsapp && !isValidPhone(whatsapp)) return res.status(400).json({ error: 'WhatsApp inválido' });
    const ptype = ['fixo','freelance','substituto'].includes(promoter_type) ? promoter_type : 'fixo';
    // Ensure columns exist (JIT)
    await query(`ALTER TABLE agency_promoters
      ADD COLUMN IF NOT EXISTS promoter_type VARCHAR(20) DEFAULT 'fixo',
      ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS mei_cnpj VARCHAR(20),
      ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS cnh_url TEXT,
      ADD COLUMN IF NOT EXISTS contrato_url TEXT,
      ADD COLUMN IF NOT EXISTS comprovante_endereco_url TEXT,
      ADD COLUMN IF NOT EXISTS ctps_url TEXT,
      ADD COLUMN IF NOT EXISTS selfie_url TEXT`).catch(() => {});
    const agency = await query('SELECT max_promoters FROM agencies WHERE id=$1', [req.agencyId]);
    const count = await query('SELECT COUNT(*) as c FROM agency_promoters WHERE agency_id=$1 AND status=\'active\'', [req.agencyId]);
    if (parseInt(count.rows[0].c) >= agency.rows[0]?.max_promoters) {
      return res.status(400).json({ error: 'Limite de promotores atingido' });
    }
    const r = await query(
      `INSERT INTO agency_promoters (agency_id, name, cpf, phone, photo_url, document_url, employee_id, email, whatsapp, birth_date, rg, gender, address, city, state, emergency_contact, emergency_phone, notes, promoter_type, mei_cnpj, hourly_rate, is_available, cnh_url, contrato_url, comprovante_endereco_url, ctps_url, selfie_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
      [req.agencyId, name, onlyDigits(cpf), phone ? onlyDigits(phone) : null, photo_url||null, document_url||null, employee_id||null,
       email||null, whatsapp ? onlyDigits(whatsapp) : null, birth_date||null, rg||null, gender||null, address||null, city||null, state||null,
       emergency_contact||null, emergency_phone ? onlyDigits(emergency_phone) : null, notes||null,
       ptype, mei_cnpj||null, hourly_rate||null, is_available !== false,
       cnh_url||null, contrato_url||null, comprovante_endereco_url||null, ctps_url||null, selfie_url||null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'CPF já cadastrado' });
    logError('agency.promoters.create', err); res.status(500).json({ error: 'Erro' });
  }
});


// Agency: update promoter
router.put('/agency/promoters/:id', authenticateAgency, async (req, res) => {
  try {
    const { name, phone, photo_url, document_url, email, whatsapp, birth_date, rg, gender, address, city, state,
            emergency_contact, emergency_phone, notes,
            promoter_type, mei_cnpj, hourly_rate, is_available,
            cnh_url, contrato_url, comprovante_endereco_url, ctps_url, selfie_url } = req.body;
    if (phone && !isValidPhone(phone)) return res.status(400).json({ error: 'Telefone inválido' });
    if (whatsapp && !isValidPhone(whatsapp)) return res.status(400).json({ error: 'WhatsApp inválido' });
    await query(`ALTER TABLE agency_promoters
      ADD COLUMN IF NOT EXISTS promoter_type VARCHAR(20) DEFAULT 'fixo',
      ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS mei_cnpj VARCHAR(20),
      ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS cnh_url TEXT,
      ADD COLUMN IF NOT EXISTS contrato_url TEXT,
      ADD COLUMN IF NOT EXISTS comprovante_endereco_url TEXT,
      ADD COLUMN IF NOT EXISTS ctps_url TEXT,
      ADD COLUMN IF NOT EXISTS selfie_url TEXT`).catch(() => {});
    const ptype = ['fixo','freelance','substituto'].includes(promoter_type) ? promoter_type : null;
    const r = await query(
      `UPDATE agency_promoters SET name=COALESCE($1,name), phone=$2, photo_url=COALESCE($3,photo_url), document_url=COALESCE($4,document_url),
       email=$5, whatsapp=$6, birth_date=$7, rg=$8, gender=$9, address=$10, city=$11, state=$12,
       emergency_contact=$13, emergency_phone=$14, notes=$15,
       promoter_type=COALESCE($16, promoter_type),
       mei_cnpj=$17, hourly_rate=$18, is_available=COALESCE($19, is_available),
       cnh_url=COALESCE($20, cnh_url),
       contrato_url=COALESCE($21, contrato_url),
       comprovante_endereco_url=COALESCE($22, comprovante_endereco_url),
       ctps_url=COALESCE($23, ctps_url),
       selfie_url=COALESCE($24, selfie_url),
       updated_at=NOW()
       WHERE id=$25 AND agency_id=$26 RETURNING *`,
      [name, phone ? onlyDigits(phone) : null, photo_url, document_url, email||null, whatsapp ? onlyDigits(whatsapp) : null,
       birth_date||null, rg||null, gender||null, address||null, city||null, state||null,
       emergency_contact||null, emergency_phone ? onlyDigits(emergency_phone) : null, notes||null,
       ptype, mei_cnpj||null, hourly_rate||null, is_available,
       cnh_url||null, contrato_url||null, comprovante_endereco_url||null, ctps_url||null, selfie_url||null,
       req.params.id, req.agencyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Promotor não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { logError('agency.promoters.update', err); res.status(500).json({ error: 'Erro' }); }
});


// Agency: toggle promoter status
router.put('/agency/promoters/:id/status', authenticateAgency, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'blocked', 'inactive'].includes(status)) return res.status(400).json({ error: 'Status inválido' });
    const r = await query(
      'UPDATE agency_promoters SET status=$1, updated_at=NOW() WHERE id=$2 AND agency_id=$3 RETURNING *',
      [status, req.params.id, req.agencyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Promotor não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { logError('agency.promoters.status', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: list access rules for own promoters
router.get('/agency/access-rules', authenticateAgency, async (req, res) => {
  try {
    const r = await query(
      `SELECT ar.*, su.name as unit_name, ap.name as promoter_name, ap.cpf,
       COALESCE(json_agg(json_build_object('brand_id', bp.brand_id, 'brand_name', b.name))
       FILTER (WHERE bp.id IS NOT NULL), '[]') as brands
       FROM pdv_access_rules ar
       JOIN agency_promoters ap ON ap.id = ar.agency_promoter_id
       JOIN supermarket_units su ON su.id = ar.supermarket_unit_id
       LEFT JOIN promoter_brand_permissions bp ON bp.access_rule_id = ar.id
       LEFT JOIN brands b ON b.id = bp.brand_id
       WHERE ap.agency_id = $1
       GROUP BY ar.id, su.name, ap.name, ap.cpf ORDER BY su.name`, [req.agencyId]);
    res.json(r.rows);
  } catch (err) { logError('agency.rules.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: create access rule
router.post('/agency/access-rules', authenticateAgency, async (req, res) => {
  try {
    const { agency_promoter_id, supermarket_unit_id, allowed_weekdays, start_time, end_time, brand_ids } = req.body;
    if (!agency_promoter_id || !supermarket_unit_id) return res.status(400).json({ error: 'Promotor e unidade são obrigatórios' });
    // Verify promoter belongs to agency
    const pCheck = await query('SELECT id FROM agency_promoters WHERE id=$1 AND agency_id=$2', [agency_promoter_id, req.agencyId]);
    if (!pCheck.rows.length) return res.status(403).json({ error: 'Promotor não pertence a esta agência' });
    const r = await query(
      `INSERT INTO pdv_access_rules (organization_id, agency_promoter_id, supermarket_unit_id, allowed_weekdays, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.orgId, agency_promoter_id, supermarket_unit_id, JSON.stringify(allowed_weekdays||[1,2,3,4,5]), start_time||'08:00', end_time||'18:00']
    );
    if (brand_ids?.length) {
      for (const bid of brand_ids) {
        await query('INSERT INTO promoter_brand_permissions (access_rule_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.rows[0].id, bid]);
      }
    }
    res.json(r.rows[0]);
  } catch (err) { logError('agency.rules.create', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: update access rule
router.put('/agency/access-rules/:id', authenticateAgency, async (req, res) => {
  try {
    const { allowed_weekdays, start_time, end_time, supermarket_unit_id, brand_ids, active } = req.body;
    // Ensure rule belongs to a promoter of this agency
    const owns = await query(
      `SELECT ar.id FROM pdv_access_rules ar
       JOIN agency_promoters ap ON ap.id = ar.agency_promoter_id
       WHERE ar.id=$1 AND ap.agency_id=$2`,
      [req.params.id, req.agencyId]
    );
    if (!owns.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });
    const r = await query(
      `UPDATE pdv_access_rules SET
         allowed_weekdays = COALESCE($1::jsonb, allowed_weekdays),
         start_time = COALESCE($2, start_time),
         end_time = COALESCE($3, end_time),
         supermarket_unit_id = COALESCE($4, supermarket_unit_id),
         active = COALESCE($5, active),
         updated_at = NOW()
       WHERE id=$6 RETURNING *`,
      [allowed_weekdays ? JSON.stringify(allowed_weekdays) : null, start_time||null, end_time||null, supermarket_unit_id||null, typeof active === 'boolean' ? active : null, req.params.id]
    );
    if (Array.isArray(brand_ids)) {
      await query('DELETE FROM promoter_brand_permissions WHERE access_rule_id=$1', [req.params.id]);
      for (const bid of brand_ids) {
        await query('INSERT INTO promoter_brand_permissions (access_rule_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, bid]);
      }
    }
    res.json(r.rows[0]);
  } catch (err) { logError('agency.rules.update', err); res.status(500).json({ error: err?.message || 'Erro', detail: err?.detail, code: err?.code }); }
});

// Agency: delete access rule
router.delete('/agency/access-rules/:id', authenticateAgency, async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM pdv_access_rules WHERE id=$1 AND agency_promoter_id IN (SELECT id FROM agency_promoters WHERE agency_id=$2) RETURNING id`,
      [req.params.id, req.agencyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });
    res.json({ success: true });
  } catch (err) { logError('agency.rules.delete', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ AGENCY BRANDS ============

// Ensure agency_brands table exists (with CNPJ canonical uniqueness per organization)
let agencyBrandsSchemaReady = null;
async function ensureAgencyBrandsSchema() {
  if (agencyBrandsSchemaReady) return agencyBrandsSchemaReady;
  agencyBrandsSchemaReady = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS agency_brands (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        cnpj VARCHAR(20),
        segment VARCHAR(100),
        contact_name VARCHAR(255),
        contact_phone VARCHAR(30),
        contact_email VARCHAR(255),
        notes TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(agency_id, name)
      )
    `);
    await query('CREATE INDEX IF NOT EXISTS idx_agency_brands_agency ON agency_brands(agency_id)');
    // Backfill columns if they don't exist yet
    await query(`ALTER TABLE agency_brands ADD COLUMN IF NOT EXISTS razao_social VARCHAR(255)`).catch(() => {});
    await query(`ALTER TABLE agency_brands ADD COLUMN IF NOT EXISTS street VARCHAR(255)`).catch(() => {});
    await query(`ALTER TABLE agency_brands ADD COLUMN IF NOT EXISTS number VARCHAR(50)`).catch(() => {});
    await query(`ALTER TABLE agency_brands ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(120)`).catch(() => {});
    await query(`ALTER TABLE agency_brands ADD COLUMN IF NOT EXISTS city VARCHAR(120)`).catch(() => {});
    await query(`ALTER TABLE agency_brands ADD COLUMN IF NOT EXISTS zip VARCHAR(20)`).catch(() => {});
    // Normalized CNPJ (digits only) for canonical uniqueness across all agencies of the same organization
    await query(`ALTER TABLE agency_brands ADD COLUMN IF NOT EXISTS cnpj_digits VARCHAR(14)`).catch(() => {});
    await query(`UPDATE agency_brands SET cnpj_digits = regexp_replace(COALESCE(cnpj,''), '\\D', '', 'g') WHERE cnpj_digits IS NULL`).catch(() => {});
    // Unicidade por agência: a mesma agência não duplica a marca; outras agências podem ter o mesmo CNPJ
    await query(`DROP INDEX IF EXISTS uq_agency_brands_org_cnpj`).catch(() => {});
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_brands_agency_cnpj
                 ON agency_brands(agency_id, cnpj_digits)
                 WHERE cnpj_digits IS NOT NULL AND cnpj_digits <> ''`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_agency_brands_org_name ON agency_brands(organization_id, lower(name))`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_agency_brands_org_cnpj ON agency_brands(organization_id, cnpj_digits)`).catch(() => {});
  })();
  try { await agencyBrandsSchemaReady; } catch(e) { agencyBrandsSchemaReady = null; throw e; }
}

// Agency: list brands (own agency)
router.get('/agency/brands', authenticateAgency, async (req, res) => {
  try {
    await ensureAgencyBrandsSchema();
    const r = await query('SELECT * FROM agency_brands WHERE agency_id=$1 ORDER BY name', [req.agencyId]);
    res.json(r.rows);
  } catch (err) { logError('agency.brands.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: suggestions — autocomplete by name OR CNPJ across all agencies of the same org
// Helps prevent duplicates like "Saboroso" vs "Saboroso Laticínios"
router.get('/agency/brands/suggestions', authenticateAgency, async (req, res) => {
  try {
    await ensureAgencyBrandsSchema();
    const q = String(req.query.q || '').trim();
    const cnpjDigits = onlyDigits(req.query.cnpj);
    if (!q && !cnpjDigits) return res.json([]);
    const params = [req.orgId];
    const where = ['ab.organization_id = $1'];
    if (cnpjDigits) {
      params.push(cnpjDigits);
      where.push(`ab.cnpj_digits = $${params.length}`);
    } else {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`lower(ab.name) LIKE $${params.length}`);
    }
    const r = await query(
      `SELECT ab.id, ab.name, ab.cnpj, ab.cnpj_digits, ab.segment, ab.agency_id,
              a.name AS agency_name,
              (ab.agency_id = $${params.length + 1}) AS is_own
         FROM agency_brands ab
         JOIN agencies a ON a.id = ab.agency_id
        WHERE ${where.join(' AND ')}
        ORDER BY is_own DESC, ab.name ASC
        LIMIT 8`,
      [...params, req.agencyId]
    );
    res.json(r.rows);
  } catch (err) { logError('agency.brands.suggestions', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: create brand — CNPJ obrigatório e validado; bloqueia se já existe na org
router.post('/agency/brands', authenticateAgency, async (req, res) => {
  try {
    await ensureAgencyBrandsSchema();
    const { name, cnpj, segment, contact_name, contact_phone, contact_email, notes,
            razao_social, street, number, neighborhood, city, zip } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    const cnpjDigits = onlyDigits(cnpj);
    if (!cnpjDigits) return res.status(400).json({ error: 'CNPJ é obrigatório' });
    if (!isValidCnpj(cnpjDigits)) return res.status(400).json({ error: 'CNPJ inválido' });

    // Bloqueia apenas se a MESMA agência já cadastrou esse CNPJ; outras agências podem cadastrar a mesma marca
    const dup = await query(
      `SELECT id, name FROM agency_brands
        WHERE agency_id = $1 AND cnpj_digits = $2 LIMIT 1`,
      [req.agencyId, cnpjDigits]
    );
    if (dup.rows[0]) {
      return res.status(409).json({
        error: `Você já cadastrou essa marca como "${dup.rows[0].name}"`,
        duplicate: dup.rows[0],
      });
    }

    const r = await query(
      `INSERT INTO agency_brands (agency_id, organization_id, name, cnpj, cnpj_digits, segment,
         contact_name, contact_phone, contact_email, notes,
         razao_social, street, number, neighborhood, city, zip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.agencyId, req.orgId, name.trim(), cnpj, cnpjDigits, segment||null,
       contact_name||null, contact_phone||null, contact_email||null, notes||null,
       razao_social||null, street||null, number||null, neighborhood||null, city||null, zip||null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Marca já cadastrada (CNPJ ou nome em uso)' });
    logError('agency.brands.create', err); res.status(500).json({ error: 'Erro' });
  }
});

// Agency: update brand
router.put('/agency/brands/:id', authenticateAgency, async (req, res) => {
  try {
    await ensureAgencyBrandsSchema();
    const { name, cnpj, segment, contact_name, contact_phone, contact_email, notes,
            razao_social, street, number, neighborhood, city, zip } = req.body;
    const cnpjDigits = onlyDigits(cnpj);
    if (!cnpjDigits) return res.status(400).json({ error: 'CNPJ é obrigatório' });
    if (!isValidCnpj(cnpjDigits)) return res.status(400).json({ error: 'CNPJ inválido' });

    // Bloqueia se a MESMA agência já tem outra marca com esse CNPJ
    const dup = await query(
      `SELECT id, name FROM agency_brands
        WHERE agency_id = $1 AND cnpj_digits = $2 AND id <> $3 LIMIT 1`,
      [req.agencyId, cnpjDigits, req.params.id]
    );
    if (dup.rows[0]) {
      return res.status(409).json({
        error: `Você já tem outra marca com esse CNPJ ("${dup.rows[0].name}").`,
        duplicate: dup.rows[0],
      });
    }

    const r = await query(
      `UPDATE agency_brands SET name=COALESCE($1,name), cnpj=$2, cnpj_digits=$3, segment=$4,
              contact_name=$5, contact_phone=$6, contact_email=$7, notes=$8,
              razao_social=$9, street=$10, number=$11, neighborhood=$12, city=$13, zip=$14,
              updated_at=NOW()
        WHERE id=$15 AND agency_id=$16 RETURNING *`,
      [name?.trim(), cnpj, cnpjDigits, segment||null,
       contact_name||null, contact_phone||null, contact_email||null, notes||null,
       razao_social||null, street||null, number||null, neighborhood||null, city||null, zip||null,
       req.params.id, req.agencyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Marca não encontrada' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Marca já cadastrada (CNPJ ou nome em uso)' });
    logError('agency.brands.update', err); res.status(500).json({ error: 'Erro' });
  }
});

// Agency: delete brand
router.delete('/agency/brands/:id', authenticateAgency, async (req, res) => {
  try {
    await ensureAgencyBrandsSchema();
    const r = await query('DELETE FROM agency_brands WHERE id=$1 AND agency_id=$2 RETURNING id', [req.params.id, req.agencyId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Marca não encontrada' });
    res.json({ success: true });
  } catch (err) { logError('agency.brands.delete', err); res.status(500).json({ error: 'Erro' }); }
});


router.get('/agency/visit-requests', authenticateAgency, async (req, res) => {
  try {
    const r = await query(
      `SELECT vr.*, su.name as unit_name FROM visit_requests vr
       JOIN supermarket_units su ON su.id = vr.supermarket_unit_id
       WHERE vr.agency_id = $1 ORDER BY vr.created_at DESC`,
      [req.agencyId]
    );
    res.json(r.rows);
  } catch (err) { logError('agency.visit_requests.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: create visit request
router.post('/agency/visit-requests', authenticateAgency, async (req, res) => {
  try {
    const { supermarket_unit_id, promoter_id, promoter_name, brand_name, period_start, period_end, weekdays, start_time, end_time, notes } = req.body;
    if (!supermarket_unit_id || !period_start || !period_end) return res.status(400).json({ error: 'Unidade e período são obrigatórios' });

    // Verify unit is in allowed list
    const allowed = await query('SELECT id FROM agency_allowed_units WHERE agency_id=$1 AND supermarket_unit_id=$2', [req.agencyId, supermarket_unit_id]);
    if (!allowed.rows.length) return res.status(403).json({ error: 'Esta unidade não está na lista de PDVs autorizados para sua agência' });

    if (promoter_id) {
      const pCheck = await query('SELECT id FROM agency_promoters WHERE id=$1 AND agency_id=$2', [promoter_id, req.agencyId]);
      if (!pCheck.rows.length) return res.status(403).json({ error: 'Promotor não pertence a esta agência' });
    }

    const r = await query(
      `INSERT INTO visit_requests (organization_id, agency_id, supermarket_unit_id, promoter_id, promoter_name, brand_name, period_start, period_end, weekdays, start_time, end_time, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.orgId, req.agencyId, supermarket_unit_id, promoter_id || null, promoter_name || null, brand_name || null,
       period_start, period_end, JSON.stringify(weekdays || [1,2,3,4,5]), start_time || '08:00', end_time || '18:00', notes || null]
    );

    // Auto-trigger AI document validation (fire-and-forget)
    if (promoter_id) {
      triggerValidation({ agency_promoter_id: promoter_id, supermarket_unit_id })
        .catch(err => logError('visit_requests.auto_validation', err));
    }

    res.json(r.rows[0]);
  } catch (err) { logError('agency.visit_requests.create', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: list allowed units
router.get('/agency/allowed-units', authenticateAgency, async (req, res) => {
  try {
    const r = await query(
      `SELECT su.id, su.name, su.city, su.state, sn.name as network_name
       FROM agency_allowed_units aau
       JOIN supermarket_units su ON su.id = aau.supermarket_unit_id
       LEFT JOIN supermarket_networks sn ON sn.id = su.network_id
       WHERE aau.agency_id = $1 AND su.active = true ORDER BY su.name`,
      [req.agencyId]
    );
    res.json(r.rows);
  } catch (err) { logError('agency.allowed_units.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Agency: required documents aggregated across networks this agency operates in
router.get('/agency/required-documents', authenticateAgency, async (req, res) => {
  try {
    // Ensure columns exist
    await query(`ALTER TABLE supermarket_networks
      ADD COLUMN IF NOT EXISTS required_documents JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS required_documents_freelance JSONB,
      ADD COLUMN IF NOT EXISTS required_documents_substituto JSONB,
      ADD COLUMN IF NOT EXISTS docs_block_submission BOOLEAN DEFAULT true`).catch(() => {});

    const r = await query(
      `SELECT DISTINCT sn.id, sn.name,
              sn.required_documents,
              sn.required_documents_freelance,
              sn.required_documents_substituto,
              sn.docs_block_submission
         FROM agency_allowed_units aau
         JOIN supermarket_units su ON su.id = aau.supermarket_unit_id
         JOIN supermarket_networks sn ON sn.id = su.network_id
        WHERE aau.agency_id = $1 AND su.active = true`,
      [req.agencyId]
    );

    const pickForType = (row, type) => {
      if (type === 'freelance' && Array.isArray(row.required_documents_freelance)) return row.required_documents_freelance;
      if (type === 'substituto' && Array.isArray(row.required_documents_substituto)) return row.required_documents_substituto;
      return Array.isArray(row.required_documents) ? row.required_documents : [];
    };

    const byType = { fixo: new Set(), freelance: new Set(), substituto: new Set() };
    let blockSubmission = false;
    const networks = r.rows.map(row => {
      ['fixo', 'freelance', 'substituto'].forEach(t => pickForType(row, t).forEach(d => byType[t].add(d)));
      if (row.docs_block_submission !== false) blockSubmission = true;
      return {
        id: row.id,
        name: row.name,
        required_documents: pickForType(row, 'fixo'),
        required_documents_freelance: pickForType(row, 'freelance'),
        required_documents_substituto: pickForType(row, 'substituto'),
        docs_block_submission: row.docs_block_submission !== false,
      };
    });

    res.json({
      block_submission: blockSubmission,
      required_by_type: {
        fixo: Array.from(byType.fixo),
        freelance: Array.from(byType.freelance),
        substituto: Array.from(byType.substituto),
      },
      networks,
    });
  } catch (err) { logError('agency.required_documents', err); res.status(500).json({ error: 'Erro' }); }
});


// =====================================================================
// VISIT REQUESTS (Supermarket side)
// =====================================================================

// Supermarket: list visit requests for this unit
router.get('/supermarket/visit-requests', authenticateSupermarket, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT vr.*, a.name as agency_name FROM visit_requests vr
               JOIN agencies a ON a.id = vr.agency_id
               WHERE vr.supermarket_unit_id = $1`;
    const params = [req.unitId];
    if (status) { sql += ` AND vr.status = $2`; params.push(status); }
    sql += ' ORDER BY vr.created_at DESC';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('supermarket.visit_requests.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Supermarket: approve/reject visit requests (supports bulk)
router.post('/supermarket/visit-requests/review', authenticateSupermarket, async (req, res) => {
  try {
    const { ids, action, rejection_reason } = req.body;
    if (!ids?.length || !['approved', 'rejected'].includes(action)) {
      return res.status(400).json({ error: 'IDs e ação (approved/rejected) são obrigatórios' });
    }
    // Verify all requests belong to this unit
    const check = await query(
      `SELECT id FROM visit_requests WHERE id = ANY($1) AND supermarket_unit_id = $2`,
      [ids, req.unitId]
    );
    if (check.rows.length !== ids.length) return res.status(403).json({ error: 'Algumas solicitações não pertencem a esta unidade' });

    const r = await query(
      `UPDATE visit_requests SET status=$1, rejection_reason=$2, reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW()
       WHERE id = ANY($4) RETURNING *`,
      [action, action === 'rejected' ? (rejection_reason || null) : null, req.supermarketUserId, ids]
    );
    res.json({ updated: r.rows.length, requests: r.rows });
  } catch (err) { logError('supermarket.visit_requests.review', err); res.status(500).json({ error: 'Erro' }); }
});

// Admin: list all visit requests
router.get('/visit-requests', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const r = await query(
      `SELECT vr.*, a.name as agency_name, su.name as unit_name FROM visit_requests vr
       JOIN agencies a ON a.id = vr.agency_id
       JOIN supermarket_units su ON su.id = vr.supermarket_unit_id
       WHERE vr.organization_id = $1 ORDER BY vr.created_at DESC`,
      [orgId]
    );
    res.json(r.rows);
  } catch (err) { logError('visit_requests.list', err); res.status(500).json({ error: 'Erro' }); }
});

// =====================================================================
// SUPERMARKET LOGIN & PANEL
// =====================================================================

router.post('/supermarket/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const r = await query(
      `SELECT su_user.*, su.organization_id as org_id, su.name as unit_name FROM supermarket_users su_user
       JOIN supermarket_units su ON su.id = su_user.supermarket_unit_id
       WHERE (su_user.email = $1 OR su_user.name = $1) AND su_user.active = true`, [normalizedEmail]);
    if (!r.rows.length) {
      console.log(`[Supermarket Login] User not found: ${normalizedEmail}`);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      console.log(`[Supermarket Login] Invalid password for: ${normalizedEmail}`);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const token = jwt.sign({
      userId: user.id, unitId: user.supermarket_unit_id, networkId: user.network_id,
      canViewAllNetwork: user.can_view_all_network, orgId: user.org_id, type: 'supermarket'
    }, process.env.JWT_SECRET, { expiresIn: '24h' });
    await query('UPDATE supermarket_users SET last_login=NOW() WHERE id=$1', [user.id]);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, unit_name: user.unit_name, supermarket_unit_id: user.supermarket_unit_id, network_id: user.network_id, can_view_all_network: user.can_view_all_network } });
  } catch (err) { logError('supermarket.login', err); res.status(500).json({ error: 'Erro no login' }); }
});

router.get('/supermarket/me', authenticateSupermarket, async (req, res) => {
  try {
    const r = await query(
      `SELECT su_user.id, su_user.email, su_user.name, su_user.role, su_user.supermarket_unit_id, su_user.network_id,
              su_user.can_view_all_network, su.name as unit_name, su.organization_id
       FROM supermarket_users su_user
       JOIN supermarket_units su ON su.id = su_user.supermarket_unit_id
       WHERE su_user.id = $1 AND su_user.active = true`,
      [req.supermarketUserId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ user: r.rows[0] });
  } catch (err) { logError('supermarket.me', err); res.status(500).json({ error: 'Erro ao carregar usuário' }); }
});

// Supermarket: create user (admin)
router.post('/supermarket-users', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { supermarket_unit_id, network_id, email, password, name, role, can_view_all_network } = req.body;
    if (!email || !password || !name || !supermarket_unit_id) return res.status(400).json({ error: 'Dados obrigatórios faltando' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    const unit = await query(
      'SELECT id, network_id FROM supermarket_units WHERE id=$1 AND organization_id=$2',
      [supermarket_unit_id, orgId]
    );
    if (!unit.rows.length) return res.status(404).json({ error: 'Unidade não encontrada' });
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      `INSERT INTO supermarket_users (supermarket_unit_id, network_id, email, password_hash, name, role, can_view_all_network)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, email, name, role`,
      [supermarket_unit_id, network_id ?? unit.rows[0].network_id ?? null, String(email).trim().toLowerCase(), hash, String(name).trim(), role||'manager', can_view_all_network||false]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email já cadastrado' });
    logError('supermarket.users.create', err); res.status(500).json({ error: 'Erro' });
  }
});

router.put('/supermarket-users/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req);
    const { supermarket_unit_id, network_id, email, password, name, role, can_view_all_network, active } = req.body;
    if (!email || !name || !supermarket_unit_id) return res.status(400).json({ error: 'Nome, email e unidade são obrigatórios' });
    if (password && String(password).length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });

    const existing = await query(
      `SELECT su_user.id
       FROM supermarket_users su_user
       JOIN supermarket_units su ON su.id = su_user.supermarket_unit_id
       WHERE su_user.id = $1 AND su.organization_id = $2`,
      [req.params.id, orgId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Acesso não encontrado' });

    const unit = await query(
      'SELECT id, network_id FROM supermarket_units WHERE id=$1 AND organization_id=$2',
      [supermarket_unit_id, orgId]
    );
    if (!unit.rows.length) return res.status(404).json({ error: 'Unidade não encontrada' });

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const r = await query(
      `UPDATE supermarket_users
       SET supermarket_unit_id = $1,
           network_id = $2,
           email = $3,
           password_hash = COALESCE($4, password_hash),
           name = $5,
           role = $6,
           can_view_all_network = $7,
           active = COALESCE($8, active),
           updated_at = NOW()
       WHERE id = $9
       RETURNING id, email, name, role, can_view_all_network, active, supermarket_unit_id, network_id`,
      [
        supermarket_unit_id,
        network_id ?? unit.rows[0].network_id ?? null,
        String(email).trim().toLowerCase(),
        passwordHash,
        String(name).trim(),
        role || 'manager',
        can_view_all_network || false,
        active,
        req.params.id,
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email já cadastrado' });
    logError('supermarket.users.update', err); res.status(500).json({ error: 'Erro ao atualizar acesso do supermercado' });
  }
});

// Supermarket: dashboard - who is in the store now
router.get('/supermarket/dashboard', authenticateSupermarket, async (req, res) => {
  try {
    const unitIds = [req.unitId];
    if (req.canViewAllNetwork && req.networkId) {
      const network = await query('SELECT id FROM supermarket_units WHERE network_id=$1 AND active=true', [req.networkId]);
      unitIds.length = 0;
      network.rows.forEach(r => unitIds.push(r.id));
    }
    const placeholders = unitIds.map((_, i) => `$${i + 1}`).join(',');

    // Currently in store (entered, not exited)
    const inStore = await query(
      `SELECT el.*, ap.name as promoter_name, ap.photo_url, a.name as agency_name, su.name as unit_name
       FROM pdv_entry_logs el
       LEFT JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
       LEFT JOIN agencies a ON a.id = ap.agency_id
       LEFT JOIN supermarket_units su ON su.id = el.supermarket_unit_id
       WHERE el.supermarket_unit_id IN (${placeholders}) AND el.exit_at IS NULL AND el.status = 'authorized'
       ORDER BY el.entry_at DESC`, unitIds);

    // Today's entries
    const todayEntries = await query(
      `SELECT COUNT(*) FILTER (WHERE status='authorized') as authorized,
              COUNT(*) FILTER (WHERE status='blocked') as blocked,
              COUNT(*) FILTER (WHERE exit_at IS NOT NULL) as exited
       FROM pdv_entry_logs WHERE supermarket_unit_id IN (${placeholders}) AND entry_at::date = CURRENT_DATE`, unitIds);

    // Brands today
    const brands = await query(
      `SELECT dbp.*, b.name as brand_name FROM daily_brand_presence dbp
       JOIN brands b ON b.id = dbp.brand_id
       WHERE dbp.supermarket_unit_id IN (${placeholders}) AND dbp.presence_date = CURRENT_DATE
       ORDER BY b.name`, unitIds);

    res.json({
      in_store: inStore.rows,
      today_stats: todayEntries.rows[0] || { authorized: 0, blocked: 0, exited: 0 },
      brands_today: brands.rows,
    });
  } catch (err) { logError('supermarket.dashboard', err); res.status(500).json({ error: 'Erro' }); }
});

// Supermarket: access history
// ============ SUPERMARKET-PORTAL: Live & Today Stats (aliases for dashboard) ============
router.get('/supermarket-portal/live', authenticateSupermarket, async (req, res) => {
  try {
    const unitIds = [req.unitId];
    if (req.canViewAllNetwork && req.networkId) {
      const network = await query('SELECT id FROM supermarket_units WHERE network_id=$1 AND active=true', [req.networkId]);
      unitIds.length = 0;
      network.rows.forEach(r => unitIds.push(r.id));
    }
    const placeholders = unitIds.map((_, i) => `$${i + 1}`).join(',');

    // Currently in store — include agency brands via visit_requests
    const inStore = await query(
      `SELECT el.*, ap.name as promoter_name, ap.photo_url, a.name as agency_name, su.name as unit_name,
              EXTRACT(EPOCH FROM (NOW() - el.entry_at)) / 60 as duration_so_far,
              TO_CHAR(el.entry_at, 'HH24:MI') as entry_time,
              'cpf' as validation_method,
              COALESCE(
                (SELECT ARRAY_AGG(DISTINCT vr.brand_name) FROM visit_requests vr
                 WHERE vr.agency_id = a.id AND vr.supermarket_unit_id = el.supermarket_unit_id
                 AND vr.status = 'approved' AND vr.brand_name IS NOT NULL
                 AND CURRENT_DATE BETWEEN vr.period_start AND vr.period_end),
                ARRAY[]::text[]
              ) as brands_attending
       FROM pdv_entry_logs el
       LEFT JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
       LEFT JOIN agencies a ON a.id = ap.agency_id
       LEFT JOIN supermarket_units su ON su.id = el.supermarket_unit_id
       WHERE el.supermarket_unit_id IN (${placeholders}) AND el.exit_at IS NULL AND el.status = 'authorized'
       ORDER BY el.entry_at DESC`, unitIds);

    // Brands today — merge daily_brand_presence with agency brands from visit requests
    const brands = await query(
      `SELECT DISTINCT vr.brand_name, a.name as agency_name, COUNT(DISTINCT vr.promoter_id) as promoter_count, 'in_progress' as status
       FROM visit_requests vr
       JOIN agencies a ON a.id = vr.agency_id
       WHERE vr.supermarket_unit_id IN (${placeholders}) AND vr.status = 'approved'
       AND CURRENT_DATE BETWEEN vr.period_start AND vr.period_end AND vr.brand_name IS NOT NULL
       GROUP BY vr.brand_name, a.name
       ORDER BY vr.brand_name`, unitIds).catch(() => ({ rows: [] }));

    // Blocked today
    const blocked = await query(
      `SELECT el.cpf, ap.name, el.block_reason, TO_CHAR(el.entry_at, 'HH24:MI') as time,
              CASE el.block_reason WHEN 'fora_horario' THEN 'Fora do Horário' WHEN 'sem_autorizacao' THEN 'Sem Autorização' WHEN 'pdv_nao_permitido' THEN 'PDV Não Permitido' WHEN 'cadastro_inexistente' THEN 'Cadastro Inexistente' WHEN 'agencia_bloqueada' THEN 'Agência Bloqueada' ELSE el.block_reason END as block_reason_label
       FROM pdv_entry_logs el LEFT JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
       WHERE el.supermarket_unit_id IN (${placeholders}) AND el.status = 'blocked' AND el.entry_at::date = CURRENT_DATE
       ORDER BY el.entry_at DESC LIMIT 20`, unitIds).catch(() => ({ rows: [] }));

    res.json({
      promoters_now: inStore.rows.map(p => ({ ...p, name: p.promoter_name, duration_so_far: Math.round(p.duration_so_far || 0) })),
      brands_now: brands.rows.map(b => ({ ...b, promoter_count: parseInt(b.promoter_count) || 1 })),
      alerts: [],
      blocked_today: blocked.rows,
    });
  } catch (err) { logError('sm.portal.live', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/supermarket-portal/today-stats', authenticateSupermarket, async (req, res) => {
  try {
    const unitIds = [req.unitId];
    if (req.canViewAllNetwork && req.networkId) {
      const network = await query('SELECT id FROM supermarket_units WHERE network_id=$1 AND active=true', [req.networkId]);
      unitIds.length = 0;
      network.rows.forEach(r => unitIds.push(r.id));
    }
    const placeholders = unitIds.map((_, i) => `$${i + 1}`).join(',');

    const stats = await query(
      `SELECT COUNT(*) FILTER (WHERE status='authorized') as entries,
              COUNT(*) FILTER (WHERE exit_at IS NOT NULL) as exits,
              COUNT(*) FILTER (WHERE status='blocked') as blocked,
              ROUND(AVG(duration_minutes) FILTER (WHERE duration_minutes IS NOT NULL)) as avg_duration
       FROM pdv_entry_logs WHERE supermarket_unit_id IN (${placeholders}) AND entry_at::date = CURRENT_DATE`, unitIds);

    const brands = await query(
      `SELECT COUNT(DISTINCT brand_id) as active_brands FROM daily_brand_presence
       WHERE supermarket_unit_id IN (${placeholders}) AND presence_date = CURRENT_DATE`, unitIds).catch(() => ({ rows: [{ active_brands: 0 }] }));

    const agencies = await query(
      `SELECT COUNT(DISTINCT a.id) as active_agencies FROM pdv_entry_logs el
       JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
       JOIN agencies a ON a.id = ap.agency_id
       WHERE el.supermarket_unit_id IN (${placeholders}) AND el.entry_at::date = CURRENT_DATE AND el.status = 'authorized'`, unitIds).catch(() => ({ rows: [{ active_agencies: 0 }] }));

    const s = stats.rows[0] || {};
    res.json({
      entries: parseInt(s.entries) || 0,
      exits: parseInt(s.exits) || 0,
      blocked: parseInt(s.blocked) || 0,
      avg_duration: parseInt(s.avg_duration) || 0,
      active_brands: parseInt(brands.rows[0]?.active_brands) || 0,
      active_agencies: parseInt(agencies.rows[0]?.active_agencies) || 0,
    });
  } catch (err) { logError('sm.portal.today_stats', err); res.status(500).json({ error: 'Erro' }); }
});

// Supermarket: access history
router.get('/supermarket/history', authenticateSupermarket, async (req, res) => {
  try {
    const { date, status } = req.query;
    let sql = `SELECT el.*, ap.name as promoter_name, ap.photo_url, a.name as agency_name,
               COALESCE(
                 (SELECT ARRAY_AGG(DISTINCT vr.brand_name) FROM visit_requests vr
                  WHERE vr.agency_id = a.id AND vr.supermarket_unit_id = el.supermarket_unit_id
                  AND vr.status = 'approved' AND vr.brand_name IS NOT NULL
                  AND el.entry_at::date BETWEEN vr.period_start AND vr.period_end),
                 ARRAY[]::text[]
               ) as brands_attending
               FROM pdv_entry_logs el
               LEFT JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
               LEFT JOIN agencies a ON a.id = ap.agency_id
               WHERE el.supermarket_unit_id = $1`;
    const params = [req.unitId];
    if (date) { params.push(date); sql += ` AND el.entry_at::date = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND el.status = $${params.length}`; }
    sql += ' ORDER BY el.entry_at DESC LIMIT 200';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('supermarket.history', err); res.status(500).json({ error: 'Erro' }); }
});

// =====================================================================
// ADMIN: Unified Promoters list (frontend /promoters endpoint)
// =====================================================================
router.get('/promoters', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const r = await query(
      `SELECT ap.id, ap.name as full_name, ap.cpf, ap.phone, ap.photo_url, ap.status,
              ap.agency_id, a.name as agency_name, ap.employee_id,
              ap.status = 'active' as is_active,
              ap.created_at
       FROM agency_promoters ap
       LEFT JOIN agencies a ON a.id = ap.agency_id
       WHERE a.organization_id = $1
       UNION ALL
       SELECT e.id, e.full_name, e.cpf, e.phone, e.photo_url, 'active' as status,
              NULL as agency_id, NULL as agency_name, e.id as employee_id,
              true as is_active, e.created_at
       FROM employees e WHERE e.organization_id = $1
       ORDER BY full_name`,
      [orgId]
    );
    res.json(r.rows);
  } catch (err) { logError('access.promoters.list', err); res.status(500).json({ error: 'Erro ao listar promotores' }); }
});

router.post('/promoters', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { full_name, cpf, phone, agency_id } = req.body;
    if (!full_name || !cpf) return res.status(400).json({ error: 'Nome e CPF são obrigatórios' });
    if (!isValidCpf(cpf)) return res.status(400).json({ error: 'CPF inválido' });
    if (phone && !isValidPhone(phone)) return res.status(400).json({ error: 'Telefone inválido' });
    if (agency_id) {
      const agency = await query('SELECT max_promoters FROM agencies WHERE id=$1 AND organization_id=$2', [agency_id, orgId]);
      if (!agency.rows.length) return res.status(404).json({ error: 'Agência não encontrada' });
      const count = await query("SELECT COUNT(*) as c FROM agency_promoters WHERE agency_id=$1 AND status='active'", [agency_id]);
      if (parseInt(count.rows[0].c) >= agency.rows[0].max_promoters) {
        return res.status(400).json({ error: 'Limite de promotores atingido' });
      }
      const r = await query(
        'INSERT INTO agency_promoters (agency_id, name, cpf, phone) VALUES ($1,$2,$3,$4) RETURNING *, name as full_name, true as is_active',
        [agency_id, full_name, onlyDigits(cpf), onlyDigits(phone) || null]
      );
      res.json(r.rows[0]);
    } else {
      const r = await query(
        `INSERT INTO employees (organization_id, full_name, cpf, phone, worker_profile)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, full_name, cpf, phone, photo_url, status,
                   NULL::uuid as agency_id, NULL::text as agency_name, id as employee_id,
                   true as is_active, created_at`,
        [orgId, full_name, onlyDigits(cpf), onlyDigits(phone) || null, 'operacional']
      );
      res.json(r.rows[0]);
    }
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'CPF já cadastrado' });
    logError('access.promoters.create', err); res.status(500).json({ error: 'Erro' });
  }
});

router.put('/promoters/:id', authenticate, async (req, res) => {
  try {
    const { full_name, cpf, phone, agency_id, is_active } = req.body;
    if (cpf && !isValidCpf(cpf)) return res.status(400).json({ error: 'CPF inválido' });
    if (phone && !isValidPhone(phone)) return res.status(400).json({ error: 'Telefone inválido' });
    // Try agency_promoters first
    let r = await query(
      `UPDATE agency_promoters SET name=COALESCE($1,name), cpf=COALESCE($2,cpf), phone=$3,
       status=CASE WHEN $4 THEN 'active' ELSE 'inactive' END, updated_at=NOW()
       WHERE id=$5 RETURNING *, name as full_name, status='active' as is_active`,
      [full_name, cpf ? onlyDigits(cpf) : cpf, phone ? onlyDigits(phone) : null, is_active !== false, req.params.id]
    );
    if (!r.rows.length) {
      r = await query(
        `UPDATE employees SET full_name=COALESCE($1,full_name), cpf=COALESCE($2,cpf), phone=$3, updated_at=NOW()
         WHERE id=$4
         RETURNING id, full_name, cpf, phone, photo_url, status,
                   NULL::uuid as agency_id, NULL::text as agency_name, id as employee_id,
                   true as is_active, created_at`,
        [full_name, cpf ? onlyDigits(cpf) : cpf, phone ? onlyDigits(phone) : null, req.params.id]
      );
    }
    if (!r.rows.length) return res.status(404).json({ error: 'Promotor não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { logError('access.promoters.update', err); res.status(500).json({ error: 'Erro' }); }
});

// =====================================================================
// ADMIN: Unified Rules endpoint (frontend /rules)
// =====================================================================
router.get('/rules', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { promoter_id } = req.query;
    let sql = `SELECT ar.id, ar.supermarket_unit_id as unit_id, su.name as unit_name,
               ar.allowed_weekdays, ar.start_time as time_start, ar.end_time as time_end,
               ar.active, ar.notes, '[]'::jsonb as brands
               FROM pdv_access_rules ar
               LEFT JOIN supermarket_units su ON su.id = ar.supermarket_unit_id
               WHERE ar.organization_id = $1`;
    const params = [orgId];
    if (promoter_id) {
      params.push(promoter_id);
      sql += ` AND (ar.agency_promoter_id = $${params.length} OR ar.employee_id = $${params.length})`;
    }
    sql += ' ORDER BY su.name';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.rules.list_unified', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/rules', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { promoter_id, unit_id, allowed_weekdays, time_start, time_end, brands } = req.body;
    if (!promoter_id || !unit_id) return res.status(400).json({ error: 'Promotor e unidade são obrigatórios' });
    // Determine if agency_promoter or employee
    const ap = await query('SELECT id FROM agency_promoters WHERE id=$1', [promoter_id]);
    const isAgencyPromoter = ap.rows.length > 0;
    const r = await query(
      `INSERT INTO pdv_access_rules (organization_id, ${isAgencyPromoter ? 'agency_promoter_id' : 'employee_id'},
       supermarket_unit_id, allowed_weekdays, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, promoter_id, unit_id, JSON.stringify(allowed_weekdays || [1,2,3,4,5]),
       time_start || '08:00', time_end || '18:00']
    );
    res.json(r.rows[0]);
  } catch (err) { logError('access.rules.create_unified', err); res.status(500).json({ error: 'Erro' }); }
});

router.delete('/rules/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    await query('DELETE FROM pdv_access_rules WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    res.json({ ok: true });
  } catch (err) { logError('access.rules.delete_unified', err); res.status(500).json({ error: 'Erro' }); }
});

// =====================================================================
// ADMIN: Logs endpoint (frontend /logs)
// =====================================================================
router.get('/logs', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { unit_id, date, status } = req.query;
    let sql = `SELECT el.id, el.cpf, el.entry_at as entry_time, el.exit_at as exit_time,
               el.duration_minutes, el.status, el.block_reason,
               COALESCE(ap.name, e.full_name) as promoter_name,
               su.name as unit_name, a.name as agency_name,
               '[]'::jsonb as brands
               FROM pdv_entry_logs el
               LEFT JOIN supermarket_units su ON su.id = el.supermarket_unit_id
               LEFT JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
               LEFT JOIN agencies a ON a.id = ap.agency_id
               LEFT JOIN employees e ON e.id = el.employee_id
               WHERE el.organization_id = $1`;
    const params = [orgId];
    if (unit_id) { params.push(unit_id); sql += ` AND el.supermarket_unit_id = $${params.length}`; }
    if (date) { params.push(date); sql += ` AND el.entry_at::date = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND el.status = $${params.length}`; }
    sql += ' ORDER BY el.entry_at DESC LIMIT 200';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.logs.list', err); res.status(500).json({ error: 'Erro' }); }
});

// =====================================================================
// ADMIN: Billing routes (frontend /billing/*)
// =====================================================================

// Plans
router.get('/billing/plans', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const r = await query('SELECT * FROM agency_billing_plans WHERE organization_id=$1 ORDER BY name', [orgId]);
    res.json(r.rows);
  } catch (err) { logError('billing.plans.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/billing/plans', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { name, price_per_promoter, max_promoters } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
    const r = await query(
      'INSERT INTO agency_billing_plans (organization_id, name, price_per_promoter, max_promoters) VALUES ($1,$2,$3,$4) RETURNING *',
      [orgId, name, price_per_promoter || 0, max_promoters || null]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('billing.plans.create', err); res.status(500).json({ error: 'Erro' }); }
});

// Subscriptions
router.get('/billing/subscriptions', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const r = await query(
      `SELECT s.*, a.name as agency_name, p.name as plan_name,
       (SELECT COUNT(*) FROM agency_promoters ap WHERE ap.agency_id = a.id AND ap.status='active') as promoter_count
       FROM agency_subscriptions s
       JOIN agencies a ON a.id = s.agency_id
       LEFT JOIN agency_billing_plans p ON p.id = s.plan_id
       WHERE a.organization_id = $1 ORDER BY a.name`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('billing.subs.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/billing/subscriptions/:id/block', authenticate, async (req, res) => {
  try {
    const r = await query(
      "UPDATE agency_subscriptions SET status='blocked', updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    if (r.rows.length) {
      await query("UPDATE agencies SET billing_status='blocked', status='blocked' WHERE id=$1", [r.rows[0].agency_id]);
    }
    res.json(r.rows[0] || { ok: true });
  } catch (err) { logError('billing.subs.block', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/billing/subscriptions/:id/unblock', authenticate, async (req, res) => {
  try {
    const r = await query(
      "UPDATE agency_subscriptions SET status='active', updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    if (r.rows.length) {
      await query("UPDATE agencies SET billing_status='active', status='active' WHERE id=$1", [r.rows[0].agency_id]);
    }
    res.json(r.rows[0] || { ok: true });
  } catch (err) { logError('billing.subs.unblock', err); res.status(500).json({ error: 'Erro' }); }
});

// Invoices
router.get('/billing/invoices', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const r = await query(
      `SELECT i.*, a.name as agency_name
       FROM agency_invoices i
       JOIN agencies a ON a.id = i.agency_id
       WHERE a.organization_id = $1
       ORDER BY i.created_at DESC`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('billing.invoices.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/billing/invoices/:id/pay', authenticate, async (req, res) => {
  try {
    const r = await query(
      "UPDATE agency_invoices SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    res.json(r.rows[0] || { ok: true });
  } catch (err) { logError('billing.invoices.pay', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/billing/invoices/generate', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { agency_id, months_ahead } = req.body;
    if (!agency_id) return res.status(400).json({ error: 'Agência é obrigatória' });
    const agency = await query('SELECT * FROM agencies WHERE id=$1 AND organization_id=$2', [agency_id, orgId]);
    if (!agency.rows.length) return res.status(404).json({ error: 'Agência não encontrada' });
    const a = agency.rows[0];

    // Use contracted count from subscription or agency max_promoters
    let sub = await query('SELECT * FROM agency_subscriptions WHERE agency_id=$1', [agency_id]);
    let subId;
    const contractedCount = sub.rows.length ? parseInt(sub.rows[0].promoter_count) : parseInt(a.max_promoters) || 0;
    const unitPrice = parseFloat(a.price_per_promoter) || 0;
    const total = contractedCount * unitPrice;

    if (!sub.rows.length) {
      const s = await query(
        "INSERT INTO agency_subscriptions (agency_id, promoter_count, amount_due) VALUES ($1,$2,$3) RETURNING id",
        [agency_id, contractedCount, total]
      );
      subId = s.rows[0].id;
    } else {
      subId = sub.rows[0].id;
      await query('UPDATE agency_subscriptions SET promoter_count=$1, amount_due=$2, updated_at=NOW() WHERE id=$3',
        [contractedCount, total, subId]);
    }

    // Generate invoices for current month + future months
    const totalMonths = Math.min(Math.max(parseInt(months_ahead) || 1, 1), 12);
    const now = new Date();
    const generatedInvoices = [];

    for (let m = 0; m < totalMonths; m++) {
      const refMonth = new Date(now.getFullYear(), now.getMonth() + m, 1);
      const dueDate = new Date(now.getFullYear(), now.getMonth() + m + 1, 10);

      // Skip if invoice already exists for this month
      const existing = await query(
        'SELECT id FROM agency_invoices WHERE agency_id=$1 AND reference_month=$2',
        [agency_id, refMonth]
      );
      if (existing.rows.length) continue;

      const inv = await query(
        `INSERT INTO agency_invoices (subscription_id, agency_id, reference_month, promoter_count, unit_price, total_amount, final_amount, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING *`,
        [subId, agency_id, refMonth, contractedCount, unitPrice, total, dueDate]
      );
      generatedInvoices.push(inv.rows[0]);

      // Log
      await query(
        `INSERT INTO agency_billing_logs (agency_id, action, details) VALUES ($1,'invoice_created',$2)`,
        [agency_id, JSON.stringify({ invoice_id: inv.rows[0].id, reference_month: refMonth, amount: total })]
      );
    }

    res.json({ invoices: generatedInvoices, total_generated: generatedInvoices.length });
  } catch (err) { logError('billing.invoices.generate', err); res.status(500).json({ error: 'Erro' }); }
});

// Assign/update plan for agency subscription
router.post('/billing/subscriptions/assign-plan', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { agency_id, plan_id, contracted_promoters } = req.body;
    if (!agency_id || !plan_id) return res.status(400).json({ error: 'Agência e plano são obrigatórios' });

    const plan = await query('SELECT * FROM agency_billing_plans WHERE id=$1 AND organization_id=$2', [plan_id, orgId]);
    if (!plan.rows.length) return res.status(404).json({ error: 'Plano não encontrado' });

    const count = contracted_promoters || plan.rows[0].max_promoters || 10;
    const amount = count * parseFloat(plan.rows[0].price_per_promoter);

    // Update agency
    await query(
      'UPDATE agencies SET plan_name=$1, price_per_promoter=$2, max_promoters=$3, updated_at=NOW() WHERE id=$4 AND organization_id=$5',
      [plan.rows[0].name, plan.rows[0].price_per_promoter, count, agency_id, orgId]
    );

    // Upsert subscription
    let sub = await query('SELECT id FROM agency_subscriptions WHERE agency_id=$1', [agency_id]);
    if (!sub.rows.length) {
      sub = await query(
        'INSERT INTO agency_subscriptions (agency_id, plan_id, promoter_count, amount_due) VALUES ($1,$2,$3,$4) RETURNING *',
        [agency_id, plan_id, count, amount]
      );
    } else {
      sub = await query(
        'UPDATE agency_subscriptions SET plan_id=$1, promoter_count=$2, amount_due=$3, updated_at=NOW() WHERE agency_id=$4 RETURNING *',
        [plan_id, count, amount, agency_id]
      );
    }

    res.json(sub.rows[0]);
  } catch (err) { logError('billing.assign_plan', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ SEND ACCESS CREDENTIALS (email / WhatsApp) ============
router.post('/send-access', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });

    const { channel, recipient_email, recipient_phone, recipient_name, portal_type, portal_url, login_email } = req.body;

    if (!channel || !portal_type || !portal_url) {
      return res.status(400).json({ error: 'Campos obrigatórios: channel, portal_type, portal_url' });
    }

    const portalLabel = portal_type === 'agency' ? 'Portal da Agência' : 'Portal do Supermercado';
    const messageBody = `Olá${recipient_name ? ' ' + recipient_name : ''}!\n\nSeu acesso ao ${portalLabel} está pronto.\n\n🔗 Link de acesso: ${portal_url}\n📧 E-mail: ${login_email || '(definido no cadastro)'}\n\nAcesse o portal para gerenciar suas operações.`;

    if (channel === 'email') {
      if (!recipient_email) return res.status(400).json({ error: 'E-mail do destinatário é obrigatório' });

      // Use sendEmailImmediately from email-scheduler
      const { sendEmailImmediately } = await import('../email-scheduler.js');
      await sendEmailImmediately({
        organizationId: orgId,
        senderUserId: req.userId,
        toEmail: recipient_email,
        toName: recipient_name || '',
        subject: `Acesso ao ${portalLabel} — Ayratech`,
        bodyHtml: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
            <h2 style="color:#333;">Acesso ao ${portalLabel}</h2>
            <p>Olá${recipient_name ? ' <strong>' + recipient_name + '</strong>' : ''},</p>
            <p>Seu acesso ao portal está pronto. Utilize o link abaixo para entrar:</p>
            <p style="margin:24px 0;">
              <a href="${portal_url}" style="background-color:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                Acessar Portal
              </a>
            </p>
            <p><strong>E-mail de acesso:</strong> ${login_email || '(definido no cadastro)'}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;">Enviado por Ayratech</p>
          </div>
        `,
        contextType: 'access_credentials',
      });

      return res.json({ success: true, message: `E-mail enviado para ${recipient_email}` });
    }

    if (channel === 'whatsapp') {
      if (!recipient_phone) return res.status(400).json({ error: 'Telefone do destinatário é obrigatório' });

      // Get default connection
      const connResult = await query(
        `SELECT c.* FROM connections c
         JOIN organization_members om ON om.organization_id = c.organization_id
         WHERE om.user_id = $1 AND c.status = 'connected'
         ORDER BY c.is_default DESC, c.created_at ASC LIMIT 1`,
        [req.userId]
      );

      if (!connResult.rows[0]) {
        return res.status(400).json({ error: 'Nenhuma conexão WhatsApp ativa encontrada' });
      }

      const connection = connResult.rows[0];
      const { sendMessage } = await import('../lib/whatsapp-provider.js');
      const phone = onlyDigits(recipient_phone);
      const result = await sendMessage(connection, phone, messageBody, 'text');

      if (!result.success) {
        return res.status(500).json({ error: result.error || 'Falha ao enviar mensagem' });
      }

      return res.json({ success: true, message: `Mensagem enviada via WhatsApp` });
    }

    return res.status(400).json({ error: 'Canal inválido. Use "email" ou "whatsapp".' });
  } catch (err) {
    logError('access.send_credentials', err);
    res.status(500).json({ error: err.message || 'Erro ao enviar acesso' });
  }
});

// =====================================================================
// AUTH MODULE ROUTES — Network Auth Settings, QR Tokens, Audit
// =====================================================================

// --- Network Auth Settings CRUD ---
router.get('/networks/:id/auth-settings', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM network_auth_settings WHERE network_id = $1', [req.params.id]);
    res.json(r.rows[0] || null);
  } catch (err) { logError('access.auth_settings.get', err); res.status(500).json({ error: 'Erro' }); }
});

router.put('/networks/:id/auth-settings', authenticate, async (req, res) => {
  try {
    const { cpf_entry_enabled, qr_entry_enabled, selfie_entry_required, selfie_exit_required,
            facial_recognition_enabled, combined_validation, security_level,
            facial_min_confidence, allow_low_confidence_entry, low_confidence_action,
            qr_expiration_minutes, qr_single_use, require_lgpd_consent, consent_text } = req.body;
    const r = await query(
      `INSERT INTO network_auth_settings (network_id, cpf_entry_enabled, qr_entry_enabled, selfie_entry_required,
       selfie_exit_required, facial_recognition_enabled, combined_validation, security_level,
       facial_min_confidence, allow_low_confidence_entry, low_confidence_action,
       qr_expiration_minutes, qr_single_use, require_lgpd_consent, consent_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (network_id) DO UPDATE SET
       cpf_entry_enabled=EXCLUDED.cpf_entry_enabled, qr_entry_enabled=EXCLUDED.qr_entry_enabled,
       selfie_entry_required=EXCLUDED.selfie_entry_required, selfie_exit_required=EXCLUDED.selfie_exit_required,
       facial_recognition_enabled=EXCLUDED.facial_recognition_enabled, combined_validation=EXCLUDED.combined_validation,
       security_level=EXCLUDED.security_level, facial_min_confidence=EXCLUDED.facial_min_confidence,
       allow_low_confidence_entry=EXCLUDED.allow_low_confidence_entry, low_confidence_action=EXCLUDED.low_confidence_action,
       qr_expiration_minutes=EXCLUDED.qr_expiration_minutes, qr_single_use=EXCLUDED.qr_single_use,
       require_lgpd_consent=EXCLUDED.require_lgpd_consent, consent_text=EXCLUDED.consent_text,
       updated_at=NOW()
       RETURNING *`,
      [req.params.id, cpf_entry_enabled ?? true, qr_entry_enabled ?? false, selfie_entry_required ?? false,
       selfie_exit_required ?? false, facial_recognition_enabled ?? false, combined_validation || 'cpf_only',
       security_level || 'basic', facial_min_confidence ?? 70, allow_low_confidence_entry ?? false,
       low_confidence_action || 'alert', qr_expiration_minutes ?? 60, qr_single_use ?? true,
       require_lgpd_consent ?? true, consent_text || null]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('access.auth_settings.upsert', err); res.status(500).json({ error: 'Erro ao salvar configurações' }); }
});

// --- PDV Auth Override ---
router.get('/units/:id/auth-override', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM pdv_auth_overrides WHERE supermarket_unit_id = $1', [req.params.id]);
    res.json(r.rows[0] || null);
  } catch (err) { logError('access.pdv_auth_override.get', err); res.status(500).json({ error: 'Erro' }); }
});

router.put('/units/:id/auth-override', authenticate, async (req, res) => {
  try {
    const { cpf_entry_enabled, qr_entry_enabled, selfie_entry_required, selfie_exit_required,
            facial_recognition_enabled, combined_validation, security_level,
            facial_min_confidence, allow_low_confidence_entry } = req.body;
    const r = await query(
      `INSERT INTO pdv_auth_overrides (supermarket_unit_id, cpf_entry_enabled, qr_entry_enabled, selfie_entry_required,
       selfie_exit_required, facial_recognition_enabled, combined_validation, security_level,
       facial_min_confidence, allow_low_confidence_entry)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (supermarket_unit_id) DO UPDATE SET
       cpf_entry_enabled=EXCLUDED.cpf_entry_enabled, qr_entry_enabled=EXCLUDED.qr_entry_enabled,
       selfie_entry_required=EXCLUDED.selfie_entry_required, selfie_exit_required=EXCLUDED.selfie_exit_required,
       facial_recognition_enabled=EXCLUDED.facial_recognition_enabled, combined_validation=EXCLUDED.combined_validation,
       security_level=EXCLUDED.security_level, facial_min_confidence=EXCLUDED.facial_min_confidence,
       allow_low_confidence_entry=EXCLUDED.allow_low_confidence_entry, updated_at=NOW()
       RETURNING *`,
      [req.params.id, cpf_entry_enabled, qr_entry_enabled, selfie_entry_required,
       selfie_exit_required, facial_recognition_enabled, combined_validation,
       security_level, facial_min_confidence, allow_low_confidence_entry]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('access.pdv_auth_override.upsert', err); res.status(500).json({ error: 'Erro' }); }
});

// --- QR Token Generation ---
router.post('/qr-tokens', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { agency_promoter_id, employee_id, supermarket_unit_id, valid_date, valid_from, valid_until } = req.body;
    if (!supermarket_unit_id) return res.status(400).json({ error: 'Unidade é obrigatória' });
    if (!agency_promoter_id && !employee_id) return res.status(400).json({ error: 'Promotor é obrigatório' });

    // Get auth settings for this unit's network
    const unitR = await query('SELECT network_id FROM supermarket_units WHERE id=$1', [supermarket_unit_id]);
    const networkId = unitR.rows[0]?.network_id;
    let expirationMinutes = 60;
    if (networkId) {
      const settingsR = await query('SELECT qr_expiration_minutes FROM network_auth_settings WHERE network_id=$1', [networkId]);
      if (settingsR.rows[0]) expirationMinutes = settingsR.rows[0].qr_expiration_minutes || 60;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expirationMinutes * 60 * 1000);

    const r = await query(
      `INSERT INTO qr_access_tokens (organization_id, agency_promoter_id, employee_id, supermarket_unit_id,
       token, valid_date, valid_from, valid_until, expires_at, created_by, created_by_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'admin') RETURNING *`,
      [orgId, agency_promoter_id || null, employee_id || null, supermarket_unit_id,
       token, valid_date || new Date().toISOString().slice(0, 10), valid_from || null, valid_until || null,
       expiresAt, req.userId]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('access.qr_tokens.create', err); res.status(500).json({ error: 'Erro ao gerar QR' }); }
});

router.get('/qr-tokens', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { unit_id, status: statusFilter } = req.query;
    let sql = `SELECT qt.*, su.name as unit_name, ap.name as promoter_name, ap.cpf,
               e.full_name as employee_name
               FROM qr_access_tokens qt
               LEFT JOIN supermarket_units su ON su.id = qt.supermarket_unit_id
               LEFT JOIN agency_promoters ap ON ap.id = qt.agency_promoter_id
               LEFT JOIN employees e ON e.id = qt.employee_id
               WHERE qt.organization_id = $1`;
    const params = [orgId];
    if (unit_id) { params.push(unit_id); sql += ` AND qt.supermarket_unit_id = $${params.length}`; }
    if (statusFilter) { params.push(statusFilter); sql += ` AND qt.status = $${params.length}`; }
    sql += ' ORDER BY qt.created_at DESC LIMIT 100';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.qr_tokens.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.delete('/qr-tokens/:id', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    await query("UPDATE qr_access_tokens SET status='revoked' WHERE id=$1 AND organization_id=$2", [req.params.id, orgId]);
    res.json({ ok: true });
  } catch (err) { logError('access.qr_tokens.revoke', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Totem: Get auth config for this unit ---
router.get('/totem/auth-config', authenticateTotem, async (req, res) => {
  try {
    await ensureSupermarketPortalSchema();

    const unitR = await query(
      `SELECT network_id, logo_url, totem_primary_color, totem_secondary_color, totem_bg_color,
              totem_button_color, totem_button_text_color, totem_header_text, totem_slogan, totem_pdv_name, name
       FROM supermarket_units WHERE id=$1`,
      [req.unitId]
    );
    const unit = unitR.rows[0] || {};
    const networkId = unit.network_id;

    let settings = null;
    if (networkId) {
      const r = await query('SELECT * FROM network_auth_settings WHERE network_id=$1', [networkId]);
      settings = r.rows[0] || null;
    }

    const overrideR = await query('SELECT * FROM pdv_auth_overrides WHERE supermarket_unit_id=$1', [req.unitId]);
    const override = overrideR.rows[0];

    const effective = {
      cpf_entry_enabled: override?.cpf_entry_enabled ?? settings?.cpf_entry_enabled ?? true,
      qr_entry_enabled: override?.qr_entry_enabled ?? settings?.qr_entry_enabled ?? false,
      selfie_entry_required: override?.selfie_entry_required ?? settings?.selfie_entry_required ?? false,
      selfie_exit_required: override?.selfie_exit_required ?? settings?.selfie_exit_required ?? false,
      facial_recognition_enabled: override?.facial_recognition_enabled ?? settings?.facial_recognition_enabled ?? false,
      combined_validation: override?.combined_validation ?? settings?.combined_validation ?? 'cpf_only',
      security_level: override?.security_level ?? settings?.security_level ?? 'basic',
      facial_min_confidence: override?.facial_min_confidence ?? settings?.facial_min_confidence ?? 70,
      allow_low_confidence_entry: override?.allow_low_confidence_entry ?? settings?.allow_low_confidence_entry ?? false,
      require_lgpd_consent: settings?.require_lgpd_consent ?? true,
      consent_text: settings?.consent_text || null,
      logo_url: unit.logo_url || '',
      unit_name: unit.name || 'PDV',
      totem_primary_color: unit.totem_primary_color || DEFAULT_TOTEM_BRANDING.totem_primary_color,
      totem_secondary_color: unit.totem_secondary_color || DEFAULT_TOTEM_BRANDING.totem_secondary_color,
      totem_bg_color: unit.totem_bg_color || DEFAULT_TOTEM_BRANDING.totem_bg_color,
      totem_button_color: unit.totem_button_color || DEFAULT_TOTEM_BRANDING.totem_button_color,
      totem_button_text_color: unit.totem_button_text_color || DEFAULT_TOTEM_BRANDING.totem_button_text_color,
      totem_header_text: unit.totem_header_text || DEFAULT_TOTEM_BRANDING.totem_header_text,
      totem_slogan: unit.totem_slogan || DEFAULT_TOTEM_BRANDING.totem_slogan,
      totem_pdv_name: unit.totem_pdv_name || unit.name || DEFAULT_TOTEM_BRANDING.totem_pdv_name,
    };

    res.json(effective);
  } catch (err) { logError('totem.auth_config', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Totem: Validate QR Token ---
router.post('/totem/validate-qr', authenticateTotem, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token QR é obrigatório' });

    const r = await query(
      `SELECT qt.*, ap.name as promoter_name, ap.photo_url, ap.cpf, ap.agency_id,
              a.name as agency_name, a.status as agency_status, a.billing_status,
              e.full_name as employee_name, e.photo_url as employee_photo, e.cpf as employee_cpf
       FROM qr_access_tokens qt
       LEFT JOIN agency_promoters ap ON ap.id = qt.agency_promoter_id
       LEFT JOIN agencies a ON a.id = ap.agency_id
       LEFT JOIN employees e ON e.id = qt.employee_id
       WHERE qt.token = $1`,
      [token]
    );

    if (!r.rows.length) {
      await query(
        `INSERT INTO qr_usage_logs (qr_token_id, supermarket_unit_id, action, reason) VALUES (NULL,$1,'rejected','token_not_found')`,
        [req.unitId]
      );
      await query(
        `INSERT INTO fraud_detection_logs (organization_id, supermarket_unit_id, fraud_type, severity, details)
         VALUES ($1,$2,'qr_invalid','medium',$3)`,
        [req.orgId, req.unitId, JSON.stringify({ token: token.substring(0, 8) + '...' })]
      );
      return res.json({ valid: false, reason: 'QR Code inválido' });
    }

    const qr = r.rows[0];

    // Check if belongs to this unit
    if (qr.supermarket_unit_id !== req.unitId) {
      await query(`INSERT INTO qr_usage_logs (qr_token_id, supermarket_unit_id, action, reason) VALUES ($1,$2,'rejected','wrong_unit')`, [qr.id, req.unitId]);
      await query(
        `INSERT INTO fraud_detection_logs (organization_id, supermarket_unit_id, fraud_type, severity, details)
         VALUES ($1,$2,'unauthorized_pdv','high',$3)`,
        [req.orgId, req.unitId, JSON.stringify({ qr_id: qr.id, expected_unit: qr.supermarket_unit_id })]
      );
      return res.json({ valid: false, reason: 'QR Code não é válido para este PDV' });
    }

    // Check status
    if (qr.status === 'used') {
      await query(`INSERT INTO qr_usage_logs (qr_token_id, supermarket_unit_id, action, reason) VALUES ($1,$2,'rejected','already_used')`, [qr.id, req.unitId]);
      await query(
        `INSERT INTO fraud_detection_logs (organization_id, supermarket_unit_id, fraud_type, severity, details)
         VALUES ($1,$2,'qr_reused','high',$3)`,
        [req.orgId, req.unitId, JSON.stringify({ qr_id: qr.id })]
      );
      return res.json({ valid: false, reason: 'QR Code já foi utilizado' });
    }

    if (qr.status === 'expired' || qr.status === 'revoked') {
      await query(`INSERT INTO qr_usage_logs (qr_token_id, supermarket_unit_id, action, reason) VALUES ($1,$2,'rejected','expired_or_revoked')`, [qr.id, req.unitId]);
      await query(
        `INSERT INTO fraud_detection_logs (organization_id, supermarket_unit_id, fraud_type, severity, details)
         VALUES ($1,$2,'qr_expired','medium',$3)`,
        [req.orgId, req.unitId, JSON.stringify({ qr_id: qr.id, status: qr.status })]
      );
      return res.json({ valid: false, reason: 'QR Code expirado ou revogado' });
    }

    // Check expiration
    if (new Date() > new Date(qr.expires_at)) {
      await query("UPDATE qr_access_tokens SET status='expired' WHERE id=$1", [qr.id]);
      await query(`INSERT INTO qr_usage_logs (qr_token_id, supermarket_unit_id, action, reason) VALUES ($1,$2,'expired','time_expired')`, [qr.id, req.unitId]);
      return res.json({ valid: false, reason: 'QR Code expirado' });
    }

    // Check date
    const today = new Date().toISOString().slice(0, 10);
    if (qr.valid_date && qr.valid_date.toISOString().slice(0, 10) !== today) {
      return res.json({ valid: false, reason: 'QR Code não é válido para hoje' });
    }

    // Mark as used if single-use
    const unitR2 = await query('SELECT network_id FROM supermarket_units WHERE id=$1', [req.unitId]);
    const nid = unitR2.rows[0]?.network_id;
    let singleUse = true;
    if (nid) {
      const sR = await query('SELECT qr_single_use FROM network_auth_settings WHERE network_id=$1', [nid]);
      if (sR.rows[0]) singleUse = sR.rows[0].qr_single_use;
    }
    if (singleUse) {
      await query("UPDATE qr_access_tokens SET status='used', used_at=NOW() WHERE id=$1", [qr.id]);
    }

    await query(`INSERT INTO qr_usage_logs (qr_token_id, supermarket_unit_id, action) VALUES ($1,$2,'validated')`, [qr.id, req.unitId]);

    const name = qr.promoter_name || qr.employee_name;
    const photo = qr.photo_url || qr.employee_photo;
    const cpf = qr.cpf || qr.employee_cpf;

    res.json({
      valid: true,
      promoter: { name, photo_url: photo, cpf, agency_name: qr.agency_name },
      qr_token_id: qr.id,
      agency_promoter_id: qr.agency_promoter_id,
      employee_id: qr.employee_id,
    });
  } catch (err) { logError('totem.validate_qr', err); res.status(500).json({ error: 'Erro na validação do QR' }); }
});

// --- Totem: Save selfie capture ---
router.post('/totem/selfie', authenticateTotem, async (req, res) => {
  try {
    const { entry_log_id, agency_promoter_id, employee_id, capture_type, image_url } = req.body;
    if (!capture_type || !image_url) return res.status(400).json({ error: 'Tipo e imagem são obrigatórios' });
    const r = await query(
      `INSERT INTO selfie_captures (organization_id, entry_log_id, agency_promoter_id, employee_id,
       supermarket_unit_id, capture_type, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.orgId, entry_log_id || null, agency_promoter_id || null, employee_id || null,
       req.unitId, capture_type, image_url]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('totem.selfie', err); res.status(500).json({ error: 'Erro ao salvar selfie' }); }
});

// --- Totem: Log authentication attempt ---
router.post('/totem/auth-attempt', authenticateTotem, async (req, res) => {
  try {
    const { agency_promoter_id, employee_id, cpf, method, auth_steps, overall_result,
            confidence_level, block_reason, entry_log_id } = req.body;
    const r = await query(
      `INSERT INTO authentication_attempt_logs (organization_id, supermarket_unit_id, agency_promoter_id,
       employee_id, cpf, method, auth_steps, overall_result, confidence_level, block_reason, entry_log_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.orgId, req.unitId, agency_promoter_id || null, employee_id || null, cpf || null,
       method, JSON.stringify(auth_steps || []), overall_result, confidence_level || null,
       block_reason || null, entry_log_id || null]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('totem.auth_attempt', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Admin: Auth attempt logs ---
router.get('/auth-attempts', authenticate, async (req, res) => {
  try {
    const hasAuthAttemptLogs = await tableExists('public.authentication_attempt_logs');
    if (!hasAuthAttemptLogs) return res.json([]);

    const orgId = await getOrgId(req.userId);
    const { unit_id, method, result: resultFilter, date } = req.query;
    let sql = `SELECT aal.*, su.name as unit_name, ap.name as promoter_name, e.full_name as employee_name
               FROM authentication_attempt_logs aal
               LEFT JOIN supermarket_units su ON su.id = aal.supermarket_unit_id
               LEFT JOIN agency_promoters ap ON ap.id = aal.agency_promoter_id
               LEFT JOIN employees e ON e.id = aal.employee_id
               WHERE aal.organization_id = $1`;
    const params = [orgId];
    if (unit_id) { params.push(unit_id); sql += ` AND aal.supermarket_unit_id = $${params.length}`; }
    if (method) { params.push(method); sql += ` AND aal.method = $${params.length}`; }
    if (resultFilter) { params.push(resultFilter); sql += ` AND aal.overall_result = $${params.length}`; }
    if (date) { params.push(date); sql += ` AND aal.created_at::date = $${params.length}`; }
    sql += ' ORDER BY aal.created_at DESC LIMIT 200';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.auth_attempts.list', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Admin: Fraud detection logs ---
router.get('/fraud-logs', authenticate, async (req, res) => {
  try {
    const hasFraudLogs = await tableExists('public.fraud_detection_logs');
    if (!hasFraudLogs) return res.json([]);

    const orgId = await getOrgId(req.userId);
    const { unit_id, fraud_type, severity, resolved } = req.query;
    let sql = `SELECT fdl.*, su.name as unit_name, ap.name as promoter_name, e.full_name as employee_name
               FROM fraud_detection_logs fdl
               LEFT JOIN supermarket_units su ON su.id = fdl.supermarket_unit_id
               LEFT JOIN agency_promoters ap ON ap.id = fdl.agency_promoter_id
               LEFT JOIN employees e ON e.id = fdl.employee_id
               WHERE fdl.organization_id = $1`;
    const params = [orgId];
    if (unit_id) { params.push(unit_id); sql += ` AND fdl.supermarket_unit_id = $${params.length}`; }
    if (fraud_type) { params.push(fraud_type); sql += ` AND fdl.fraud_type = $${params.length}`; }
    if (severity) { params.push(severity); sql += ` AND fdl.severity = $${params.length}`; }
    if (resolved !== undefined) { params.push(resolved === 'true'); sql += ` AND fdl.resolved = $${params.length}`; }
    sql += ' ORDER BY fdl.created_at DESC LIMIT 200';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.fraud_logs.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.put('/fraud-logs/:id/resolve', authenticate, async (req, res) => {
  try {
    const hasFraudLogs = await tableExists('public.fraud_detection_logs');
    if (!hasFraudLogs) return res.status(404).json({ error: 'Logs de fraude ainda não estão disponíveis neste ambiente' });

    const { resolution_notes } = req.body;
    const r = await query(
      `UPDATE fraud_detection_logs SET resolved=true, resolved_by=$1, resolved_at=NOW(), resolution_notes=$2 WHERE id=$3 RETURNING *`,
      [req.userId, resolution_notes || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Log não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { logError('access.fraud_logs.resolve', err); res.status(500).json({ error: 'Erro' }); }
});

// =====================================================================
// PROMOTER CONFORMITY & FACIAL COMPARISON
// =====================================================================

// --- Check/refresh conformity for a promoter across all networks ---
async function checkPromoterConformity(orgId, { agency_promoter_id, employee_id, photo_url }) {
  const preparedPhotoUrl = normalizePhotoUrl(photo_url);
  // Get all networks in this org
  const networksR = await query('SELECT id, name FROM supermarket_networks WHERE organization_id=$1 AND active=true', [orgId]);

  const results = [];
  for (const network of networksR.rows) {
    // Get auth settings for this network
    const settingsR = await query('SELECT * FROM network_auth_settings WHERE network_id=$1', [network.id]);
    const settings = settingsR.rows[0];

    if (!settings) {
      // No auth settings = basic (CPF only), always conforme
      await upsertConformity(orgId, agency_promoter_id, employee_id, network.id, 'conforme', null);
      results.push({ network_id: network.id, network_name: network.name, status: 'conforme', reason: null });
      continue;
    }

    const needsPhoto = settings.selfie_entry_required || settings.selfie_exit_required || settings.facial_recognition_enabled;

    if (!needsPhoto) {
      // Network doesn't require photo validation
      await upsertConformity(orgId, agency_promoter_id, employee_id, network.id, 'conforme', null);
      results.push({ network_id: network.id, network_name: network.name, status: 'conforme', reason: null });
      continue;
    }

    // Needs photo — validate
    if (!preparedPhotoUrl) {
      const reason = 'Foto não cadastrada';
      await upsertConformity(orgId, agency_promoter_id, employee_id, network.id, 'nao_conforme', reason);
      results.push({ network_id: network.id, network_name: network.name, status: 'nao_conforme', reason });
      continue;
    }

    // Basic photo validation (URL exists, we assume quality is OK for now)
    // In production, this would call an image analysis service
    const photoScore = preparedPhotoUrl ? 80 : 0;
    const status = photoScore >= 50 ? 'conforme' : 'pendente';
    const reason = status === 'conforme' ? null : 'Foto com qualidade insuficiente para reconhecimento facial';

    await upsertConformity(orgId, agency_promoter_id, employee_id, network.id, status, reason, {
      photo_quality_score: photoScore,
      photo_resolution_ok: !!preparedPhotoUrl,
      photo_frontal_ok: !!preparedPhotoUrl,
      photo_illumination_ok: !!preparedPhotoUrl,
    });

    results.push({ network_id: network.id, network_name: network.name, status, reason });
  }

  return results;
}

async function upsertConformity(orgId, agencyPromoterId, employeeId, networkId, status, reason, extras = {}) {
  const values = [
    status,
    reason || null,
    extras.photo_quality_score ?? null,
    extras.photo_resolution_ok ?? null,
    extras.photo_frontal_ok ?? null,
    extras.photo_illumination_ok ?? null,
    orgId,
    networkId,
  ];

  let updateResult;

  if (agencyPromoterId) {
    updateResult = await query(
      `UPDATE promoter_conformity
       SET status=$1, reason=$2, photo_quality_score=$3, photo_resolution_ok=$4,
           photo_frontal_ok=$5, photo_illumination_ok=$6, checked_at=NOW(), updated_at=NOW()
       WHERE organization_id=$7 AND network_id=$8 AND agency_promoter_id=$9
       RETURNING id`,
      [...values, agencyPromoterId]
    );

    if (updateResult.rows.length) return;

    await query(
      `INSERT INTO promoter_conformity (organization_id, agency_promoter_id, employee_id, network_id, status, reason,
       photo_quality_score, photo_resolution_ok, photo_frontal_ok, photo_illumination_ok, checked_at, updated_at)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
      [orgId, agencyPromoterId, networkId, status, reason || null,
       extras.photo_quality_score ?? null, extras.photo_resolution_ok ?? null,
       extras.photo_frontal_ok ?? null, extras.photo_illumination_ok ?? null]
    );
    return;
  }

  if (employeeId) {
    updateResult = await query(
      `UPDATE promoter_conformity
       SET status=$1, reason=$2, photo_quality_score=$3, photo_resolution_ok=$4,
           photo_frontal_ok=$5, photo_illumination_ok=$6, checked_at=NOW(), updated_at=NOW()
       WHERE organization_id=$7 AND network_id=$8 AND employee_id=$9
       RETURNING id`,
      [...values, employeeId]
    );

    if (updateResult.rows.length) return;

    await query(
      `INSERT INTO promoter_conformity (organization_id, agency_promoter_id, employee_id, network_id, status, reason,
       photo_quality_score, photo_resolution_ok, photo_frontal_ok, photo_illumination_ok, checked_at, updated_at)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
      [orgId, employeeId, networkId, status, reason || null,
       extras.photo_quality_score ?? null, extras.photo_resolution_ok ?? null,
       extras.photo_frontal_ok ?? null, extras.photo_illumination_ok ?? null]
    );
  }
}

// --- Get conformity status for all promoters ---
router.get('/promoters/conformity', authenticate, async (req, res) => {
  try {
    await ensurePromoterConformitySchema();

    const orgId = await getOrgId(req.userId);
    const { network_id, status: statusFilter } = req.query;
    let sql = `SELECT pc.*, sn.name as network_name,
               ap.name as promoter_name, ap.cpf as promoter_cpf, ap.photo_url as promoter_photo,
               a.name as agency_name, a.id as agency_id,
               e.full_name as employee_name, e.cpf as employee_cpf, e.photo_url as employee_photo
               FROM (
                 SELECT DISTINCT ON (agency_promoter_id, employee_id, network_id) *
                 FROM promoter_conformity
                 WHERE organization_id = $1
                 ORDER BY agency_promoter_id, employee_id, network_id, updated_at DESC NULLS LAST, checked_at DESC NULLS LAST, created_at DESC NULLS LAST
               ) pc
               LEFT JOIN agency_promoters ap ON ap.id = pc.agency_promoter_id
               LEFT JOIN agencies a ON a.id = ap.agency_id
               LEFT JOIN employees e ON e.id = pc.employee_id
               LEFT JOIN supermarket_networks sn ON sn.id = pc.network_id
               WHERE 1=1`;
    const params = [orgId];
    if (network_id) { params.push(network_id); sql += ` AND pc.network_id = $${params.length}`; }
    if (statusFilter) { params.push(statusFilter); sql += ` AND pc.status = $${params.length}`; }
    sql += ' ORDER BY pc.status ASC, pc.updated_at DESC LIMIT 500';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.conformity.list', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Bulk conformity check (all promoters) --- MUST be before :id route
router.post('/promoters/check-all-conformity', authenticate, async (req, res) => {
  try {
    await ensurePromoterConformitySchema();

    const orgId = await getOrgId(req.userId);
    const networksR = await query(
      'SELECT COUNT(*)::int AS count FROM supermarket_networks WHERE organization_id = $1 AND active = true',
      [orgId]
    );

    if (!networksR.rows[0]?.count) {
      return res.json({ checked: 0, total: 0, message: 'Nenhuma rede ativa encontrada para validar a conformidade' });
    }

    const apR = await query(
      `SELECT ap.id as agency_promoter_id, ap.photo_url, NULL as employee_id
       FROM agency_promoters ap
       JOIN agencies a ON a.id = ap.agency_id
       WHERE a.organization_id = $1 AND ap.status = 'active'`,
      [orgId]
    );

    const empR = await query(
      `SELECT NULL as agency_promoter_id, e.photo_url, e.id as employee_id
       FROM employees e
       JOIN organizations o ON o.id = $1
       WHERE e.organization_id = $1`,
      [orgId]
    );

    const all = [...apR.rows, ...empR.rows];
    let checked = 0;

    for (const p of all) {
      const results = await checkPromoterConformity(orgId, p);
      if (results.length > 0) checked++;
    }

    res.json({ checked, total: all.length });
  } catch (err) { logError('access.conformity.check_all', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Check conformity for a single promoter ---
router.post('/promoters/:id/check-conformity', authenticate, async (req, res) => {
  try {
    await ensurePromoterConformitySchema();

    const orgId = await getOrgId(req.userId);
    const { id } = req.params;
    const { type } = req.body; // 'agency_promoter' or 'employee'

    let promoter;
    if (type === 'employee') {
      const r = await query('SELECT id as employee_id, photo_url FROM employees WHERE id=$1', [id]);
      promoter = r.rows[0];
      if (!promoter) return res.status(404).json({ error: 'Promotor não encontrado' });
      promoter.agency_promoter_id = null;
    } else {
      const r = await query('SELECT id as agency_promoter_id, photo_url, agency_id FROM agency_promoters WHERE id=$1', [id]);
      promoter = r.rows[0];
      if (!promoter) return res.status(404).json({ error: 'Promotor não encontrado' });
      promoter.employee_id = null;
    }

    const results = await checkPromoterConformity(orgId, promoter);

    if (results.length === 0) {
      return res.json({ results, message: 'Nenhuma rede ativa encontrada para validar este promotor' });
    }

    const nonConform = results.filter(r => r.status === 'nao_conforme' || r.status === 'pendente');
    if (nonConform.length > 0 && promoter.agency_promoter_id) {
      const agR = await query('SELECT agency_id FROM agency_promoters WHERE id=$1', [promoter.agency_promoter_id]);
      const agencyId = agR.rows[0]?.agency_id;
      if (agencyId) {
        for (const nc of nonConform) {
          const hasNotifTable = await tableExists('public.conformity_notifications');
          if (hasNotifTable) {
            await query(
              `INSERT INTO conformity_notifications (organization_id, agency_id, agency_promoter_id, network_id,
               notification_type, message, channel, sent_at)
               VALUES ($1,$2,$3,$4,'photo_non_conform',$5,'system',NOW())
               ON CONFLICT DO NOTHING`,
              [orgId, agencyId, promoter.agency_promoter_id, nc.network_id,
               `Promotor não está em conformidade com as regras de autenticação da rede ${nc.network_name}. Motivo: ${nc.reason}`]
            );
          }
        }
      }
    }

    res.json({ results });
  } catch (err) { logError('access.conformity.check', err); res.status(500).json({ error: 'Erro ao verificar conformidade' }); }
});

// --- Get conformity notifications for an agency ---
router.get('/conformity-notifications', authenticate, async (req, res) => {
  try {
    const hasTable = await tableExists('public.conformity_notifications');
    if (!hasTable) return res.json([]);

    const orgId = await getOrgId(req.userId);
    const { agency_id, unread_only } = req.query;
    let sql = `SELECT cn.*, ap.name as promoter_name, ap.cpf, sn.name as network_name
               FROM conformity_notifications cn
               LEFT JOIN agency_promoters ap ON ap.id = cn.agency_promoter_id
               LEFT JOIN supermarket_networks sn ON sn.id = cn.network_id
               WHERE cn.organization_id = $1`;
    const params = [orgId];
    if (agency_id) { params.push(agency_id); sql += ` AND cn.agency_id = $${params.length}`; }
    if (unread_only === 'true') sql += ' AND cn.read_at IS NULL';
    sql += ' ORDER BY cn.created_at DESC LIMIT 100';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.conformity_notif.list', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Agency portal: get conformity notifications ---
router.get('/agency/conformity-notifications', authenticateAgency, async (req, res) => {
  try {
    const hasTable = await tableExists('public.conformity_notifications');
    if (!hasTable) return res.json([]);

    let sql = `SELECT cn.*, ap.name as promoter_name, ap.cpf, sn.name as network_name
               FROM conformity_notifications cn
               LEFT JOIN agency_promoters ap ON ap.id = cn.agency_promoter_id
               LEFT JOIN supermarket_networks sn ON sn.id = cn.network_id
               WHERE cn.agency_id = $1`;
    const params = [req.agencyId];
    if (req.query.unread_only === 'true') sql += ' AND cn.read_at IS NULL';
    sql += ' ORDER BY cn.created_at DESC LIMIT 100';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('access.agency.conformity_notif', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Mark notification as read ---
router.put('/conformity-notifications/:id/read', authenticate, async (req, res) => {
  try {
    const hasTable = await tableExists('public.conformity_notifications');
    if (!hasTable) return res.status(404).json({ error: 'Não disponível' });
    await query('UPDATE conformity_notifications SET read_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { logError('access.conformity_notif.read', err); res.status(500).json({ error: 'Erro' }); }
});

// --- Totem: Facial comparison (simulated) ---
router.post('/totem/facial-compare', authenticateTotem, async (req, res) => {
  try {
    const { agency_promoter_id, employee_id, entry_log_id, captured_image_url, comparison_type } = req.body;
    if (!captured_image_url) return res.status(400).json({ error: 'Imagem capturada é obrigatória' });

    // Get base photo
    let basePhoto = null;
    if (agency_promoter_id) {
      const r = await query('SELECT photo_url FROM agency_promoters WHERE id=$1', [agency_promoter_id]);
      basePhoto = r.rows[0]?.photo_url;
    } else if (employee_id) {
      const r = await query('SELECT photo_url FROM employees WHERE id=$1', [employee_id]);
      basePhoto = r.rows[0]?.photo_url;
    }

    if (!basePhoto) {
      // No base photo — cannot compare
      const hasFacialTable = await tableExists('public.facial_comparison_logs');
      if (hasFacialTable) {
        await query(
          `INSERT INTO facial_comparison_logs (organization_id, supermarket_unit_id, agency_promoter_id, employee_id,
           entry_log_id, comparison_type, captured_image_url, confidence_score, result, processing_time_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,'error',0)`,
          [req.orgId, req.unitId, agency_promoter_id || null, employee_id || null,
           entry_log_id || null, comparison_type || 'entry_vs_base', captured_image_url]
        );
      }
      return res.json({ result: 'error', confidence: 0, reason: 'Sem foto base para comparação' });
    }

    // Simulated facial comparison — in production, integrate with AWS Rekognition, Azure Face, etc.
    // For now, we simulate a positive result since both images exist
    const startTime = Date.now();
    const simulatedConfidence = 85 + Math.random() * 10; // 85-95%
    const processingTime = Date.now() - startTime;

    // Get network's min confidence threshold
    const unitR = await query('SELECT network_id FROM supermarket_units WHERE id=$1', [req.unitId]);
    const networkId = unitR.rows[0]?.network_id;
    let minConfidence = 70;
    if (networkId) {
      const settingsR = await query('SELECT facial_min_confidence FROM network_auth_settings WHERE network_id=$1', [networkId]);
      if (settingsR.rows[0]) minConfidence = settingsR.rows[0].facial_min_confidence || 70;
    }

    let result;
    if (simulatedConfidence >= minConfidence) result = 'ok';
    else if (simulatedConfidence >= minConfidence - 15) result = 'suspect';
    else result = 'divergent';

    // Log comparison
    const hasFacialTable = await tableExists('public.facial_comparison_logs');
    if (hasFacialTable) {
      await query(
        `INSERT INTO facial_comparison_logs (organization_id, supermarket_unit_id, agency_promoter_id, employee_id,
         entry_log_id, comparison_type, base_image_url, captured_image_url, confidence_score, result, processing_time_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.orgId, req.unitId, agency_promoter_id || null, employee_id || null,
         entry_log_id || null, comparison_type || 'entry_vs_base', basePhoto, captured_image_url,
         simulatedConfidence.toFixed(2), result, processingTime]
      );
    }

    // If divergent or suspect, log fraud
    if (result === 'divergent' || result === 'suspect') {
      const hasFraudTable = await tableExists('public.fraud_detection_logs');
      if (hasFraudTable) {
        await query(
          `INSERT INTO fraud_detection_logs (organization_id, supermarket_unit_id, agency_promoter_id, employee_id,
           fraud_type, severity, details)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [req.orgId, req.unitId, agency_promoter_id || null, employee_id || null,
           'identity_mismatch', result === 'divergent' ? 'high' : 'medium',
           JSON.stringify({ confidence: simulatedConfidence.toFixed(2), threshold: minConfidence, comparison_type })]
        );
      }
    }

    res.json({
      result,
      confidence: parseFloat(simulatedConfidence.toFixed(2)),
      threshold: minConfidence,
      processing_time_ms: processingTime,
    });
  } catch (err) { logError('totem.facial_compare', err); res.status(500).json({ error: 'Erro na comparação facial' }); }
});

// ============ INCIDENTS INFRASTRUCTURE ============
async function ensureIncidentsInfra() {
  const incidentsExists = await tableExists('incidents');
  const contactsExists = await tableExists('pdv_authorized_contacts');
  const auditExists = await tableExists('assistant_audit_log');
  const scoresExists = await tableExists('promoter_scores');
  const summariesExists = await tableExists('daily_operational_summaries');
  const behaviorExists = await tableExists('promoter_behavior_analysis');
  const diagnosticsExists = await tableExists('operational_diagnostics');
  if (incidentsExists && contactsExists && auditExists && scoresExists && summariesExists && behaviorExists && diagnosticsExists) return;
  try {
    await query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'incident_type') THEN CREATE TYPE incident_type AS ENUM ('delay','misconduct','non_execution','product_issue','other'); END IF; END $$`);
    await query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'incident_severity') THEN CREATE TYPE incident_severity AS ENUM ('low','medium','high'); END IF; END $$`);
    await query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'incident_status') THEN CREATE TYPE incident_status AS ENUM ('open','under_review','responded','resolved','escalated'); END IF; END $$`);
  } catch(e) {}
  await query(`CREATE TABLE IF NOT EXISTS incidents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, reported_by_unit_id UUID REFERENCES supermarket_units(id) ON DELETE SET NULL, reported_by_user_name VARCHAR(200), agency_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE SET NULL, agency_id UUID REFERENCES agencies(id) ON DELETE SET NULL, incident_type VARCHAR(30) NOT NULL DEFAULT 'other', severity VARCHAR(20) NOT NULL DEFAULT 'low', status VARCHAR(20) NOT NULL DEFAULT 'open', description TEXT, incident_date TIMESTAMPTZ DEFAULT NOW(), photo_urls TEXT[], ai_classification JSONB, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS incident_responses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE, responder_type VARCHAR(30) NOT NULL, responder_name VARCHAR(200), message TEXT NOT NULL, attachment_urls TEXT[], new_status VARCHAR(20), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS promoter_scores (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, agency_promoter_id UUID NOT NULL REFERENCES agency_promoters(id) ON DELETE CASCADE, score NUMERIC(5,2) DEFAULT 100.00, presence_score NUMERIC(5,2) DEFAULT 100.00, punctuality_score NUMERIC(5,2) DEFAULT 100.00, permanence_score NUMERIC(5,2) DEFAULT 100.00, identity_score NUMERIC(5,2) DEFAULT 100.00, incidents_score NUMERIC(5,2) DEFAULT 100.00, total_visits INTEGER DEFAULT 0, total_incidents INTEGER DEFAULT 0, total_blocks INTEGER DEFAULT 0, last_calculated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(organization_id, agency_promoter_id))`);
  await query(`CREATE TABLE IF NOT EXISTS score_history (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), promoter_score_id UUID NOT NULL REFERENCES promoter_scores(id) ON DELETE CASCADE, score NUMERIC(5,2) NOT NULL, calculated_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS promoter_behavior_analysis (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, agency_promoter_id UUID NOT NULL REFERENCES agency_promoters(id) ON DELETE CASCADE, risk_level VARCHAR(20) DEFAULT 'low', risk_justification TEXT, trend VARCHAR(20) DEFAULT 'stable', alerts JSONB DEFAULT '[]', data_snapshot JSONB, analyzed_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())`);
  const summaryUnitTable = await tableExists('supermarket_units') ? 'supermarket_units' : (await tableExists('units') ? 'units' : null);
  const summaryUnitColumn = summaryUnitTable
    ? `unit_id UUID REFERENCES ${summaryUnitTable}(id) ON DELETE SET NULL,`
    : 'unit_id UUID,';
  await query(`CREATE TABLE IF NOT EXISTS daily_operational_summaries (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, ${summaryUnitColumn} agency_id UUID REFERENCES agencies(id) ON DELETE SET NULL, summary_date DATE NOT NULL, summary_type VARCHAR(30) DEFAULT 'unit', ai_summary TEXT, metrics JSONB, highlights JSONB, risks JSONB, recommendations JSONB, generated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS pdv_authorized_contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, unit_id UUID NOT NULL REFERENCES supermarket_units(id) ON DELETE CASCADE, name VARCHAR(200) NOT NULL, phone VARCHAR(20) NOT NULL, role VARCHAR(50) DEFAULT 'other', permissions JSONB DEFAULT '["consultar_operacao"]', active BOOLEAN DEFAULT true, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS assistant_audit_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, unit_id UUID REFERENCES supermarket_units(id) ON DELETE SET NULL, contact_id UUID REFERENCES pdv_authorized_contacts(id) ON DELETE SET NULL, phone VARCHAR(20), interaction_type VARCHAR(30) DEFAULT 'query', user_message TEXT, ai_response TEXT, incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL, ai_classification JSONB, authorized BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS operational_diagnostics (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, diagnostic_type VARCHAR(30) DEFAULT 'daily', period_start DATE, period_end DATE, problems JSONB DEFAULT '[]', risks JSONB DEFAULT '[]', top_incident_agencies JSONB DEFAULT '[]', unstable_pdvs JSONB DEFAULT '[]', critical_promoters JSONB DEFAULT '[]', recommendations JSONB DEFAULT '[]', generated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())`);
  // Ensure ai_classification column exists on existing tables
  try { await query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS ai_classification JSONB`); } catch(e) {}
  logInfo('incidents', 'Incidents, scores & AI infrastructure created');
}

async function ensureAuthorizedContactsInfra() {
  const contactsExists = await tableExists('pdv_authorized_contacts');
  if (contactsExists) return;

  await query(`CREATE TABLE IF NOT EXISTS pdv_authorized_contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, unit_id UUID NOT NULL REFERENCES supermarket_units(id) ON DELETE CASCADE, name VARCHAR(200) NOT NULL, phone VARCHAR(20) NOT NULL, role VARCHAR(50) DEFAULT 'other', permissions JSONB DEFAULT '["consultar_operacao"]'::jsonb, active BOOLEAN DEFAULT true, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
}

// ============ AI CONFIG HELPER ============
async function getAIConfig(orgId) {
  try {
    const r = await query('SELECT ai_provider, ai_model, ai_api_key FROM organizations WHERE id = $1', [orgId]);
    const org = r.rows[0];
    if (!org || org.ai_provider === 'none' || !org.ai_api_key) return null;
    return { provider: org.ai_provider, model: org.ai_model, apiKey: org.ai_api_key };
  } catch { return null; }
}

// ============ AI INCIDENT ANALYSIS ============
async function analyzeIncidentWithAI(orgId, incidentId) {
  const config = await getAIConfig(orgId);
  if (!config) return null;

  const inc = await query('SELECT * FROM incidents WHERE id = $1', [incidentId]);
  if (!inc.rows.length) return null;
  const incident = inc.rows[0];

  try {
    const { callAI } = await import('../lib/ai-caller.js');
    const messages = [
      { role: 'system', content: `Você é um analista de operações de controle de acesso em supermercados. Analise a ocorrência e retorne APENAS um JSON válido sem markdown, com os seguintes campos:
{
  "type": "atraso|ausencia|saida_antecipada|nao_execucao|execucao_incompleta|comportamento_inadequado|desacordo_equipe|falha_operacional|outro",
  "severity": "baixa|media|alta",
  "impact": "operacional|relacionamento|financeiro|reputacional",
  "risk": "baixo|medio|alto",
  "summary": "resumo padronizado curto de até 100 caracteres",
  "keywords": ["palavra1","palavra2","palavra3"]
}` },
      { role: 'user', content: `Ocorrência: Tipo informado: ${incident.incident_type}, Gravidade informada: ${incident.severity}\nDescrição: ${incident.description || 'Sem descrição'}` }
    ];

    const result = await callAI(config, messages, { temperature: 0.2, maxTokens: 500, responseFormat: { type: 'json_object' } });
    let classification;
    try {
      classification = JSON.parse(result.content);
    } catch {
      // Try extracting JSON from content
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      classification = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    }

    if (classification) {
      classification.analyzed_at = new Date().toISOString();
      classification.tokens_used = result.tokensUsed;
      await query('UPDATE incidents SET ai_classification = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(classification), incidentId]);
      logInfo('ai.incident_analyzed', { incidentId, type: classification.type });
    }
    return classification;
  } catch (err) {
    logError('ai.incident_analysis_failed', err);
    return null;
  }
}

// ============ AI BEHAVIOR ANALYSIS ============
async function analyzeBehaviorWithAI(orgId, promoterId) {
  const config = await getAIConfig(orgId);
  if (!config) return null;

  try {
    // Gather data
    const [entriesR, incidentsR, scoreR] = await Promise.all([
      query(`SELECT * FROM access_entries WHERE agency_promoter_id = $1 AND entry_at > NOW() - INTERVAL '30 days' ORDER BY entry_at DESC LIMIT 50`, [promoterId]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM incidents WHERE agency_promoter_id = $1 AND created_at > NOW() - INTERVAL '30 days' ORDER BY created_at DESC LIMIT 20`, [promoterId]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM promoter_scores WHERE agency_promoter_id = $1 LIMIT 1`, [promoterId]).catch(() => ({ rows: [] })),
    ]);

    const dataSnapshot = {
      entries_30d: entriesR.rows.length,
      incidents_30d: incidentsR.rows.length,
      current_score: scoreR.rows[0]?.score || null,
      late_entries: entriesR.rows.filter(e => e.was_late).length,
      blocked_entries: entriesR.rows.filter(e => e.status === 'blocked').length,
    };

    const { callAI } = await import('../lib/ai-caller.js');
    const messages = [
      { role: 'system', content: `Analise o comportamento operacional deste promotor nos últimos 30 dias. Retorne APENAS JSON:
{
  "risk_level": "baixo|medio|alto",
  "risk_justification": "explicação curta",
  "trend": "estavel|melhorando|piorando",
  "alerts": ["alerta1","alerta2"]
}` },
      { role: 'user', content: `Dados do promotor:\n${JSON.stringify(dataSnapshot)}\n\nOcorrências recentes: ${incidentsR.rows.map(i => `${i.incident_type}: ${i.description?.slice(0,80)}`).join('; ') || 'nenhuma'}` }
    ];

    const result = await callAI(config, messages, { temperature: 0.3, maxTokens: 500, responseFormat: { type: 'json_object' } });
    let analysis;
    try { analysis = JSON.parse(result.content); } catch {
      const m = result.content.match(/\{[\s\S]*\}/);
      analysis = m ? JSON.parse(m[0]) : null;
    }

    if (analysis) {
      await query(`INSERT INTO promoter_behavior_analysis (organization_id, agency_promoter_id, risk_level, risk_justification, trend, alerts, data_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, promoterId, analysis.risk_level || 'baixo', analysis.risk_justification, analysis.trend || 'estavel', JSON.stringify(analysis.alerts || []), JSON.stringify(dataSnapshot)]);
    }
    return analysis;
  } catch (err) {
    logError('ai.behavior_analysis_failed', err);
    return null;
  }
}

// ============ AI DAILY SUMMARY ============
async function generateDailySummary(orgId, unitId = null, agencyId = null, summaryType = 'unit') {
  const config = await getAIConfig(orgId);
  if (!config) return null;

  try {
    const today = new Date().toISOString().split('T')[0];
    const params = [orgId];
    let entriesQuery = `SELECT COUNT(*) as total, COUNT(CASE WHEN status='authorized' THEN 1 END) as authorized, COUNT(CASE WHEN status='blocked' THEN 1 END) as blocked FROM access_entries WHERE organization_id = $1 AND DATE(entry_at) = CURRENT_DATE`;
    let incidentsQuery = `SELECT COUNT(*) as total, COUNT(CASE WHEN severity='high' THEN 1 END) as high_severity FROM incidents WHERE organization_id = $1 AND DATE(created_at) = CURRENT_DATE`;
    
    if (unitId) {
      entriesQuery += ` AND supermarket_unit_id = $2`;
      incidentsQuery += ` AND reported_by_unit_id = $2`;
      params.push(unitId);
    }

    const [entriesR, incidentsR] = await Promise.all([
      query(entriesQuery, params).catch(() => ({ rows: [{ total: 0, authorized: 0, blocked: 0 }] })),
      query(incidentsQuery, params).catch(() => ({ rows: [{ total: 0, high_severity: 0 }] })),
    ]);

    const metrics = {
      total_entries: parseInt(entriesR.rows[0]?.total || 0),
      authorized: parseInt(entriesR.rows[0]?.authorized || 0),
      blocked: parseInt(entriesR.rows[0]?.blocked || 0),
      incidents: parseInt(incidentsR.rows[0]?.total || 0),
      high_severity_incidents: parseInt(incidentsR.rows[0]?.high_severity || 0),
    };

    const { callAI } = await import('../lib/ai-caller.js');
    const messages = [
      { role: 'system', content: `Gere um resumo operacional diário conciso para gestores de supermercado. Retorne APENAS JSON:
{
  "summary": "texto do resumo em 2-3 frases",
  "highlights": ["destaque1","destaque2"],
  "risks": ["risco1"],
  "recommendations": ["recomendacao1"]
}` },
      { role: 'user', content: `Métricas do dia ${today}:\n${JSON.stringify(metrics)}` }
    ];

    const result = await callAI(config, messages, { temperature: 0.4, maxTokens: 500, responseFormat: { type: 'json_object' } });
    let summary;
    try { summary = JSON.parse(result.content); } catch {
      const m = result.content.match(/\{[\s\S]*\}/);
      summary = m ? JSON.parse(m[0]) : null;
    }

    if (summary) {
      await query(`INSERT INTO daily_operational_summaries (organization_id, unit_id, agency_id, summary_date, summary_type, ai_summary, metrics, highlights, risks, recommendations) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [orgId, unitId, agencyId, today, summaryType, summary.summary, JSON.stringify(metrics), JSON.stringify(summary.highlights || []), JSON.stringify(summary.risks || []), JSON.stringify(summary.recommendations || [])]);
    }
    return { ...summary, metrics };
  } catch (err) {
    logError('ai.daily_summary_failed', err);
    return null;
  }
}

// ============ SUPERMARKET PORTAL: Incidents ============
router.get('/supermarket-portal/incidents', authenticateSupermarket, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const r = await query(`SELECT i.*, ap.name AS promoter_name, a.name AS agency_name, u.name AS unit_name, (SELECT json_agg(ir ORDER BY ir.created_at) FROM incident_responses ir WHERE ir.incident_id = i.id) AS responses FROM incidents i LEFT JOIN agency_promoters ap ON ap.id = i.agency_promoter_id LEFT JOIN agencies a ON a.id = i.agency_id LEFT JOIN supermarket_units u ON u.id = i.reported_by_unit_id WHERE i.reported_by_unit_id = $1 ORDER BY i.created_at DESC LIMIT 100`, [req.unitId]);
    res.json(r.rows);
  } catch (err) { logError('sm.incidents.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/supermarket-portal/incidents', authenticateSupermarket, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const { agency_promoter_id, agency_id, incident_type, severity, description, incident_date } = req.body;
    const r = await query(`INSERT INTO incidents (organization_id, reported_by_unit_id, reported_by_user_name, agency_promoter_id, agency_id, incident_type, severity, description, incident_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.orgId, req.unitId, 'Supermercado', agency_promoter_id || null, agency_id || null, incident_type || 'other', severity || 'low', description, incident_date || new Date()]);
    const incident = r.rows[0];
    // Trigger AI analysis asynchronously
    analyzeIncidentWithAI(req.orgId, incident.id).catch(e => logError('ai.auto_analyze', e));
    res.json(incident);
  } catch (err) { logError('sm.incidents.create', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/supermarket-portal/incidents/:id/respond', authenticateSupermarket, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const { message, new_status, responder_type, responder_name } = req.body;
    await query(`INSERT INTO incident_responses (incident_id, responder_type, responder_name, message, new_status) VALUES ($1,$2,$3,$4,$5)`, [req.params.id, responder_type || 'supermarket', responder_name || 'Supermercado', message, new_status || null]);
    if (new_status) await query(`UPDATE incidents SET status = $1, updated_at = NOW() WHERE id = $2`, [new_status, req.params.id]);
    res.json({ ok: true });
  } catch (err) { logError('sm.incidents.respond', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/supermarket-portal/scores', authenticateSupermarket, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const r = await query(`SELECT ps.*, ap.name AS promoter_name, a.name AS agency_name FROM promoter_scores ps JOIN agency_promoters ap ON ap.id = ps.agency_promoter_id LEFT JOIN agencies a ON a.id = ap.agency_id WHERE ps.organization_id = $1 ORDER BY ps.score DESC`, [req.orgId]);
    res.json(r.rows);
  } catch (err) { logError('sm.scores', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/supermarket-portal/schedule', authenticateSupermarket, async (req, res) => {
  try {
    const hasTable = await tableExists('visit_requests');
    if (!hasTable) return res.json({ today: [], tomorrow: [] });
    const today = await query(`SELECT vr.*, ap.name AS promoter_name, a.name AS agency_name FROM visit_requests vr LEFT JOIN agency_promoters ap ON ap.id = vr.agency_promoter_id LEFT JOIN agencies a ON a.id = vr.agency_id WHERE vr.unit_id = $1 AND vr.visit_date = CURRENT_DATE ORDER BY vr.scheduled_time`, [req.unitId]);
    const tomorrow = await query(`SELECT vr.*, ap.name AS promoter_name, a.name AS agency_name FROM visit_requests vr LEFT JOIN agency_promoters ap ON ap.id = vr.agency_promoter_id LEFT JOIN agencies a ON a.id = vr.agency_id WHERE vr.unit_id = $1 AND vr.visit_date = CURRENT_DATE + INTERVAL '1 day' ORDER BY vr.scheduled_time`, [req.unitId]);
    res.json({ today: today.rows, tomorrow: tomorrow.rows });
  } catch (err) { logError('sm.schedule', err); res.json({ today: [], tomorrow: [] }); }
});

// ============ SUPERMARKET: AI Analysis endpoints ============
router.post('/supermarket-portal/incidents/:id/analyze', authenticateSupermarket, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const classification = await analyzeIncidentWithAI(req.orgId, req.params.id);
    if (!classification) return res.status(400).json({ error: 'IA não configurada ou erro na análise' });
    res.json(classification);
  } catch (err) { logError('sm.incident.analyze', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/supermarket-portal/daily-summary', authenticateSupermarket, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const today = new Date().toISOString().split('T')[0];
    // Check if already generated
    const existing = await query(`SELECT * FROM daily_operational_summaries WHERE unit_id = $1 AND summary_date = $2 LIMIT 1`, [req.unitId, today]);
    if (existing.rows.length) return res.json(existing.rows[0]);
    // Generate new
    const summary = await generateDailySummary(req.orgId, req.unitId, null, 'unit');
    if (!summary) return res.json({ ai_summary: null, metrics: {} });
    res.json(summary);
  } catch (err) { logError('sm.daily_summary', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ SUPERMARKET: Authorized contacts ============
// ============ SUPERMARKET-PORTAL: History (alias with from/to) ============
router.get('/supermarket-portal/history', authenticateSupermarket, async (req, res) => {
  try {
    const { from, to, status } = req.query;
    let sql = `SELECT el.*, ap.name as promoter_name, ap.photo_url, a.name as agency_name
               FROM pdv_entry_logs el
               LEFT JOIN agency_promoters ap ON ap.id = el.agency_promoter_id
               LEFT JOIN agencies a ON a.id = ap.agency_id
               WHERE el.supermarket_unit_id = $1`;
    const params = [req.unitId];
    if (from) { params.push(from); sql += ` AND el.entry_at::date >= $${params.length}`; }
    if (to) { params.push(to); sql += ` AND el.entry_at::date <= $${params.length}`; }
    if (status) { params.push(status); sql += ` AND el.status = $${params.length}`; }
    sql += ' ORDER BY el.entry_at DESC LIMIT 500';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('sm.portal.history', err); res.status(500).json({ error: 'Erro ao buscar histórico' }); }
});

router.get('/supermarket-portal/authorized-contacts', authenticateSupermarket, async (req, res) => {
  try {
    await ensureAuthorizedContactsInfra();
    const r = await query(`SELECT * FROM pdv_authorized_contacts WHERE unit_id = $1 ORDER BY name`, [req.unitId]);
    res.json(r.rows);
  } catch (err) { logError('sm.contacts.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/supermarket-portal/authorized-contacts', authenticateSupermarket, async (req, res) => {
  try {
    await ensureAuthorizedContactsInfra();
    const { name, phone, role, permissions, notes } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Nome e telefone obrigatórios' });
    const r = await query(`INSERT INTO pdv_authorized_contacts (organization_id, unit_id, name, phone, role, permissions, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.orgId, req.unitId, name, phone, role || 'other', JSON.stringify(permissions || ['consultar_operacao']), notes || null]);
    res.json(r.rows[0]);
  } catch (err) { logError('sm.contacts.create', err); res.status(500).json({ error: 'Erro' }); }
});

router.put('/supermarket-portal/authorized-contacts/:id', authenticateSupermarket, async (req, res) => {
  try {
    await ensureAuthorizedContactsInfra();
    const { name, phone, role, permissions, active, notes } = req.body;
    const r = await query(`UPDATE pdv_authorized_contacts SET name=COALESCE($1,name), phone=COALESCE($2,phone), role=COALESCE($3,role), permissions=COALESCE($4,permissions), active=COALESCE($5,active), notes=COALESCE($6,notes), updated_at=NOW() WHERE id=$7 AND unit_id=$8 RETURNING *`,
      [name, phone, role, permissions ? JSON.stringify(permissions) : null, active, notes, req.params.id, req.unitId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Contato não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { logError('sm.contacts.update', err); res.status(500).json({ error: 'Erro' }); }
});

router.delete('/supermarket-portal/authorized-contacts/:id', authenticateSupermarket, async (req, res) => {
  try {
    await query('DELETE FROM pdv_authorized_contacts WHERE id = $1 AND unit_id = $2', [req.params.id, req.unitId]);
    res.json({ ok: true });
  } catch (err) { logError('sm.contacts.delete', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ SUPERMARKET: Assistant audit log ============
router.get('/supermarket-portal/assistant-log', authenticateSupermarket, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const r = await query(`SELECT al.*, pac.name as contact_name FROM assistant_audit_log al LEFT JOIN pdv_authorized_contacts pac ON pac.id = al.contact_id WHERE al.unit_id = $1 ORDER BY al.created_at DESC LIMIT 100`, [req.unitId]);
    res.json(r.rows);
  } catch (err) { logError('sm.audit_log', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ AGENCY PORTAL: Incidents & Scores ============

// ============ SUPERMARKET-PORTAL: Settings ============
router.get('/supermarket-portal/settings', authenticateSupermarket, async (req, res) => {
  try {
    await ensureSupermarketPortalSchema();
    const r = await query(
      `SELECT su.id, su.name, su.totem_token, su.totem_enabled, su.logo_url,
              su.totem_primary_color, su.totem_secondary_color, su.totem_bg_color,
              su.totem_button_color, su.totem_button_text_color, su.totem_header_text,
              su.totem_slogan, su.totem_pdv_name,
              su.city, su.state, su.address,
              smu.email as login_email,
              smu.name as login_name,
              sn.name as network_name
       FROM supermarket_units su
       LEFT JOIN supermarket_networks sn ON sn.id = su.network_id
       LEFT JOIN supermarket_users smu ON smu.id = $2
       WHERE su.id = $1`,
      [req.unitId, req.supermarketUserId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unidade não encontrada' });

    const settings = r.rows[0];
    res.json({
      ...settings,
      totem_token: settings.totem_token || null,
      totem_enabled: Boolean(settings.totem_enabled),
      logo_url: settings.logo_url || '',
      totem_primary_color: settings.totem_primary_color || DEFAULT_TOTEM_BRANDING.totem_primary_color,
      totem_secondary_color: settings.totem_secondary_color || DEFAULT_TOTEM_BRANDING.totem_secondary_color,
      totem_bg_color: settings.totem_bg_color || DEFAULT_TOTEM_BRANDING.totem_bg_color,
      totem_button_color: settings.totem_button_color || DEFAULT_TOTEM_BRANDING.totem_button_color,
      totem_button_text_color: settings.totem_button_text_color || DEFAULT_TOTEM_BRANDING.totem_button_text_color,
      totem_header_text: settings.totem_header_text || DEFAULT_TOTEM_BRANDING.totem_header_text,
      totem_slogan: settings.totem_slogan || DEFAULT_TOTEM_BRANDING.totem_slogan,
      totem_pdv_name: settings.totem_pdv_name || settings.name || DEFAULT_TOTEM_BRANDING.totem_pdv_name,
    });
  } catch (err) { logError('sm.settings.get', err); res.status(500).json({ error: 'Erro ao carregar configurações do supermercado' }); }
});

router.put('/supermarket-portal/settings', authenticateSupermarket, async (req, res) => {
  try {
    await ensureSupermarketPortalSchema();
    const { logo_url, totem_primary_color, totem_secondary_color, totem_bg_color,
            totem_button_color, totem_button_text_color, totem_header_text, totem_slogan, totem_pdv_name } = req.body;

    const r = await query(
      `UPDATE supermarket_units SET
        logo_url = $1,
        totem_primary_color = $2,
        totem_secondary_color = $3,
        totem_bg_color = $4,
        totem_button_color = $5,
        totem_button_text_color = $6,
        totem_header_text = $7,
        totem_slogan = $8,
        totem_pdv_name = $9,
        updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [
        typeof logo_url === 'string' ? logo_url.trim() : null,
        typeof totem_primary_color === 'string' ? totem_primary_color.trim() : DEFAULT_TOTEM_BRANDING.totem_primary_color,
        typeof totem_secondary_color === 'string' ? totem_secondary_color.trim() : DEFAULT_TOTEM_BRANDING.totem_secondary_color,
        typeof totem_bg_color === 'string' ? totem_bg_color.trim() : DEFAULT_TOTEM_BRANDING.totem_bg_color,
        typeof totem_button_color === 'string' ? totem_button_color.trim() : DEFAULT_TOTEM_BRANDING.totem_button_color,
        typeof totem_button_text_color === 'string' ? totem_button_text_color.trim() : DEFAULT_TOTEM_BRANDING.totem_button_text_color,
        typeof totem_header_text === 'string' ? totem_header_text.trim() : DEFAULT_TOTEM_BRANDING.totem_header_text,
        typeof totem_slogan === 'string' ? totem_slogan.trim() : '',
        typeof totem_pdv_name === 'string' ? totem_pdv_name.trim() : '',
        req.unitId,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unidade não encontrada' });
    res.json({ success: true, settings: r.rows[0] });
  } catch (err) { logError('sm.settings.update', err); res.status(500).json({ error: 'Erro ao salvar configurações' }); }
});

router.put('/supermarket-portal/change-password', authenticateSupermarket, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Senhas são obrigatórias' });
    if (String(new_password).length < 6) return res.status(400).json({ error: 'Nova senha deve ter no mínimo 6 caracteres' });

    const user = await query('SELECT password_hash, email FROM supermarket_users WHERE id = $1', [req.supermarketUserId]);
    if (!user.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });

    const valid = await bcrypt.compare(current_password, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });

    const hash = await bcrypt.hash(new_password, 10);
    await query('UPDATE supermarket_users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.supermarketUserId]);
    res.json({ success: true, message: 'Senha alterada com sucesso', login_email: user.rows[0].email });
  } catch (err) { logError('sm.change_password', err); res.status(500).json({ error: 'Erro ao alterar senha' }); }
});

router.post('/supermarket-portal/regenerate-token', authenticateSupermarket, async (req, res) => {
  try {
    await ensureSupermarketPortalSchema();
    const newToken = crypto.randomBytes(32).toString('hex');
    const r = await query(
      'UPDATE supermarket_units SET totem_token = $1, totem_enabled = true, updated_at = NOW() WHERE id = $2 RETURNING totem_token, totem_enabled',
      [newToken, req.unitId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unidade não encontrada' });
    res.json({ totem_token: r.rows[0].totem_token, totem_enabled: r.rows[0].totem_enabled });
  } catch (err) { logError('sm.regen_token', err); res.status(500).json({ error: 'Erro ao regenerar token' }); }
});

router.get('/agency/incidents', authenticateAgency, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const r = await query(`SELECT i.*, ap.name AS promoter_name, a.name AS agency_name, u.name AS unit_name, (SELECT json_agg(ir ORDER BY ir.created_at) FROM incident_responses ir WHERE ir.incident_id = i.id) AS responses FROM incidents i LEFT JOIN agency_promoters ap ON ap.id = i.agency_promoter_id LEFT JOIN agencies a ON a.id = i.agency_id LEFT JOIN supermarket_units u ON u.id = i.reported_by_unit_id WHERE i.agency_id = $1 ORDER BY i.created_at DESC LIMIT 100`, [req.agencyId]);
    res.json(r.rows);
  } catch (err) { logError('agency.incidents.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/agency/incidents/:id/respond', authenticateAgency, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const { message, new_status, responder_type, responder_name } = req.body;
    await query(`INSERT INTO incident_responses (incident_id, responder_type, responder_name, message, new_status) VALUES ($1,$2,$3,$4,$5)`, [req.params.id, responder_type || 'agency', responder_name || 'Agência', message, new_status || null]);
    if (new_status) await query(`UPDATE incidents SET status = $1, updated_at = NOW() WHERE id = $2`, [new_status, req.params.id]);
    res.json({ ok: true });
  } catch (err) { logError('agency.incidents.respond', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/agency/scores', authenticateAgency, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const r = await query(`SELECT ps.*, ap.name AS promoter_name FROM promoter_scores ps JOIN agency_promoters ap ON ap.id = ps.agency_promoter_id WHERE ap.agency_id = $1 ORDER BY ps.score DESC`, [req.agencyId]);
    res.json(r.rows);
  } catch (err) { logError('agency.scores', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/agency/schedule', authenticateAgency, async (req, res) => {
  try {
    const hasTable = await tableExists('visit_requests');
    if (!hasTable) return res.json({ today: [], tomorrow: [], week: [] });
    const today = await query(`SELECT vr.*, ap.name AS promoter_name, u.name AS unit_name FROM visit_requests vr LEFT JOIN agency_promoters ap ON ap.id = vr.agency_promoter_id LEFT JOIN units u ON u.id = vr.unit_id WHERE vr.agency_id = $1 AND vr.visit_date = CURRENT_DATE ORDER BY vr.scheduled_time`, [req.agencyId]);
    const tomorrow = await query(`SELECT vr.*, ap.name AS promoter_name, u.name AS unit_name FROM visit_requests vr LEFT JOIN agency_promoters ap ON ap.id = vr.agency_promoter_id LEFT JOIN units u ON u.id = vr.unit_id WHERE vr.agency_id = $1 AND vr.visit_date = CURRENT_DATE + INTERVAL '1 day' ORDER BY vr.scheduled_time`, [req.agencyId]);
    const week = await query(`SELECT vr.*, ap.name AS promoter_name, u.name AS unit_name FROM visit_requests vr LEFT JOIN agency_promoters ap ON ap.id = vr.agency_promoter_id LEFT JOIN units u ON u.id = vr.unit_id WHERE vr.agency_id = $1 AND vr.visit_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' ORDER BY vr.visit_date, vr.scheduled_time`, [req.agencyId]);
    res.json({ today: today.rows, tomorrow: tomorrow.rows, week: week.rows });
  } catch (err) { logError('agency.schedule', err); res.json({ today: [], tomorrow: [], week: [] }); }
});

// ============ AGENCY: AI endpoints ============
router.get('/agency/daily-summary', authenticateAgency, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const today = new Date().toISOString().split('T')[0];
    const existing = await query(`SELECT * FROM daily_operational_summaries WHERE agency_id = $1 AND summary_date = $2 LIMIT 1`, [req.agencyId, today]);
    if (existing.rows.length) return res.json(existing.rows[0]);
    // Get org from agency
    const agR = await query('SELECT organization_id FROM agencies WHERE id = $1', [req.agencyId]);
    const orgId = agR.rows[0]?.organization_id;
    if (!orgId) return res.json({ ai_summary: null });
    const summary = await generateDailySummary(orgId, null, req.agencyId, 'agency');
    if (!summary) return res.json({ ai_summary: null, metrics: {} });
    res.json(summary);
  } catch (err) { logError('agency.daily_summary', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/agency/promoter-behavior/:promoterId', authenticateAgency, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const r = await query(`SELECT * FROM promoter_behavior_analysis WHERE agency_promoter_id = $1 ORDER BY analyzed_at DESC LIMIT 5`, [req.params.promoterId]);
    res.json(r.rows);
  } catch (err) { logError('agency.behavior', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/agency/promoter-behavior/:promoterId/analyze', authenticateAgency, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const agR = await query('SELECT organization_id FROM agencies WHERE id = $1', [req.agencyId]);
    const orgId = agR.rows[0]?.organization_id;
    if (!orgId) return res.status(400).json({ error: 'Org não encontrada' });
    const analysis = await analyzeBehaviorWithAI(orgId, req.params.promoterId);
    if (!analysis) return res.status(400).json({ error: 'IA não configurada' });
    res.json(analysis);
  } catch (err) { logError('agency.behavior.analyze', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ ADMIN: Incidents & Scores ============
router.get('/incidents', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.user.id);
    const r = await query(`SELECT i.*, ap.name AS promoter_name, a.name AS agency_name, u.name AS unit_name, (SELECT json_agg(ir ORDER BY ir.created_at) FROM incident_responses ir WHERE ir.incident_id = i.id) AS responses FROM incidents i LEFT JOIN agency_promoters ap ON ap.id = i.agency_promoter_id LEFT JOIN agencies a ON a.id = i.agency_id LEFT JOIN supermarket_units u ON u.id = i.reported_by_unit_id WHERE i.organization_id = $1 ORDER BY i.created_at DESC LIMIT 200`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('admin.incidents.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/incidents/:id/analyze', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.user.id);
    const classification = await analyzeIncidentWithAI(orgId, req.params.id);
    if (!classification) return res.status(400).json({ error: 'IA não configurada' });
    res.json(classification);
  } catch (err) { logError('admin.incident.analyze', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/incidents/analyze-batch', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.user.id);
    const unanalyzed = await query(`SELECT id FROM incidents WHERE organization_id = $1 AND ai_classification IS NULL ORDER BY created_at DESC LIMIT 20`, [orgId]);
    const results = [];
    for (const inc of unanalyzed.rows) {
      const c = await analyzeIncidentWithAI(orgId, inc.id);
      results.push({ id: inc.id, classification: c });
    }
    res.json({ analyzed: results.length, results });
  } catch (err) { logError('admin.incidents.batch_analyze', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/scores', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.user.id);
    const r = await query(`SELECT ps.*, ap.name AS promoter_name, a.name AS agency_name FROM promoter_scores ps JOIN agency_promoters ap ON ap.id = ps.agency_promoter_id LEFT JOIN agencies a ON a.id = ap.agency_id WHERE ps.organization_id = $1 ORDER BY ps.score DESC`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('admin.scores', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/daily-summary', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.user.id);
    const today = new Date().toISOString().split('T')[0];
    const existing = await query(`SELECT * FROM daily_operational_summaries WHERE organization_id = $1 AND summary_type = 'admin' AND summary_date = $2 LIMIT 1`, [orgId, today]);
    if (existing.rows.length) return res.json(existing.rows[0]);
    const summary = await generateDailySummary(orgId, null, null, 'admin');
    if (!summary) return res.json({ ai_summary: null, metrics: {} });
    res.json(summary);
  } catch (err) { logError('admin.daily_summary', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/diagnostics', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.user.id);
    const r = await query(`SELECT * FROM operational_diagnostics WHERE organization_id = $1 ORDER BY generated_at DESC LIMIT 10`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('admin.diagnostics', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/behavior/:promoterId', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const r = await query(`SELECT * FROM promoter_behavior_analysis WHERE agency_promoter_id = $1 ORDER BY analyzed_at DESC LIMIT 5`, [req.params.promoterId]);
    res.json(r.rows);
  } catch (err) { logError('admin.behavior', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/behavior/:promoterId/analyze', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.user.id);
    const analysis = await analyzeBehaviorWithAI(orgId, req.params.promoterId);
    if (!analysis) return res.status(400).json({ error: 'IA não configurada' });
    res.json(analysis);
  } catch (err) { logError('admin.behavior.analyze', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ ADMIN: Authorized contacts management ============
router.get('/authorized-contacts', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.userId);
    const r = await query(`SELECT pac.*, u.name as unit_name FROM pdv_authorized_contacts pac LEFT JOIN supermarket_units u ON u.id = pac.unit_id WHERE pac.organization_id = $1 ORDER BY pac.name`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('admin.contacts', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ ADMIN: Assistant audit ============
router.get('/assistant-log', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.userId);
    const r = await query(`SELECT al.*, pac.name as contact_name, u.name as unit_name FROM assistant_audit_log al LEFT JOIN pdv_authorized_contacts pac ON pac.id = al.contact_id LEFT JOIN supermarket_units u ON u.id = al.unit_id WHERE al.organization_id = $1 ORDER BY al.created_at DESC LIMIT 200`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('admin.audit_log', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ WHATSAPP ASSISTANT: Process incoming message ============
router.post('/whatsapp-assistant/process', authenticate, async (req, res) => {
  try {
    await ensureIncidentsInfra();
    const orgId = await getOrgId(req.userId);
    const { phone, message: userMessage, audio_transcript } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefone obrigatório' });

    const msgContent = audio_transcript || userMessage;
    if (!msgContent) return res.status(400).json({ error: 'Mensagem ou transcrição obrigatória' });

    // Find authorized contact
    const contactR = await query(`SELECT pac.*, u.name as unit_name FROM pdv_authorized_contacts pac LEFT JOIN supermarket_units u ON u.id = pac.unit_id WHERE pac.phone = $1 AND pac.organization_id = $2 AND pac.active = true LIMIT 1`, [phone, orgId]);
    
    if (!contactR.rows.length) {
      // Log unauthorized attempt
      await query(`INSERT INTO assistant_audit_log (organization_id, phone, interaction_type, user_message, ai_response, authorized) VALUES ($1,$2,'unauthorized',$3,'Número não autorizado',false)`, [orgId, phone, msgContent]);
      return res.json({ response: 'Este número não está autorizado para interagir com o assistente. Solicite liberação ao administrador do supermercado.', authorized: false });
    }

    const contact = contactR.rows[0];
    const permissions = contact.permissions || [];
    const config = await getAIConfig(orgId);

    if (!config) {
      return res.json({ response: 'Assistente indisponível no momento. IA não configurada.', authorized: true });
    }

    // Determine intent and respond
    const { callAI } = await import('../lib/ai-caller.js');
    const tools = [
      {
        type: 'function',
        function: {
          name: 'consultar_operacao',
          description: 'Consulta dados operacionais do PDV: promotores ativos, marcas, entradas do dia',
          parameters: { type: 'object', properties: { query_type: { type: 'string', enum: ['promotores_ativos', 'marcas_hoje', 'entradas_hoje', 'agenda_amanha', 'bloqueios_hoje'] } }, required: ['query_type'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'registrar_ocorrencia',
          description: 'Registra uma ocorrência/incidente com um promotor',
          parameters: { type: 'object', properties: { description: { type: 'string' }, promoter_name: { type: 'string' }, incident_type: { type: 'string', enum: ['atraso', 'ausencia', 'nao_execucao', 'comportamento_inadequado', 'outro'] }, severity: { type: 'string', enum: ['baixa', 'media', 'alta'] } }, required: ['description'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'consultar_score',
          description: 'Consulta o score de confiabilidade de um promotor',
          parameters: { type: 'object', properties: { promoter_name: { type: 'string' } }, required: ['promoter_name'] }
        }
      }
    ];

    // Filter tools by permissions
    const allowedTools = tools.filter(t => {
      if (permissions.includes('acesso_total')) return true;
      if (t.function.name === 'consultar_operacao' && permissions.includes('consultar_operacao')) return true;
      if (t.function.name === 'registrar_ocorrencia' && permissions.includes('registrar_ocorrencia')) return true;
      if (t.function.name === 'consultar_score' && permissions.includes('consultar_score')) return true;
      return false;
    });

    const messages = [
      { role: 'system', content: `Você é o assistente operacional do supermercado "${contact.unit_name || 'PDV'}". Responda de forma curta, objetiva e operacional. O contato é ${contact.name} (${contact.role}). Use as ferramentas disponíveis para consultar dados ou registrar ocorrências. Sempre confirme antes de registrar uma ocorrência.` },
      { role: 'user', content: msgContent }
    ];

    const result = await callAI(config, messages, { temperature: 0.3, maxTokens: 500, tools: allowedTools.length > 0 ? allowedTools : undefined });
    
    let responseText = result.content || 'Desculpe, não consegui processar sua solicitação.';
    let interactionType = 'query';
    let incidentId = null;

    // Handle tool calls
    if (result.toolCalls?.length) {
      for (const tc of result.toolCalls) {
        if (tc.name === 'consultar_operacao') {
          interactionType = 'query';
          // Execute query based on type
          const qt = tc.arguments.query_type;
          let data;
          if (qt === 'promotores_ativos') {
            data = await query(`SELECT ap.name, a.name as agency_name FROM access_entries ae JOIN agency_promoters ap ON ap.id = ae.agency_promoter_id LEFT JOIN agencies a ON a.id = ap.agency_id WHERE ae.supermarket_unit_id = $1 AND ae.status = 'authorized' AND ae.exit_at IS NULL AND DATE(ae.entry_at) = CURRENT_DATE`, [contact.unit_id]).catch(() => ({ rows: [] }));
            responseText = data.rows.length ? `Promotores ativos agora:\n${data.rows.map(r => `• ${r.name} (${r.agency_name || '—'})`).join('\n')}` : 'Nenhum promotor ativo no momento.';
          } else if (qt === 'entradas_hoje') {
            data = await query(`SELECT COUNT(*) as total FROM access_entries WHERE supermarket_unit_id = $1 AND DATE(entry_at) = CURRENT_DATE`, [contact.unit_id]).catch(() => ({ rows: [{ total: 0 }] }));
            responseText = `Total de entradas hoje: ${data.rows[0]?.total || 0}`;
          } else if (qt === 'bloqueios_hoje') {
            data = await query(`SELECT COUNT(*) as total FROM access_entries WHERE supermarket_unit_id = $1 AND status = 'blocked' AND DATE(entry_at) = CURRENT_DATE`, [contact.unit_id]).catch(() => ({ rows: [{ total: 0 }] }));
            responseText = `Entradas bloqueadas hoje: ${data.rows[0]?.total || 0}`;
          } else {
            responseText = 'Consulta processada. Dados disponíveis no painel.';
          }
        } else if (tc.name === 'registrar_ocorrencia') {
          interactionType = 'incident_creation';
          const typeMap = { atraso: 'delay', ausencia: 'non_execution', nao_execucao: 'non_execution', comportamento_inadequado: 'misconduct', outro: 'other' };
          const sevMap = { baixa: 'low', media: 'medium', alta: 'high' };
          const r = await query(`INSERT INTO incidents (organization_id, reported_by_unit_id, reported_by_user_name, incident_type, severity, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [orgId, contact.unit_id, contact.name, typeMap[tc.arguments.incident_type] || 'other', sevMap[tc.arguments.severity] || 'low', tc.arguments.description]);
          incidentId = r.rows[0]?.id;
          if (incidentId) {
            analyzeIncidentWithAI(orgId, incidentId).catch(e => logError('ai.auto_analyze_wa', e));
            responseText = `✅ Ocorrência registrada com sucesso!\nDescrição: ${tc.arguments.description}\nTipo: ${tc.arguments.incident_type || 'outro'}\nGravidade: ${tc.arguments.severity || 'baixa'}`;
          }
        } else if (tc.name === 'consultar_score') {
          interactionType = 'score_check';
          const scoreR = await query(`SELECT ps.score, ap.name FROM promoter_scores ps JOIN agency_promoters ap ON ap.id = ps.agency_promoter_id WHERE ap.name ILIKE $1 LIMIT 3`, [`%${tc.arguments.promoter_name}%`]).catch(() => ({ rows: [] }));
          if (scoreR.rows.length) {
            responseText = scoreR.rows.map(s => `${s.name}: Score ${s.score}/100`).join('\n');
          } else {
            responseText = 'Promotor não encontrado ou sem score registrado.';
          }
        }
      }
    }

    // Log the interaction
    await query(`INSERT INTO assistant_audit_log (organization_id, unit_id, contact_id, phone, interaction_type, user_message, ai_response, incident_id, authorized) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
      [orgId, contact.unit_id, contact.id, phone, interactionType, msgContent, responseText, incidentId]);

    res.json({ response: responseText, authorized: true, interaction_type: interactionType, incident_id: incidentId });
  } catch (err) { logError('wa.assistant.process', err); res.status(500).json({ error: 'Erro no assistente' }); }
});

// ============ WHATSAPP AGENT CONFIG: Save/Load ============
router.get('/whatsapp-agent-config', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    await query(`CREATE TABLE IF NOT EXISTS whatsapp_agent_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name TEXT NOT NULL DEFAULT 'Assistente Operacional PDV',
      is_active BOOLEAN DEFAULT false,
      connection_id UUID,
      ai_provider TEXT DEFAULT 'openai',
      ai_model TEXT DEFAULT 'gpt-4o-mini',
      system_prompt TEXT,
      temperature NUMERIC DEFAULT 0.4,
      max_tokens INTEGER DEFAULT 1000,
      greeting_message TEXT,
      fallback_message TEXT,
      capabilities JSONB DEFAULT '[]'::jsonb,
      personality_traits JSONB DEFAULT '[]'::jsonb,
      language TEXT DEFAULT 'pt-BR',
      context_window INTEGER DEFAULT 10,
      working_hours JSONB,
      notification_rules JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id)
    )`);
    const r = await query('SELECT * FROM whatsapp_agent_config WHERE organization_id = $1', [orgId]);
    res.json(r.rows[0] || {});
  } catch (err) { logError('wa.agent.config.get', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/whatsapp-agent-config', authenticate, async (req, res) => {
  try {
    const orgId = await getOrgId(req.userId);
    const { name, is_active, connection_id, ai_provider, ai_model, system_prompt, temperature, max_tokens, greeting_message, fallback_message, capabilities, personality_traits, language, context_window, working_hours, notification_rules } = req.body;
    
    // Ensure table
    await query(`CREATE TABLE IF NOT EXISTS whatsapp_agent_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name TEXT NOT NULL DEFAULT 'Assistente Operacional PDV',
      is_active BOOLEAN DEFAULT false,
      connection_id UUID,
      ai_provider TEXT DEFAULT 'openai',
      ai_model TEXT DEFAULT 'gpt-4o-mini',
      system_prompt TEXT,
      temperature NUMERIC DEFAULT 0.4,
      max_tokens INTEGER DEFAULT 1000,
      greeting_message TEXT,
      fallback_message TEXT,
      capabilities JSONB DEFAULT '[]'::jsonb,
      personality_traits JSONB DEFAULT '[]'::jsonb,
      language TEXT DEFAULT 'pt-BR',
      context_window INTEGER DEFAULT 10,
      working_hours JSONB,
      notification_rules JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id)
    )`);

    const r = await query(`INSERT INTO whatsapp_agent_config (organization_id, name, is_active, connection_id, ai_provider, ai_model, system_prompt, temperature, max_tokens, greeting_message, fallback_message, capabilities, personality_traits, language, context_window, working_hours, notification_rules)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (organization_id) DO UPDATE SET
        name=EXCLUDED.name, is_active=EXCLUDED.is_active, connection_id=EXCLUDED.connection_id,
        ai_provider=EXCLUDED.ai_provider, ai_model=EXCLUDED.ai_model, system_prompt=EXCLUDED.system_prompt,
        temperature=EXCLUDED.temperature, max_tokens=EXCLUDED.max_tokens, greeting_message=EXCLUDED.greeting_message,
        fallback_message=EXCLUDED.fallback_message, capabilities=EXCLUDED.capabilities, personality_traits=EXCLUDED.personality_traits,
        language=EXCLUDED.language, context_window=EXCLUDED.context_window, working_hours=EXCLUDED.working_hours,
        notification_rules=EXCLUDED.notification_rules, updated_at=NOW()
      RETURNING *`,
      [orgId, name, is_active, connection_id || null, ai_provider, ai_model, system_prompt, temperature, max_tokens, greeting_message, fallback_message, JSON.stringify(capabilities || []), JSON.stringify(personality_traits || []), language, context_window, JSON.stringify(working_hours || null), JSON.stringify(notification_rules || null)]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('wa.agent.config.save', err); res.status(500).json({ error: 'Erro ao salvar' }); }
});

// ============ SHARED AUTHORIZATION LETTERS ============
let sharedLettersSchemaReady = null;
async function ensureSharedLettersSchema() {
  if (sharedLettersSchemaReady) return sharedLettersSchemaReady;
  sharedLettersSchemaReady = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS shared_authorization_letters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      agency_id UUID,
      agency_name TEXT,
      promoter_name TEXT NOT NULL,
      promoter_cpf TEXT NOT NULL,
      supermarket_unit_id UUID REFERENCES supermarket_units(id) ON DELETE CASCADE,
      unit_name TEXT,
      network_name TEXT,
      brands TEXT[] DEFAULT '{}',
      allowed_weekdays INTEGER[] DEFAULT '{1,2,3,4,5}',
      start_time TIME DEFAULT '08:00',
      end_time TIME DEFAULT '18:00',
      valid_from TEXT,
      valid_until TEXT,
      is_digitally_signed BOOLEAN DEFAULT false,
      signature_hash TEXT,
      signed_at TEXT,
      signed_by TEXT,
      pdf_url TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_shared_letters_unit ON shared_authorization_letters(supermarket_unit_id, status)');
    await query('CREATE INDEX IF NOT EXISTS idx_shared_letters_agency ON shared_authorization_letters(agency_id)');
  })();
  try { await sharedLettersSchemaReady; } catch { sharedLettersSchemaReady = null; throw arguments[0]; }
}

// Agency: save shared letter
router.post('/agency/shared-letters', authenticateAgency, async (req, res) => {
  try {
    await ensureSharedLettersSchema();
    const { promoter_name, promoter_cpf, supermarket_unit_id, unit_name, network_name, brands, allowed_weekdays, start_time, end_time, valid_from, valid_until, is_digitally_signed, signature_hash, signed_at, signed_by, pdf_url } = req.body;
    const agency = await query('SELECT organization_id, name FROM agencies WHERE id = $1', [req.agencyId]);
    const orgId = agency.rows[0]?.organization_id;
    const agencyName = agency.rows[0]?.name;
    const r = await query(`INSERT INTO shared_authorization_letters (organization_id, agency_id, agency_name, promoter_name, promoter_cpf, supermarket_unit_id, unit_name, network_name, brands, allowed_weekdays, start_time, end_time, valid_from, valid_until, is_digitally_signed, signature_hash, signed_at, signed_by, pdf_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [orgId, req.agencyId, agencyName, promoter_name, onlyDigits(promoter_cpf), supermarket_unit_id || null, unit_name, network_name, brands || [], allowed_weekdays || [1,2,3,4,5], start_time, end_time, valid_from, valid_until, is_digitally_signed, signature_hash, signed_at, signed_by, pdf_url]);
    res.json(r.rows[0]);
  } catch (err) { logError('shared-letter.create', err); res.status(500).json({ error: 'Erro ao salvar carta' }); }
});

// Agency: list own shared letters
router.get('/agency/shared-letters', authenticateAgency, async (req, res) => {
  try {
    await ensureSharedLettersSchema();
    const r = await query('SELECT * FROM shared_authorization_letters WHERE agency_id = $1 ORDER BY created_at DESC', [req.agencyId]);
    res.json(r.rows);
  } catch (err) { logError('shared-letter.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Supermarket: list shared letters for this unit
router.get('/supermarket-portal/shared-letters', authenticateSupermarket, async (req, res) => {
  try {
    await ensureSharedLettersSchema();
    const r = await query('SELECT * FROM shared_authorization_letters WHERE supermarket_unit_id = $1 AND status = $2 ORDER BY created_at DESC', [req.unitId, 'active']);
    res.json(r.rows);
  } catch (err) { logError('sm.shared-letters', err); res.status(500).json({ error: 'Erro' }); }
});

// ============ ONSITE REGISTRATION KEYS (Freelance) ============
let registrationKeysSchemaReady = null;
async function ensureRegistrationKeysSchema() {
  if (registrationKeysSchemaReady) return registrationKeysSchemaReady;
  registrationKeysSchemaReady = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS onsite_registration_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      key_code VARCHAR(8) NOT NULL,
      whatsapp_number TEXT,
      promoter_name TEXT,
      sent_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      used_by_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE SET NULL,
      supermarket_unit_id UUID REFERENCES supermarket_units(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_reg_keys_agency ON onsite_registration_keys(agency_id, status)');
    await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_keys_code ON onsite_registration_keys(key_code) WHERE status = \'pending\'');
  })();
  try { await registrationKeysSchemaReady; } catch { registrationKeysSchemaReady = null; throw arguments[0]; }
}

// Agency: generate registration key and send via WhatsApp
router.post('/agency/registration-keys', authenticateAgency, async (req, res) => {
  try {
    await ensureRegistrationKeysSchema();
    const { whatsapp_number, promoter_name } = req.body;
    if (!whatsapp_number) return res.status(400).json({ error: 'Número de WhatsApp é obrigatório' });
    const agency = await query('SELECT organization_id, name FROM agencies WHERE id = $1', [req.agencyId]);
    const orgId = agency.rows[0]?.organization_id;
    const agencyName = agency.rows[0]?.name;
    // Generate 6-digit key
    const keyCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours
    const r = await query(`INSERT INTO onsite_registration_keys (organization_id, agency_id, key_code, whatsapp_number, promoter_name, sent_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,NOW(),$6) RETURNING *`,
      [orgId, req.agencyId, keyCode, onlyDigits(whatsapp_number), promoter_name || null, expiresAt]);
    
    // Try to send via WhatsApp (best effort)
    try {
      const conn = await query(`SELECT c.* FROM connections c JOIN organization_members om ON om.organization_id = c.organization_id WHERE c.organization_id = $1 AND c.active = true ORDER BY c.is_default DESC LIMIT 1`, [orgId]);
      if (conn.rows[0]) {
        const { sendWhatsAppMessage } = await import('../lib/whatsapp-provider.js');
        const phone = onlyDigits(whatsapp_number);
        const msg = `🔑 *Chave de Cadastro no PDV*\n\nOlá${promoter_name ? ` ${promoter_name}` : ''}!\n\nSua chave de cadastro para acesso ao PDV é:\n\n*${keyCode}*\n\nUse esta chave no totem do supermercado para se cadastrar.\n\n⏰ Válida por 4 horas.\n\n_${agencyName}_`;
        await sendWhatsAppMessage(conn.rows[0], phone, msg).catch(() => {});
      }
    } catch {}

    res.json(r.rows[0]);
  } catch (err) { logError('reg-key.create', err); res.status(500).json({ error: 'Erro ao gerar chave' }); }
});

// Agency: list registration keys
router.get('/agency/registration-keys', authenticateAgency, async (req, res) => {
  try {
    await ensureRegistrationKeysSchema();
    const r = await query('SELECT * FROM onsite_registration_keys WHERE agency_id = $1 ORDER BY created_at DESC LIMIT 50', [req.agencyId]);
    res.json(r.rows);
  } catch (err) { logError('reg-key.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Totem: validate registration key
router.post('/totem/validate-registration-key', async (req, res) => {
  try {
    const totemToken = req.headers['x-totem-token'];
    if (!totemToken) return res.status(401).json({ error: 'Token do totem não fornecido' });
    await ensureRegistrationKeysSchema();
    const { key_code } = req.body;
    if (!key_code || key_code.length !== 6) return res.status(400).json({ error: 'Chave inválida' });
    const r = await query(`SELECT rk.*, a.name as agency_name FROM onsite_registration_keys rk JOIN agencies a ON a.id = rk.agency_id WHERE rk.key_code = $1 AND rk.status = 'pending' AND rk.expires_at > NOW()`, [key_code]);
    if (!r.rows.length) return res.status(404).json({ error: 'Chave inválida ou expirada' });
    res.json({ valid: true, key: r.rows[0] });
  } catch (err) { logError('reg-key.validate', err); res.status(500).json({ error: 'Erro' }); }
});

// Totem: register freelance promoter with key
router.post('/totem/register-freelance', async (req, res) => {
  try {
    const totemToken = req.headers['x-totem-token'];
    if (!totemToken) return res.status(401).json({ error: 'Token do totem não fornecido' });
    await ensureRegistrationKeysSchema();
    const { key_code, name, cpf, phone, photo_url } = req.body;
    if (!key_code || !name || !cpf) return res.status(400).json({ error: 'Dados incompletos' });
    // Validate key
    const keyR = await query(`SELECT * FROM onsite_registration_keys WHERE key_code = $1 AND status = 'pending' AND expires_at > NOW()`, [key_code]);
    if (!keyR.rows.length) return res.status(404).json({ error: 'Chave inválida ou expirada' });
    const regKey = keyR.rows[0];
    // Check if CPF already exists for this agency
    const existing = await query('SELECT id FROM agency_promoters WHERE agency_id = $1 AND cpf = $2', [regKey.agency_id, onlyDigits(cpf)]);
    if (existing.rows.length) return res.status(409).json({ error: 'CPF já cadastrado nesta agência', promoter_id: existing.rows[0].id });

    // Check if agency is over promoter limit (don't block, just flag for billing)
    const agency = await query('SELECT a.*, au.email FROM agencies a LEFT JOIN agency_users au ON au.agency_id = a.id WHERE a.id = $1 LIMIT 1', [regKey.agency_id]);
    const agencyData = agency.rows[0];
    const activeCount = await query('SELECT COUNT(*) as c FROM agency_promoters WHERE agency_id = $1 AND status = \'active\'', [regKey.agency_id]);
    const currentCount = parseInt(activeCount.rows[0]?.c || '0');
    const maxPromoters = agencyData?.max_promoters || 10;
    const isOverLimit = currentCount >= maxPromoters;

    // Create promoter (never block on-site registration)
    const pR = await query(`INSERT INTO agency_promoters (agency_id, name, cpf, phone, photo_url, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [regKey.agency_id, name, onlyDigits(cpf), phone ? onlyDigits(phone) : null, normalizePhotoUrl(photo_url)]);
    
    // Mark key as used
    const session = await query(`SELECT su.id, su.name FROM totem_sessions ts JOIN supermarket_units su ON su.id = ts.supermarket_unit_id WHERE ts.token_hash = $1 AND ts.expires_at > NOW()`, [totemToken]);
    const unitId = session.rows[0]?.id || null;
    await query(`UPDATE onsite_registration_keys SET status = 'used', used_at = NOW(), used_by_promoter_id = $1, supermarket_unit_id = $2 WHERE id = $3`,
      [pR.rows[0].id, unitId, regKey.id]);
    
    // Notify agency via WhatsApp (best effort)
    const orgId = agencyData?.organization_id;
    try {
      const conn = await query(`SELECT c.* FROM connections c WHERE c.organization_id = $1 AND c.active = true ORDER BY c.is_default DESC LIMIT 1`, [orgId]);
      if (conn.rows[0] && agencyData?.responsible_phone) {
        const { sendWhatsAppMessage } = await import('../lib/whatsapp-provider.js');
        const unitName = session.rows[0]?.name || 'PDV';
        const overLimitMsg = isOverLimit ? `\n\n⚠️ *Atenção:* Este cadastro excedeu o limite do plano (${maxPromoters} promotores). Uma cobrança avulsa será gerada.` : '';
        const msg = `✅ *Cadastro Realizado no PDV*\n\nO promotor *${name}* (CPF: ${onlyDigits(cpf)}) foi cadastrado com sucesso no ${unitName}.\n\nChave utilizada: ${key_code}${overLimitMsg}`;
        await sendWhatsAppMessage(conn.rows[0], onlyDigits(agencyData.responsible_phone), msg).catch(() => {});
      }
    } catch {}

    // If over limit, notify Ayratech admin for extra billing
    if (isOverLimit && orgId) {
      try {
        // Log audit entry for billing
        await query(`INSERT INTO access_audit_logs (organization_id, action, entity_type, entity_id, agency_id, agency_promoter_id, details)
          VALUES ($1, 'overlimit_registration', 'promoter', $2, $3, $4, $5)`,
          [orgId, pR.rows[0].id, regKey.agency_id, pR.rows[0].id,
           JSON.stringify({
             agency_name: agencyData.name,
             promoter_name: name,
             promoter_cpf: onlyDigits(cpf),
             current_count: currentCount + 1,
             max_promoters: maxPromoters,
             unit_name: session.rows[0]?.name || null,
             registration_type: 'onsite_freelance',
             requires_extra_billing: true
           })
          ]);

        // Notify org admins via WhatsApp
        const admins = await query(`SELECT u.phone FROM users u JOIN organization_members om ON om.user_id = u.id WHERE om.organization_id = $1 AND om.role IN ('owner','admin') AND u.phone IS NOT NULL LIMIT 3`, [orgId]);
        const conn = await query(`SELECT c.* FROM connections c WHERE c.organization_id = $1 AND c.active = true ORDER BY c.is_default DESC LIMIT 1`, [orgId]);
        if (conn.rows[0]) {
          const { sendWhatsAppMessage } = await import('../lib/whatsapp-provider.js');
          const unitName = session.rows[0]?.name || 'PDV';
          const billingMsg = `💰 *Cobrança Avulsa Necessária*\n\nA agência *${agencyData.name}* cadastrou um promotor freelance acima do limite do plano.\n\n👤 ${name} (CPF: ${onlyDigits(cpf)})\n📍 ${unitName}\n📊 Promotores: ${currentCount + 1}/${maxPromoters}\n\nÉ necessário gerar uma cobrança avulsa para este promotor adicional.`;
          for (const admin of admins.rows) {
            await sendWhatsAppMessage(conn.rows[0], onlyDigits(admin.phone), billingMsg).catch(() => {});
          }
        }
      } catch (billingErr) { logError('totem.register-freelance.billing-notify', billingErr); }
    }

    res.json({ success: true, promoter: pR.rows[0], over_limit: isOverLimit });
  } catch (err) { logError('totem.register-freelance', err); res.status(500).json({ error: 'Erro ao cadastrar' }); }
});

export default router;
