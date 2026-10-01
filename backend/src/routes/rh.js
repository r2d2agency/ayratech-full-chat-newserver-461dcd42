import express from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { callAI } from '../lib/ai-caller.js';
import { logInfo, logError } from '../logger.js';
import {
  TZ,
  DEFAULT_ENTRY,
  DEFAULT_EXIT,
  formatHHMM,
  parseHHMMToMinutes,
  timeColumnToMinutes,
  classifyDay,
  dayBalance,
  accumulate,
} from '../lib/time-calc.js';


const router = express.Router();

// Public route for client-side logging (must be BEFORE router.use(authenticate))
router.post('/client-logs', async (req, res) => {
  try {
    const { logFromClient } = await import('../logger.js');
    const { level, event, payload } = req.body;
    
    // Enrich with request context (userId will be null if not authenticated, which is expected for public logs)
    const enrichedPayload = {
      ...payload,
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      user_id: req.userId || null
    };

    logFromClient(level || 'info', event || 'client_event', enrichedPayload);
    res.json({ ok: true });
  } catch (err) {
    console.error('Client logs error:', err);
    res.status(500).json({ error: 'Erro ao registrar log do cliente' });
  }
});

router.use(authenticate);

const BR_GEOCODE_USER_AGENT = 'Ayratech/1.0 (suporte@ayratech.app.br)';

function splitAddressAndNumber(address = '') {
  const normalized = String(address || '').trim().replace(/\s+/g, ' ');
  const match = normalized.match(/^(.*?)(?:,\s*|\s+)(?:n[ºo°.]?\s*)?(\d{1,6}[a-zA-Z]?)\s*$/i);
  if (!match) return { street: normalized, number: '' };
  return {
    street: String(match[1] || '').trim().replace(/,$/, ''),
    number: String(match[2] || '').trim(),
  };
}

function normalizeGeocodeInput({ address, address_number, complement, neighborhood, city, state, zip_code, requireComplete = false }) {
  const parsed = splitAddressAndNumber(address);
  const cleanZip = String(zip_code || '').replace(/\D/g, '');
  const street = String(parsed.street || '').trim();
  const number = String(address_number || parsed.number || '').trim();
  const normalized = {
    street,
    number,
    complement: String(complement || '').trim(),
    neighborhood: String(neighborhood || '').trim(),
    city: String(city || '').trim(),
    state: String(state || '').trim().toUpperCase(),
    cleanZip,
  };

  if (requireComplete) {
    if (!street || !number || !normalized.neighborhood || !normalized.city || !normalized.state || cleanZip.length !== 8) {
      return {
        normalized,
        validationError: 'Endereço incompleto: informe rua, número, bairro, cidade, UF e CEP válido (8 dígitos).',
      };
    }
  }

  return { normalized, validationError: null };
}

function buildGeocodeCandidates(normalized) {
  const { street, number, complement, neighborhood, city, state, cleanZip } = normalized;
  const streetWithNumber = [street, number].filter(Boolean).join(', ');
  const streetWithComplement = [streetWithNumber, complement].filter(Boolean).join(', ');

  return [
    [streetWithComplement, neighborhood, `${city} - ${state}`, cleanZip, 'Brasil'].filter(Boolean).join(', '),
    [streetWithComplement, neighborhood, city, state, cleanZip, 'Brasil'].filter(Boolean).join(', '),
    [streetWithComplement, neighborhood, city, state, 'Brasil'].filter(Boolean).join(', '),
    [streetWithNumber, neighborhood, `${city} - ${state}`, cleanZip, 'Brasil'].filter(Boolean).join(', '),
    [streetWithNumber, neighborhood, city, state, cleanZip, 'Brasil'].filter(Boolean).join(', '),
    [streetWithNumber, neighborhood, city, state, 'Brasil'].filter(Boolean).join(', '),
    [street, neighborhood, city, state, cleanZip, 'Brasil'].filter(Boolean).join(', '),
  ].filter((candidate, index, arr) => candidate && arr.indexOf(candidate) === index);
}

async function geocodeAddressWithFallback(input, options = {}) {
  const { requireComplete = false } = options;
  const { normalized, validationError } = normalizeGeocodeInput({ ...input, requireComplete });
  const candidates = buildGeocodeCandidates(normalized);

  if (validationError) {
    return {
      geo: null,
      validationError,
      attemptedAddress: candidates[0] || [normalized.street, normalized.number, normalized.complement, normalized.neighborhood, normalized.city, normalized.state, normalized.cleanZip, 'Brasil'].filter(Boolean).join(', '),
    };
  }

  for (const candidate of candidates) {
    try {
      const q = encodeURIComponent(candidate);
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=${q}`;
      const res = await fetch(url, { headers: { 'User-Agent': BR_GEOCODE_USER_AGENT } });
      const data = await res.json();
      if (Array.isArray(data) && data[0]) {
        return {
          geo: {
            lat: parseFloat(data[0].lat),
            lng: parseFloat(data[0].lon),
            display_name: data[0].display_name,
          },
          validationError: null,
          attemptedAddress: candidate,
        };
      }
    } catch (_) {}
  }

  return { geo: null, validationError: null, attemptedAddress: candidates[0] || '' };
}

// Auto-geocode using canonical Brazilian address + Nominatim
async function autoGeocodeAddress(address, city, state, zip_code, neighborhood, address_number = null, complement = null) {
  const result = await geocodeAddressWithFallback({ address, address_number, complement, neighborhood, city, state, zip_code });
  return result.geo;
}

let holidaysInfraPromise = null;
const seededHolidayYears = new Set();

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function formatHolidayDate(year, month, day) {
  return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
}

function calculateEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addUtcDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate;
}

function toIsoDate(date) {
  return formatHolidayDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function getBrazilNationalHolidays(year) {
  const safeYear = Number(year);
  if (!Number.isInteger(safeYear) || safeYear < 2000 || safeYear > 2100) {
    return [];
  }

  const easterSunday = calculateEasterSunday(safeYear);
  const goodFriday = addUtcDays(easterSunday, -2);

  return [
    { name: 'Confraternização Universal', holiday_date: formatHolidayDate(safeYear, 1, 1), type: 'nacional', recurring: true },
    { name: 'Paixão de Cristo', holiday_date: toIsoDate(goodFriday), type: 'nacional', recurring: false },
    { name: 'Tiradentes', holiday_date: formatHolidayDate(safeYear, 4, 21), type: 'nacional', recurring: true },
    { name: 'Dia do Trabalho', holiday_date: formatHolidayDate(safeYear, 5, 1), type: 'nacional', recurring: true },
    { name: 'Independência do Brasil', holiday_date: formatHolidayDate(safeYear, 9, 7), type: 'nacional', recurring: true },
    { name: 'Nossa Senhora Aparecida', holiday_date: formatHolidayDate(safeYear, 10, 12), type: 'nacional', recurring: true },
    { name: 'Finados', holiday_date: formatHolidayDate(safeYear, 11, 2), type: 'nacional', recurring: true },
    { name: 'Proclamação da República', holiday_date: formatHolidayDate(safeYear, 11, 15), type: 'nacional', recurring: true },
    { name: 'Natal', holiday_date: formatHolidayDate(safeYear, 12, 25), type: 'nacional', recurring: true },
  ];
}

async function ensureHolidaysInfrastructure() {
  if (!holidaysInfraPromise) {
    holidaysInfraPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS holidays (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          holiday_date DATE NOT NULL,
          type VARCHAR(20) DEFAULT 'nacional',
          state VARCHAR(2),
          city VARCHAR(100),
          recurring BOOLEAN DEFAULT true,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS name VARCHAR(255)`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS holiday_date DATE`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'nacional'`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS state VARCHAR(2)`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS city VARCHAR(100)`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS recurring BOOLEAN DEFAULT true`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
      await query(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
      await query(`CREATE INDEX IF NOT EXISTS idx_holidays_org ON holidays(organization_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(holiday_date)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_holidays_type ON holidays(type)`);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_org_name_date ON holidays(organization_id, name, holiday_date)`);
    })().catch((error) => {
      holidaysInfraPromise = null;
      throw error;
    });
  }

  return holidaysInfraPromise;
}

async function seedNationalHolidays(orgId, year) {
  const safeYear = Number(year);
  const holidays = getBrazilNationalHolidays(safeYear);
  if (!orgId || !holidays.length) {
    return;
  }

  const cacheKey = `${orgId}:${safeYear}`;
  if (seededHolidayYears.has(cacheKey)) {
    return;
  }

  await Promise.all(
    holidays.map((holiday) =>
      query(
        `INSERT INTO holidays (organization_id, name, holiday_date, type, state, city, recurring, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT (organization_id, name, holiday_date) DO NOTHING`,
        [orgId, holiday.name, holiday.holiday_date, holiday.type, null, null, holiday.recurring]
      )
    )
  );

  seededHolidayYears.add(cacheKey);
}

router.use('/holidays', async (req, res, next) => {
  try {
    await ensureHolidaysInfrastructure();

    if (req.method === 'GET') {
      const orgId = req.query.org_id || await getUserOrgId(req.userId);
      const requestedYear = Number(req.query.year || new Date().getFullYear());
      if (orgId && Number.isInteger(requestedYear)) {
        await seedNationalHolidays(orgId, requestedYear);
      }
    }

    next();
  } catch (err) {
    logError('rh.holidays.bootstrap', err, { user_id: req.userId, path: req.path, method: req.method });
    res.status(500).json({ error: err?.message || 'Erro ao inicializar feriados' });
  }
});

let employeeExtraColsReady = false;
async function ensureEmployeeExtraColumns() {
  if (employeeExtraColsReady) return;
  try {
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS voter_zone VARCHAR(20)`);
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS voter_section VARCHAR(20)`);
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS skin_color VARCHAR(50)`);
    // facial_required: null = segue config da organização; true = sempre exigir; false = dispensado
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS facial_required BOOLEAN`);
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS punch_tolerance_minutes INTEGER`);
    // Ações: permissões para bater ponto
    // punch_requires_checkin: true = só pode bater ponto após fazer check-in numa loja/rota
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS punch_requires_checkin BOOLEAN DEFAULT false`);
    // punch_without_active_route: true = pode bater ponto sem ter uma rota ativa
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS punch_without_active_route BOOLEAN DEFAULT false`);
    employeeExtraColsReady = true;

  } catch (e) {
    logError('rh.employees.ensureExtraCols', e);
  }
}

router.use('/employees', async (req, _res, next) => {
  await ensureEmployeeExtraColumns();
  next();
});

// Colunas reais da tabela employees que podem ser gravadas
const EMPLOYEE_UPDATABLE_COLS = new Set([
  'full_name','social_name','cpf','rg','rg_issuer','birth_date','gender','marital_status',
  'email','phone','phone2','address','address_number','complement','neighborhood','city',
  'state','zip_code','registration_number','worker_profile','employment_type','position',
  'role_level','branch_id','pdv_id','department_id','cost_center_id','direct_manager_id',
  'admission_date','contract_end_date','salary','work_schedule','bank_name','bank_agency',
  'bank_account','bank_account_type','pix_key','pix_key_type','ctps_number','ctps_series',
  'pis_pasep','voter_id','voter_zone','voter_section','skin_color','cnpj','company_name',
  'status','photo_url','home_latitude','home_longitude','facial_required','punch_tolerance_minutes',
  'punch_requires_checkin','punch_without_active_route'
]);

let EMPLOYEE_TABLE_COLS_CACHE = null;
async function getEmployeeTableColumns() {
  if (EMPLOYEE_TABLE_COLS_CACHE) return EMPLOYEE_TABLE_COLS_CACHE;
  const res = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'employees'`
  );
  EMPLOYEE_TABLE_COLS_CACHE = new Set(res.rows.map((r) => r.column_name));
  return EMPLOYEE_TABLE_COLS_CACHE;
}

function emptyToNull(value) {

  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return value;
}

function parseOptionalInteger(value) {
  const normalized = emptyToNull(value);
  if (normalized === null) return null;
  const parsed = Number.parseInt(String(normalized), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEmployeePayload(body = {}) {
  // Sem jornada explícita, grava NULL para que o ponto use a jornada global
  // da organização (valor legado '08:00-17:00' tinha precedência indevida).
  const workSchedule = body.work_schedule
    ? (typeof body.work_schedule === 'object' ? JSON.stringify(body.work_schedule) : String(body.work_schedule))
    : null;

  return {
    ...body,
    full_name: typeof body.full_name === 'string' ? body.full_name.trim() : body.full_name,
    social_name: emptyToNull(body.social_name),
    cpf: emptyToNull(body.cpf),
    rg: emptyToNull(body.rg),
    rg_issuer: emptyToNull(body.rg_issuer),
    birth_date: emptyToNull(body.birth_date),
    gender: emptyToNull(body.gender),
    marital_status: emptyToNull(body.marital_status),
    email: emptyToNull(body.email),
    phone: emptyToNull(body.phone),
    phone2: emptyToNull(body.phone2),
    address: emptyToNull(body.address),
    address_number: emptyToNull(body.address_number),
    complement: emptyToNull(body.complement),
    neighborhood: emptyToNull(body.neighborhood),
    city: emptyToNull(body.city),
    state: (() => {
      const raw = emptyToNull(body.state);
      if (!raw) return null;
      const s = String(raw).trim().toUpperCase();
      if (s.length <= 2) return s;
      const UF_MAP = {
        'ACRE':'AC','ALAGOAS':'AL','AMAPA':'AP','AMAZONAS':'AM','BAHIA':'BA',
        'CEARA':'CE','DISTRITO FEDERAL':'DF','ESPIRITO SANTO':'ES','GOIAS':'GO',
        'MARANHAO':'MA','MATO GROSSO':'MT','MATO GROSSO DO SUL':'MS',
        'MINAS GERAIS':'MG','PARA':'PA','PARAIBA':'PB','PARANA':'PR',
        'PERNAMBUCO':'PE','PIAUI':'PI','RIO DE JANEIRO':'RJ',
        'RIO GRANDE DO NORTE':'RN','RIO GRANDE DO SUL':'RS','RONDONIA':'RO',
        'RORAIMA':'RR','SANTA CATARINA':'SC','SAO PAULO':'SP','SERGIPE':'SE',
        'TOCANTINS':'TO',
      };
      const normalized = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return UF_MAP[normalized] || s.substring(0, 2);
    })(),
    zip_code: emptyToNull(body.zip_code),
    registration_number: emptyToNull(body.registration_number),
    worker_profile: emptyToNull(body.worker_profile) || 'operacional',
    employment_type: emptyToNull(body.employment_type) || 'clt',
    position: emptyToNull(body.position),
    role_level: emptyToNull(body.role_level),
    branch_id: emptyToNull(body.branch_id),
    pdv_id: emptyToNull(body.branch_id),
    department_id: emptyToNull(body.department_id),
    cost_center_id: emptyToNull(body.cost_center_id),
    direct_manager_id: emptyToNull(body.direct_manager_id),
    admission_date: emptyToNull(body.admission_date),
    contract_end_date: emptyToNull(body.contract_end_date),
    salary: emptyToNull(body.salary) ?? 0,
    work_schedule: workSchedule,
    bank_name: emptyToNull(body.bank_name),
    bank_agency: emptyToNull(body.bank_agency),
    bank_account: emptyToNull(body.bank_account),
    bank_account_type: emptyToNull(body.bank_account_type),
    pix_key: emptyToNull(body.pix_key),
    pix_key_type: emptyToNull(body.pix_key_type),
    ctps_number: emptyToNull(body.ctps_number),
    ctps_series: emptyToNull(body.ctps_series),
    pis_pasep: emptyToNull(body.pis_pasep),
    voter_id: emptyToNull(body.voter_id),
    voter_zone: emptyToNull(body.voter_zone),
    voter_section: emptyToNull(body.voter_section),
    skin_color: emptyToNull(body.skin_color),
    cnpj: emptyToNull(body.cnpj),
    company_name: emptyToNull(body.company_name),
    status: emptyToNull(body.status) || 'ativo',
    photo_url: emptyToNull(body.photo_url),
    salary_items: Array.isArray(body.salary_items) ? body.salary_items : [],
    benefits: Array.isArray(body.benefits) ? body.benefits : [],
    home_latitude: emptyToNull(body.home_latitude) ? Number(body.home_latitude) : null,
    home_longitude: emptyToNull(body.home_longitude) ? Number(body.home_longitude) : null,
    punch_tolerance_minutes: parseOptionalInteger(body.punch_tolerance_minutes),
    punch_requires_checkin: body.punch_requires_checkin === true ? true : body.punch_requires_checkin === false ? false : null,
    punch_without_active_route: body.punch_without_active_route === true ? true : body.punch_without_active_route === false ? false : null,
  };
}


// Helper: get user org_id
async function getUserOrgId(userId) {
  if (!userId) return null;
  const r = await query(
    `SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return r.rows[0]?.organization_id;
}

// Helper: audit log
async function auditLog(orgId, entityType, entityId, action, changes, userId) {
  for (const ch of changes) {
    await query(
      `INSERT INTO rh_audit_log (organization_id, entity_type, entity_id, action, field_name, old_value, new_value, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orgId, entityType, entityId, action, ch.field, ch.oldVal, ch.newVal, userId]
    );
  }
}

// ===== EMPLOYEES =====

// List employees
router.get('/employees', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);

    const { status, search, department_id, branch_id } = req.query;
    let sql = `SELECT e.*, d.name as department_name, b.name as branch_name,
               CASE WHEN caa.access_status IN ('liberado','aguardando_login','ativo') THEN true ELSE false END as promotor_access,
               COALESCE(caa.access_status, 'sem_acesso') as app_access_status,
               caa.last_login as app_last_login
               FROM employees e
               LEFT JOIN rh_departments d ON d.id = e.department_id
               LEFT JOIN branches b ON b.id = e.branch_id
               LEFT JOIN collaborator_app_access caa ON caa.employee_id = e.id
               WHERE e.organization_id = $1`;
    const params = [orgId];
    let idx = 2;

    if (status) { sql += ` AND e.status = $${idx++}`; params.push(status); }
    if (department_id) { sql += ` AND e.department_id = $${idx++}`; params.push(department_id); }
    if (branch_id) { sql += ` AND e.branch_id = $${idx++}`; params.push(branch_id); }
    if (search) { sql += ` AND (e.full_name ILIKE $${idx} OR e.cpf ILIKE $${idx} OR e.email ILIKE $${idx})`; params.push(`%${search}%`); idx++; }

    sql += ` ORDER BY e.full_name`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logError('rh.employees.list', err);
    res.status(500).json({ error: 'Erro ao listar colaboradores' });
  }
});

// Get single employee
router.get('/employees/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT e.*, d.name as department_name, b.name as branch_name, cc.name as cost_center_name
       FROM employees e
       LEFT JOIN rh_departments d ON d.id = e.department_id
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN cost_centers cc ON cc.id = e.cost_center_id
       WHERE e.id = $1`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.employees.get', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// Create employee
router.post('/employees', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada para o usuário' });

    const d = normalizeEmployeePayload(req.body);
    d.facial_required = req.body.facial_required === undefined ? null : req.body.facial_required;

    if (!d.full_name) return res.status(400).json({ error: 'Nome do colaborador é obrigatório' });

    // Upsert: se CPF existir na mesma org, atualiza em vez de duplicar
    if (d.cpf) {
      const cleanCpf = String(d.cpf).replace(/\D/g, '');
      if (cleanCpf.length >= 11) {
        const existing = await query(
          `SELECT id FROM employees WHERE organization_id = $1 AND REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '') = $2 LIMIT 1`,
          [orgId, cleanCpf]
        );
        if (existing.rows[0]) {
          // Atualiza o existente com os novos dados
          const empId = existing.rows[0].id;
          const updateFields = [];
          const updateValues = [];
          let pi = 1;
          const skipKeys = ['organization_id', 'created_by', 'salary_items', 'benefits'];
          for (const [k, v] of Object.entries(d)) {
            if (skipKeys.includes(k) || !EMPLOYEE_UPDATABLE_COLS.has(k)) continue;
            if (v === null || v === undefined || v === '') continue;
            updateFields.push(`${k} = $${pi++}`);
            updateValues.push(v);
          }
          if (updateFields.length) {
            updateValues.push(empId);
            await query(`UPDATE employees SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = $${pi}`, updateValues);
          }
          const updated = await query(`SELECT * FROM employees WHERE id = $1`, [empId]);
          return res.json(updated.rows[0]);
        }
      }
    }

    // Auto-geocode home address if no coordinates provided
    if (!d.home_latitude && !d.home_longitude && (d.address || d.city)) {
      const geo = await autoGeocodeAddress(d.address, d.city, d.state, d.zip_code, d.neighborhood, d.address_number, d.complement);
      if (geo) { d.home_latitude = geo.lat; d.home_longitude = geo.lng; }
    }

    // INSERT dinâmico: usa somente colunas que realmente existem na tabela employees
    const tableCols = await getEmployeeTableColumns();

    const insertData = {
      organization_id: orgId,
      created_by: req.userId,
      salary_items: JSON.stringify(d.salary_items || []),
      benefits: JSON.stringify(d.benefits || []),
    };

    for (const col of EMPLOYEE_UPDATABLE_COLS) {
      if (d[col] !== undefined) insertData[col] = d[col];
    }
    // pdv_id e branch_id apontam para a mesma unidade
    const unitId = d.pdv_id || d.branch_id || null;
    if (unitId) {
      insertData.pdv_id = unitId;
      insertData.branch_id = unitId;
    }

    const cols = [];
    const placeholders = [];
    const values = [];
    for (const [k, v] of Object.entries(insertData)) {
      if (!tableCols.has(k)) continue;
      cols.push(k);
      values.push(v === undefined ? null : v);
      placeholders.push(`$${values.length}`);
    }

    const result = await query(
      `INSERT INTO employees (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );


    // Auto-sync schedule if a branch/HQ is linked on creation
    if (result.rows[0] && d.branch_id) {
      try {
        const branchRes = await query(`SELECT schedule_id FROM pdvs WHERE id = $1`, [d.branch_id]);
        const branch = branchRes.rows[0];
        if (branch?.schedule_id) {
          await syncEmployeeScheduleWithId(result.rows[0].id, branch.schedule_id);
        }
      } catch (e) {
        logError('rh.employees.create.auto_sync', e);
      }
    }

    await auditLog(orgId, 'employee', result.rows[0].id, 'create', [{ field: 'full_name', oldVal: null, newVal: d.full_name }], req.userId);
    res.json(result.rows[0]);

  } catch (err) {
    logError('rh.employees.create', err, { body: req.body });
    const message = err?.message || 'Erro ao criar colaborador';
    res.status(400).json({
      error: message,
      details: err?.detail || null,
      code: err?.code || null,
      column: err?.column || null,
      constraint: err?.constraint || null,
    });
  }

});

// Update employee
router.put('/employees/:id', async (req, res) => {
  try {
    // Only process fields actually sent in the request body
    const allowedCols = new Set([
      'full_name','social_name','cpf','rg','rg_issuer','birth_date','gender','marital_status',
      'email','phone','phone2','address','address_number','complement','neighborhood','city',
      'state','zip_code','registration_number','worker_profile','employment_type','position',
      'role_level','branch_id','department_id','cost_center_id','direct_manager_id',
      'admission_date','contract_end_date','salary','work_schedule','bank_name','bank_agency',
      'bank_account','bank_account_type','pix_key','pix_key_type','ctps_number','ctps_series','pis_pasep',
      'voter_id','voter_zone','voter_section','skin_color','cnpj',
      'company_name','status','photo_url','salary_items','benefits',
      'home_latitude','home_longitude','facial_required','punch_tolerance_minutes',
      'punch_requires_checkin','punch_without_active_route'
    ]);


    const sentKeys = Object.keys(req.body).filter(k => allowedCols.has(k));
    if (!sentKeys.length) {
      const existing = await query(`SELECT * FROM employees WHERE id = $1`, [req.params.id]);
      return existing.rows[0] ? res.json(existing.rows[0]) : res.status(404).json({ error: 'Não encontrado' });
    }

    // Normalize only sent fields
    const d = {};
    const jsonbFields = ['salary_items', 'benefits'];
    for (const k of sentKeys) {
      if (k === 'work_schedule') {
        d[k] = req.body[k] == null || req.body[k] === ''
          ? null
          : (typeof req.body[k] === 'object' ? JSON.stringify(req.body[k]) : String(req.body[k]));
      } else if (jsonbFields.includes(k)) {
        d[k] = JSON.stringify(Array.isArray(req.body[k]) ? req.body[k] : []);
      } else {
        d[k] = emptyToNull(req.body[k]);
      }
    }

    // Special logic: If a new Branch/HQ (branch_id/pdv_id) is being linked, 
    // check if it's a "Sede" type and update the work journey accordingly.
    if (sentKeys.includes('branch_id') || sentKeys.includes('pdv_id')) {
      const targetPdvId = d.branch_id || d.pdv_id;
      if (targetPdvId) {
        try {
          const pdvRes = await query(`SELECT type, name, schedule_id FROM pdvs WHERE id = $1`, [targetPdvId]);
          const pdv = pdvRes.rows[0];
          // If it's a headquarters (sede), we could auto-apply a default journey if requested,
          // but for now we just ensure the link is consistent.
          d.pdv_id = targetPdvId;
          d.branch_id = targetPdvId;

          // Auto-sync schedule if the branch/HQ has one linked
          if (pdv?.schedule_id) {
            await syncEmployeeScheduleWithId(req.params.id, pdv.schedule_id);
          }
        } catch (e) {
          logError('rh.employees.update.pdv_sync', e);
        }
      }
    }


    // Auto-geocode home address if address changed and no coords sent
    const addressChanged = ['address', 'city', 'state', 'zip_code'].some(k => sentKeys.includes(k));
    if (addressChanged && !d.home_latitude && !d.home_longitude) {
      const addrVal = d.address || req.body.address;
      const addressNumberVal = d.address_number || req.body.address_number;
      const complementVal = d.complement || req.body.complement;
      const cityVal = d.city || req.body.city;
      const stateVal = d.state || req.body.state;
      const zipVal = d.zip_code || req.body.zip_code;
      const neighborhoodVal = d.neighborhood || req.body.neighborhood;
      if (addrVal || cityVal) {
        try {
          const geo = await autoGeocodeAddress(addrVal, cityVal, stateVal, zipVal, neighborhoodVal, addressNumberVal, complementVal);
          if (geo) { d.home_latitude = geo.lat; d.home_longitude = geo.lng; }
        } catch (geoErr) {
          logError('rh.employees.update.geocode', geoErr);
        }
      }
    }

    const old = await query(`SELECT * FROM employees WHERE id = $1`, [req.params.id]);
    if (!old.rows[0]) return res.status(404).json({ error: 'Não encontrado' });

    const fields = Object.keys(d);
    const sets = fields.map((f, i) => `${f} = $${i + 2}`);
    sets.push(`updated_at = NOW()`);
    const vals = fields.map(f => d[f]);

    const result = await query(
      `UPDATE employees SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [req.params.id, ...vals]
    );

    const changes = fields
      .filter(f => String(old.rows[0][f]) !== String(d[f]))
      .map(f => ({ field: f, oldVal: String(old.rows[0][f] ?? ''), newVal: String(d[f] ?? '') }));
    if (changes.length) {
      await auditLog(old.rows[0].organization_id, 'employee', req.params.id, 'update', changes, req.userId);
    }

    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.employees.update', err, { body: req.body, employee_id: req.params.id });
    const message = err?.detail || err?.message || 'Erro ao atualizar colaborador';
    
    // Log detailed context to help debug 400 errors
    console.error('[RH_UPDATE_ERROR]', {
      id: req.params.id,
      error: err,
      detail: err?.detail,
      constraint: err?.constraint,
      bodyKeys: Object.keys(req.body)
    });

    res.status(400).json({ 
      error: message, 
      details: err?.detail || err?.hint || '',
      code: err?.code,
      constraint: err?.constraint
});
  }
});

// Helper: Internal function to sync employee work journey with a specific scale ID
async function syncEmployeeScheduleWithId(employeeId, scheduleId, userId = null) {
  const schedRes = await query(`SELECT * FROM work_schedules WHERE id = $1`, [scheduleId]);
  const sched = schedRes.rows[0];
  if (!sched) return null;

  // Map schedule_type to work_schedule days
  const days = { seg: false, ter: false, qua: false, qui: false, sex: false, sab: false, dom: false };
  const type = String(sched.schedule_type || '').toLowerCase();

  if (type.includes('5x2')) {
    days.seg = days.ter = days.qua = days.qui = days.sex = true;
  } else if (type.includes('6x1')) {
    days.seg = days.ter = days.qua = days.qui = days.sex = days.sab = true;
  } else {
    // Default to 5x2 if unknown
    days.seg = days.ter = days.qua = days.qui = days.sex = true;
  }

  const workSchedule = {
    days,
    entry: (sched.entry_time || '08:00').slice(0, 5),
    exit: (sched.exit_time || '17:00').slice(0, 5),
    lunch_start: (sched.break_start || '12:00').slice(0, 5),
    lunch_end: (sched.break_end || '13:00').slice(0, 5),
  };

  const result = await query(
    `UPDATE employees SET work_schedule = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [JSON.stringify(workSchedule), employeeId]
  );

  if (result.rows[0] && userId) {
    await auditLog(result.rows[0].organization_id, 'employee', employeeId, 'update', 
      [{ field: 'work_schedule', oldVal: 'auto_sync', newVal: JSON.stringify(workSchedule) }], 
      userId
    );
  }
  return result.rows[0];
}

// Sync employee work journey with a specific scale
router.post('/employees/:id/sync-schedule', async (req, res) => {
  try {
    const { schedule_id } = req.body;
    if (!schedule_id) return res.status(400).json({ error: 'ID da escala é obrigatório' });

    const updated = await syncEmployeeScheduleWithId(req.params.id, schedule_id, req.userId);
    if (!updated) return res.status(404).json({ error: 'Escala não encontrada' });

    res.json(updated);
  } catch (err) {
    logError('rh.employees.sync-schedule', err);
    res.status(500).json({ error: 'Erro ao sincronizar jornada' });
  }
});

// Delete employee (soft by default, hard delete with ?hard=true)
router.delete('/employees/:id', async (req, res) => {
  try {
    const hard = req.query.hard === 'true' || req.query.hard === '1';
    if (hard) {
      // Hard delete: remove dependents first, then employee
      await query(`DELETE FROM employee_dependents WHERE employee_id = $1`, [req.params.id]).catch(() => {});
      await query(`DELETE FROM employee_documents WHERE employee_id = $1`, [req.params.id]).catch(() => {});
      await query(`DELETE FROM time_records WHERE employee_id = $1`, [req.params.id]).catch(() => {});
      await query(`DELETE FROM hour_bank WHERE employee_id = $1`, [req.params.id]).catch(() => {});
      await query(`DELETE FROM employee_absences WHERE employee_id = $1`, [req.params.id]).catch(() => {});
      await query(`DELETE FROM payslips WHERE employee_id = $1`, [req.params.id]).catch(() => {});
      await query(`DELETE FROM employees WHERE id = $1`, [req.params.id]);
    } else {
      await query(`UPDATE employees SET status = 'desligado', termination_date = NOW(), updated_at = NOW() WHERE id = $1`, [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    logError('rh.employees.delete', err);
    res.status(500).json({ error: 'Erro ao apagar colaborador' });
  }
});

// ===== TIME RECORDS (PONTO) =====

// App punches (time_punches from promotor app)
router.get('/app-punches', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { employee_id, start_date, end_date } = req.query;
    let sql = `SELECT tp.*, e.full_name as employee_name, p.name as pdv_name
               FROM time_punches tp
               JOIN employees e ON e.id = tp.employee_id
               LEFT JOIN pdvs p ON p.id = tp.pdv_id
               WHERE tp.organization_id = $1`;
    const params = [orgId];
    let idx = 2;
    if (employee_id) { sql += ` AND tp.employee_id = $${idx++}`; params.push(employee_id); }
    // Ensure comparison uses Brazil timezone date for filtered results
    if (start_date) { sql += ` AND (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date >= $${idx++}`; params.push(start_date); }
    if (end_date) { sql += ` AND (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date <= $${idx++}`; params.push(end_date); }
    sql += ` ORDER BY tp.punched_at DESC LIMIT 500`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logError('rh.app_punches.list', err);
    res.status(500).json({ error: 'Erro ao listar registros do app' });
  }
});

// ===== MANUAL PUNCH ADJUSTMENTS =====
let _punchExtraColsReady = false;
async function ensurePunchAdjustmentCols() {
  if (_punchExtraColsReady) return;
  try {
    await query(`
      ALTER TABLE time_punches
        ADD COLUMN IF NOT EXISTS manual_adjustment BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS adjustment_reason TEXT,
        ADD COLUMN IF NOT EXISTS adjusted_by UUID,
        ADD COLUMN IF NOT EXISTS adjusted_at TIMESTAMPTZ
    `);
    _punchExtraColsReady = true;
  } catch (err) { logError('rh.ensure_punch_extra_cols', err); }
}

// Create manual punch
router.post('/app-punches', async (req, res) => {
  try {
    await ensurePunchAdjustmentCols();
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não identificada' });
    const { employee_id, punch_type, punched_at, pdv_id, justification, adjustment_reason } = req.body || {};
    if (!employee_id || !punch_type || !punched_at) return res.status(400).json({ error: 'employee_id, punch_type e punched_at são obrigatórios' });
    const reason = adjustment_reason || justification || 'Ajuste manual pelo RH';
    // We treat punched_at from the frontend as already in the correct local time string
    const r = await query(
      `INSERT INTO time_punches
        (organization_id, employee_id, punch_type, punched_at, pdv_id, geo_status, is_offline, sync_status,
         justification, manual_adjustment, adjustment_reason, adjusted_by, adjusted_at)
       VALUES ($1,$2,$3,$4,$5,'manual',false,'synced',$6,true,$6,$7,NOW())
       RETURNING *`,
      [orgId, employee_id, punch_type, punched_at, pdv_id || null, reason, req.userId]
    );
    res.json(r.rows[0]);
  } catch (err) {
    logError('rh.app_punches.create', err);
    res.status(500).json({ error: err.message });
  }
});

// Edit punch (manual adjustment)
router.patch('/app-punches/:id', async (req, res) => {
  try {
    await ensurePunchAdjustmentCols();
    const orgId = await getUserOrgId(req.userId);
    const { punched_at, punch_type, pdv_id, adjustment_reason } = req.body || {};
    if (!adjustment_reason) return res.status(400).json({ error: 'Informe o motivo do ajuste' });
    
    // We treat punched_at from the frontend as already in the correct local time string
    const r = await query(
      `UPDATE time_punches SET
         punched_at = COALESCE($1, punched_at),
         punch_type = COALESCE($2, punch_type),
         pdv_id = COALESCE($3, pdv_id),
         manual_adjustment = true,
         adjustment_reason = $4,
         adjusted_by = $5,
         adjusted_at = NOW()
       WHERE id = $6 AND organization_id = $7
       RETURNING *`,
      [punched_at || null, punch_type || null, pdv_id || null, adjustment_reason, req.userId, req.params.id, orgId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Registro não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    logError('rh.app_punches.update', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete punch (with audit reason)
router.delete('/app-punches/:id', async (req, res) => {
  try {
    await ensurePunchAdjustmentCols();
    const orgId = await getUserOrgId(req.userId);
    const reason = req.query.reason || req.body?.reason || 'Removido pelo RH';
    // Log before delete
    try {
      await query(
        `INSERT INTO rh_audit_log (organization_id, entity_type, entity_id, action, field_name, old_value, new_value, changed_by)
         VALUES ($1,'time_punch',$2,'delete','punch',$3,NULL,$4)`,
        [orgId, req.params.id, reason, req.userId]
      );
    } catch {}
    const r = await query(`DELETE FROM time_punches WHERE id=$1 AND organization_id=$2 RETURNING id`, [req.params.id, orgId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Registro não encontrado' });
    res.json({ success: true });
  } catch (err) {
    logError('rh.app_punches.delete', err);
    res.status(500).json({ error: err.message });
  }
});

// Sync diagnostics
router.get('/sync-diagnostics', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json({ total: 0, synced: 0, pending: 0, employees: [] });

    const [stats, byEmployee, recent] = await Promise.all([
      query(`SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE sync_status = 'synced') as synced,
        COUNT(*) FILTER (WHERE sync_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE is_offline = true) as offline_originated,
        MAX(punched_at) as last_punch_at
       FROM time_punches WHERE organization_id = $1`, [orgId]),
      query(`SELECT e.id, e.full_name, e.photo_url,
        COUNT(tp.id) as total_punches,
        COUNT(tp.id) FILTER (WHERE tp.sync_status = 'synced') as synced,
        COUNT(tp.id) FILTER (WHERE tp.sync_status = 'pending') as pending,
        COUNT(tp.id) FILTER (WHERE tp.is_offline = true) as offline,
        MAX(tp.punched_at) as last_punch,
        MAX(CASE WHEN tp.sync_status = 'synced' THEN tp.punched_at END) as last_synced_at
       FROM employees e
       LEFT JOIN time_punches tp ON tp.employee_id = e.id
       WHERE e.organization_id = $1 AND e.status = 'ativo'
       GROUP BY e.id, e.full_name, e.photo_url
       HAVING COUNT(tp.id) > 0
       ORDER BY MAX(tp.punched_at) DESC NULLS LAST`, [orgId]),
      query(`SELECT tp.id, tp.employee_id, e.full_name, tp.punch_type, tp.punched_at, tp.sync_status, tp.is_offline, tp.geo_status, p.name as pdv_name
       FROM time_punches tp JOIN employees e ON e.id = tp.employee_id LEFT JOIN pdvs p ON p.id = tp.pdv_id
       WHERE tp.organization_id = $1 ORDER BY tp.punched_at DESC LIMIT 20`, [orgId]),
    ]);

    res.json({
      ...stats.rows[0],
      employees: byEmployee.rows,
      recent_punches: recent.rows,
    });
  } catch (err) {
    logError('rh.sync_diagnostics', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.get('/time-records', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { employee_id, start_date, end_date } = req.query;
    let sql = `SELECT tr.*, e.full_name as employee_name
               FROM time_records tr
               JOIN employees e ON e.id = tr.employee_id
               WHERE tr.organization_id = $1`;
    const params = [orgId];
    let idx = 2;
    if (employee_id) { sql += ` AND tr.employee_id = $${idx++}`; params.push(employee_id); }
    if (start_date) { sql += ` AND tr.record_date >= $${idx++}`; params.push(start_date); }
    if (end_date) { sql += ` AND tr.record_date <= $${idx++}`; params.push(end_date); }
    sql += ` ORDER BY tr.record_date DESC, e.full_name`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logError('rh.time_records.list', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.post('/time-records', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    const d = req.body;
    const result = await query(
      `INSERT INTO time_records (organization_id, employee_id, record_date, entry1, exit1, entry2, exit2, entry3, exit3, total_hours, overtime_hours, status, justification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (employee_id, record_date) DO UPDATE SET
         entry1=EXCLUDED.entry1, exit1=EXCLUDED.exit1, entry2=EXCLUDED.entry2, exit2=EXCLUDED.exit2,
         entry3=EXCLUDED.entry3, exit3=EXCLUDED.exit3, total_hours=EXCLUDED.total_hours,
         overtime_hours=EXCLUDED.overtime_hours, status=EXCLUDED.status, justification=EXCLUDED.justification, updated_at=NOW()
       RETURNING *`,
      [orgId, d.employee_id, d.record_date,
        d.entry1 || null, d.exit1 || null, d.entry2 || null, d.exit2 || null,
        d.entry3 || null, d.exit3 || null, d.total_hours || 0, d.overtime_hours || 0,
        d.status || 'normal', d.justification]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.time_records.create', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// work_schedules is created with CREATE TABLE IF NOT EXISTS, which never adds
// a column to a table that already exists. An environment provisioned before
// entry_time/exit_time/workdays existed therefore lacks them, and selecting
// them takes the whole query down. Probing once lets the SELECT fall back to
// the columns that are actually there.
let scheduleColumnCache = null;
async function getScheduleColumns() {
  if (scheduleColumnCache) return scheduleColumnCache;
  try {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'work_schedules'
          AND column_name = ANY($1::text[])`,
      [['entry_time', 'exit_time', 'workdays', 'daily_hours', 'break_minutes']]
    );
    const present = new Set(r.rows.map((x) => x.column_name));
    scheduleColumnCache = {
      entry_time: present.has('entry_time'),
      exit_time: present.has('exit_time'),
      workdays: present.has('workdays'),
      daily_hours: present.has('daily_hours'),
      break_minutes: present.has('break_minutes'),
    };
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
    scheduleColumnCache = {
      entry_time: false, exit_time: false, workdays: false,
      daily_hours: false, break_minutes: false,
    };
  }
  return scheduleColumnCache;
}

// Consolidated timesheet (app punches grouped by employee+date)
router.get('/consolidated-timesheet', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { employee_id, start_date, end_date } = req.query;

    const cols = await getScheduleColumns();
    const col = (name) => (cols[name] ? `ws.${name}` : 'NULL');

    let sql = `
      SELECT
        tp.employee_id,
        e.full_name as employee_name,
        e.cpf,
        e.position,
        e.work_schedule,
        schedule.daily_hours,
        schedule.schedule_name,
        schedule.entry_time,
        schedule.exit_time,
        schedule.workdays,
        schedule.break_minutes,
        (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date as record_date,
        json_agg(json_build_object(
          'id', tp.id, 'punch_type', tp.punch_type, 'punched_at', tp.punched_at,
          'geo_status', tp.geo_status, 'is_offline', tp.is_offline, 'pdv_name', p.name,
          'sync_status', tp.sync_status,
          'manual_adjustment', tp.manual_adjustment, 'adjustment_reason', tp.adjustment_reason
        ) ORDER BY tp.punched_at) as punches,
        COUNT(*) as punch_count
      FROM time_punches tp
      JOIN employees e ON e.id = tp.employee_id
      LEFT JOIN pdvs p ON p.id = tp.pdv_id
      LEFT JOIN LATERAL (
        SELECT ${col('daily_hours')}, ws.name AS schedule_name, ${col('workdays')},
               ${col('entry_time')}, ${col('exit_time')}, ${col('break_minutes')}
        FROM employee_schedules es
        JOIN work_schedules ws ON ws.id = es.schedule_id
        WHERE es.employee_id = tp.employee_id
          AND es.organization_id = tp.organization_id
          AND es.active = true
          AND es.start_date <= (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date
          AND (es.end_date IS NULL OR es.end_date >= (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date)
        ORDER BY es.start_date DESC
        LIMIT 1
      ) schedule ON true
      WHERE tp.organization_id = $1`;
    const params = [orgId];
    let idx = 2;
    if (employee_id) { sql += ` AND tp.employee_id = $${idx++}`; params.push(employee_id); }
    
    // Default to today if no dates provided to ensure something appears
    const saoPauloToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const sd = start_date || saoPauloToday();
    const ed = end_date || saoPauloToday();
    
    sql += ` AND (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date >= $${idx++}`; params.push(sd);
    sql += ` AND (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date <= $${idx++}`; params.push(ed);
    
    // Every non-aggregated column must appear in GROUP BY. entry_time,
    // exit_time and workdays were added to the SELECT after the original
    // list was written, and a missing one takes the whole query down.
    sql += ` GROUP BY tp.employee_id, e.full_name, e.cpf, e.position, e.work_schedule,
                    (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date,
                    schedule.daily_hours, schedule.schedule_name,
                    schedule.entry_time, schedule.exit_time, schedule.workdays,
                    schedule.break_minutes
             ORDER BY (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date DESC, e.full_name`;
    const result = await query(sql, params);
    
    // Server-side calculation logic for hours.
    // Uses the same shared module as the Cartão de Ponto (lib/time-calc.js), so
    // the two screens can never disagree about a day's total.
    const rows = result.rows.map(row => {
      const punches = Array.isArray(row.punches) ? row.punches : [];

      const entryMinutes = timeColumnToMinutes(row.entry_time);
      const exitMinutes = timeColumnToMinutes(row.exit_time);
      const schedule = {
        entryMinutes: entryMinutes ?? parseHHMMToMinutes(DEFAULT_ENTRY),
        exitMinutes: exitMinutes ?? parseHHMMToMinutes(DEFAULT_EXIT),
        expectedMinutes: row.daily_hours != null ? Math.round(Number(row.daily_hours) * 60) : undefined,
        breakMinutes: row.break_minutes != null ? Number(row.break_minutes) : null,
      };

      // A day is a workday when the employee is scheduled on it. With no scale
      // on file we fall back to Mon-Fri, the assumption the rest of RH makes.
      const workdays = Array.isArray(row.workdays) && row.workdays.length
        ? row.workdays.map(Number)
        : [1, 2, 3, 4, 5];
      // record_date is a DATE column: it arrives as a JS Date at UTC midnight,
      // so getUTCDay() is the civil weekday with no timezone shift involved.
      const civil = row.record_date instanceof Date
        ? row.record_date.toISOString().slice(0, 10)
        : String(row.record_date).slice(0, 10);
      const isoDow = new Date(`${civil}T12:00:00Z`).getUTCDay() || 7;
      const dayType = classifyDay({ date: civil, isHoliday: false, isWorkday: workdays.includes(isoDow) });

      const { workedMinutes: total_minutes } = dayBalance({ punches, schedule, dayType });

      return {
        ...row,
        total_minutes: total_minutes,
        formatted_hours: formatHHMM(total_minutes),
        first_punch: punches[0]?.punched_at,
        last_punch: punches[punches.length - 1]?.punched_at
      };
    });

    res.json(rows);
  } catch (err) {
    logError('rh.consolidated_timesheet', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== CARTAO DE PONTO =====
// Ficha individual dia a dia de UM colaborador: batidas, totais calculados pelo
// modulo compartilhado (lib/time-calc.js) e correcao com trilha de auditoria.
//
// Fonte canonica: time_punches. O 'time_records' existe por causa do dialogo
// manual legado e nao e migrado aqui.

const CARTAO_MAX_PUNCHES = 8;
const CARTAO_TIME_RE = /^\d{1,2}:\d{2}$/;

function saoPauloTodayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function isValidCivilDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, day] = String(value).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  if (Number.isNaN(d.getTime())) return false;
  // Rejects 2026-02-30 and friends, which Date would otherwise roll over.
  return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m && d.getUTCDate() === day;
}

// Every civil date that leaves this module is a text 'YYYY-MM-DD', never a Date.
// A DATE column serialised to JSON becomes midnight UTC, which the browser
// reads as the previous day in São Paulo.
// A scale's entry-to-exit span is wall-clock time and contains the break; the
// daily figure is net. Mirrors applyBreak() in lib/time-calc.js so the card and
// the module agree on what one hour of lunch is worth.
function subtractBreak(span, breakMinutes) {
  const b = Number(breakMinutes);
  if (!Number.isFinite(b) || b <= 0) return span;
  return Math.max(0, span - Math.min(b, span));
}

function toCharLocal(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
}

function isoDowOf(value) {
  const str = toCharLocal(value);
  if (!str) return null;
  const d = new Date(`${str}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay() === 0 ? 7 : d.getUTCDay();
}

function monthsBetween(start, end) {
  const out = [];
  let y = Number(String(start).slice(0, 4));
  let m = Number(String(start).slice(5, 7));
  const endY = Number(String(end).slice(0, 4));
  const endM = Number(String(end).slice(5, 7));
  for (let guard = 0; guard < 240; guard += 1) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (y === endY && m === endM) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function isMissingRelation(err) {
  const code = err?.code || '';
  const msg = String(err?.message || '');
  return code === '42P01' || code === '42703' || /does not exist/i.test(msg);
}

function formatSignedHHMM(minutes) {
  const m = Math.round(minutes || 0);
  const sign = m < 0 ? '-' : '';
  return `${sign}${formatHHMM(Math.abs(m))}`;
}

// 'YYYY-MM-DD' -> 'YYYY-MM', no local timezone games.
function referenceMonthOf(date) {
  return String(date).slice(0, 7);
}

// The last-index rule wins over parity: on a 4-punch day index 3 is both the
// last element and an odd index, and we want it typed 'saida', not
// 'saida_intervalo'.
function punchTypeForIndex(index, total) {
  if (index === 0) return 'entrada';
  if (index === total - 1) return 'saida';
  if (index % 2 === 1) return 'saida_intervalo';
  return 'retorno_intervalo';
}

async function isPeriodClosed(orgId, employeeId, date) {
  const r = await query(
    `SELECT closed FROM rh_period_closures WHERE organization_id = $1 AND employee_id = $2 AND reference_month = $3`,
    [orgId, employeeId, referenceMonthOf(date)]
  );
  return r.rows[0]?.closed === true;
}

// Turns one row of the generate_series query into a day of the card. The
// punches arrive already grouped by the same civil date, so the grouping never
// depends on JavaScript date arithmetic.
function buildCartaoDay(row, { employee, tolerance, closure }) {
  const date = toCharLocal(row.date) || String(row.date || '').slice(0, 10);
  const punches = Array.isArray(row.punches) ? row.punches : [];
  const isoDow = row.iso_dow || isoDowOf(row.date);

  // Schedule: the day-specific assignment wins, then the employee's
  // work_schedule for that weekday, then the built-in default. The weekday
  // matters: a promoter on Seg-Sex 07:00-16:00 with Sab 07:00-11:00 would read
  // 07:00-17:00 on every row if we only looked at the general entry/exit.
  const fromScheduleRow = timeColumnToMinutes(row.entry_time) ?? null;
  const fromScheduleRowExit = timeColumnToMinutes(row.exit_time) ?? null;
  let entry = fromScheduleRow;
  let exit = fromScheduleRowExit;
  let scheduleBreak = null;
  let isWorkday = isoDow == null || (isoDow >= 1 && isoDow <= 5);
  if (entry == null || exit == null) {
    const parsed = parseWorkScheduleString(employee?.work_schedule, isoDow);
    entry = entry ?? parsed.entry;
    exit = exit ?? parsed.exit;
    scheduleBreak = parsed.breakMinutes;
    if (parsed.isWorkday != null) isWorkday = parsed.isWorkday;
  }
  if (entry == null) entry = parseHHMMToMinutes(DEFAULT_ENTRY);
  if (exit == null) exit = parseHHMMToMinutes(DEFAULT_EXIT);
  const dayType = classifyDay({
    isHoliday: Boolean(row.holiday_name),
    isWorkday,
  });
  if (row.absence_type) {
    // An approved absence overrides the type but keeps the punches visible, so
    // the manager can see the day was worked on paper but marked as leave.
    if (!punches.length) {
      return {
        date,
        isoDow,
        dayType: 'ausencia',
        absenceType: row.absence_type,
        punches: [],
        workedMinutes: 0,
        creditMinutes: 0,
        debitMinutes: 0,
        worked: '--',
        credit: '--',
        debit: '--',
        // An approved leave is not a shortfall: the day keeps its type as
        // 'ausencia', so accumulate() never counts it as expected time. The
        // manager sees the hours the day would have been, and the month is
        // measured against the days actually expected.
        expected: formatHHMM(subtractBreak(exit > entry ? exit - entry : 0, row.break_minutes != null ? Number(row.break_minutes) : scheduleBreak)),
        expectedMinutes: 0,
        schedule: { entry: formatHHMM(entry), exit: formatHHMM(exit), name: row.schedule_name || null },
        closed: Boolean(closure?.closed),
      };
    }
  }

  // The scale row's declared break wins; otherwise the lunch the RH screen
  // saved per weekday. Without this a 07:00-16:00 day with a 12:00-13:00 lunch
  // reads as nine hours of expected journey.
  const breakMinutes = row.break_minutes != null
    ? Number(row.break_minutes)
    : scheduleBreak;
  const expectedMinutes = exit > entry ? subtractBreak(exit - entry, breakMinutes) : 0;
  const balance = dayBalance({
    punches,
    schedule: { entryMinutes: entry, exitMinutes: exit, expectedMinutes, breakMinutes },
    dayType,
    tolerance,
  });

  return {
    date,
    isoDow,
    dayType,
    holidayName: row.holiday_name || null,
    absenceType: row.absence_type || null,
    schedule: { entry: formatHHMM(entry), exit: formatHHMM(exit), name: row.schedule_name || null },
    expected: expectedMinutes ? formatHHMM(expectedMinutes) : '--',
    expectedMinutes,
    punches: punches.map((p) => ({
      id: p.id,
      punch_type: p.punch_type,
      punched_at: p.punched_at,
      time: instantToSaoPauloClock(p.punched_at),
      source: p.source || 'app',
      adjustment_reason: p.adjustment_reason || null,
    })),
    workedMinutes: balance.workedMinutes,
    creditMinutes: balance.creditMinutes,
    debitMinutes: balance.debitMinutes,
    worked: punches.length ? formatHHMM(balance.workedMinutes) : '--',
    credit: balance.creditMinutes ? formatHHMM(balance.creditMinutes) : '--',
    debit: balance.debitMinutes ? formatHHMM(balance.debitMinutes) : '--',
    closed: Boolean(closure?.closed),
  };
}

// Banco de horas month by month. The 220h figure is a legal convention, not a
// fact about the calendar: a month rarely has 22 workdays, and the one that
// does still loses days to holidays and to the employee's own schedule. So the
// expectation is derived from the days the month actually has, never assumed.
function buildMonthBank(days) {
  const byMonth = new Map();
  for (const day of days || []) {
    const month = String(day.date || '').slice(0, 7);
    if (!month) continue;
    if (!byMonth.has(month)) {
      byMonth.set(month, { reference_month: month, days: [], workedMinutes: 0, expectedMinutes: 0 });
    }
    const bucket = byMonth.get(month);
    bucket.days.push(day);
    bucket.workedMinutes += day.workedMinutes || 0;
    if (day.dayType === 'util') bucket.expectedMinutes += day.expectedMinutes || 0;
  }

  return [...byMonth.values()]
    .sort((a, b) => a.reference_month.localeCompare(b.reference_month))
    .map((bucket) => {
      const totals = accumulate(bucket.days);
      const saldo = totals.saldoMinutes;
      return {
        reference_month: bucket.reference_month,
        workedMinutes: totals.workedMinutes,
        expectedMinutes: totals.expectedMinutes,
        worked: totals.worked,
        expected: totals.expected,
        creditMinutes: totals.creditMinutes,
        debitMinutes: totals.debitMinutes,
        daysWorked: totals.daysWorked,
        daysAbsent: totals.daysAbsent,
        saldoMinutes: saldo,
        saldo: formatSignedHHMM(saldo),
        // Three states, decided by the schedule rather than by the tolerance:
        // positive means banco de horas, negative means deficit.
        status: saldo > 0 ? 'banco' : saldo < 0 ? 'deficit' : 'nivel',
      };
    });
}

// ISO weekday keys used by the schedule editor in RHColaboradores.
const DOW_KEYS = { 1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab', 7: 'dom' };

/**
 * Reads employees.work_schedule, which the RH screen stores as JSON:
 *   { useIndividualDays, dayConfig: { seg: { entry, exit, lunch_start,
 *     lunch_end }, ... }, entry, exit, lunch_start, lunch_end }
 * A legacy plain-text "08:00-17:00" is still accepted.
 *
 * isoDow selects the weekday from dayConfig, which is what makes a Mon-Fri
 * 07:00-16:00 with a Saturday 07:00-11:00 read correctly on every row. Passing
 * no isoDow returns the general entry/exit.
 */
function parseWorkScheduleString(value, isoDow = null) {
  const out = { entry: null, exit: null, breakMinutes: null, isWorkday: null };
  if (!value) return out;
  const str = String(value).trim();

  // "08:00-17:00", "08:00 até 17:00" -- the legacy flat format.
  const range = str.match(/(\d{1,2}:\d{2})\s*(?:-|até|ate|ao)\s*(\d{1,2}:\d{2})/i);
  if (range) {
    out.entry = parseHHMMToMinutes(range[1]);
    out.exit = parseHHMMToMinutes(range[2]);
    return out;
  }

  if (!str.startsWith('{')) return out;
  let parsed;
  try {
    parsed = typeof value === 'object' ? value : JSON.parse(str);
  } catch {
    return out;
  }

  const key = isoDow ? DOW_KEYS[isoDow] : null;
  const days = parsed.days || {};
  if (key) {
    // A day switched off in the editor is a rest day even if it is a weekday.
    if (days[key] === false) out.isWorkday = false;
    if (parsed.useIndividualDays && parsed.dayConfig && parsed.dayConfig[key]) {
      const cfg = parsed.dayConfig[key];
      out.entry = parseHHMMToMinutes(cfg.entry);
      out.exit = parseHHMMToMinutes(cfg.exit);
      const lunch = lunchMinutesOf(cfg);
      if (lunch > 0) out.breakMinutes = lunch;
      if (days[key] === true) out.isWorkday = true;
      return out;
    }
  }

  out.entry = parseHHMMToMinutes(parsed.entry || parsed.start);
  out.exit = parseHHMMToMinutes(parsed.exit || parsed.end);
  const topLunch = lunchMinutesOf(parsed);
  if (topLunch > 0) out.breakMinutes = topLunch;
  return out;
}

// lunch_start/lunch_end as a duration. Absent or degenerate values mean no
// declared break, never zero-length.
function lunchMinutesOf(cfg) {
  const s = parseHHMMToMinutes(cfg && (cfg.lunch_start ?? cfg.break_start));
  const e = parseHHMMToMinutes(cfg && (cfg.lunch_end ?? cfg.break_end));
  if (s == null || e == null) return 0;
  return e > s ? e - s : 0;
}

// The wall-clock time in São Paulo, as 'HH:MM', for a timestamptz.
function instantToSaoPauloClock(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

// Tolerances come from time_rules when the org configured them: the employee
// rule wins over the org-wide one, and an absent row falls back to the module
// default rather than zero.
async function getCartaoTolerance(orgId, employeeId) {
  try {
    const r = await query(
      `SELECT late_tolerance_minutes, early_leave_tolerance
         FROM time_rules
        WHERE organization_id = $1 AND (employee_id = $2 OR employee_id IS NULL)
        ORDER BY employee_id NULLS LAST
        LIMIT 1`,
      [orgId, employeeId]
    );
    const row = r.rows[0];
    if (!row) return {};
    return {
      late: row.late_tolerance_minutes ?? undefined,
      early: row.early_leave_tolerance ?? undefined,
    };
  } catch (err) {
    if (isMissingRelation(err)) return {};
    throw err;
  }
}

// work_schedules/employee_schedules are created at runtime by the schedule
// router and holidays by the holiday bootstrap, so neither is guaranteed to
// exist on a fresh database. Probing once lets the day grid degrade to
// employee.work_schedule instead of failing the whole request.
let cartaoTableCaps = null;
async function getCartaoTableCapabilities() {
  if (cartaoTableCaps) return cartaoTableCaps;
  const missing = [];
  const has = async (table) => {
    try {
      await query(`SELECT 1 FROM ${table} LIMIT 1`);
      return true;
    } catch (err) {
      if (isMissingRelation(err)) return false;
      throw err;
    }
  };
  if (!(await has('work_schedules'))) missing.push('escalas');
  if (!(await has('employee_schedules'))) missing.push('escalas');
  if (!(await has('holidays'))) missing.push('feriados');
  if (!(await has('employee_absences'))) missing.push('afastamentos');
  cartaoTableCaps = {
    schedules: !missing.includes('escalas'),
    holidays: !missing.includes('feriados'),
    absences: !missing.includes('afastamentos'),
    missing,
  };
  return cartaoTableCaps;
}

// The Cartao de Ponto reads time_punches.source and rh_period_closures, but
// neither exists in schema-promotor-app.sql -- the columns and the table are
// only added by init-db.js. On a database provisioned from that schema the
// grid query would 500 on an unqualified column name. Every statement is
// idempotent and the whole thing is best-effort: if it cannot run we still
// try the request and let the real error surface.
let cartaoSchemaPromise = null;
async function ensureCartaoSchema() {
  if (!cartaoSchemaPromise) {
    cartaoSchemaPromise = (async () => {
      await query(`ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'app'`);
      await query(`ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS punched_by UUID REFERENCES users(id) ON DELETE SET NULL`);
      await query(`
        CREATE TABLE IF NOT EXISTS rh_period_closures (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          reference_month VARCHAR(7) NOT NULL,
          closed BOOLEAN DEFAULT true,
          closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
          closed_at TIMESTAMPTZ DEFAULT NOW(),
          reopened_by UUID REFERENCES users(id) ON DELETE SET NULL,
          reopened_at TIMESTAMPTZ,
          UNIQUE (employee_id, reference_month)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_rh_period_closures ON rh_period_closures(employee_id, reference_month)`);
    })().catch((error) => {
      logError('rh.ponto.cartao.schema', error);
      cartaoSchemaPromise = null;
    });
  }
  return cartaoSchemaPromise;
}

// One query builds the full day grid for a period. The LATERAL subqueries are
// conditional on the probed capabilities so a missing table cannot take the
// whole statement down with it.
async function queryCartaoDays({ employeeId, orgId, start, end, capabilities }) {
  // Same column caveat as the consolidated view: work_schedules may predate
  // entry_time/exit_time. Selecting a missing column kills the whole grid.
  const schedCols = await getScheduleColumns();
  const sc = (name) => (schedCols[name] ? `ws.${name}` : 'NULL');

  const schedSql = capabilities.schedules ? `
       LEFT JOIN LATERAL (
         SELECT ${sc('entry_time')}, ${sc('exit_time')}, ${sc('break_minutes')}, ws.name AS schedule_name
           FROM employee_schedules es
           JOIN work_schedules ws ON ws.id = es.schedule_id
          WHERE es.employee_id = $1
            AND es.organization_id = $2
            AND COALESCE(es.active, true) = true
            AND es.start_date <= d.dt::date
            AND (es.end_date IS NULL OR es.end_date >= d.dt::date)
          ORDER BY es.start_date DESC
          LIMIT 1
       ) sched ON true` : '';

  const holidaySql = capabilities.holidays ? `
       LEFT JOIN LATERAL (
         SELECT hd.name
           FROM holidays hd
          WHERE hd.organization_id = $2
            AND hd.holiday_date = d.dt::date
            AND COALESCE(hd.active, true) = true
          ORDER BY hd.name
          LIMIT 1
       ) h ON true` : '';

  const absenceSql = capabilities.absences ? `
       LEFT JOIN LATERAL (
         SELECT ab.absence_type
           FROM employee_absences ab
          WHERE ab.employee_id = $1
            AND d.dt::date BETWEEN ab.start_date AND ab.end_date
            AND COALESCE(ab.approved, false) = true
          ORDER BY ab.start_date DESC
          LIMIT 1
       ) a ON true` : '';

  const r = await query(
    `SELECT
       to_char(d.dt, 'YYYY-MM-DD') AS date,
       EXTRACT(ISODOW FROM d.dt)::int AS iso_dow,
       sched.entry_time,
       sched.exit_time,
       sched.break_minutes,
       sched.schedule_name,
       h.name AS holiday_name,
       a.absence_type,
       COALESCE(
         (SELECT json_agg(json_build_object(
             'id', p.id, 'punch_type', p.punch_type, 'punched_at', p.punched_at,
             'source', p.source, 'adjustment_reason', p.adjustment_reason
           ) ORDER BY p.punched_at)
            FROM time_punches p
           WHERE p.employee_id = $1
             AND p.organization_id = $2
             AND (p.punched_at AT TIME ZONE 'America/Sao_Paulo')::date = d.dt::date),
         '[]'::json) AS punches
     FROM generate_series($3::date, $4::date, '1 day'::interval) d(dt)
     ${schedSql}
     ${holidaySql}
     ${absenceSql}
    ORDER BY d.dt`,
    [employeeId, orgId, start, end]
  );
  return r.rows;
}

// GET /ponto/cartao?employee_id=&start=&end=
router.get('/ponto/cartao', async (req, res) => {
  const { employee_id, start, end } = req.query;
  if (!employee_id) return res.status(400).json({ error: 'employee_id obrigatório' });
  if (!isValidCivilDate(start) || !isValidCivilDate(end)) {
    return res.status(400).json({ error: 'start e end devem ser datas válidas (YYYY-MM-DD)' });
  }
  if (start > end) return res.status(400).json({ error: 'start deve ser anterior a end' });

  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });

    await ensureCartaoSchema();

    const empRes = await query(
      `SELECT e.id, e.full_name, e.cpf, e.position, e.work_schedule
         FROM employees e WHERE e.id = $1 AND e.organization_id = $2`,
      [employee_id, orgId]
    );
    const employee = empRes.rows[0];
    if (!employee) return res.status(404).json({ error: 'Colaborador não encontrado' });

    const tolerance = await getCartaoTolerance(orgId, employee_id);

    const closedRes = await query(
      `SELECT reference_month, closed, closed_at, reopened_at
         FROM rh_period_closures
        WHERE organization_id = $1 AND employee_id = $2 AND reference_month = ANY($3::varchar[])
        ORDER BY reference_month`,
      [orgId, employee_id, monthsBetween(start, end)]
    );
    const closures = new Map(closedRes.rows.map((c) => [c.reference_month, c]));

    const capabilities = await getCartaoTableCapabilities(orgId);
    const days = (await queryCartaoDays({
      employeeId: employee_id, orgId, start, end, capabilities,
    })).map((row) => buildCartaoDay(row, {
      employee,
      tolerance,
      closure: closures.get(referenceMonthOf(row.date)) || null,
    }));

    const periodTotals = accumulate(days);

    // Balance is accumulated from 1 January, not read from hour_bank: that
    // table has no organization_id and is never written, so reading it would
    // return zero for everyone. Same day-grid query as the visible period, so
    // the YTD figure and the on-screen rows are computed by identical code.
    const yearStart = `${String(start).slice(0, 4)}-01-01`;
    const ytdDays = (await queryCartaoDays({
      employeeId: employee_id, orgId, start: yearStart, end, capabilities,
    })).map((row) => buildCartaoDay(row, { employee, tolerance, closure: null }));
    const ytdTotals = accumulate(ytdDays);

    res.json({
      employee: {
        id: employee.id,
        full_name: employee.full_name,
        cpf: employee.cpf,
        position: employee.position,
        work_schedule: employee.work_schedule,
      },
      period: { start, end },
      days,
      totals: periodTotals,
      // Saldo is worked minus what the employee's own schedule says those days
      // should have lasted. Splitting by month is what makes it a banco de
      // horas: the legal figure is a monthly one, and a single saldo over a
      // period that straddles two months would not survive a payroll review.
      monthBank: buildMonthBank(days),
      yearToDate: {
        from: yearStart,
        to: end,
        creditMinutes: ytdTotals.creditMinutes,
        debitMinutes: ytdTotals.debitMinutes,
        workedMinutes: ytdTotals.workedMinutes,
        balanceMinutes: ytdTotals.balanceMinutes,
        credit: ytdTotals.credit,
        debit: ytdTotals.debit,
        worked: ytdTotals.worked,
        balance: formatSignedHHMM(ytdTotals.balanceMinutes),
        expectedMinutes: ytdTotals.expectedMinutes,
        expected: ytdTotals.expected,
        saldoMinutes: ytdTotals.saldoMinutes,
        saldo: formatSignedHHMM(ytdTotals.saldoMinutes),
      },
      warning: capabilities.missing.length
        ? `Sem ${capabilities.missing.join(' e ')} neste ambiente: jornada e feriados caem no padrão 08:00-17:00.`
        : undefined,
    });
  } catch (err) {
    logError('rh.ponto.cartao', err);
    // The generic message hid every real cause: a missing column, a bad
    // parameter type and a dead pool all looked identical from the browser.
    // Postgres errors carry no secrets beyond schema shape, so returning the
    // text here is what makes this diagnosable instead of guessable.
    res.status(500).json({
      error: 'Erro ao carregar o cartão de ponto',
      detail: err?.message || String(err),
      code: err?.code || null,
    });
  }
});

// PUT /ponto/cartao — corrige as batidas de um dia.
// Bloqueia com 423 quando o mês do dia está fechado.
router.put('/ponto/cartao', async (req, res) => {
  const { employee_id, date, times, reason } = req.body || {};
  if (!employee_id) return res.status(400).json({ error: 'employee_id obrigatório' });
  if (!isValidCivilDate(date)) return res.status(400).json({ error: 'date deve ser uma data válida (YYYY-MM-DD)' });

  const list = Array.isArray(times) ? times : [];
  if (list.length > CARTAO_MAX_PUNCHES) {
    return res.status(400).json({ error: `Máximo de ${CARTAO_MAX_PUNCHES} batidas por dia` });
  }
  const cleaned = list
    .map((t) => (t == null ? '' : String(t).trim()))
    .filter((t) => t !== '');
  for (const t of cleaned) {
    if (!CARTAO_TIME_RE.test(t)) {
      return res.status(400).json({ error: `Horário inválido: "${t}". Use HH:MM.` });
    }
  }
  // Editing punches without saying why defeats the point of the audit trail.
  if (!String(reason || '').trim()) {
    return res.status(400).json({ error: 'Justificativa obrigatória' });
  }

  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });

    await ensureCartaoSchema();

    const empRes = await query(
      `SELECT id FROM employees WHERE id = $1 AND organization_id = $2`,
      [employee_id, orgId]
    );
    if (!empRes.rows[0]) return res.status(404).json({ error: 'Colaborador não encontrado' });

    if (await isPeriodClosed(orgId, employee_id, date)) {
      return res.status(423).json({
        error: `Período ${referenceMonthOf(date)} fechado. Reabra o período para corrigir batidas.`,
        code: 'PERIOD_CLOSED',
        reference_month: referenceMonthOf(date),
      });
    }

    const before = await query(
      `SELECT json_agg(json_build_object('punch_type', punch_type, 'punched_at', punched_at) ORDER BY punched_at) AS punches
         FROM time_punches
        WHERE employee_id = $1 AND organization_id = $2
          AND (punched_at AT TIME ZONE 'America/Sao_Paulo')::date = $3::date`,
      [employee_id, orgId, date]
    );
    const previous = before.rows[0]?.punches || [];
    const oldLabel = previous.map((p) => instantToSaoPauloClock(p.punched_at)).filter(Boolean).join(', ');

    // Replace the day wholesale: a half-updated punch set is what makes the
    // totals disagree with what the manager sees.
    await query(
      `DELETE FROM time_punches
        WHERE employee_id = $1 AND organization_id = $2
          AND (punched_at AT TIME ZONE 'America/Sao_Paulo')::date = $3::date`,
      [employee_id, orgId, date]
    );

    for (let i = 0; i < cleaned.length; i += 1) {
      // The instant is built from the civil date and the wall-clock time in
      // São Paulo, never from the server clock, which runs in another zone.
      await query(
        `INSERT INTO time_punches
           (organization_id, employee_id, punch_type, punched_at, source, punched_by,
            sync_status, justification, manual_adjustment, adjustment_reason, adjusted_by, adjusted_at)
         VALUES ($1, $2, $3, (($4::date + $5::time) AT TIME ZONE 'America/Sao_Paulo'), 'manual', $6,
                 'synced', $7, true, $7, $6, NOW())`,
        [orgId, employee_id, punchTypeForIndex(i, cleaned.length), date, cleaned[i], req.userId, String(reason).trim()]
      );
    }

    const newLabel = cleaned.join(', ');
    await auditLog(
      orgId, 'time_punch', employee_id, 'update',
      [{ field: `times:${date}`, oldVal: oldLabel, newVal: newLabel }],
      req.userId
    );

    res.json({ ok: true, date, times: cleaned, previous: previous.length });
  } catch (err) {
    logError('rh.ponto.cartao.update', err);
    res.status(500).json({ error: 'Erro ao salvar as batidas' });
  }
});

// GET /ponto/cartao/audit?employee_id=&date=
router.get('/ponto/cartao/audit', async (req, res) => {
  const { employee_id, date } = req.query;
  if (!employee_id) return res.status(400).json({ error: 'employee_id obrigatório' });
  if (date && !isValidCivilDate(date)) {
    return res.status(400).json({ error: 'date deve ser uma data válida (YYYY-MM-DD)' });
  }
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });

    await ensureCartaoSchema();

    // rh_audit_log.entity_id is a UUID and a day has none, so the day is encoded
    // in field_name as 'times:YYYY-MM-DD' against the employee id.
    const r = await query(
      `SELECT a.id, a.field_name, a.old_value, a.new_value, a.action, a.created_at,
              u.name AS editor_name
         FROM rh_audit_log a
         LEFT JOIN users u ON u.id = a.changed_by
        WHERE a.organization_id = $1
          AND a.entity_type = 'time_punch'
          AND a.entity_id = $2
          AND a.field_name LIKE 'times:%'
          AND ($3::date IS NULL OR a.field_name = 'times:' || $3::date::text)
        ORDER BY a.created_at DESC
        LIMIT 100`,
      [orgId, employee_id, date || null]
    );
    res.json(r.rows);
  } catch (err) {
    logError('rh.ponto.cartao.audit', err);
    res.status(500).json({ error: 'Erro ao carregar o histórico' });
  }
});

// POST /ponto/cartao/period-close — fecha ou reabre o mês de um colaborador.
router.post('/ponto/cartao/period-close', async (req, res) => {
  const { employee_id, reference_month, closed } = req.body || {};
  if (!employee_id) return res.status(400).json({ error: 'employee_id obrigatório' });
  if (!/^\d{4}-\d{2}$/.test(String(reference_month || ''))) {
    return res.status(400).json({ error: 'reference_month deve estar no formato YYYY-MM' });
  }
  const m = Number(String(reference_month).slice(5, 7));
  if (m < 1 || m > 12) return res.status(400).json({ error: 'Mês inválido' });
  const shouldClose = closed !== false;

  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });

    await ensureCartaoSchema();

    const empRes = await query(
      `SELECT id FROM employees WHERE id = $1 AND organization_id = $2`,
      [employee_id, orgId]
    );
    if (!empRes.rows[0]) return res.status(404).json({ error: 'Colaborador não encontrado' });

    await query(
      `INSERT INTO rh_period_closures
         (organization_id, employee_id, reference_month, closed, closed_by, closed_at, reopened_by, reopened_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 THEN NOW() ELSE NULL END, $6, CASE WHEN $4 THEN NULL ELSE NOW() END)
       ON CONFLICT (employee_id, reference_month) DO UPDATE
         SET closed = EXCLUDED.closed,
             closed_by = CASE WHEN EXCLUDED.closed THEN EXCLUDED.closed_by ELSE rh_period_closures.closed_by END,
             closed_at = CASE WHEN EXCLUDED.closed THEN NOW() ELSE rh_period_closures.closed_at END,
             reopened_by = CASE WHEN EXCLUDED.closed THEN NULL ELSE EXCLUDED.reopened_by END,
             reopened_at = CASE WHEN EXCLUDED.closed THEN NULL ELSE NOW() END`,
      [orgId, employee_id, reference_month, shouldClose, req.userId, req.userId]
    );

    await auditLog(
      orgId, 'time_period', employee_id, shouldClose ? 'close' : 'reopen',
      [{ field: `period:${reference_month}`, oldVal: shouldClose ? 'aberto' : 'fechado', newVal: shouldClose ? 'fechado' : 'aberto' }],
      req.userId
    );

    res.json({ ok: true, employee_id, reference_month, closed: shouldClose });
  } catch (err) {
    logError('rh.ponto.cartao.period_close', err);
    res.status(500).json({ error: 'Erro ao alterar o fechamento do período' });
  }
});

// Divergence detection
router.get('/punch-divergences', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { start_date, end_date } = req.query;
    // Default em horário do Brasil. `toISOString()` usa UTC, então às 21:00 BRT
    // (ou antes, em horário de verão) já devolvia o dia seguinte e a janela
    // padrão não cobria o dia corrente.
    const saoPauloToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const sd = start_date || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 7 * 86400000));
    const ed = end_date || saoPauloToday();

    // Find employees who didn't punch on workdays + incomplete punch sequences
    const divergences = [];

    // 1. Employees with no punches on workdays
    const noPunch = await query(`
      SELECT e.id, e.full_name, e.work_schedule, d.dt::date as missing_date
      FROM employees e
      CROSS JOIN generate_series($2::date, $3::date, '1 day'::interval) d(dt)
      WHERE e.organization_id = $1 AND e.status = 'ativo'
        AND EXTRACT(DOW FROM d.dt) NOT IN (0, 6)
        AND NOT EXISTS (
          SELECT 1 FROM time_punches tp WHERE tp.employee_id = e.id AND (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date = d.dt::date
        )
        AND NOT EXISTS (
          SELECT 1 FROM time_records tr WHERE tr.employee_id = e.id AND tr.record_date = d.dt::date
        )
        AND NOT EXISTS (
          SELECT 1 FROM employee_absences ea WHERE ea.employee_id = e.id AND d.dt::date BETWEEN ea.start_date AND ea.end_date
        )
      ORDER BY d.dt DESC, e.full_name
      LIMIT 100
    `, [orgId, sd, ed]);

    for (const r of noPunch.rows) {
      divergences.push({
        employee_id: r.id,
        employee_name: r.full_name,
        date: r.missing_date,
        type: 'sem_registro',
        description: 'Nenhum registro de ponto neste dia',
        severity: 'high',
      });
    }

    // 2. Incomplete punch sequences (odd number of punches = missing entry/exit)
    const incomplete = await query(`
      SELECT tp.employee_id, e.full_name, (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date as punch_date, COUNT(*) as punch_count
      FROM time_punches tp
      JOIN employees e ON e.id = tp.employee_id
      WHERE tp.organization_id = $1 AND (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
      GROUP BY tp.employee_id, e.full_name, (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date
      HAVING COUNT(*) % 2 != 0
      ORDER BY (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date DESC
    `, [orgId, sd, ed]);

    for (const r of incomplete.rows) {
      divergences.push({
        employee_id: r.employee_id,
        employee_name: r.full_name,
        date: r.punch_date,
        type: 'incompleto',
        description: `Sequência incompleta (${r.punch_count} registros - ímpar)`,
        severity: 'medium',
      });
    }

    // 3. Outside PDV punches
    const outsidePdv = await query(`
      SELECT tp.employee_id, e.full_name, (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date as punch_date, COUNT(*) as count
      FROM time_punches tp
      JOIN employees e ON e.id = tp.employee_id
      WHERE tp.organization_id = $1 AND (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
        AND tp.geo_status = 'fora_area'
      GROUP BY tp.employee_id, e.full_name, (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date
      ORDER BY (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date DESC
    `, [orgId, sd, ed]);

    for (const r of outsidePdv.rows) {
      divergences.push({
        employee_id: r.employee_id,
        employee_name: r.full_name,
        date: r.punch_date,
        type: 'fora_pdv',
        description: `${r.count} registro(s) fora do PDV`,
        severity: 'low',
      });
    }

    res.json(divergences);
  } catch (err) {
    logError('rh.punch_divergences', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== PAYSLIPS (HOLERITE) =====

router.get('/payslips', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { employee_id, reference_month } = req.query;
    let sql = `SELECT p.*, e.full_name as employee_name, e.cpf, e.position
               FROM payslips p
               JOIN employees e ON e.id = p.employee_id
               WHERE p.organization_id = $1`;
    const params = [orgId];
    let idx = 2;
    if (employee_id) { sql += ` AND p.employee_id = $${idx++}`; params.push(employee_id); }
    if (reference_month) { sql += ` AND p.reference_month = $${idx++}`; params.push(reference_month); }
    sql += ` ORDER BY p.reference_month DESC, e.full_name`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logError('rh.payslips.list', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.post('/payslips', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });
    const d = req.body;
    const result = await query(
      `INSERT INTO payslips (organization_id, employee_id, reference_month, payment_type, gross_salary, earnings, total_earnings, deductions, total_deductions, net_salary, fgts_base, fgts_value, inss_base, inss_value, irrf_base, irrf_value, payment_date, status, notes, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [orgId, d.employee_id, d.reference_month, d.payment_type || 'mensal', d.gross_salary || 0,
        JSON.stringify(d.earnings || []), d.total_earnings || 0, JSON.stringify(d.deductions || []), d.total_deductions || 0,
        d.net_salary || 0, d.fgts_base || 0, d.fgts_value || 0, d.inss_base || 0, d.inss_value || 0,
        d.irrf_base || 0, d.irrf_value || 0, d.payment_date, d.status || 'rascunho', d.notes, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.payslips.create', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.put('/payslips/:id', async (req, res) => {
  try {
    const d = req.body;
    const result = await query(
      `UPDATE payslips SET gross_salary=$2, earnings=$3, total_earnings=$4, deductions=$5, total_deductions=$6,
       net_salary=$7, fgts_value=$8, inss_value=$9, irrf_value=$10, payment_date=$11, status=$12, notes=$13, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, d.gross_salary, JSON.stringify(d.earnings || []), d.total_earnings, JSON.stringify(d.deductions || []),
        d.total_deductions, d.net_salary, d.fgts_value, d.inss_value, d.irrf_value, d.payment_date, d.status, d.notes]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.payslips.update', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// Import payslip (PDF already uploaded via /api/uploads)
router.post('/payslips/import', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });
    const { employee_id, reference_month, payment_type, pdf_url, notes, send_for_signature } = req.body;
    if (!employee_id || !reference_month || !pdf_url) {
      return res.status(400).json({ error: 'employee_id, reference_month e pdf_url são obrigatórios' });
    }

    // Create payslip record with imported PDF
    const result = await query(
      `INSERT INTO payslips (organization_id, employee_id, reference_month, payment_type, pdf_url, status, notes, generated_by)
       VALUES ($1,$2,$3,$4,$5,'gerado',$6,$7) RETURNING *`,
      [orgId, employee_id, reference_month, payment_type || 'mensal', pdf_url, notes || '', req.userId]
    );
    const payslip = result.rows[0];

    // If send_for_signature, create a doc_signature_document and signer
    if (send_for_signature) {
      try {
        // Get employee info for signer
        const empRes = await query('SELECT full_name, email, cpf, phone FROM employees WHERE id=$1', [employee_id]);
        const emp = empRes.rows[0];
        if (emp) {
          // Create signature document
          const docRes = await query(
            `INSERT INTO doc_signature_documents (organization_id, title, description, file_url, status, created_by)
             VALUES ($1,$2,$3,$4,'pendente',$5) RETURNING *`,
            [orgId, `Holerite ${reference_month} - ${emp.full_name}`, `Demonstrativo de pagamento ref. ${reference_month}`, pdf_url, req.userId]
          );
          const doc = docRes.rows[0];

          // Add employee as signer
          const crypto = await import('crypto');
          const token = crypto.randomBytes(32).toString('hex');
          await query(
            `INSERT INTO doc_signature_signers (document_id, name, email, cpf, phone, sign_order, token)
             VALUES ($1,$2,$3,$4,$5,1,$6)`,
            [doc.id, emp.full_name, emp.email, emp.cpf, emp.phone, token]
          );

          // Update payslip with signature doc reference
          await query('UPDATE payslips SET notes = COALESCE(notes,\'\') || $2 WHERE id=$1',
            [payslip.id, `\n[Assinatura: ${doc.id}]`]);

          payslip.signature_document_id = doc.id;
        }
      } catch (sigErr) {
        logError('rh.payslips.import.signature', sigErr);
        // Don't fail the import if signature creation fails
      }
    }

    res.json(payslip);
  } catch (err) {
    logError('rh.payslips.import', err);
    res.status(500).json({ error: 'Erro ao importar holerite' });
  }
});

// ===== BULK IMPORT (multiple PDFs at once, auto-match by filename) =====

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function onlyDigits(s) { return String(s || '').replace(/\D+/g, ''); }

function scoreFilenameEmployee(filename, emp) {
  const base = normalizeText(filename.replace(/\.pdf$/i, '').replace(/[_\-]+/g, ' '));
  const digits = onlyDigits(filename);
  let score = 0;
  // CPF (11 digits) match
  const cpfDigits = onlyDigits(emp.cpf);
  if (cpfDigits && digits.includes(cpfDigits)) score += 100;
  // Registration number
  if (emp.registration_number) {
    const reg = onlyDigits(emp.registration_number) || String(emp.registration_number).toLowerCase();
    if (reg && (digits.includes(reg) || base.includes(String(reg).toLowerCase()))) score += 60;
  }
  // Name tokens
  const name = normalizeText(emp.full_name);
  if (!name) return score;
  const tokens = name.split(' ').filter(t => t.length >= 3);
  let hits = 0;
  for (const t of tokens) if (base.includes(t)) hits++;
  if (hits > 0) score += hits * 10 + (hits === tokens.length ? 20 : 0);
  // Full name substring
  if (base.includes(name)) score += 40;
  return score;
}

// Match a list of filenames against active employees (no persistence)
router.post('/payslips/bulk-match', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });
    const filenames = Array.isArray(req.body?.filenames) ? req.body.filenames : [];
    if (!filenames.length) return res.json({ matches: [] });
    const empRes = await query(
      `SELECT id, full_name, cpf, registration_number FROM employees WHERE organization_id=$1 AND status='ativo'`,
      [orgId]
    );
    const employees = empRes.rows;
    const matches = filenames.map((filename) => {
      let best = null;
      let bestScore = 0;
      for (const emp of employees) {
        const s = scoreFilenameEmployee(filename, emp);
        if (s > bestScore) { bestScore = s; best = emp; }
      }
      return {
        filename,
        employee_id: bestScore >= 20 ? best.id : null,
        employee_name: bestScore >= 20 ? best.full_name : null,
        score: bestScore,
      };
    });
    res.json({ matches, employees: employees.map(e => ({ id: e.id, full_name: e.full_name })) });
  } catch (err) {
    logError('rh.payslips.bulk-match', err);
    res.status(500).json({ error: 'Erro ao mapear holerites' });
  }
});

// Import many payslips at once (each with its own employee_id + pdf_url)
router.post('/payslips/bulk-import', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });
    const { reference_month, payment_type, send_for_signature, items } = req.body || {};
    if (!reference_month || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'reference_month e items são obrigatórios' });
    }
    const created = [];
    const errors = [];
    for (const it of items) {
      if (!it?.employee_id || !it?.pdf_url) {
        errors.push({ filename: it?.filename, error: 'employee_id/pdf_url ausente' });
        continue;
      }
      try {
        const r = await query(
          `INSERT INTO payslips (organization_id, employee_id, reference_month, payment_type, pdf_url, status, notes, generated_by)
           VALUES ($1,$2,$3,$4,$5,'gerado',$6,$7) RETURNING *`,
          [orgId, it.employee_id, reference_month, payment_type || 'mensal', it.pdf_url, it.notes || '', req.userId]
        );
        const payslip = r.rows[0];

        if (send_for_signature) {
          try {
            const empRes = await query('SELECT full_name, email, cpf, phone FROM employees WHERE id=$1', [it.employee_id]);
            const emp = empRes.rows[0];
            if (emp) {
              const docRes = await query(
                `INSERT INTO doc_signature_documents (organization_id, title, description, file_url, status, created_by)
                 VALUES ($1,$2,$3,$4,'pendente',$5) RETURNING *`,
                [orgId, `Holerite ${reference_month} - ${emp.full_name}`, `Demonstrativo de pagamento ref. ${reference_month}`, it.pdf_url, req.userId]
              );
              const doc = docRes.rows[0];
              const crypto = await import('crypto');
              const token = crypto.randomBytes(32).toString('hex');
              await query(
                `INSERT INTO doc_signature_signers (document_id, name, email, cpf, phone, sign_order, token)
                 VALUES ($1,$2,$3,$4,$5,1,$6)`,
                [doc.id, emp.full_name, emp.email, emp.cpf, emp.phone, token]
              );
              await query('UPDATE payslips SET notes = COALESCE(notes,\'\') || $2 WHERE id=$1',
                [payslip.id, `\n[Assinatura: ${doc.id}]`]);
              payslip.signature_document_id = doc.id;
            }
          } catch (sigErr) {
            logError('rh.payslips.bulk-import.signature', sigErr);
          }
        }
        created.push({ filename: it.filename, payslip });
      } catch (e) {
        errors.push({ filename: it?.filename, error: e.message });
      }
    }
    res.json({ created_count: created.length, error_count: errors.length, created, errors });
  } catch (err) {
    logError('rh.payslips.bulk-import', err);
    res.status(500).json({ error: 'Erro ao importar holerites em lote' });
  }
});

// ===== ABSENCES =====

router.get('/absences', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    const { employee_id } = req.query;
    let sql = `SELECT a.*, e.full_name as employee_name
               FROM employee_absences a
               JOIN employees e ON e.id = a.employee_id
               WHERE e.organization_id = $1`;
    const params = [orgId];
    if (employee_id) { sql += ` AND a.employee_id = $2`; params.push(employee_id); }
    sql += ` ORDER BY a.start_date DESC`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logError('rh.absences.list', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.post('/absences', async (req, res) => {
  try {
    const d = req.body;
    const result = await query(
      `INSERT INTO employee_absences (employee_id, absence_type, start_date, end_date, days_count, reason, document_url, approved, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [d.employee_id, d.absence_type, d.start_date, d.end_date, d.days_count, d.reason, d.document_url, d.approved || false, d.approved ? req.userId : null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.absences.create', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== BRANCHES, DEPARTMENTS, COST CENTERS =====

router.get('/branches', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    const result = await query(`SELECT * FROM branches WHERE organization_id = $1 ORDER BY name`, [orgId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/branches', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    const result = await query(`INSERT INTO branches (organization_id, name, cnpj, address, city, state) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, req.body.name, req.body.cnpj, req.body.address, req.body.city, req.body.state]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.get('/rh-departments', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    const result = await query(`SELECT * FROM rh_departments WHERE organization_id = $1 ORDER BY name`, [orgId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh-departments', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    const result = await query(`INSERT INTO rh_departments (organization_id, name, branch_id) VALUES ($1,$2,$3) RETURNING *`,
      [orgId, req.body.name, req.body.branch_id || null]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.get('/cost-centers', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    const result = await query(`SELECT * FROM cost_centers WHERE organization_id = $1 ORDER BY code`, [orgId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/cost-centers', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    const result = await query(`INSERT INTO cost_centers (organization_id, code, name) VALUES ($1,$2,$3) RETURNING *`,
      [orgId, req.body.code, req.body.name]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ===== POSITIONS (CARGOS) =====
router.get('/positions', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    const result = await query(`SELECT * FROM rh_positions WHERE organization_id = $1 ORDER BY name`, [orgId]);
    res.json(result.rows);
  } catch (err) {
    // Table may not exist yet — auto-create
    try {
      await query(`CREATE TABLE IF NOT EXISTS rh_positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        name VARCHAR(200) NOT NULL,
        department_id UUID REFERENCES rh_departments(id),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      res.json([]);
    } catch (e2) { res.status(500).json({ error: 'Erro' }); }
  }
});

router.post('/positions', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    // Ensure table exists
    await query(`CREATE TABLE IF NOT EXISTS rh_positions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(200) NOT NULL,
      department_id UUID REFERENCES rh_departments(id),
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const result = await query(
      `INSERT INTO rh_positions (organization_id, name, department_id, description) VALUES ($1,$2,$3,$4) RETURNING *`,
      [orgId, req.body.name, req.body.department_id || null, req.body.description || null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao criar cargo' }); }
});

router.delete('/positions/:id', async (req, res) => {
  try {
    await query(`DELETE FROM rh_positions WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.delete('/rh-departments/:id', async (req, res) => {
  try {
    await query(`DELETE FROM rh_departments WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.delete('/branches/:id', async (req, res) => {
  try {
    await query(`DELETE FROM branches WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ===== WORKER PROFILES (PERFIS FUNCIONAIS) =====
router.get('/worker-profiles', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    await query(`CREATE TABLE IF NOT EXISTS rh_worker_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(200) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const result = await query(`SELECT * FROM rh_worker_profiles WHERE organization_id = $1 ORDER BY name`, [orgId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/worker-profiles', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    await query(`CREATE TABLE IF NOT EXISTS rh_worker_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(200) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const result = await query(
      `INSERT INTO rh_worker_profiles (organization_id, name) VALUES ($1,$2) RETURNING *`,
      [orgId, req.body.name]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao criar perfil' }); }
});

router.delete('/worker-profiles/:id', async (req, res) => {
  try {
    await query(`DELETE FROM rh_worker_profiles WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ===== AUDIT LOG =====

// ===== RH DASHBOARD STATS =====
router.get('/dashboard-stats', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json({});
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const lateRes = await query(
      `SELECT tr.*, e.full_name, e.work_schedule
       FROM time_records tr JOIN employees e ON e.id = tr.employee_id
       WHERE tr.organization_id = $1 AND tr.record_date = $2
         AND tr.entry1 IS NOT NULL AND e.work_schedule IS NOT NULL
         AND tr.entry1 > CAST(SPLIT_PART(e.work_schedule, '-', 1) || ':00' AS TIME) + INTERVAL '5 minutes'
       ORDER BY tr.entry1 DESC`, [orgId, today]);
    const absenceRes = await query(
      `SELECT e.id, e.full_name, e.position, d.name as department_name
       FROM employees e LEFT JOIN rh_departments d ON d.id = e.department_id
       WHERE e.organization_id = $1 AND e.status = 'ativo'
         AND NOT EXISTS (SELECT 1 FROM time_records tr WHERE tr.employee_id = e.id AND tr.record_date = $2)
       ORDER BY e.full_name`, [orgId, today]);
    const vacExpiring = await query(
      `SELECT e.id, e.full_name, e.admission_date, e.position
       FROM employees e WHERE e.organization_id = $1 AND e.status = 'ativo' AND e.admission_date IS NOT NULL
         AND (DATE_PART('month', e.admission_date) = DATE_PART('month', CURRENT_DATE + INTERVAL '30 days')
           AND DATE_PART('day', e.admission_date) <= DATE_PART('day', CURRENT_DATE + INTERVAL '30 days'))
       ORDER BY e.admission_date`, [orgId]);
    let pendingCerts = { rows: [] };
    try {
      pendingCerts = await query(
        `SELECT mc.*, e.full_name FROM rh_medical_certificates mc JOIN employees e ON e.id = mc.employee_id
         WHERE mc.organization_id = $1 AND mc.validated = false ORDER BY mc.created_at DESC LIMIT 20`, [orgId]);
    } catch(e) { /* table may not exist yet */ }
    let activeVacations = { rows: [] };
    try {
      activeVacations = await query(
        `SELECT v.*, e.full_name FROM rh_vacations v JOIN employees e ON e.id = v.employee_id
         WHERE v.organization_id = $1 AND v.status IN ('agendada', 'em_andamento') ORDER BY v.start_date`, [orgId]);
    } catch(e) { /* table may not exist yet */ }
    const countRes = await query(
      `SELECT
         (SELECT COUNT(*) FROM employees WHERE organization_id = $1 AND status = 'ativo') as total_active,
         (SELECT COUNT(*) FROM employees WHERE organization_id = $1 AND status = 'ferias') as on_vacation,
         (SELECT COUNT(*) FROM employees WHERE organization_id = $1 AND status = 'afastado') as on_leave`, [orgId]);
    res.json({
      late_arrivals: lateRes.rows, absences_today: absenceRes.rows,
      vacations_expiring: vacExpiring.rows, pending_certificates: pendingCerts.rows,
      active_vacations: activeVacations.rows, summary: countRes.rows[0] || {},
    });
  } catch (err) { logError('rh.dashboard', err); res.status(500).json({ error: 'Erro ao carregar dashboard' }); }
});

// ===== VACATIONS =====
router.get('/vacations', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { employee_id, status } = req.query;
    let sql = `SELECT v.*, e.full_name as employee_name, e.position FROM rh_vacations v JOIN employees e ON e.id = v.employee_id WHERE v.organization_id = $1`;
    const params = [orgId]; let idx = 2;
    if (employee_id) { sql += ` AND v.employee_id = $${idx++}`; params.push(employee_id); }
    if (status) { sql += ` AND v.status = $${idx++}`; params.push(status); }
    sql += ` ORDER BY v.start_date DESC`;
    res.json((await query(sql, params)).rows);
  } catch (err) { logError('rh.vacations.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/vacations', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    const d = req.body;
    const result = await query(
      `INSERT INTO rh_vacations (organization_id, employee_id, vacation_type, acquisition_start, acquisition_end,
        start_date, end_date, days_total, days_taken, days_remaining, abono_pecuniario, abono_days, status, notes, approved, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [orgId, d.employee_id, d.vacation_type || 'completa', d.acquisition_start, d.acquisition_end,
        d.start_date, d.end_date, d.days_total || 30, d.days_taken || 0,
        (d.days_total || 30) - (d.days_taken || 0), d.abono_pecuniario || false, d.abono_days || 0,
        d.status || 'agendada', d.notes, d.approved || false, req.userId]);
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    if (d.start_date <= todayStr) {
      await query(`UPDATE employees SET status = 'ferias', updated_at = NOW() WHERE id = $1`, [d.employee_id]);
    }
    await auditLog(orgId, 'vacation', result.rows[0].id, 'create', [{ field: 'vacation', oldVal: null, newVal: `${d.vacation_type}: ${d.start_date} - ${d.end_date}` }], req.userId);
    res.json(result.rows[0]);
  } catch (err) { logError('rh.vacations.create', err); res.status(500).json({ error: 'Erro ao registrar férias' }); }
});

router.put('/vacations/:id', async (req, res) => {
  try {
    const d = req.body;
    const result = await query(
      `UPDATE rh_vacations SET vacation_type=$2, start_date=$3, end_date=$4, days_total=$5, days_taken=$6, days_remaining=$7,
        abono_pecuniario=$8, abono_days=$9, status=$10, notes=$11, approved=$12, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, d.vacation_type, d.start_date, d.end_date, d.days_total, d.days_taken, d.days_remaining, d.abono_pecuniario, d.abono_days, d.status, d.notes, d.approved]);
    res.json(result.rows[0]);
  } catch (err) { logError('rh.vacations.update', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== MEDICAL CERTIFICATES =====
router.get('/medical-certificates', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { employee_id, validated } = req.query;
    let sql = `SELECT mc.*, e.full_name as employee_name FROM rh_medical_certificates mc JOIN employees e ON e.id = mc.employee_id WHERE mc.organization_id = $1`;
    const params = [orgId]; let idx = 2;
    if (employee_id) { sql += ` AND mc.employee_id = $${idx++}`; params.push(employee_id); }
    if (validated !== undefined) { sql += ` AND mc.validated = $${idx++}`; params.push(validated === 'true'); }
    sql += ` ORDER BY mc.created_at DESC`;
    res.json((await query(sql, params)).rows);
  } catch (err) { logError('rh.medical.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/medical-certificates', async (req, res) => {
  try {
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    const d = req.body;
    const result = await query(
      `INSERT INTO rh_medical_certificates (organization_id, employee_id, doctor_name, doctor_crm, cid_code,
        healthcare_unit, absence_start, absence_end, absence_days, absence_hours, is_partial,
        document_url, ai_extracted_data, ai_confidence, notes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [orgId, d.employee_id, d.doctor_name, d.doctor_crm, d.cid_code, d.healthcare_unit,
        d.absence_start, d.absence_end, d.absence_days, d.absence_hours, d.is_partial || false,
        d.document_url, d.ai_extracted_data ? JSON.stringify(d.ai_extracted_data) : null,
        d.ai_confidence, d.notes, req.userId]);
    // Auto-justify time records
    if (d.absence_start && d.absence_end) {
      const days = Math.ceil((new Date(d.absence_end) - new Date(d.absence_start)) / 86400000) + 1;
      for (let i = 0; i < days; i++) {
        const dt = new Date(d.absence_start); dt.setDate(dt.getDate() + i);
        const dateStr = dt.toISOString().slice(0, 10);
        await query(
          `INSERT INTO time_records (organization_id, employee_id, record_date, status, justification, total_hours, overtime_hours)
           VALUES ($1, $2, $3, 'atestado', $4, 0, 0)
           ON CONFLICT (employee_id, record_date) DO UPDATE SET status = 'atestado', justification = EXCLUDED.justification, updated_at = NOW()`,
          [orgId, d.employee_id, dateStr, `Atestado: CID ${d.cid_code || 'N/I'} - Dr. ${d.doctor_name || 'N/I'}`]);
      }
    }
    await auditLog(orgId, 'medical_certificate', result.rows[0].id, 'create',
      [{ field: 'certificate', oldVal: null, newVal: `CID: ${d.cid_code}, Dr: ${d.doctor_name}` }], req.userId);
    res.json(result.rows[0]);
  } catch (err) { logError('rh.medical.create', err); res.status(500).json({ error: 'Erro ao registrar atestado' }); }
});

router.put('/medical-certificates/:id/validate', async (req, res) => {
  try {
    const { validated, rejection_reason } = req.body;
    const result = await query(
      `UPDATE rh_medical_certificates SET validated = $2, validated_by = $3, validated_at = NOW(), rejection_reason = $4, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, validated, req.userId, rejection_reason || null]);
    res.json(result.rows[0]);
  } catch (err) { logError('rh.medical.validate', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== EMPLOYEE DOCUMENTS =====
router.get('/documents', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { employee_id, doc_type } = req.query;
    let sql = `SELECT ed.*, e.full_name as employee_name FROM employee_documents ed JOIN employees e ON e.id = ed.employee_id WHERE e.organization_id = $1`;
    const params = [orgId]; let idx = 2;
    if (employee_id) { sql += ` AND ed.employee_id = $${idx++}`; params.push(employee_id); }
    if (doc_type) { sql += ` AND ed.doc_type = $${idx++}`; params.push(doc_type); }
    sql += ` ORDER BY ed.created_at DESC`;
    res.json((await query(sql, params)).rows);
  } catch (err) { logError('rh.documents.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/documents', async (req, res) => {
  try {
    const d = req.body;
    const result = await query(
      `INSERT INTO employee_documents (employee_id, doc_type, title, file_url, expiry_date, notes, status, uploaded_by, ai_extracted_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [d.employee_id, d.doc_type, d.title, d.file_url, d.expiry_date, d.notes, d.status || 'pendente', req.userId,
        d.ai_extracted_data ? JSON.stringify(d.ai_extracted_data) : null]);
    res.json(result.rows[0]);
  } catch (err) { logError('rh.documents.create', err); res.status(500).json({ error: 'Erro' }); }
});

router.put('/documents/:id/validate', async (req, res) => {
  try {
    const { status, rejection_reason } = req.body;
    const result = await query(
      `UPDATE employee_documents SET status = $2, validated_by = $3, validated_at = NOW(), rejection_reason = $4 WHERE id = $1 RETURNING *`,
      [req.params.id, status || 'aprovado', req.userId, rejection_reason || null]);
    res.json(result.rows[0]);
  } catch (err) { logError('rh.documents.validate', err); res.status(500).json({ error: 'Erro' }); }
});

router.delete('/documents/:id', async (req, res) => {
  try {
    await query(`DELETE FROM employee_documents WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { logError('rh.documents.delete', err); res.status(500).json({ error: 'Erro' }); }
});



router.get('/audit-log', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    const { entity_type, entity_id } = req.query;
    let sql = `SELECT a.*, u.name as changed_by_name
               FROM rh_audit_log a
               LEFT JOIN users u ON u.id = a.changed_by
               WHERE a.organization_id = $1`;
    const params = [orgId];
    let idx = 2;
    if (entity_type) { sql += ` AND a.entity_type = $${idx++}`; params.push(entity_type); }
    if (entity_id) { sql += ` AND a.entity_id = $${idx++}`; params.push(entity_id); }
    sql += ` ORDER BY a.changed_at DESC LIMIT 200`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logError('rh.audit.list', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== AI CERTIFICATE ANALYSIS =====
async function getAIConfig(userId) {
  const orgResult = await query(
    `SELECT o.ai_provider, o.ai_model, o.ai_api_key 
     FROM organizations o
     JOIN organization_members om ON om.organization_id = o.id
     WHERE om.user_id = $1 LIMIT 1`,
    [userId]
  );
  const org = orgResult.rows[0];
  if (!org || !org.ai_api_key || org.ai_provider === 'none') return null;
  return {
    provider: org.ai_provider,
    model: org.ai_model || (org.ai_provider === 'openai' ? 'gpt-4o-mini' : 'gemini-2.0-flash'),
    apiKey: org.ai_api_key,
  };
}

router.post('/analyze-certificate', async (req, res) => {
  try {
    const { document_url } = req.body;
    if (!document_url) return res.status(400).json({ error: 'document_url é obrigatório' });

    const aiConfig = await getAIConfig(req.userId);
    if (!aiConfig) {
      return res.status(400).json({ error: 'IA não configurada. Configure a chave de IA nas configurações da organização.' });
    }

    // Build image/document content for AI
    const resolvedUrl = document_url.startsWith('/') 
      ? `${process.env.BASE_URL || 'http://localhost:3000'}${document_url}`
      : document_url;

    const messages = [
      {
        role: 'system',
        content: `Você é um especialista em análise de atestados médicos brasileiros. Analise a imagem/documento do atestado e extraia as seguintes informações em JSON:
{
  "doctor_name": "nome completo do médico",
  "doctor_crm": "número do CRM (apenas números e UF, ex: 12345/SP)",
  "cid_code": "código CID (ex: J11, Z76.3)",
  "healthcare_unit": "nome do hospital, clínica ou unidade de saúde",
  "absence_start": "data início do afastamento no formato YYYY-MM-DD",
  "absence_end": "data fim do afastamento no formato YYYY-MM-DD",
  "absence_days": número de dias de afastamento,
  "absence_hours": "horários se parcial (ex: 08:00-12:00) ou vazio",
  "is_partial": true ou false se é atestado parcial (horas),
  "notes": "observações relevantes do atestado"
}
Se algum campo não for legível ou não estiver presente, use string vazia "" ou 0 para números. Responda APENAS com o JSON, sem texto adicional.`
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analise este atestado médico e extraia as informações:' },
          { type: 'image_url', image_url: { url: resolvedUrl } }
        ]
      }
    ];

    const result = await callAI(aiConfig, messages, { temperature: 0.1, maxTokens: 800 });
    
    let parsed = {};
    try {
      const jsonStr = (result.content || '').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      logError('rh.analyze-certificate.parse', { raw: result.content });
      return res.status(422).json({ error: 'Não foi possível extrair dados do atestado. Tente uma imagem mais nítida.' });
    }

    logInfo('rh.analyze-certificate', { parsed });
    res.json({ success: true, data: parsed });
  } catch (err) {
    logError('rh.analyze-certificate', err);
    res.status(500).json({ error: 'Erro ao analisar atestado' });
  }
});

// ===== CRM VALIDATION =====
router.post('/validate-crm', async (req, res) => {
  try {
    const { crm, uf } = req.body;
    if (!crm || !uf) return res.status(400).json({ error: 'CRM e UF são obrigatórios' });

    const cleanCrm = crm.replace(/\D/g, '');
    const cleanUf = uf.toUpperCase().trim();

    // Use CFM portal search
    const url = `https://portal.cfm.org.br/api/public/medicos?crm=${cleanCrm}&uf=${cleanUf}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // Fallback: try alternative endpoint
      const altUrl = `https://www.consultacrm.com.br/api/index.php?tipo=crm&q=${cleanCrm}&chave=1173&destession=&ession=&ession=`;
      try {
        const altResp = await fetch(altUrl, { 
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (altResp.ok) {
          const altData = await altResp.json();
          const items = altData?.item || [];
          const match = items.find(i => i.uf?.toUpperCase() === cleanUf);
          if (match) {
            return res.json({
              valid: match.situacao?.toLowerCase().includes('regular') || match.situacao?.toLowerCase().includes('ativo'),
              doctor_name: match.nome || '',
              situation: match.situacao || 'Desconhecida',
              specialty: match.especialidade || '',
              source: 'consultacrm',
            });
          }
        }
      } catch { /* ignore fallback errors */ }

      return res.json({ valid: null, message: 'Não foi possível verificar o CRM no momento. Tente novamente mais tarde.' });
    }

    const data = await response.json();
    const medicos = data?.dados || data?.items || (Array.isArray(data) ? data : []);
    
    if (medicos.length === 0) {
      return res.json({ valid: false, message: 'CRM não encontrado no CFM.' });
    }

    const medico = medicos[0];
    const situacao = medico.situacao || medico.status || '';
    const isValid = situacao.toLowerCase().includes('regular') || situacao.toLowerCase().includes('ativo');

    res.json({
      valid: isValid,
      doctor_name: medico.nome || medico.name || '',
      situation: situacao,
      specialty: medico.especialidade || medico.specialty || '',
      source: 'cfm',
    });
  } catch (err) {
    logError('rh.validate-crm', err);
    res.json({ valid: null, message: 'Erro ao consultar CRM. Serviço pode estar indisponível.' });
  }
});

// ===== HOLIDAYS =====

// List holidays
router.get('/holidays', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);

    const { year, type } = req.query;
    const params = [orgId];
    let sql = `SELECT * FROM holidays WHERE organization_id = $1 AND active = true`;

    if (year) {
      sql += ` AND EXTRACT(YEAR FROM holiday_date) = $${params.length + 1}`;
      params.push(Number(year));
    }

    if (type) {
      sql += ` AND type = $${params.length + 1}`;
      params.push(type);
    }

    sql += ` ORDER BY holiday_date ASC, name ASC`;
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) {
    logError('rh.holidays.list', err);
    res.status(500).json({ error: err.message });
  }
});

// Create holiday
router.post('/holidays', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    const { name, holiday_date, type, state, city, recurring } = req.body;
    if (!name || !holiday_date) return res.status(400).json({ error: 'Nome e data obrigatórios' });

    const r = await query(
      `INSERT INTO holidays (organization_id, name, holiday_date, type, state, city, recurring)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, name, holiday_date) DO UPDATE SET
         type = EXCLUDED.type,
         state = EXCLUDED.state,
         city = EXCLUDED.city,
         recurring = EXCLUDED.recurring,
         active = true,
         updated_at = NOW()
       RETURNING *`,
      [orgId, name, holiday_date, type || 'nacional', emptyToNull(state), emptyToNull(city), recurring !== false]
    );
    res.json(r.rows[0]);
  } catch (err) {
    logError('rh.holidays.create', err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk import holidays (from CSV/Excel)
router.post('/holidays/bulk', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    const { holidays } = req.body;
    if (!Array.isArray(holidays) || !holidays.length) return res.status(400).json({ error: 'Lista de feriados vazia' });

    let imported = 0;
    for (const h of holidays) {
      if (!h.name || !h.holiday_date) continue;
      await query(
        `INSERT INTO holidays (organization_id, name, holiday_date, type, state, city, recurring)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (organization_id, name, holiday_date) DO UPDATE SET
           type = EXCLUDED.type,
           state = EXCLUDED.state,
           city = EXCLUDED.city,
           recurring = EXCLUDED.recurring,
           active = true,
           updated_at = NOW()`,
        [orgId, h.name, h.holiday_date, h.type || 'nacional', emptyToNull(h.state), emptyToNull(h.city), h.recurring !== false]
      );
      imported++;
    }

    res.json({ imported });
  } catch (err) {
    logError('rh.holidays.bulk', err);
    res.status(500).json({ error: err.message });
  }
});

// Update holiday
router.put('/holidays/:id', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    const { name, holiday_date, type, state, city, recurring } = req.body;
    if (!name || !holiday_date) return res.status(400).json({ error: 'Nome e data obrigatórios' });
    const result = await query(
      `UPDATE holidays SET name=$1, holiday_date=$2, type=$3, state=$4, city=$5,
       recurring=$6, active=true, updated_at=NOW()
       WHERE id=$7 AND organization_id=$8 RETURNING *`,
      [name, holiday_date, type || 'nacional', emptyToNull(state), emptyToNull(city), recurring !== false, req.params.id, orgId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Feriado não encontrado' });
    res.json(result.rows[0]);
  } catch (err) { logError('rh.holidays.update', err); res.status(500).json({ error: err.message }); }
});

// Delete holiday
router.delete('/holidays/:id', async (req, res) => {
  try {
    await query(`DELETE FROM holidays WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { logError('rh.holidays.delete', err); res.status(500).json({ error: err.message }); }
});

// ===== SERVICE REGIONS (auto-heal) =====
let regionsInfraPromise = null;
async function ensureRegionsInfrastructure() {
  if (!regionsInfraPromise) {
    regionsInfraPromise = (async () => {
      // Try with FK first, fall back without FK if organizations table missing
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS service_regions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            color VARCHAR(7) DEFAULT '#3b82f6',
            polygon JSONB DEFAULT '[]',
            cities JSONB DEFAULT '[]',
            states JSONB DEFAULT '[]',
            supervisor_id UUID,
            active BOOLEAN DEFAULT true,
            notes TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
      } catch (_fkErr) {
        await query(`
          CREATE TABLE IF NOT EXISTS service_regions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id UUID NOT NULL,
            name VARCHAR(255) NOT NULL,
            color VARCHAR(7) DEFAULT '#3b82f6',
            polygon JSONB DEFAULT '[]',
            cities JSONB DEFAULT '[]',
            states JSONB DEFAULT '[]',
            supervisor_id UUID,
            active BOOLEAN DEFAULT true,
            notes TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
      }
      await query(`CREATE INDEX IF NOT EXISTS idx_service_regions_org ON service_regions(organization_id)`);

      // Ensure all columns exist (safe for already-created tables)
      const cols = [
        ['organization_id', 'UUID'],
        ['color', "VARCHAR(7) DEFAULT '#3b82f6'"],
        ['polygon', "JSONB DEFAULT '[]'"],
        ['cities', "JSONB DEFAULT '[]'"],
        ['states', "JSONB DEFAULT '[]'"],
        ['supervisor_id', 'UUID'],
        ['active', 'BOOLEAN DEFAULT true'],
        ['notes', 'TEXT'],
        ['updated_at', 'TIMESTAMPTZ DEFAULT NOW()'],
      ];
      for (const [col, def] of cols) {
        try { await query(`ALTER TABLE service_regions ADD COLUMN IF NOT EXISTS ${col} ${def}`); } catch (_e) { /* ignore */ }
      }

      try {
        await query(`
          CREATE TABLE IF NOT EXISTS region_pdvs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            region_id UUID NOT NULL REFERENCES service_regions(id) ON DELETE CASCADE,
            pdv_id UUID NOT NULL,
            auto_assigned BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(region_id, pdv_id)
          )
        `);
      } catch (_e) {
        await query(`
          CREATE TABLE IF NOT EXISTS region_pdvs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            region_id UUID NOT NULL,
            pdv_id UUID NOT NULL,
            auto_assigned BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(region_id, pdv_id)
          )
        `);
      }
      await query(`CREATE INDEX IF NOT EXISTS idx_region_pdvs_region ON region_pdvs(region_id)`);

      // Ensure geo columns
      try { await query(`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION`); } catch (_e) { /* */ }
      try { await query(`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION`); } catch (_e) { /* */ }
      try { await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS home_latitude NUMERIC(10,7)`); } catch (_e) { /* */ }
      try { await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS home_longitude NUMERIC(10,7)`); } catch (_e) { /* */ }
    })().catch(err => { regionsInfraPromise = null; throw err; });
  }
  return regionsInfraPromise;
}

// Middleware: ensure tables exist before any region/map route
router.use(['/regions', '/map-data'], async (req, res, next) => {
  try {
    await ensureRegionsInfrastructure();
    next();
  } catch (err) {
    logError('rh.regions.bootstrap', err);
    res.status(500).json({ error: err?.message || 'Erro ao inicializar regiões' });
  }
});

// List regions
router.get('/regions', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const r = await query(
      `SELECT sr.*, e.full_name as supervisor_name,
         (SELECT COUNT(*) FROM region_pdvs rp WHERE rp.region_id = sr.id) as pdv_count
       FROM service_regions sr
       LEFT JOIN employees e ON e.id = sr.supervisor_id
       WHERE sr.organization_id = $1
       ORDER BY sr.name`,
      [orgId]
    );
    res.json(r.rows);
  } catch (err) { logError('rh.regions.list', err); res.status(500).json({ error: err.message }); }
});

// Create region
router.post('/regions', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    const { name, color, polygon, cities, states, supervisor_id, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const r = await query(
      `INSERT INTO service_regions (organization_id, name, color, polygon, cities, states, supervisor_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orgId, name, color || '#3b82f6', JSON.stringify(polygon || []), JSON.stringify(cities || []), JSON.stringify(states || []), emptyToNull(supervisor_id), emptyToNull(notes)]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('rh.regions.create', err); res.status(500).json({ error: err.message }); }
});

// Update region
router.put('/regions/:id', async (req, res) => {
  try {
    const { name, color, polygon, cities, states, supervisor_id, notes, active } = req.body;
    const r = await query(
      `UPDATE service_regions SET name=$1, color=$2, polygon=$3, cities=$4, states=$5, supervisor_id=$6, notes=$7, active=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [name, color, JSON.stringify(polygon || []), JSON.stringify(cities || []), JSON.stringify(states || []), emptyToNull(supervisor_id), emptyToNull(notes), active !== false, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('rh.regions.update', err); res.status(500).json({ error: err.message }); }
});

// Delete region
router.delete('/regions/:id', async (req, res) => {
  try {
    await query(`DELETE FROM service_regions WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { logError('rh.regions.delete', err); res.status(500).json({ error: err.message }); }
});

// Link PDVs to region
router.post('/regions/:id/pdvs', async (req, res) => {
  try {
    const { pdv_ids, auto_assigned } = req.body;
    if (!Array.isArray(pdv_ids)) return res.status(400).json({ error: 'pdv_ids obrigatório' });
    for (const pdvId of pdv_ids) {
      await query(
        `INSERT INTO region_pdvs (region_id, pdv_id, auto_assigned) VALUES ($1,$2,$3) ON CONFLICT (region_id, pdv_id) DO NOTHING`,
        [req.params.id, pdvId, auto_assigned || false]
      );
    }
    res.json({ ok: true });
  } catch (err) { logError('rh.regions.link-pdvs', err); res.status(500).json({ error: err.message }); }
});

// Get PDVs in a region
router.get('/regions/:id/pdvs', async (req, res) => {
  try {
    const r = await query(
      `SELECT p.*, rp.auto_assigned FROM region_pdvs rp JOIN pdvs p ON p.id = rp.pdv_id WHERE rp.region_id = $1 ORDER BY p.name`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { logError('rh.regions.pdvs', err); res.status(500).json({ error: err.message }); }
});

// Remove PDV from region
router.delete('/regions/:regionId/pdvs/:pdvId', async (req, res) => {
  try {
    await query(`DELETE FROM region_pdvs WHERE region_id = $1 AND pdv_id = $2`, [req.params.regionId, req.params.pdvId]);
    res.json({ ok: true });
  } catch (err) { logError('rh.regions.remove-pdv', err); res.status(500).json({ error: err.message }); }
});

// ===== GEOCODING (via Nominatim - free) =====
router.post('/geocode', async (req, res) => {
  try {
    const payload = req.body || {};
    const address = payload.address || payload.endereco || '';
    const address_number = payload.address_number || payload.numero || '';
    const complement = payload.complement || payload.complemento || '';
    const neighborhood = payload.neighborhood || payload.bairro || '';
    const city = payload.city || payload.cidade || '';
    const state = payload.state || payload.estado || '';
    const zip_code = payload.zip_code || payload.cep || '';

    const result = await geocodeAddressWithFallback(
      { address, address_number, complement, neighborhood, city, state, zip_code },
      { requireComplete: true }
    );

    if (result.validationError) {
      return res.status(400).json({ error: result.validationError, details: `Busca: ${result.attemptedAddress}`, attempted_address: result.attemptedAddress });
    }

    if (!result.geo) {
      return res.json({ found: false, attempted_address: result.attemptedAddress });
    }

    res.json({
      found: true,
      latitude: result.geo.lat,
      longitude: result.geo.lng,
      display_name: result.geo.display_name,
      attempted_address: result.attemptedAddress,
    });
  } catch (err) { logError('rh.geocode', err); res.status(500).json({ error: err.message }); }
});

// ===== MAP DATA: PDVs + Employees with coords =====
router.get('/map-data', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json({ pdvs: [], employees: [], regions: [] });
    const [pdvsR, empsR, regionsR] = await Promise.all([
      query(`SELECT id, name, client_name, address, city, state, latitude, longitude, radius_meters, supervisor_id, active FROM pdvs WHERE organization_id = $1 AND active = true`, [orgId]),
      query(`SELECT id, full_name, position, worker_profile, city, state, home_latitude, home_longitude, photo_url FROM employees WHERE organization_id = $1 AND status = 'ativo'`, [orgId]),
      query(`SELECT sr.*, e.full_name as supervisor_name FROM service_regions sr LEFT JOIN employees e ON e.id = sr.supervisor_id WHERE sr.organization_id = $1 AND sr.active = true`, [orgId]),
    ]);
    res.json({ pdvs: pdvsR.rows, employees: empsR.rows, regions: regionsR.rows });
  } catch (err) { logError('rh.map-data', err); res.status(500).json({ error: err.message }); }
});

router.get('/pdvs', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);

    const result = await query(
      `SELECT p.*, e.full_name as supervisor_name
       FROM pdvs p
       LEFT JOIN employees e ON e.id = p.supervisor_id
       WHERE p.organization_id = $1
       ORDER BY p.name`,
      [orgId]
    );

    res.json(result.rows);
  } catch (err) {
    logError('rh.pdvs.list', err);
    res.status(500).json({ error: err.message || 'Erro ao listar PDVs' });
  }
});

// ─── Facial Recognition Config ───
let facialRecognitionInfraReady = false;

async function ensureFacialRecognitionInfra() {
  if (facialRecognitionInfraReady) return;
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await query(`
    CREATE TABLE IF NOT EXISTS facial_recognition_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      enabled BOOLEAN DEFAULT false,
      use_for_attendance BOOLEAN DEFAULT false,
      use_for_checkin BOOLEAN DEFAULT false,
      min_confidence NUMERIC(5,2) DEFAULT 70.00,
      require_photo_registration BOOLEAN DEFAULT true,
      auto_verify_on_clock_in BOOLEAN DEFAULT false,
      allow_manual_fallback BOOLEAN DEFAULT true,
      photo_quality_check BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS face_verification_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
      agency_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE SET NULL,
      verification_context VARCHAR(30) NOT NULL,
      confidence_score NUMERIC(5,2),
      result VARCHAR(20) NOT NULL,
      captured_image_url TEXT,
      device_info TEXT,
      ip_address VARCHAR(45),
      processing_time_ms INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_face_verify_org ON face_verification_logs(organization_id, created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_face_verify_employee ON face_verification_logs(employee_id, created_at)`);
  facialRecognitionInfraReady = true;
}

router.get('/facial-recognition/config', async (req, res) => {
  try {
    await ensureFacialRecognitionInfra();
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json({ enabled: false });
    const result = await query(
      `SELECT * FROM facial_recognition_config WHERE organization_id = $1 LIMIT 1`,
      [orgId]
    );
    if (result.rows.length === 0) {
      return res.json({
        enabled: false,
        use_for_attendance: false,
        use_for_checkin: false,
        min_confidence: 70,
        require_photo_registration: true,
        auto_verify_on_clock_in: false,
        allow_manual_fallback: true,
        photo_quality_check: true,
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.facial-config.get', err);
    res.status(500).json({ error: err.message || 'Erro ao carregar configuração da biometria facial' });
  }
});

router.put('/facial-recognition/config', async (req, res) => {
  try {
    await ensureFacialRecognitionInfra();
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });

    const d = {
      enabled: !!req.body.enabled,
      use_for_attendance: !!req.body.use_for_attendance,
      use_for_checkin: !!req.body.use_for_checkin,
      min_confidence: Number(req.body.min_confidence) || 70,
      require_photo_registration: req.body.require_photo_registration !== false,
      auto_verify_on_clock_in: !!req.body.auto_verify_on_clock_in,
      allow_manual_fallback: req.body.allow_manual_fallback !== false,
      photo_quality_check: req.body.photo_quality_check !== false,
    };

    const result = await query(
      `INSERT INTO facial_recognition_config (
         organization_id, enabled, use_for_attendance, use_for_checkin, min_confidence,
         require_photo_registration, auto_verify_on_clock_in, allow_manual_fallback, photo_quality_check
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         use_for_attendance = EXCLUDED.use_for_attendance,
         use_for_checkin = EXCLUDED.use_for_checkin,
         min_confidence = EXCLUDED.min_confidence,
         require_photo_registration = EXCLUDED.require_photo_registration,
         auto_verify_on_clock_in = EXCLUDED.auto_verify_on_clock_in,
         allow_manual_fallback = EXCLUDED.allow_manual_fallback,
         photo_quality_check = EXCLUDED.photo_quality_check,
         updated_at = NOW()
       RETURNING *`,
      [
        orgId,
        d.enabled,
        d.use_for_attendance,
        d.use_for_checkin,
        d.min_confidence,
        d.require_photo_registration,
        d.auto_verify_on_clock_in,
        d.allow_manual_fallback,
        d.photo_quality_check,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.facial-config.put', err);
    res.status(500).json({ error: err.message || 'Erro ao salvar configuração da biometria facial' });
  }
});

// ─── Facial Enrollment for Employees ───

// Ensure employees have face_descriptor column
let faceEnrollColumnReady = false;
async function ensureFaceEnrollColumn() {
  if (faceEnrollColumnReady) return;
  await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS face_descriptor JSONB`);
  await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS face_photo_url TEXT`);
  await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS face_enrolled_at TIMESTAMPTZ`);
  faceEnrollColumnReady = true;
}

const ACTIVE_EMPLOYEE_STATUS_SQL = `COALESCE(e.status::text, '') IN ('ativo', 'active')`;

// List employees with facial enrollment status
router.get('/facial-recognition/employees', async (req, res) => {
  try {
    await ensureFacialRecognitionInfra();
    await ensureFaceEnrollColumn();
    await ensureEmployeeExtraColumns();
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);

    const { filter } = req.query; // 'all' | 'enrolled' | 'pending'
    let sql = `SELECT e.id, e.full_name, e.photo_url, e.cpf, e.position, e.status,
                      e.face_descriptor IS NOT NULL as face_enrolled,
                      e.face_photo_url, e.face_enrolled_at,
                      COALESCE(e.facial_required, true) as facial_verification_enabled
               FROM employees e
               WHERE e.organization_id = $1 AND ${ACTIVE_EMPLOYEE_STATUS_SQL}`;

    if (filter === 'enrolled') sql += ` AND e.face_descriptor IS NOT NULL`;
    else if (filter === 'pending') sql += ` AND e.face_descriptor IS NULL`;

    sql += ` ORDER BY e.face_descriptor IS NULL DESC, e.full_name`;
    const result = await query(sql, [orgId]);
    res.json(result.rows);
  } catch (err) {
    logError('rh.facial.employees', err);
    res.status(500).json({ error: err.message });
  }
});

// Enroll employee face
router.post('/facial-recognition/enroll/:employeeId', async (req, res) => {
  try {
    await ensureFacialRecognitionInfra();
    await ensureFaceEnrollColumn();
    const { employeeId } = req.params;
    const { descriptor, landmarks, imageDataUrl, geometricProfile } = req.body;

    if (!descriptor || !Array.isArray(descriptor)) {
      return res.status(400).json({ error: 'Descriptor facial é obrigatório' });
    }

    const faceData = { descriptor, landmarks, geometricProfile };

    await query(
      `UPDATE employees SET
         face_descriptor = $1,
         face_photo_url = $2,
         face_enrolled_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(faceData), imageDataUrl || null, employeeId]
    );

    // Log the enrollment
    const emp = await query(`SELECT organization_id FROM employees WHERE id = $1`, [employeeId]);
    if (emp.rows[0]) {
      await query(
        `INSERT INTO face_verification_logs
         (organization_id, employee_id, verification_context, confidence_score, result, captured_image_url)
         VALUES ($1, $2, 'enrollment', 100, 'approved', $3)`,
        [emp.rows[0].organization_id, employeeId, imageDataUrl || null]
      );
    }

    res.json({ success: true });
  } catch (err) {
    logError('rh.facial.enroll', err);
    res.status(500).json({ error: err.message });
  }
});

// Remove employee face enrollment
router.delete('/facial-recognition/enroll/:employeeId', async (req, res) => {
  try {
    await ensureFaceEnrollColumn();
    await query(
      `UPDATE employees SET face_descriptor = NULL, face_photo_url = NULL, face_enrolled_at = NULL WHERE id = $1`,
      [req.params.employeeId]
    );
    res.json({ success: true });
  } catch (err) {
    logError('rh.facial.remove', err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle per-employee facial verification override
router.put('/facial-recognition/toggle-verification/:employeeId', async (req, res) => {
  try {
    await ensureEmployeeExtraColumns();
    const orgId = req.body.organization_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });

    const { employeeId } = req.params;
    const enabled = req.body?.enabled !== false;

    const result = await query(
      `UPDATE employees
          SET facial_required = $1,
              updated_at = NOW()
        WHERE id = $2
          AND organization_id = $3
        RETURNING id, full_name, facial_required`,
      [enabled, employeeId, orgId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Colaborador não encontrado' });
    }

    res.json({
      success: true,
      employee: result.rows[0],
      facial_verification_enabled: enabled,
    });
  } catch (err) {
    logError('rh.facial.toggle-verification', err, { employee_id: req.params.employeeId, body: req.body });
    res.status(500).json({ error: err.message || 'Erro ao atualizar verificação facial' });
  }
});

// Placeholder: alerts about employees with facial recognition disabled.
// Returns an empty array by default; may be enriched in the future.
router.get('/facial-recognition/disabled-alerts', async (_req, res) => {
  try {
    res.json([]);
  } catch (e) {
    logError('rh.facial.disabled-alerts', e);
    res.json([]);
  }
});

// Get face descriptor for testing verification
router.get('/facial-recognition/descriptor/:employeeId', async (req, res) => {
  try {
    await ensureFaceEnrollColumn();
    const { rows } = await query(
      `SELECT face_descriptor, face_photo_url, full_name FROM employees WHERE id = $1`,
      [req.params.employeeId]
    );
    if (!rows.length || !rows[0].face_descriptor) {
      return res.status(404).json({ error: 'Sem dados faciais cadastrados' });
    }
    const desc = typeof rows[0].face_descriptor === 'string'
      ? JSON.parse(rows[0].face_descriptor)
      : rows[0].face_descriptor;
    const descriptor = Array.isArray(desc)
      ? desc
      : Array.isArray(desc?.descriptor)
        ? desc.descriptor
        : [];

    if (!descriptor.length) {
      return res.status(422).json({ error: 'Dados faciais inválidos para teste' });
    }

    res.json({
      descriptor,
      photo_url: rows[0].face_photo_url,
      name: rows[0].full_name,
    });
  } catch (err) {
    logError('rh.facial.descriptor', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── Monitoring & Logs ───
router.get('/runtime-logs', async (req, res) => {
  try {
    const { getRecentLogs } = await import('../logger.js');
    const { level, limit, event_prefix } = req.query;
    const safeLimit = parseInt(limit) || 100;
    const memoryLogs = getRecentLogs({
      level,
      limit: safeLimit,
      eventPrefixes: event_prefix ? [event_prefix] : []
    });

    // Erros/fatais também ficam persistidos no banco (ver logger.js) — o
    // buffer em memória acima é pequeno e compartilhado com todos os níveis,
    // então um erro visível agora pode sumir da lista minutos depois (ou some
    // de vez após um restart do servidor). Mesclamos os dois aqui para que
    // filtrar por "Erros" sempre mostre um histórico confiável.
    let dbLogs = [];
    if (!level || level === 'all' || level === 'error' || level === 'fatal' || level === 'warn') {
      try {
        const params = [];
        let sql = 'SELECT payload FROM system_error_logs WHERE 1=1';
        if (level && level !== 'all') { params.push(level); sql += ` AND level = $${params.length}`; }
        if (event_prefix) { params.push(`${event_prefix}%`); sql += ` AND event ILIKE $${params.length}`; }
        params.push(safeLimit);
        sql += ` ORDER BY ts DESC LIMIT $${params.length}`;
        const r = await query(sql, params);
        dbLogs = r.rows.map((row) => row.payload).filter(Boolean);
      } catch {
        // Tabela pode ainda não existir se nenhum erro foi persistido ainda.
      }
    }

    const merged = new Map();
    for (const l of [...dbLogs, ...memoryLogs]) {
      merged.set(l.id || `${l.ts}-${l.event}`, l);
    }
    const combined = Array.from(merged.values())
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, safeLimit);

    res.json(combined);
  } catch (err) {
    console.error('Runtime logs error:', err);
    res.status(500).json({ error: 'Erro ao buscar logs em tempo real' });
  }
});


router.get('/connected-devices', async (req, res) => {
  try {
    const orgId = req.orgId || await getUserOrgId(req.userId);
    if (!orgId) {
      return res.status(403).json({ error: 'Organização não identificada para este usuário' });
    }

    const result = await query(
      `SELECT 
        e.full_name as employee_name, 
        e.email as employee_email,
        e.photo_url,
        caa.last_device as device_info,
        caa.last_login as last_seen,
        caa.last_ip as ip_address
       FROM collaborator_app_access caa
       JOIN employees e ON e.id = caa.employee_id
       WHERE e.organization_id = $1
       ORDER BY caa.last_login DESC NULLS LAST`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    logError('rh.devices.list', err);
    res.status(500).json({ 
      error: 'Erro ao listar dispositivos',
      details: err.message,
      hint: 'Verifique se a coluna last_login existe na tabela collaborator_app_access'
    });
  }
});

export default router;
