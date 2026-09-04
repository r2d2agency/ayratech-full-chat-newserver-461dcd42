import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logInfo, logError, logWarn } from '../logger.js';
import { validatePdvLocation, ensurePdvGeofenceColumn } from '../lib/geofence.js';

const router = express.Router();

let homeColumnsReady = null;
async function ensurePromotorHomeColumns() {
  if (homeColumnsReady) return homeColumnsReady;
  homeColumnsReady = (async () => {
    try {
      await ensurePdvGeofenceColumn();
    } catch (e) { /* ignore */ }
    try {
      await query(`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'pdv'`);
      await query(`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS geofence_polygon JSONB`);
    } catch (e) { /* ignore */ }
    try {
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS checklist_ids JSONB`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_require_checkin_photo BOOLEAN`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_require_checkout_photo BOOLEAN`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_require_stock_count BOOLEAN`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_require_validity_check BOOLEAN`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_require_extra_point BOOLEAN`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_require_category_photos BOOLEAN`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_category_photo_mode VARCHAR(20)`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_min_category_photos_before INT`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_min_category_photos_after INT`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS eff_checklist_type VARCHAR(20)`);
    } catch (e) { /* ignore */ }
    try {
      await query(`ALTER TABLE route_brands ADD COLUMN IF NOT EXISTS checklist_ids JSONB`);
      await query(`ALTER TABLE route_brands ADD COLUMN IF NOT EXISTS eff_checklist_type VARCHAR(20)`);
      for (const col of ['eff_require_checkin_photo', 'eff_require_checkout_photo', 'eff_require_stock_count', 'eff_require_validity_check', 'eff_require_extra_point', 'eff_require_category_photos']) {
        await query(`ALTER TABLE route_brands ADD COLUMN IF NOT EXISTS ${col} BOOLEAN`).catch(() => {});
      }
      await query(`ALTER TABLE route_brands ADD COLUMN IF NOT EXISTS eff_category_photo_mode VARCHAR(20)`).catch(() => {});
      await query(`ALTER TABLE route_brands ADD COLUMN IF NOT EXISTS eff_min_category_photos_before INT`).catch(() => {});
      await query(`ALTER TABLE route_brands ADD COLUMN IF NOT EXISTS eff_min_category_photos_after INT`).catch(() => {});
    } catch (e) { /* ignore */ }
    try {
      await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS require_category_photos BOOLEAN DEFAULT true`);
      await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS category_photo_mode VARCHAR(20) DEFAULT 'both'`);
      await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_before INT DEFAULT 1`);
      await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_after INT DEFAULT 1`);
      await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS checklist_type VARCHAR(20) DEFAULT 'standard'`);
    } catch (e) { /* ignore */ }
  })().catch(() => {});
  return homeColumnsReady;
}
router.use((req, res, next) => {
  // Skip auth for promotor app routes that use their own middleware
  const isPromotorRoute = req.path.startsWith('/login') ||
                          req.path.startsWith('/home') || 
                          req.path.startsWith('/punch') || 
                          req.path.startsWith('/overtime-request') ||
                          req.path.startsWith('/location-update') ||
                          req.path.startsWith('/punches') ||
                          req.path.startsWith('/documents') ||
                          req.path.startsWith('/inbound-documents') ||
                          req.path.startsWith('/payslips') ||
                          req.path.startsWith('/timesheets') ||
                          req.path.startsWith('/notifications') ||
                          req.path.startsWith('/settings') ||
                          req.path.startsWith('/change-password') ||
                          req.path.startsWith('/face-enrollment') ||
                          req.path.startsWith('/sync');

  if (isPromotorRoute) {
    return next();
  }
  return authenticate(req, res, next);
});

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

function buildGeocodeCandidates({ address, address_number, complement, neighborhood, city, state, zip_code }) {
  const parsed = splitAddressAndNumber(address);
  const street = String(parsed.street || '').trim();
  const number = String(address_number || parsed.number || '').trim();
  const normalizedComplement = String(complement || '').trim();
  const cleanZip = String(zip_code || '').replace(/\D/g, '');
  const normalizedState = String(state || '').trim().toUpperCase();
  const streetWithNumber = [street, number].filter(Boolean).join(', ');
  const streetWithComplement = [streetWithNumber, normalizedComplement].filter(Boolean).join(', ');

  return [
    [streetWithComplement, neighborhood, `${city} - ${normalizedState}`, cleanZip, 'Brasil'].filter(Boolean).join(', '),
    [streetWithComplement, neighborhood, city, normalizedState, cleanZip, 'Brasil'].filter(Boolean).join(', '),
    [streetWithComplement, neighborhood, city, normalizedState, 'Brasil'].filter(Boolean).join(', '),
    [streetWithNumber, neighborhood, `${city} - ${normalizedState}`, cleanZip, 'Brasil'].filter(Boolean).join(', '),
    [streetWithNumber, neighborhood, city, normalizedState, cleanZip, 'Brasil'].filter(Boolean).join(', '),
    [streetWithNumber, neighborhood, city, normalizedState, 'Brasil'].filter(Boolean).join(', '),
    [street, neighborhood, city, normalizedState, cleanZip, 'Brasil'].filter(Boolean).join(', '),
  ].filter((candidate, index, arr) => candidate && arr.indexOf(candidate) === index);
}

// Auto-geocode using canonical Brazilian address + Nominatim
async function autoGeocode(address, city, state, zip_code, neighborhood, address_number = null, complement = null) {
  const candidates = buildGeocodeCandidates({ address, address_number, complement, neighborhood, city, state, zip_code });
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    try {
      const q = encodeURIComponent(candidate);
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=${q}`, {
        headers: { 'User-Agent': BR_GEOCODE_USER_AGENT }
      });
      const data = await res.json();
      if (Array.isArray(data) && data[0]) {
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display_name: data[0].display_name };
      }
    } catch (_) {}
  }

  return null;
}

async function resolveOrganizationId(req) {
  const orgIdFromRequest =
    req.query?.org_id ||
    req.body?.organization_id ||
    req.organizationId ||
    req.user?.organization_id ||
    req.profile?.organization_id ||
    req.headers['x-organization-id'];

  if (orgIdFromRequest) return orgIdFromRequest;
  if (!req.userId) return null;

  const orgResult = await query(
    `SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`,
    [req.userId]
  );

  return orgResult.rows[0]?.organization_id || null;
}

async function tableExists(tableName) {
  const result = await query(`SELECT to_regclass($1) as table_name`, [tableName]);
  return Boolean(result.rows[0]?.table_name);
}

async function isOrgAdmin(userId, orgId) {
  if (!userId || !orgId) return false;
  const r = await query(
    `SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2 LIMIT 1`,
    [userId, orgId]
  );
  const role = r.rows[0]?.role;
  return role === 'owner' || role === 'admin';
}

// ===== MIDDLEWARE: Promotor Auth =====
const authenticatePromotor = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.appType !== 'promotor') return res.status(403).json({ error: 'Token inválido para este app' });
    req.employeeId = decoded.employeeId;
    req.organizationId = decoded.organizationId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

// =============================================
// PUBLIC: LOGIN DO COLABORADOR
// =============================================
router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body; // login = CPF ou email
    if (!login || !password) return res.status(400).json({ error: 'Login e senha obrigatórios' });

    const cleaned = login.replace(/\D/g, '');
    const isCpf = cleaned.length === 11;

    const emp = await query(
      `SELECT e.id, e.full_name, e.cpf, e.email, e.organization_id, e.worker_profile, e.photo_url,
              a.password_hash, a.access_status, a.temp_password, a.force_password_change
       FROM employees e
       JOIN collaborator_app_access a ON a.employee_id = e.id
       WHERE ${isCpf ? 'REPLACE(REPLACE(REPLACE(e.cpf, \'.\', \'\'), \'-\', \'\'), \' \', \'\') = $1' : 'LOWER(e.email) = LOWER($1)'}
         AND a.access_status IN ('liberado', 'aguardando_login', 'ativo')`,
      [isCpf ? cleaned : login]
    );

    if (!emp.rows[0]) return res.status(401).json({ error: 'Credenciais inválidas ou acesso não liberado' });
    const employee = emp.rows[0];

    const valid = await bcrypt.compare(password, employee.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });

    // Update access status
    await query(
      `UPDATE collaborator_app_access SET access_status = 'ativo', last_login = NOW(), last_device = $2, last_ip = $3, updated_at = NOW() WHERE employee_id = $1`,
      [employee.id, req.headers['user-agent'] || '', req.ip]
    );

    const token = jwt.sign(
      { employeeId: employee.id, organizationId: employee.organization_id, appType: 'promotor' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      employee: {
        id: employee.id,
        name: employee.full_name,
        cpf: employee.cpf,
        email: employee.email,
        photo_url: employee.photo_url,
        profile: employee.worker_profile,
        organization_id: employee.organization_id,
        force_password_change: employee.force_password_change && employee.temp_password,
      },
    });
  } catch (err) {
    logError('promotor.login', err);
    res.status(500).json({ error: 'Erro no login' });
  }
});

// =============================================
// PROMOTOR: CHANGE PASSWORD
// =============================================
router.post('/change-password', authenticatePromotor, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const acc = await query(`SELECT password_hash FROM collaborator_app_access WHERE employee_id = $1`, [req.employeeId]);
    if (!acc.rows[0]) return res.status(404).json({ error: 'Acesso não encontrado' });

    if (current_password) {
      const valid = await bcrypt.compare(current_password, acc.rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: 'Senha atual incorreta' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await query(
      `UPDATE collaborator_app_access SET password_hash = $2, temp_password = false, force_password_change = false, updated_at = NOW() WHERE employee_id = $1`,
      [req.employeeId, hash]
    );
    await query(`INSERT INTO collaborator_password_resets (employee_id, reset_by, ip_address) VALUES ($1, 'proprio', $2)`, [req.employeeId, req.ip]);
    res.json({ ok: true });
  } catch (err) {
    logError('promotor.change-password', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// PROMOTOR: HOME / STATUS DO DIA
// =============================================
router.get('/home', authenticatePromotor, async (req, res) => {
  try {
    await ensurePromotorHomeColumns();
    // Use America/Sao_Paulo timezone - ensures the current date matches the collaborator's region
    // CRITICAL: Database-side NOW() and America/Sao_Paulo context
    // We strictly use NOW() in DB to avoid any drift from app-server JS time
    const todayResult = await query("SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date as today");
    const today = todayResult.rows[0].today.toISOString().split('T')[0];
    const empId = req.employeeId;

    // Helper to run a query safely – returns empty result on missing-table/column errors
    const safeQuery = async (sql, params) => {
      try { return await query(sql, params); }
      catch (e) { if (e.code === '42P01' || e.code === '42703') return { rows: [] }; throw e; }
    };

    const [employee, punches, pendingDocs, notifications, assignment, settings] = await Promise.all([
      safeQuery(`SELECT e.id, e.full_name, e.email, e.cpf, e.photo_url, e.worker_profile, e.work_schedule, e.position, e.punch_tolerance_minutes, o.work_schedule as organization_work_schedule FROM employees e JOIN organizations o ON o.id = e.organization_id WHERE e.id = $1`, [empId]),
      safeQuery(`SELECT * FROM time_punches WHERE employee_id = $1 AND punched_at::date = $2 ORDER BY punched_at`, [empId, today]),
      safeQuery(`SELECT COUNT(*) as count FROM rh_document_deliveries WHERE employee_id = $1 AND status IN ('enviado', 'entregue', 'visualizado') AND (requires_signature = true OR requires_confirmation = true)`, [empId]),
      safeQuery(`SELECT * FROM collaborator_notifications WHERE employee_id = $1 AND read = false ORDER BY created_at DESC LIMIT 10`, [empId]),
      safeQuery(`SELECT da.*, p.name as pdv_name, p.latitude, p.longitude, p.radius_meters FROM collaborator_daily_assignments da LEFT JOIN pdvs p ON p.id = da.pdv_id WHERE da.employee_id = $1 AND da.assignment_date = $2 LIMIT 1`, [empId, today]),
      safeQuery(`SELECT * FROM collaborator_app_settings WHERE employee_id = $1`, [empId]),
    ]);

    // Get linked PDVs if no daily assignment
    let pdvs = [];
    if (!assignment.rows[0]) {
      const pdvRes = await safeQuery(
        `SELECT p.* FROM collaborator_pdvs cp JOIN pdvs p ON p.id = cp.pdv_id WHERE cp.employee_id = $1 AND cp.active = true`, [empId]
      );
      pdvs = pdvRes.rows;
    }

    // ===== TODAY'S ROUTES =====
    let todayRoutes = [];
    try {
      const routesRes = await query(
        `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
         p.latitude as pdv_lat, p.longitude as pdv_lng, p.radius_meters as pdv_radius,
         CASE WHEN p.type IS NOT NULL THEN p.type ELSE 'pdv' END as pdv_type,
         p.geofence_polygon as pdv_geofence_polygon,
         b.name as brand_name, b.logo_url as brand_logo,
         bc.name as checklist_name,
         (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_id = r.id) as product_count,
         (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_id = r.id AND rpe.status = 'completed') as products_done
         FROM merch_routes r
         LEFT JOIN pdvs p ON p.id = r.pdv_id
         LEFT JOIN merch_brands b ON b.id = r.brand_id
         LEFT JOIN brand_checklists bc ON bc.id = r.checklist_id
         WHERE r.promoter_id = $1 AND r.visit_date = $2
         ORDER BY r.scheduled_time, r.created_at`,
        [empId, today]
      );
      todayRoutes = routesRes.rows;
    } catch (e) {
      if (e?.code === '42703' || e?.code === '42P01') {
        try {
          const fallbackRes = await query(
            `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
             p.latitude as pdv_lat, p.longitude as pdv_lng, p.radius_meters as pdv_radius,
             'pdv'::text as pdv_type,
             NULL::jsonb as pdv_geofence_polygon,
             b.name as brand_name, b.logo_url as brand_logo,
             NULL::text as checklist_name,
             0::bigint as product_count,
             0::bigint as products_done
             FROM merch_routes r
             LEFT JOIN pdvs p ON p.id = r.pdv_id
             LEFT JOIN merch_brands b ON b.id = r.brand_id
             WHERE r.promoter_id = $1 AND r.visit_date = $2
             ORDER BY r.scheduled_time, r.created_at`,
            [empId, today]
          );
          todayRoutes = fallbackRes.rows;
        } catch (e2) {
          if (e2?.code === '42P01' || e2?.code === '42703') {
            try {
              const fallbackFinal = await query(
                `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
                 p.latitude as pdv_lat, p.longitude as pdv_lng, p.radius_meters as pdv_radius,
                 'pdv'::text as pdv_type,
                 NULL::jsonb as pdv_geofence_polygon,
                 NULL::text as brand_name,
                 NULL::text as brand_logo,
                 NULL::text as checklist_name,
                 0::bigint as product_count,
                 0::bigint as products_done
                 FROM merch_routes r
                 LEFT JOIN pdvs p ON p.id = r.pdv_id
                 WHERE r.promoter_id = $1 AND r.visit_date = $2
                 ORDER BY r.scheduled_time, r.created_at`,
                [empId, today]
              );
              todayRoutes = fallbackFinal.rows;
            } catch (e3) {
              if (e3.code !== '42P01') logError('promotor.home.routes_final_fallback', e3);
              todayRoutes = [];
            }
          } else if (e2.code !== '42P01') {
            logError('promotor.home.routes_fallback', e2);
          }
        }
      } else if (e?.code !== '42P01') {
        logError('promotor.home.routes', e);
      }
    }

    // ===== PDV VISIT STATUS (group routes by PDV) =====
    let pdvVisits = [];
    try {
      const visitRes = await safeQuery(
        `SELECT * FROM pdv_visits WHERE promoter_id = $1 AND visit_date = $2 ORDER BY checkin_at`,
        [empId, today]
      );
      pdvVisits = visitRes.rows;
    } catch { /* table may not exist */ }

    // Check schedule status (prioritize daily assignment or recurring schedule)
    let scheduleStart = null;
    let scheduleEnd = null;
    
    // 1. Check daily assignment
    if (assignment.rows[0]?.shift_start && assignment.rows[0]?.shift_end) {
      scheduleStart = assignment.rows[0].shift_start;
      scheduleEnd = assignment.rows[0].shift_end;
    } else {
      // 2. Check recurring schedule (Escala)
      try {
        const dowMap = { 0: 'dom', 1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab' };
        const dowRes = await query("SELECT EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')) as dow");
        const dayOfWeek = dowMap[Math.floor(dowRes.rows[0].dow)];
        const recurring = await safeQuery(
          `SELECT s.items FROM rh_employee_schedules es
           JOIN rh_schedules s ON s.id = es.schedule_id
           WHERE es.employee_id = $1 AND es.active = true
           ORDER BY es.created_at DESC`,
          [empId]
        );
        
        if (recurring.rows && recurring.rows.length > 0) {
          // Find the first schedule that has items for today
          for (const row of recurring.rows) {
            if (row.items) {
              const items = row.items;
              const todaySchedule = Array.isArray(items) ? items.find(i => i.day === dayOfWeek) : null;
              if (todaySchedule && todaySchedule.entry && todaySchedule.exit) {
                scheduleStart = todaySchedule.entry;
                scheduleEnd = todaySchedule.exit;
                break;
              }
            }
          }
        }
      } catch (e) {
        logError('promotor.home.recurring', e);
      }
    }

    // 3. Fallback to general work schedule (Jornada) - ONLY if no Scale (Escala) exists
    if (!scheduleStart) {
      const wsRaw = employee.rows[0]?.work_schedule || '08:00-17:00';
      try {
        const parsed = typeof wsRaw === 'object' ? wsRaw : (typeof wsRaw === 'string' && wsRaw.trim().startsWith('{') ? JSON.parse(wsRaw) : null);
        
        if (parsed) {
          const dowMap = { 0: 'dom', 1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab' };
          const dowRes = await query("SELECT EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')) as dow");
          const dayOfWeek = dowMap[Math.floor(dowRes.rows[0].dow)];
          
          if (parsed.useIndividualDays && parsed.dayConfig && parsed.dayConfig[dayOfWeek]) {
            const config = parsed.dayConfig[dayOfWeek];
            if (config.entry && config.exit) {
              scheduleStart = config.entry;
              scheduleEnd = config.exit;
            }
          }
          
          if (!scheduleStart && parsed.entry) {
            scheduleStart = parsed.entry;
            scheduleEnd = parsed.exit || '17:00';
          }
        }
        
        if (!scheduleStart) {
          const parts = String(wsRaw).split('-');
          if (parts.length >= 2) { 
            scheduleStart = parts[0].trim(); 
            scheduleEnd = parts[1].trim(); 
          }
        }
      } catch {
        const parts = String(wsRaw).split('-');
        if (parts.length >= 2) { 
          scheduleStart = parts[0].trim(); 
          scheduleEnd = parts[1].trim(); 
        }
      }
    } else {
      logInfo('promotor.home.schedule', { type: 'SCALE', start: scheduleStart, end: scheduleEnd, empId });
    }


    // Final safety defaults
    if (!scheduleStart) scheduleStart = '08:00';
    if (!scheduleEnd) scheduleEnd = '17:00';
    // Final safety defaults
    if (!scheduleStart) scheduleStart = '08:00';
    if (!scheduleEnd) scheduleEnd = '17:00';

    const minRes = await query("SELECT (EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')) * 60 + EXTRACT(MINUTE FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))) as current_min");
    const currentMin = Math.floor(minRes.rows[0].current_min);
    const parseToMin = (str) => {
      if (!str || typeof str !== 'string') return 0;
      const parts = str.split(':');
      if (parts.length < 2) return 0;
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    };

    const startMin = parseToMin(scheduleStart) || 480;
    const endMin = parseToMin(scheduleEnd) || 1020;
    
    // Punch tolerance logic: Individual employee > Global org setting > 15 min default
    const globalSchedule = employee.rows[0]?.organization_work_schedule;
    const globalTolerance = (globalSchedule && typeof globalSchedule === 'object') ? (globalSchedule.punch_tolerance_minutes || 15) : 15;
    const toleranceMinutes = employee.rows[0]?.punch_tolerance_minutes ?? globalTolerance;
    
    const isWithinSchedule = currentMin >= (startMin - toleranceMinutes) && currentMin <= (endMin + toleranceMinutes);

    // Check overtime approval for today
    let overtimeRequest = null;
    let hasOvertimeApproval = false;
    try {
      const otRes = await query(
        `SELECT id, status, requested_start, requested_end FROM overtime_requests WHERE employee_id = $1 AND request_date = $2 ORDER BY created_at DESC LIMIT 1`,
        [empId, today]
      );
      overtimeRequest = otRes.rows[0] || null;
      hasOvertimeApproval = overtimeRequest?.status === 'aprovado';
    } catch (e) { if (e.code !== '42P01' && e.code !== '42703') throw e; }

    // Determine active/next route
    const activeRoute = todayRoutes.find(r => r.status === 'in_progress');
    const nextRoute = !activeRoute ? todayRoutes.find(r => r.status === 'scheduled' || r.status === 'confirmed') : null;
    const completedRoutes = todayRoutes.filter(r => r.status === 'completed');
    const pendingRoutes = todayRoutes.filter(r => r.status === 'scheduled' || r.status === 'confirmed');
    const hasRoutesToday = todayRoutes.length > 0;

    res.json({
      employee: employee.rows[0],
      today_punches: punches.rows,
      pending_docs_count: parseInt(pendingDocs.rows[0]?.count || '0'),
      notifications: notifications.rows,
      daily_assignment: assignment.rows[0] || null,
      available_pdvs: pdvs,
      settings: settings.rows[0] || { theme: 'auto' },
      // Route data
      today_routes: todayRoutes,
      active_route: activeRoute || null,
      next_route: nextRoute || null,
      completed_routes_count: completedRoutes.length,
      pending_routes_count: pendingRoutes.length,
      has_routes_today: hasRoutesToday,
      pdv_visits: pdvVisits,
      schedule_status: {
        work_schedule: `${scheduleStart}-${scheduleEnd}`,
        schedule_start: scheduleStart,
        schedule_end: scheduleEnd,
        is_within_schedule: isWithinSchedule,
        has_overtime_approval: hasOvertimeApproval,
        overtime_request: overtimeRequest,
      },
    });
  } catch (err) {
    logError('promotor.home', err);
    res.status(500).json({ error: 'Erro ao carregar home' });
  }
});

// =============================================
// PROMOTOR: BATER PONTO
// =============================================
router.post('/punch', authenticatePromotor, async (req, res) => {
  try {
    const { punch_type, latitude, longitude, accuracy_meters, pdv_id, is_offline, offline_local_time, justification, local_id, facial_verified } = req.body;

    // ===== WORK SCHEDULE VALIDATION =====
    const empRes = await query(`SELECT work_schedule, face_descriptor, facial_required, punch_tolerance_minutes, punch_requires_checkin, punch_without_active_route FROM employees WHERE id = $1`, [req.employeeId]);
    const employee = empRes.rows[0];

    // CRITICAL: Database-side NOW() and America/Sao_Paulo context
    // We strictly use NOW() in DB to avoid any drift from app-server JS time
    const timeInfoRes = await query(`
      SELECT 
        (NOW() AT TIME ZONE 'America/Sao_Paulo')::date as today,
        (EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')) * 60 + EXTRACT(MINUTE FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))) as current_minutes,
        TO_CHAR(NOW() AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') as current_time_str
    `);
    
    const today = timeInfoRes.rows[0].today.toISOString().split('T')[0];
    const currentMinutes = Math.floor(timeInfoRes.rows[0].current_minutes);
    const currentTimeStr = timeInfoRes.rows[0].current_time_str;

    // Use a date object for is_offline fallback if provided, but standard punch uses DB time
    const now = is_offline && offline_local_time ? new Date(offline_local_time) : new Date();

    // ===== PERMISSÕES DE AÇÕES (Novas flags do perfil do colaborador)
    // 1. Verificar rota ativa (se punch_without_active_route = false, precisa ter rota hoje)
    if (!employee?.punch_without_active_route) {
      try {
        const todayRoutes = await query(
          `SELECT COUNT(*) as cnt FROM merch_routes WHERE promoter_id = $1 AND visit_date = $2 AND status NOT IN ('cancelled','canceled')`,
          [req.employeeId, today]
        );
        const hasDailyAssignment = await query(
          `SELECT COUNT(*) as cnt FROM collaborator_daily_assignments WHERE employee_id = $1 AND assignment_date = $2`,
          [req.employeeId, today]
        );
        const hasLinkedPdvs = await query(
          `SELECT COUNT(*) as cnt FROM collaborator_pdvs cp JOIN pdvs p ON p.id = cp.pdv_id WHERE cp.employee_id = $1 AND cp.active = true`,
          [req.employeeId]
        );
        const routeCount = parseInt(todayRoutes.rows[0]?.cnt || 0);
        const assignCount = parseInt(hasDailyAssignment.rows[0]?.cnt || 0);
        const pdvCount = parseInt(hasLinkedPdvs.rows[0]?.cnt || 0);
        if (routeCount === 0 && assignCount === 0 && pdvCount === 0) {
          return res.status(403).json({
            error: 'Você não tem rota ativa hoje. Contate o RH/supervisor para liberar seu ponto.',
            code: 'NO_ACTIVE_ROUTE'
          });
        }
      } catch (e) { /* ignore missing tables */ }
    }

    // 2. Verificar check-in obrigatório (se punch_requires_checkin = true, precisa ter feito check-in num PDV)
    if (employee?.punch_requires_checkin) {
      try {
        const visitCheckins = await query(
          `SELECT COUNT(*) as cnt FROM pdv_visits WHERE promoter_id = $1 AND visit_date = $2 AND checkin_at IS NOT NULL AND checkout_at IS NULL`,
          [req.employeeId, today]
        );
        const routeCheckins = await query(
          `SELECT COUNT(*) as cnt FROM merch_routes WHERE promoter_id = $1 AND visit_date = $2 AND status = 'in_progress' AND checkin_at IS NOT NULL`,
          [req.employeeId, today]
        );
        const visitCount = parseInt(visitCheckins.rows[0]?.cnt || 0);
        const routeCountCI = parseInt(routeCheckins.rows[0]?.cnt || 0);
        if (visitCount === 0 && routeCountCI === 0) {
          return res.status(403).json({
            error: 'Faça o check-in numa loja antes de bater o ponto.',
            code: 'CHECKIN_REQUIRED_BEFORE_PUNCH'
          });
        }
      } catch (e) { /* ignore missing tables */ }
    }
    
    // 1. Check for specific daily assignment (Escala) or recurring schedule first
    let scheduleStart = null, scheduleEnd = null;
    try {
      // Prioritize daily assignment (highest priority)
      const assignment = await query(
        `SELECT shift_start, shift_end FROM collaborator_daily_assignments
         WHERE employee_id = $1 AND assignment_date = $2 LIMIT 1`,
        [req.employeeId, today]
      );
      if (assignment.rows[0]?.shift_start && assignment.rows[0]?.shift_end) {
        scheduleStart = assignment.rows[0].shift_start;
        scheduleEnd = assignment.rows[0].shift_end;
      } else {
        // Check for recurring work schedule (Escala recorrente)
        const dowMap = { 0: 'dom', 1: 'seg', 2: 'ter', 3: 'qua', 4: 'qui', 5: 'sex', 6: 'sab' };
        const dowRes = await query("SELECT EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Sao_Paulo')) as dow");
        const dayOfWeek = dowMap[Math.floor(dowRes.rows[0].dow)];
        const recurring = await query(
          `SELECT s.items FROM rh_employee_schedules es
           JOIN rh_schedules s ON s.id = es.schedule_id
           WHERE es.employee_id = $1 AND es.active = true
           ORDER BY es.created_at DESC`,
          [req.employeeId]
        );
        
        if (recurring.rows && recurring.rows.length > 0) {
          for (const row of recurring.rows) {
            if (row.items) {
              const items = row.items;
              const todaySchedule = Array.isArray(items) ? items.find(i => i.day === dayOfWeek) : null;
              if (todaySchedule && todaySchedule.entry && todaySchedule.exit) {
                scheduleStart = todaySchedule.entry;
                scheduleEnd = todaySchedule.exit;
                break;
              }
            }
          }
        }
      }
    } catch (e) { /* ignore table/column missing */ }

    // 2. Fallback to general work schedule (Jornada) - ONLY if no specific assignment or recurring schedule
    let schedStartStr = '08:00', schedEndStr = '17:00';
    if (!scheduleStart) {
      const wsRaw = empRes.rows[0]?.work_schedule || '08:00-17:00';
      try {
        const parsed = typeof wsRaw === 'object' ? wsRaw : (typeof wsRaw === 'string' && wsRaw.trim().startsWith('{') ? JSON.parse(wsRaw) : null);
        if (parsed && parsed.entry) { schedStartStr = parsed.entry; schedEndStr = parsed.exit || '17:00'; }
        else { const parts = String(wsRaw).split('-'); if (parts.length >= 2) { schedStartStr = parts[0].trim(); schedEndStr = parts[1].trim(); } }
      } catch { const parts = String(wsRaw).split('-'); if (parts.length >= 2) { schedStartStr = parts[0].trim(); schedEndStr = parts[1].trim(); } }
      scheduleStart = schedStartStr;
      scheduleEnd = schedEndStr;
    } else {
      console.log(`[Promotor Punch] Using schedule from SCALE: ${scheduleStart}-${scheduleEnd}`);
    }

    const parseToMin = (str) => {
      if (!str || typeof str !== 'string') return 0;
      const parts = str.split(':');
      if (parts.length < 2) return 0;
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    };

    const scheduleStartMin = parseToMin(scheduleStart) || 480;
    const scheduleEndMin = parseToMin(scheduleEnd) || 1020;

    // Tolerance priority: Employee > Organization > Default(15)
    let tolerance = 15;
    
    if (empRes.rows[0]?.punch_tolerance_minutes !== null && empRes.rows[0]?.punch_tolerance_minutes !== undefined) {
      tolerance = parseInt(empRes.rows[0].punch_tolerance_minutes);
    } else {
      try {
        const orgRes = await query(`SELECT work_schedule FROM organizations WHERE id = $1`, [req.organizationId]);
        if (orgRes.rows[0]?.work_schedule) {
          const sched = typeof orgRes.rows[0].work_schedule === 'string' 
            ? JSON.parse(orgRes.rows[0].work_schedule) 
            : orgRes.rows[0].work_schedule;
          if (sched.punch_tolerance_minutes !== undefined) {
            tolerance = parseInt(sched.punch_tolerance_minutes);
          }
        }
      } catch (e) {
        console.error('[Promotor Punch] Error reading org tolerance:', e);
      }
    }

    const toleranceBefore = tolerance;
    const toleranceAfter = tolerance;


    const isWithinSchedule = currentMinutes >= (scheduleStartMin - toleranceBefore) && currentMinutes <= (scheduleEndMin + toleranceAfter);

    if (!isWithinSchedule) {
      // Check for approved overtime request for today
      const otReq = await query(
        `SELECT id, requested_start, requested_end FROM overtime_requests
         WHERE employee_id = $1 AND request_date = $2 AND status = 'aprovado'
         ORDER BY created_at DESC LIMIT 1`,
        [req.employeeId, today]
      );

      if (!otReq.rows[0]) {
        return res.status(403).json({
          error: `Fora do horário de trabalho (${scheduleStart} - ${scheduleEnd}). Solicite autorização de hora extra ao supervisor.`,
          code: 'OUTSIDE_SCHEDULE',
          schedule: { start: scheduleStart, end: scheduleEnd },
          current_time: currentTimeStr
        });
      }

      // Check if overtime window covers current time
      const otStart = otReq.rows[0].requested_start;
      const otEnd = otReq.rows[0].requested_end;
      if (otStart && otEnd) {
        const otStartMin = otStart.split(':').reduce((h, m) => parseInt(h) * 60 + parseInt(m), 0);
        const otEndMin = otEnd.split(':').reduce((h, m) => parseInt(h) * 60 + parseInt(m), 0);
        if (currentMinutes < otStartMin - 15 || currentMinutes > otEndMin + 15) {
          return res.status(403).json({
            error: `Hora extra aprovada apenas de ${otStart} a ${otEnd}.`,
            code: 'OUTSIDE_OVERTIME_WINDOW'
          });
        }
      }
    }

    // ===== FACIAL VALIDATION =====
    try {
      const facialCfg = await query(
        `SELECT enabled, use_for_attendance, allow_manual_fallback
         FROM facial_recognition_config
         WHERE organization_id = $1
         LIMIT 1`,
        [req.organizationId]
      );

      const cfg = facialCfg.rows[0];
      const empOverride = empRes.rows[0]?.facial_required; // true|false|null
      const rawDescriptor = empRes.rows[0]?.face_descriptor;
      const parsedDescriptor = typeof rawDescriptor === 'string'
        ? JSON.parse(rawDescriptor)
        : rawDescriptor;
      const hasEnrollment = Array.isArray(parsedDescriptor)
        ? parsedDescriptor.length > 0
        : Array.isArray(parsedDescriptor?.descriptor)
          ? parsedDescriptor.descriptor.length > 0
          : false;

      // Override por colaborador: false => dispensado; true => sempre exigir
      // null => segue config da organização
      const orgRequires = !!(cfg?.enabled && cfg?.use_for_attendance);
      const facialRequired = empOverride === false ? false : (empOverride === true ? true : orgRequires);

      if (facialRequired && !hasEnrollment && cfg?.allow_manual_fallback === false) {
        return res.status(403).json({
          error: 'Biometria facial obrigatória, mas este colaborador ainda não possui cadastro facial.',
          code: 'FACIAL_ENROLLMENT_REQUIRED'
        });
      }

      // Check for facial_verified or bypass if no enrollment yet and allowed
      if (facialRequired && hasEnrollment && (facial_verified === undefined || facial_verified === false)) {
        return res.status(403).json({
          error: 'Confirmação facial obrigatória para registrar o ponto.',
          code: 'FACIAL_REQUIRED'
        });
      }

    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    // ===== GEO VALIDATION (polygon-first, radius fallback) =====
    
    await ensurePdvGeofenceColumn(query);
    let distance = null;
    let geo_status = 'sem_gps';
    let geoLastPdvMeta = null;

    if (latitude && longitude && pdv_id) {
      const pdv = await query(`SELECT p.id, p.name, p.type, p.latitude, p.longitude, p.radius_meters, p.geofence_polygon
                                FROM pdvs p WHERE p.id = $1`, [pdv_id]);
      if (pdv.rows[0]) {
        const p = pdv.rows[0];
        const v = validatePdvLocation({
          userLat: latitude, userLng: longitude,
          pdvLat: p.latitude, pdvLng: p.longitude,
          radiusMeters: p.radius_meters,
          polygon: p.geofence_polygon,
        });
        distance = v.distance != null ? Math.round(v.distance) : null;
        geoLastPdvMeta = {
          id: p.id,
          name: p.name || null,
          type: p.type === 'sede' ? 'sede' : 'pdv',
          mode: v.mode === 'polygon' ? 'polygon' : 'radius',
          radius_meters: p.radius_meters != null ? Number(p.radius_meters) : null,
          distance_meters: distance,
        };
        if (v.status === 'inside') geo_status = 'dentro_area';
        else if (v.status === 'outside') geo_status = 'fora_area';
        else geo_status = 'sem_gps';
      }
    } else if (latitude && longitude) {
      geo_status = 'sem_pdv';
    }

    if (geo_status === 'fora_area') {
      const rules = await query(
        `SELECT allow_exception_punch FROM time_rules WHERE organization_id = $1 AND (employee_id = $2 OR employee_id IS NULL) ORDER BY employee_id NULLS LAST LIMIT 1`,
        [req.organizationId, req.employeeId]
      );
      const allowException = rules.rows[0]?.allow_exception_punch === true;
      if (!allowException && !justification) {
        const meta = geoLastPdvMeta || {};
        let dist = '';
        if (meta.distance_meters != null) {
          if (meta.distance_meters >= 1000) {
            const km = (meta.distance_meters / 1000).toFixed(1).replace('.', ',');
            dist = ` (você está a ~${km} km do local)`;
          } else {
            dist = ` (você está a ~${meta.distance_meters} m do local)`;
          }
        }
        const placeShort = meta.type === 'sede'
          ? 'na Sede cadastrada'
          : `no PDV selecionado${meta.name ? ` (${meta.name})` : ''}`;
        const hasOrgHeadquarters = await query(
          `SELECT 1 FROM pdvs WHERE organization_id=$1 AND type='sede' AND (latitude IS NOT NULL OR geofence_polygon IS NOT NULL) LIMIT 1`,
          [req.organizationId]
        ).catch(() => ({ rows: [] }));
        const hasLinkedSede = await query(
          `SELECT 1 FROM employees e
           JOIN pdvs p ON p.id = e.branch_id OR p.id = e.pdv_id
           WHERE e.id=$1 AND p.type='sede' AND (p.latitude IS NOT NULL OR p.geofence_polygon IS NOT NULL) LIMIT 1`,
          [req.employeeId]
        ).catch(() => ({ rows: [] }));
        const sedeExtra = meta.type !== 'sede' && (hasOrgHeadquarters.rows.length > 0 || hasLinkedSede.rows.length > 0)
          ? ' ou na Sede da empresa'
          : '';
        const modeText = meta.mode === 'polygon'
          ? 'Perímetro (polígono geográfico) do local.'
          : 'Raio (em metros) do local.';
        return res.status(400).json({
          error: `Você precisa estar ${placeShort}${sedeExtra} dentro da área permitida para bater o ponto.${dist}`,
          error_code: 'GEO_OUT_OF_RANGE',
          geo_status,
          distance,
          details: {
            place_type: meta.type,
            place_name: meta.name,
            mode: meta.mode,
            mode_hint: modeText,
            distance_meters: meta.distance_meters,
            radius_meters: meta.radius_meters,
            user_coords: { latitude, longitude },
            accept_justification: allowException,
          },
        });
      }
      if (justification) geo_status = 'excecao';
    }

    // CRITICAL FIX: Explicitly force America/Sao_Paulo session and fetch DB NOW()
    await query("SET timezone = 'America/Sao_Paulo'");
    const nowBrResult = await query("SELECT NOW() as now_br");
    const nowBr = nowBrResult.rows[0].now_br;

    // Use Brazil/Sao Paulo timezone for "now"
    const punchedAt = is_offline && offline_local_time ? new Date(offline_local_time) : nowBr;

    const result = await query(
      `INSERT INTO time_punches (
        organization_id, employee_id, punch_type, punched_at, latitude, longitude, accuracy_meters, 
        pdv_id, distance_from_pdv, geo_status, device_info, ip_address, is_offline, 
        offline_local_time, sync_status, justification, adjustment_reason
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, 'Live BR Time Fix') RETURNING *`,
      [req.organizationId, req.employeeId, punch_type, punchedAt,
        latitude, longitude, accuracy_meters, pdv_id || null, distance, geo_status,
        req.headers['user-agent'], req.ip, is_offline || false, offline_local_time || null,
        'synced', justification || null]
    );

    if (geo_status === 'fora_area' || geo_status === 'excecao') {
      await query(
        `INSERT INTO time_alerts (organization_id, employee_id, alert_type, alert_date, description) VALUES ($1,$2,'fora_pdv',$3,$4)`,
        [req.organizationId, req.employeeId, new Date().toISOString().slice(0,10), `Ponto registrado ${Math.round(distance)}m do PDV (${geo_status})`]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    logError('promotor.punch', err);
    res.status(500).json({ error: 'Erro ao registrar ponto' });
  }
});

// =============================================
// PROMOTOR: SOLICITAR HORA EXTRA
// =============================================
router.post('/overtime-request', authenticatePromotor, async (req, res) => {
  try {
    const { reason, request_date, requested_start, requested_end } = req.body;
    if (!reason) return res.status(400).json({ error: 'Informe o motivo da hora extra' });
    const date = request_date || new Date().toISOString().slice(0, 10);

    // Check for existing pending request
    const existing = await query(
      `SELECT id FROM overtime_requests WHERE employee_id = $1 AND request_date = $2 AND status = 'pendente'`,
      [req.employeeId, date]
    );
    if (existing.rows[0]) {
      return res.status(400).json({ error: 'Já existe uma solicitação pendente para esta data' });
    }

    const result = await query(
      `INSERT INTO overtime_requests (organization_id, employee_id, request_date, reason, requested_start, requested_end)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.organizationId, req.employeeId, date, reason, requested_start || null, requested_end || null]
    );

    // Notify supervisor + all RH admins/owners
    const emp = await query(`SELECT full_name, direct_manager_id FROM employees WHERE id = $1`, [req.employeeId]);
    const empName = emp.rows[0]?.full_name || 'Colaborador';
    const notifTitle = 'Solicitação de Hora Extra';
    const notifMsg = `${empName} solicitou hora extra para ${date}: ${reason}`;

    // Collect unique employee IDs to notify
    const notifyIds = new Set();
    if (emp.rows[0]?.direct_manager_id) notifyIds.add(emp.rows[0].direct_manager_id);

    // Find all admin/owner users in the org and their employee records
    try {
      const admins = await query(
        `SELECT e.id FROM employees e
         JOIN users u ON u.id = e.user_id
         WHERE e.organization_id = $1 AND u.role IN ('owner','admin')`,
        [req.organizationId]
      );
      admins.rows.forEach(r => notifyIds.add(r.id));
    } catch (e) { /* ignore */ }

    // Send notifications to all
    for (const targetId of notifyIds) {
      await query(
        `INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type)
         VALUES ($1,$2,$3,$4,'overtime_request')`,
        [req.organizationId, targetId, notifTitle, notifMsg]
      ).catch(() => {});
    }

    res.json(result.rows[0]);
  } catch (err) {
    logError('promotor.overtime-request', err);
    res.status(500).json({ error: 'Erro ao solicitar hora extra' });
  }
});

// =============================================
// PROMOTOR: MINHAS SOLICITAÇÕES DE HORA EXTRA
// =============================================
router.get('/overtime-requests', authenticatePromotor, async (req, res) => {
  try {
    const r = await query(
      `SELECT ot.*, e.full_name as approved_by_name
       FROM overtime_requests ot
       LEFT JOIN employees e ON e.id = ot.approved_by
       WHERE ot.employee_id = $1
       ORDER BY ot.created_at DESC LIMIT 30`,
      [req.employeeId]
    );
    res.json(r.rows);
  } catch (err) {
    logError('promotor.overtime-requests', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// RH/SUPERVISOR: LISTAR SOLICITAÇÕES DE HORA EXTRA
// =============================================
router.get('/rh/overtime-requests', async (req, res) => {
  try {
    const orgId = await resolveOrganizationId(req);
    if (!orgId) return res.json([]);

    const { status, employee_id } = req.query;
    let sql = `SELECT ot.*, e.full_name as employee_name, e.position, e.work_schedule, ap.full_name as approved_by_name
      FROM overtime_requests ot
      JOIN employees e ON e.id = ot.employee_id
      LEFT JOIN employees ap ON ap.id = ot.approved_by
      WHERE ot.organization_id = $1`;
    const params = [orgId];
    if (status) { sql += ` AND ot.status = $${params.length + 1}`; params.push(status); }
    if (employee_id) { sql += ` AND ot.employee_id = $${params.length + 1}`; params.push(employee_id); }
    sql += ` ORDER BY ot.created_at DESC LIMIT 100`;
    res.json((await query(sql, params)).rows);
  } catch (err) {
    logError('rh.overtime-requests', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// RH/SUPERVISOR: APROVAR/RECUSAR HORA EXTRA
// =============================================
router.put('/rh/overtime-requests/:id', async (req, res) => {
  try {
    const { status, supervisor_notes } = req.body;
    if (!['aprovado', 'recusado'].includes(status)) return res.status(400).json({ error: 'Status inválido' });

    // Get supervisor employee id
    const supEmp = await query(`SELECT id FROM employees WHERE user_id = $1 LIMIT 1`, [req.userId]);
    const approvedBy = supEmp.rows[0]?.id || null;

    const result = await query(
      `UPDATE overtime_requests SET status = $1, supervisor_notes = $2, approved_by = $3, approved_at = NOW() WHERE id = $4 RETURNING *`,
      [status, supervisor_notes || null, approvedBy, req.params.id]
    );

    // Notify employee
    if (result.rows[0]) {
      const ot = result.rows[0];
      const statusLabel = status === 'aprovado' ? '✅ Aprovada' : '❌ Recusada';
      await query(
        `INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type)
         VALUES ($1,$2,$3,$4,'overtime_response')`,
        [ot.organization_id, ot.employee_id,
         `Hora Extra ${statusLabel}`,
         `Sua solicitação para ${ot.request_date} foi ${status}. ${supervisor_notes || ''}`]
      ).catch(() => {});
    }

    res.json(result.rows[0]);
  } catch (err) {
    logError('rh.overtime-approve', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// PROMOTOR: HISTÓRICO DE PONTO
// =============================================
router.get('/punches', authenticatePromotor, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let sql = `SELECT tp.*, p.name as pdv_name FROM time_punches tp LEFT JOIN pdvs p ON p.id = tp.pdv_id WHERE tp.employee_id = $1`;
    const params = [req.employeeId];
    let idx = 2;
    if (start_date) { sql += ` AND tp.punched_at::date >= $${idx++}`; params.push(start_date); }
    if (end_date) { sql += ` AND tp.punched_at::date <= $${idx++}`; params.push(end_date); }
    sql += ` ORDER BY tp.punched_at DESC LIMIT 200`;
    res.json((await query(sql, params)).rows);
  } catch (err) {
    logError('promotor.punches', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// PROMOTOR: MEUS DOCUMENTOS
// =============================================
router.get('/documents', authenticatePromotor, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT dd.*, dt.name as type_name FROM rh_document_deliveries dd LEFT JOIN rh_document_types dt ON dt.id = dd.document_type_id WHERE dd.employee_id = $1`;
    const params = [req.employeeId];
    if (status) { sql += ` AND dd.status = $2`; params.push(status); }
    sql += ` ORDER BY dd.created_at DESC`;
    res.json((await query(sql, params)).rows);
  } catch (err) {
    logError('promotor.documents', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// PROMOTOR: CONFIRMAR RECEBIMENTO / VISUALIZAÇÃO
// =============================================
router.post('/documents/:id/view', authenticatePromotor, async (req, res) => {
  try {
    const { id } = req.params;
    await query(`UPDATE rh_document_deliveries SET status = CASE WHEN status IN ('enviado','entregue') THEN 'visualizado' ELSE status END, viewed_at = COALESCE(viewed_at, NOW()), ip_at_view = $2, device_at_view = $3, updated_at = NOW() WHERE id = $1 AND employee_id = $4`,
      [id, req.ip, req.headers['user-agent'], req.employeeId]);
    await query(`INSERT INTO rh_document_delivery_events (delivery_id, event_type, actor_type, ip_address, device_info) VALUES ($1, 'visualizado', 'colaborador', $2, $3)`, [id, req.ip, req.headers['user-agent']]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/documents/:id/confirm', authenticatePromotor, async (req, res) => {
  try {
    const { id } = req.params;
    await query(`UPDATE rh_document_deliveries SET status = 'confirmado', confirmed_at = NOW(), updated_at = NOW() WHERE id = $1 AND employee_id = $2`, [id, req.employeeId]);
    await query(`INSERT INTO rh_document_delivery_events (delivery_id, event_type, actor_type, ip_address) VALUES ($1, 'confirmado', 'colaborador', $2)`, [id, req.ip]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/documents/:id/refuse', authenticatePromotor, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    await query(`UPDATE rh_document_deliveries SET status = 'recusado', refused_at = NOW(), refuse_reason = $3, updated_at = NOW() WHERE id = $1 AND employee_id = $2`, [id, req.employeeId, reason]);
    await query(`INSERT INTO rh_document_delivery_events (delivery_id, event_type, actor_type, notes) VALUES ($1, 'recusado', 'colaborador', $2)`, [id, reason]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// PROMOTOR: ENVIAR DOCUMENTO AO RH (upload reverso)
// =============================================
router.post('/inbound-documents', authenticatePromotor, async (req, res) => {
  try {
    const { category, title, file_url, observation } = req.body;
    const result = await query(
      `INSERT INTO rh_inbound_documents (organization_id, employee_id, category, title, file_url, observation, ip_address, device_info) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.organizationId, req.employeeId, category, title || category, file_url, observation, req.ip, req.headers['user-agent']]
    );
    // Notify RH
    await query(`INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type, reference_type, reference_id) SELECT $1, e.id, 'Documento recebido do colaborador', $3, 'document', 'inbound', $4 FROM employees e WHERE e.organization_id = $1 AND e.worker_profile IN ('administrativo','supervisor') LIMIT 5`,
      [req.organizationId, req.employeeId, `${category} enviado`, result.rows[0].id]);
    res.json(result.rows[0]);
  } catch (err) {
    logError('promotor.inbound-doc', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.get('/inbound-documents', authenticatePromotor, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM rh_inbound_documents WHERE employee_id = $1 ORDER BY created_at DESC`, [req.employeeId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// PROMOTOR: HOLERITES
// =============================================
router.get('/payslips', authenticatePromotor, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, pd.delivery_status, pd.viewed_at, pd.signed_at FROM payslips p LEFT JOIN payslip_deliveries pd ON pd.payslip_id = p.id AND pd.employee_id = $1 WHERE p.employee_id = $1 AND p.status IN ('gerado','pago') ORDER BY p.reference_month DESC`,
      [req.employeeId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// PROMOTOR: ESPELHO DE PONTO
// =============================================
router.get('/timesheets', authenticatePromotor, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM timesheet_exports WHERE employee_id = $1 AND status IN ('enviado', 'concluido') ORDER BY reference_month DESC`,
      [req.employeeId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// PROMOTOR: NOTIFICAÇÕES
// =============================================
router.get('/notifications', authenticatePromotor, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM collaborator_notifications WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.employeeId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/notifications/:id/read', authenticatePromotor, async (req, res) => {
  try {
    await query(`UPDATE collaborator_notifications SET read = true, read_at = NOW() WHERE id = $1 AND employee_id = $2`, [req.params.id, req.employeeId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// PROMOTOR: CONFIGURAÇÕES
// =============================================
router.get('/settings', authenticatePromotor, async (req, res) => {
  try {
    let result = await query(`SELECT * FROM collaborator_app_settings WHERE employee_id = $1`, [req.employeeId]);
    if (!result.rows[0]) {
      result = await query(`INSERT INTO collaborator_app_settings (employee_id) VALUES ($1) RETURNING *`, [req.employeeId]);
    }
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.put('/settings', authenticatePromotor, async (req, res) => {
  try {
    const { theme, notifications_enabled } = req.body;
    const result = await query(
      `INSERT INTO collaborator_app_settings (employee_id, theme, notifications_enabled) VALUES ($1,$2,$3) ON CONFLICT (employee_id) DO UPDATE SET theme=EXCLUDED.theme, notifications_enabled=EXCLUDED.notifications_enabled, updated_at=NOW() RETURNING *`,
      [req.employeeId, theme || 'auto', notifications_enabled !== false]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// PROMOTOR: BIOMETRIA FACIAL (auto-cadastro pelo colaborador)
// =============================================
async function ensurePromotorFaceColumns() {
  try {
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS face_descriptor JSONB`);
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS face_photo_url TEXT`);
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS face_enrolled_at TIMESTAMPTZ`);
  } catch {}
}

router.get('/face-enrollment', authenticatePromotor, async (req, res) => {
  try {
    await ensurePromotorFaceColumns();
    const r = await query(
      `SELECT face_enrolled_at, face_photo_url, (face_descriptor IS NOT NULL) AS enrolled
         FROM employees WHERE id = $1`,
      [req.employeeId]
    );
    const row = r.rows[0] || {};
    res.json({
      enrolled: !!row.enrolled,
      face_photo_url: row.face_photo_url || null,
      face_enrolled_at: row.face_enrolled_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar status da biometria' });
  }
});

router.post('/face-enrollment', authenticatePromotor, async (req, res) => {
  try {
    await ensurePromotorFaceColumns();
    const { descriptor, landmarks, imageDataUrl, geometricProfile, selfTestScore } = req.body || {};

    if (!Array.isArray(descriptor) || descriptor.length < 64) {
      return res.status(400).json({ error: 'Descriptor facial inválido' });
    }
    if (typeof selfTestScore === 'number' && selfTestScore < 70) {
      return res.status(400).json({ error: 'Validação facial não atingiu a pontuação mínima' });
    }

    // Bloqueio: não permitir troca após cadastro aprovado
    const existing = await query(
      `SELECT face_descriptor, face_enrolled_at, organization_id FROM employees WHERE id = $1`,
      [req.employeeId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Colaborador não encontrado' });
    if (existing.rows[0].face_descriptor && existing.rows[0].face_enrolled_at) {
      return res.status(403).json({ error: 'Biometria já cadastrada. Procure o RH para alterar.' });
    }

    const faceData = { descriptor, landmarks: landmarks || [], geometricProfile: geometricProfile || {} };
    await query(
      `UPDATE employees SET face_descriptor = $1, face_photo_url = $2, face_enrolled_at = NOW() WHERE id = $3`,
      [JSON.stringify(faceData), imageDataUrl || null, req.employeeId]
    );

    try {
      await query(
        `INSERT INTO face_verification_logs
           (organization_id, employee_id, verification_context, confidence_score, result, captured_image_url)
         VALUES ($1, $2, 'self_enrollment', $3, 'approved', $4)`,
        [existing.rows[0].organization_id, req.employeeId, selfTestScore || 100, imageDataUrl || null]
      );
    } catch {}

    res.json({ success: true, enrolled: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao salvar biometria' });
  }
});

// =============================================
// PROMOTOR: SYNC OFFLINE QUEUE
// =============================================
router.post('/sync', authenticatePromotor, async (req, res) => {
  try {
    const { events } = req.body; // Array of offline events
    const results = [];
    for (const ev of (events || [])) {
      try {
        if (ev.action_type === 'time_punch') {
          const punch = await query(
            `INSERT INTO time_punches (organization_id, employee_id, punch_type, punched_at, latitude, longitude, accuracy_meters, pdv_id, is_offline, offline_local_time, sync_status, device_info, ip_address)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,'synced',$10,$11) RETURNING id`,
            [req.organizationId, req.employeeId, ev.payload.punch_type, ev.payload.offline_local_time || ev.local_timestamp,
              ev.payload.latitude, ev.payload.longitude, ev.payload.accuracy_meters, ev.payload.pdv_id,
              ev.local_timestamp, req.headers['user-agent'], req.ip]
          );
          results.push({ local_id: ev.local_id, server_id: punch.rows[0].id, status: 'synced' });
        } else if (ev.action_type === 'confirm_receipt') {
          await query(`UPDATE rh_document_deliveries SET status = 'confirmado', confirmed_at = NOW() WHERE id = $1`, [ev.payload.delivery_id]);
          results.push({ local_id: ev.local_id, status: 'synced' });
        } else if (ev.action_type === 'view_document') {
          await query(`UPDATE rh_document_deliveries SET viewed_at = COALESCE(viewed_at, NOW()), status = CASE WHEN status IN ('enviado','entregue') THEN 'visualizado' ELSE status END WHERE id = $1`, [ev.payload.delivery_id]);
          results.push({ local_id: ev.local_id, status: 'synced' });
        } else {
          results.push({ local_id: ev.local_id, status: 'unknown_action' });
        }
      } catch (e) {
        results.push({ local_id: ev.local_id, status: 'failed', error: e.message });
      }
    }
    res.json({ results });
  } catch (err) {
    logError('promotor.sync', err);
    res.status(500).json({ error: 'Erro na sincronização' });
  }
});

// =============================================
// RH: GERENCIAR ACESSO AO APP (autenticado como RH)
// =============================================
router.use('/rh', authenticate);

router.post('/rh/grant-access', async (req, res) => {
  try {
    const { employee_id, password, login_type, force_change } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await query(
      `INSERT INTO collaborator_app_access (employee_id, login_type, password_hash, temp_password, force_password_change, access_status, enabled_at, enabled_by)
       VALUES ($1,$2,$3,true,$4,'liberado',NOW(),$5)
       ON CONFLICT (employee_id) DO UPDATE SET password_hash=$3, temp_password=true, force_password_change=$4, access_status='liberado', enabled_at=NOW(), enabled_by=$5, updated_at=NOW()`,
      [employee_id, login_type || 'cpf', hash, force_change !== false, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    logError('promotor.grant-access', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.post('/rh/block-access', async (req, res) => {
  try {
    await query(`UPDATE collaborator_app_access SET access_status = 'bloqueado', updated_at = NOW() WHERE employee_id = $1`, [req.body.employee_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/reset-password', async (req, res) => {
  try {
    const { employee_id, new_password } = req.body;
    const hash = await bcrypt.hash(new_password, 10);
    await query(`UPDATE collaborator_app_access SET password_hash = $2, temp_password = true, force_password_change = true, updated_at = NOW() WHERE employee_id = $1`, [employee_id, hash]);
    await query(`INSERT INTO collaborator_password_resets (employee_id, reset_by, reset_by_user_id, ip_address) VALUES ($1, 'rh', $2, $3)`, [employee_id, req.userId, req.ip]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.get('/rh/app-access', async (req, res) => {
  try {
    const { employee_id } = req.query;
    if (employee_id) {
      const result = await query(`SELECT employee_id, login_type, temp_password, force_password_change, access_status, enabled_at, last_login, last_device FROM collaborator_app_access WHERE employee_id = $1`, [employee_id]);
      return res.json(result.rows[0] || null);
    }
    res.json(null);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// RH: PDVs
// =============================================
router.get('/rh/pdvs', async (req, res) => {
  try {
    const orgId = req.query.org_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const result = await query(`SELECT p.*, e.full_name as supervisor_name FROM pdvs p LEFT JOIN employees e ON e.id = p.supervisor_id WHERE p.organization_id = $1 ORDER BY p.name`, [orgId]);
    res.json(result.rows);
  } catch (err) { logError('promotor.pdvs.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/pdvs', async (req, res) => {
  try {
    const orgId = req.body.organization_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const d = req.body;
    // Auto-geocode if no lat/lng provided but address exists
    let lat = d.latitude, lng = d.longitude;
    if ((!lat || !lng) && (d.address || d.city)) {
      try {
        const geo = await autoGeocode(d.address, d.city, d.state, d.zip_code, d.neighborhood, d.address_number, d.complement);
        if (geo) { lat = geo.lat; lng = geo.lng; }
      } catch (_) {}
    }
    
    await ensurePdvGeofenceColumn(query);
    const polygon = Array.isArray(d.geofence_polygon) && d.geofence_polygon.length >= 3 ? JSON.stringify(d.geofence_polygon) : null;
    const result = await query(
      `INSERT INTO pdvs (organization_id, name, client_name, address, zip_code, city, state, neighborhood, latitude, longitude, radius_meters, supervisor_id, notes, geofence_polygon, type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb, $15) RETURNING *`,
      [orgId, d.name, d.client_name, d.address, d.zip_code, d.city, d.state, d.neighborhood, lat, lng, d.radius_meters || 200, d.supervisor_id || null, d.notes, polygon, d.type || 'pdv']
    );

    res.json(result.rows[0]);
  } catch (err) { logError('promotor.pdvs.create', err); res.status(500).json({ error: 'Erro' }); }
});

router.put('/rh/pdvs/:id', async (req, res) => {
  try {
    const d = req.body;
    // Auto-geocode if no lat/lng provided but address exists
    let lat = d.latitude, lng = d.longitude;
    if ((!lat || !lng) && (d.address || d.city)) {
      try {
        const geo = await autoGeocode(d.address, d.city, d.state, d.zip_code, d.neighborhood, d.address_number, d.complement);
        if (geo) { lat = geo.lat; lng = geo.lng; }
      } catch (_) {}
    }
    
    await ensurePdvGeofenceColumn(query);
    const polygon = Array.isArray(d.geofence_polygon) && d.geofence_polygon.length >= 3 ? JSON.stringify(d.geofence_polygon)
      : (d.geofence_polygon === null ? null : undefined);
    const result = await query(
      `UPDATE pdvs SET name=$2, client_name=$3, address=$4, zip_code=$5, city=$6, state=$7, neighborhood=$8, latitude=$9, longitude=$10, radius_meters=$11, supervisor_id=$12, notes=$13, active=$14,
        geofence_polygon = COALESCE($15::jsonb, geofence_polygon), type=$16, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, d.name, d.client_name, d.address, d.zip_code, d.city, d.state, d.neighborhood, lat, lng, d.radius_meters, d.supervisor_id || null, d.notes, d.active !== false, polygon ?? null, d.type || 'pdv']
    );

    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.delete('/rh/pdvs/:id', async (req, res) => {
  try {
    // Check if pdv has dependencies before deleting (optional, but good practice)
    // For now, let's just try to delete. If it has foreign keys, it will fail and we return error.
    await query('DELETE FROM pdvs WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    logError('promotor.pdvs.delete', err);
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Este PDV não pode ser excluído pois possui vínculos (visitas, roteiros ou colaboradores).' });
    }
    res.status(500).json({ error: 'Erro ao excluir PDV' });
  }
});

router.post('/rh/pdvs/import', async (req, res) => {
  try {
    const orgId = await resolveOrganizationId(req);
    if (!orgId) return res.status(401).json({ error: 'Organização não encontrada para o usuário' });

    if (!(await isOrgAdmin(req.userId, orgId))) {
      return res.status(403).json({ error: 'Apenas administradores podem importar PDVs' });
    }

    const { items } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Nenhum item enviado' });

    // Garante coluna network_id em pdvs (caso schema antigo)
    const hasNetworksTable = await tableExists('supermarket_networks');
    if (hasNetworksTable) {
      try {
        await query(`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS network_id UUID REFERENCES supermarket_networks(id) ON DELETE SET NULL`);
      } catch (_) {}
    }

    let created = 0, updated = 0, skipped = 0, networksCreated = 0;
    const networkCache = new Map(); // nome normalizado -> id

    const findOrCreateNetwork = async (rawName) => {
      const name = String(rawName || '').trim();
      if (!name || !hasNetworksTable) return null;
      const key = name.toLowerCase();
      if (networkCache.has(key)) return networkCache.get(key);
      const existing = await query(
        `SELECT id FROM supermarket_networks WHERE organization_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [orgId, name]
      );
      let id = existing.rows[0]?.id;
      if (!id) {
        const ins = await query(
          `INSERT INTO supermarket_networks (organization_id, name) VALUES ($1, $2) RETURNING id`,
          [orgId, name]
        );
        id = ins.rows[0].id;
        networksCreated++;
      }
      networkCache.set(key, id);
      return id;
    };

    for (const item of items) {
      try {
        const name = String(item.name || item.fantasia || '').trim();
        const cnpj = String(item.cnpj || '').replace(/\D/g, '');
        const redeName = String(item.rede || item.client_name || '').trim();
        const address = String(item.endereco || item.address || '').trim();
        const zipCode = String(item.cep || item.zip_code || '').replace(/\D/g, '');
        const city = String(item.cidade || item.city || '').trim();
        const state = String(item.estado || item.state || '').trim().substring(0, 2).toUpperCase();
        const neighborhood = String(item.bairro || item.neighborhood || '').trim();
        const externalCode = String(item.codigo || item.external_code || '').trim();

        if (!name) { skipped++; continue; }

        const networkId = await findOrCreateNetwork(redeName);

        let existing;
        try {
          existing = await query(
            `SELECT id FROM pdvs WHERE organization_id = $1 AND name = $2 LIMIT 1`,
            [orgId, name]
          );
        } catch (e) {
          console.error('Error checking existing PDV:', e);
          existing = { rows: [] };
        }

        if (existing.rows.length) {
          try {
            await query(
              `UPDATE pdvs SET 
                client_name = COALESCE(NULLIF($2, ''), client_name),
                address = COALESCE(NULLIF($3, ''), address),
                zip_code = COALESCE(NULLIF($4, ''), zip_code),
                city = COALESCE(NULLIF($5, ''), city),
                state = COALESCE(NULLIF($6, ''), state),
                neighborhood = COALESCE(NULLIF($7, ''), neighborhood),
                network_id = COALESCE($9, network_id),
                notes = COALESCE(notes, '') || CASE WHEN $8 <> '' THEN E'\nCód: ' || $8 ELSE '' END,
                updated_at = NOW()
               WHERE id = $1`,
              [existing.rows[0].id, redeName, address, zipCode, city, state, neighborhood, externalCode, networkId]
            );
          } catch (e) {
            console.error('Update PDV error:', e);
            skipped++;
            continue;
          }
          updated++;
        } else {
          let lat = null, lng = null;
          // Desativamos geocode automático pesado durante importação em lote para evitar 504 Gateway Timeout
          /* 
          try {
            const geo = await autoGeocode(address, city, state, zipCode, neighborhood);
            if (geo) { lat = geo.lat; lng = geo.lng; }
          } catch (_) {}
          */

          try {
            await query(
              `INSERT INTO pdvs (organization_id, name, client_name, address, zip_code, city, state, neighborhood, latitude, longitude, radius_meters, notes, network_id, cnpj)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,200,$11,$12,$13)`,
              [orgId, name, redeName, address, zipCode, city, state, neighborhood, lat, lng, externalCode ? `Cód: ${externalCode}` : null, networkId, cnpj]
            );
          } catch (e) {
            const msg = String(e.message || '').toLowerCase();
            if (msg.includes('cnpj') && (msg.includes('coluna') || msg.includes('column') || msg.includes('does not exist') || msg.includes('não existe'))) {
              await query(
                `INSERT INTO pdvs (organization_id, name, client_name, address, zip_code, city, state, neighborhood, latitude, longitude, radius_meters, notes, network_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,200,$11,$12)`,
                [orgId, name, redeName, address, zipCode, city, state, neighborhood, lat, lng, externalCode ? `Cód: ${externalCode}` : null, networkId]
              );
            } else {
              console.error('Insert error for PDV:', name, e.message);
              skipped++;
              continue;
            }
          }
          created++;
        }
      } catch (err) {
        console.error('Error processing item in import:', err);
        skipped++;
      }
    }

    res.json({ ok: true, created, updated, skipped, networks_created: networksCreated });
  } catch (err) {
    console.error('Error in PDV import:', err);
    logError('promotor.pdvs.import', err);
    // Include stack trace in response for debugging during development
    res.status(500).json({ 
      error: 'Erro na importação: ' + err.message,
      stack: err.stack 
    });
  }
});

router.get('/rh/pdvs/export', async (req, res) => {
  try {
    const orgId = await resolveOrganizationId(req);
    if (!orgId) return res.status(401).json({ error: 'Organização não encontrada' });
    if (!(await isOrgAdmin(req.userId, orgId))) {
      return res.status(403).json({ error: 'Apenas administradores podem exportar PDVs' });
    }
    const result = await query(
      `SELECT p.name, p.client_name, p.address, p.neighborhood, p.city, p.state, p.zip_code, p.latitude, p.longitude, p.radius_meters, p.active, p.notes
       FROM pdvs p WHERE p.organization_id = $1 ORDER BY p.name`,
      [orgId]
    );
    const headers = ['Fantasia','Rede','Endereço','Bairro','Cidade','Estado','CEP','Latitude','Longitude','Raio(m)','Ativo','Notas'];
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",;\n]/.test(s) ? `"${s}"` : s;
    };
    const lines = [headers.join(';')];
    for (const r of result.rows) {
      lines.push([
        r.name, r.client_name, r.address, r.neighborhood, r.city, r.state, r.zip_code,
        r.latitude, r.longitude, r.radius_meters, r.active ? 'Sim' : 'Não', r.notes
      ].map(escape).join(';'));
    }
    const csv = '\ufeff' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pdvs_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    logError('promotor.pdvs.export', err);
    res.status(500).json({ error: 'Erro ao exportar PDVs' });
  }
});

// =============================================
// RH: VÍNCULO COLABORADOR ↔ PDV
// =============================================
router.get('/rh/collaborator-pdvs/:employeeId', async (req, res) => {
  try {
    const result = await query(
      `SELECT cp.*, p.name as pdv_name FROM collaborator_pdvs cp JOIN pdvs p ON p.id = cp.pdv_id WHERE cp.employee_id = $1 ORDER BY cp.active DESC, p.name`,
      [req.params.employeeId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/collaborator-pdvs', async (req, res) => {
  try {
    const d = req.body;
    const result = await query(
      `INSERT INTO collaborator_pdvs (employee_id, pdv_id, assignment_type, weekdays, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.employee_id, d.pdv_id, d.assignment_type || 'fixo', JSON.stringify(d.weekdays || []), d.start_date, d.end_date]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// RH: ENVIAR DOCUMENTO PARA COLABORADOR
// =============================================
router.post('/rh/document-deliveries', async (req, res) => {
  try {
    const orgId = req.body.organization_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const d = req.body;
    const batch_id = d.employee_ids?.length > 1 ? crypto.randomUUID() : null;
    const employees = d.employee_ids || [d.employee_id];
    const results = [];
    for (const empId of employees) {
      const result = await query(
        `INSERT INTO rh_document_deliveries (organization_id, employee_id, document_type_id, title, description, file_url, file_hash, requires_view_only, requires_confirmation, requires_signature, signature_deadline, block_until_signed, status, sent_by, sent_at, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'enviado',$13,NOW(),$14) RETURNING *`,
        [orgId, empId, d.document_type_id || null, d.title, d.description, d.file_url, d.file_hash,
          d.requires_view_only || false, d.requires_confirmation || false, d.requires_signature || false,
          d.signature_deadline, d.block_until_signed || false, req.userId, batch_id]
      );
      await query(`INSERT INTO rh_document_delivery_events (delivery_id, event_type, actor_type, actor_id) VALUES ($1, 'enviado', 'rh', $2)`, [result.rows[0].id, req.userId]);
      await query(`INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type, reference_type, reference_id) VALUES ($1,$2,'Novo documento','${d.title}','document','delivery',$3)`,
        [orgId, empId, result.rows[0].id]);
      results.push(result.rows[0]);
    }
    res.json(results.length === 1 ? results[0] : results);
  } catch (err) {
    logError('promotor.send-doc', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// RH: ENVIAR RECADO / NOTIFICAÇÃO PARA COLABORADOR
// =============================================
router.post('/rh/send-notice', async (req, res) => {
  try {
    const orgId = req.body.organization_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const { title, message, employee_ids, type } = req.body;
    if (!title || !employee_ids?.length) return res.status(400).json({ error: 'Título e colaboradores obrigatórios' });

    const results = [];
    for (const empId of employee_ids) {
      const result = await query(
        `INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type, reference_type)
         VALUES ($1,$2,$3,$4,$5,'notice') RETURNING *`,
        [orgId, empId, title, message || '', type || 'info']
      );
      results.push(result.rows[0]);
    }
    res.json(results);
  } catch (err) {
    logError('promotor.send-notice', err);
    res.status(500).json({ error: 'Erro ao enviar recado' });
  }
});

router.get('/rh/document-deliveries', async (req, res) => {
  try {
    const orgId = req.query.org_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const { employee_id, status } = req.query;
    let sql = `SELECT dd.*, e.full_name as employee_name, dt.name as type_name FROM rh_document_deliveries dd JOIN employees e ON e.id = dd.employee_id LEFT JOIN rh_document_types dt ON dt.id = dd.document_type_id WHERE dd.organization_id = $1`;
    const params = [orgId]; let idx = 2;
    if (employee_id) { sql += ` AND dd.employee_id = $${idx++}`; params.push(employee_id); }
    if (status) { sql += ` AND dd.status = $${idx++}`; params.push(status); }
    sql += ` ORDER BY dd.created_at DESC`;
    res.json((await query(sql, params)).rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/document-deliveries/:id/cancel', async (req, res) => {
  try {
    await query(`UPDATE rh_document_deliveries SET status = 'cancelado', cancelled_at = NOW(), cancelled_by = $2, updated_at = NOW() WHERE id = $1`, [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/document-deliveries/:id/resend', async (req, res) => {
  try {
    await query(`UPDATE rh_document_deliveries SET status = 'enviado', sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [req.params.id]);
    await query(`INSERT INTO rh_document_delivery_events (delivery_id, event_type, actor_type, actor_id) VALUES ($1, 'reenviado', 'rh', $2)`, [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// RH: DOCUMENT DELIVERY EVENTS
// =============================================
router.get('/rh/document-delivery-events/:deliveryId', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM rh_document_delivery_events WHERE delivery_id = $1 ORDER BY event_at`, [req.params.deliveryId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// RH: INBOUND DOCUMENTS (do colaborador)
// =============================================
router.get('/rh/inbound-documents', async (req, res) => {
  try {
    const orgId = req.query.org_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const { status, employee_id } = req.query;
    let sql = `SELECT ib.*, e.full_name as employee_name FROM rh_inbound_documents ib JOIN employees e ON e.id = ib.employee_id WHERE ib.organization_id = $1`;
    const params = [orgId]; let idx = 2;
    if (status) { sql += ` AND ib.status = $${idx++}`; params.push(status); }
    if (employee_id) { sql += ` AND ib.employee_id = $${idx++}`; params.push(employee_id); }
    sql += ` ORDER BY ib.created_at DESC`;
    res.json((await query(sql, params)).rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.put('/rh/inbound-documents/:id', async (req, res) => {
  try {
    const { status, process_notes } = req.body;
    const result = await query(
      `UPDATE rh_inbound_documents SET status = $2, process_notes = $3,
        read_by = CASE WHEN $2 IN ('lido','em_analise','aprovado','recusado','concluido') THEN COALESCE(read_by, $4::uuid) ELSE read_by END,
        read_at = CASE WHEN $2 IN ('lido','em_analise','aprovado','recusado','concluido') THEN COALESCE(read_at, NOW()) ELSE read_at END,
        processed_by = CASE WHEN $2 IN ('aprovado','recusado','concluido') THEN $4::uuid ELSE processed_by END,
        processed_at = CASE WHEN $2 IN ('aprovado','recusado','concluido') THEN NOW() ELSE processed_at END,
        updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, status, process_notes, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// RH: MONITORAMENTO DE PONTO EM TEMPO REAL
// =============================================
router.get('/rh/punch-monitor', async (req, res) => {
  try {
    const orgId = await resolveOrganizationId(req);
    const today = new Date().toISOString().slice(0, 10);

    const [punched, notPunched, alerts, outsidePdv] = await Promise.all([
      query(`SELECT DISTINCT ON (tp.employee_id) tp.*, e.full_name, e.position, p.name as pdv_name
             FROM time_punches tp JOIN employees e ON e.id = tp.employee_id LEFT JOIN pdvs p ON p.id = tp.pdv_id
             WHERE tp.organization_id = $1 AND tp.punched_at::date = $2 ORDER BY tp.employee_id, tp.punched_at DESC`, [orgId, today]),
      query(`SELECT e.id, e.full_name, e.position, e.work_schedule, d.name as department_name
             FROM employees e LEFT JOIN rh_departments d ON d.id = e.department_id
             WHERE e.organization_id = $1 AND e.status = 'ativo'
               AND NOT EXISTS (SELECT 1 FROM time_punches tp WHERE tp.employee_id = e.id AND tp.punched_at::date = $2)
             ORDER BY e.full_name`, [orgId, today]),
      query(`SELECT ta.*, e.full_name FROM time_alerts ta JOIN employees e ON e.id = ta.employee_id WHERE ta.organization_id = $1 AND ta.alert_date = $2 AND ta.resolved = false ORDER BY ta.created_at DESC`, [orgId, today]),
      query(`SELECT tp.*, e.full_name, p.name as pdv_name FROM time_punches tp JOIN employees e ON e.id = tp.employee_id LEFT JOIN pdvs p ON p.id = tp.pdv_id WHERE tp.organization_id = $1 AND tp.punched_at::date = $2 AND tp.geo_status IN ('fora_area','excecao') ORDER BY tp.punched_at DESC`, [orgId, today]),
    ]);

    res.json({
      punched_today: punched.rows,
      not_punched: notPunched.rows,
      alerts: alerts.rows,
      outside_pdv: outsidePdv.rows,
    });
  } catch (err) {
    logError('promotor.punch-monitor', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// RH: DOCUMENT TYPES
// =============================================
router.get('/rh/document-types', async (req, res) => {
  try {
    const orgId = req.query.org_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const result = await query(`SELECT * FROM rh_document_types WHERE organization_id = $1 ORDER BY name`, [orgId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/document-types', async (req, res) => {
  try {
    const orgId = req.body.organization_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const d = req.body;
    const result = await query(
      `INSERT INTO rh_document_types (organization_id, name, slug, requires_signature, requires_confirmation, category) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, d.name, d.slug || d.name.toLowerCase().replace(/\s+/g, '_'), d.requires_signature || false, d.requires_confirmation !== false, d.category || 'geral']
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// RH: TIMESHEET EXPORTS
// =============================================
router.get('/rh/timesheets', async (req, res) => {
  try {
    const orgId = req.query.org_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const { employee_id, reference_month, status } = req.query;
    let sql = `SELECT te.*, e.full_name as employee_name FROM timesheet_exports te JOIN employees e ON e.id = te.employee_id WHERE te.organization_id = $1`;
    const params = [orgId]; let idx = 2;
    if (employee_id) { sql += ` AND te.employee_id = $${idx++}`; params.push(employee_id); }
    if (reference_month) { sql += ` AND te.reference_month = $${idx++}`; params.push(reference_month); }
    if (status) { sql += ` AND te.status = $${idx++}`; params.push(status); }
    sql += ` ORDER BY te.reference_month DESC, e.full_name`;
    res.json((await query(sql, params)).rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/timesheets', async (req, res) => {
  try {
    const orgId = req.body.organization_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const d = req.body;
    const result = await query(
      `INSERT INTO timesheet_exports (organization_id, employee_id, reference_month, status, total_hours, overtime_hours, absences, lates, requires_signature, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [orgId, d.employee_id, d.reference_month, d.status || 'rascunho', d.total_hours, d.overtime_hours, d.absences || 0, d.lates || 0, d.requires_signature || false, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.put('/rh/timesheets/:id', async (req, res) => {
  try {
    const d = req.body;
    // If sending to collaborator
    if (d.status === 'enviado') {
      await query(`UPDATE timesheet_exports SET status = 'enviado', sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [req.params.id]);
      // Notify
      const te = await query(`SELECT employee_id, reference_month, organization_id FROM timesheet_exports WHERE id = $1`, [req.params.id]);
      if (te.rows[0]) {
        await query(`INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type, reference_type, reference_id) VALUES ($1,$2,'Espelho de ponto disponível',$3,'timesheet','timesheet',$4)`,
          [te.rows[0].organization_id, te.rows[0].employee_id, `Referência: ${te.rows[0].reference_month}`, req.params.id]);
      }
    } else {
      await query(`UPDATE timesheet_exports SET status = $2, updated_at = NOW() WHERE id = $1`, [req.params.id, d.status]);
    }
    const result = await query(`SELECT * FROM timesheet_exports WHERE id = $1`, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// RH: NOTIFICATION RULES
// =============================================
router.get('/rh/notification-rules', async (req, res) => {
  try {
    const orgId = req.query.org_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const result = await query(`SELECT * FROM rh_notification_rules WHERE organization_id = $1 ORDER BY event_type`, [orgId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/notification-rules', async (req, res) => {
  try {
    const orgId = req.body.organization_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const d = req.body;
    const result = await query(
      `INSERT INTO rh_notification_rules (organization_id, event_type, notify_rh, notify_supervisor, notify_collaborator, channel_system, channel_push, channel_email, channel_whatsapp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *`,
      [orgId, d.event_type, d.notify_rh !== false, d.notify_supervisor || false, d.notify_collaborator || false, d.channel_system !== false, d.channel_push || false, d.channel_email || false, d.channel_whatsapp || false]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// RH: TIME RULES
// =============================================
router.get('/rh/time-rules', async (req, res) => {
  try {
    const orgId = req.query.org_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const result = await query(`SELECT tr.*, e.full_name as employee_name FROM time_rules tr LEFT JOIN employees e ON e.id = tr.employee_id WHERE tr.organization_id = $1 ORDER BY tr.employee_id NULLS FIRST`, [orgId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/rh/time-rules', async (req, res) => {
  try {
    const orgId = req.body.organization_id || (await query(`SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`, [req.userId])).rows[0]?.organization_id;
    const d = req.body;
    const result = await query(
      `INSERT INTO time_rules (organization_id, employee_id, name, late_tolerance_minutes, early_leave_tolerance, break_tolerance, max_late_minutes, require_justification, absence_on_no_punch, punch_window_minutes, allow_manual_adjustment, require_geo, allow_offline_punch, allow_exception_punch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [orgId, d.employee_id || null, d.name || 'Padrão', d.late_tolerance_minutes || 10, d.early_leave_tolerance || 10, d.break_tolerance || 5, d.max_late_minutes || 30, d.require_justification !== false, d.absence_on_no_punch !== false, d.punch_window_minutes || 60, d.allow_manual_adjustment !== false, d.require_geo !== false, d.allow_offline_punch !== false, d.allow_exception_punch || false]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// =============================================
// PROMOTOR: ATUALIZAR LOCALIZAÇÃO EM TEMPO REAL
// =============================================
router.post('/location-update', authenticatePromotor, async (req, res) => {
  try {
    const { latitude, longitude, accuracy_meters, battery_level, is_moving } = req.body;
    if (!latitude || !longitude) return res.status(400).json({ error: 'Coordenadas obrigatórias' });

    // Check work schedule - only track during work hours
    let ws = '08:00-17:00';
    try {
      const empRes = await query(`SELECT work_schedule FROM employees WHERE id = $1`, [req.employeeId]);
      ws = empRes.rows[0]?.work_schedule || ws;
    } catch (e) { /* table may not exist */ }

    const wsParts = String(ws).split('-');
    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();
    const startMin = wsParts[0] ? wsParts[0].split(':').reduce((h, m) => parseInt(h) * 60 + parseInt(m), 0) : 480;
    const endMin = wsParts[1] ? wsParts[1].split(':').reduce((h, m) => parseInt(h) * 60 + parseInt(m), 0) : 1020;

    // 15 min tolerance before/after
    if (currentMin < (startMin - 15) || currentMin > (endMin + 15)) {
      return res.json({ tracked: false, reason: 'outside_schedule' });
    }

    try {
      await query(
        `INSERT INTO employee_live_locations (organization_id, employee_id, latitude, longitude, accuracy_meters, battery_level, is_moving, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (employee_id) DO UPDATE SET latitude=$3, longitude=$4, accuracy_meters=$5, battery_level=$6, is_moving=$7, updated_at=NOW()`,
        [req.organizationId, req.employeeId, latitude, longitude, accuracy_meters || null, battery_level || null, is_moving || false]
      );
    } catch (e) {
      if (e.code === '42P01') return res.json({ tracked: false, reason: 'table_not_ready' });
      throw e;
    }

    // Also save to history for tracking/playback
    try {
      await query(
        `INSERT INTO employee_location_history (organization_id, employee_id, latitude, longitude, accuracy_meters, battery_level, is_moving, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [req.organizationId, req.employeeId, latitude, longitude, accuracy_meters || null, battery_level || null, is_moving || false]
      );
    } catch (e) {
      // table may not exist yet - silent
      if (e.code !== '42P01') logError('promotor.location-history-insert', e);
    }

    res.json({ tracked: true });
  } catch (err) {
    logError('promotor.location-update', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// RH: LIVE MAP DATA
// =============================================
router.get('/rh/live-map', async (req, res) => {
  try {
    const orgId = await resolveOrganizationId(req);
    if (!orgId) {
      return res.status(401).json({ error: 'organization_id missing', employees: [], pdvs: [], regions: [] });
    }

    const today = new Date().toISOString().slice(0, 10);
    const [hasLiveLocations, hasServiceRegions, hasMerchBrands, hasMerchPdvBrands] = await Promise.all([
      tableExists('public.employee_live_locations'),
      tableExists('public.service_regions'),
      tableExists('public.merch_brands'),
      tableExists('public.merch_pdv_brands'),
    ]);

    const liveLocationSelect = hasLiveLocations
      ? `ll.latitude as live_lat, ll.longitude as live_lng, ll.accuracy_meters as live_accuracy,
          ll.battery_level, ll.is_moving, ll.updated_at as location_updated_at,
          CASE WHEN ll.updated_at > NOW() - INTERVAL '5 minutes' THEN 'online' ELSE 'offline' END as live_status,`
      : `NULL::numeric as live_lat, NULL::numeric as live_lng, NULL::numeric as live_accuracy,
          NULL::integer as battery_level, false as is_moving, NULL::timestamptz as location_updated_at,
          'offline' as live_status,`;

    const liveLocationJoin = hasLiveLocations
      ? `LEFT JOIN employee_live_locations ll ON ll.employee_id = e.id`
      : '';

    const currentBrandsSelect = hasMerchBrands && hasMerchPdvBrands
      ? `(SELECT string_agg(DISTINCT mb.name, ', ')
           FROM merch_pdv_brands mpb
           JOIN merch_brands mb ON mb.id = mpb.brand_id
           JOIN time_punches tp2 ON tp2.pdv_id = mpb.pdv_id
           WHERE tp2.employee_id = e.id
             AND tp2.punched_at::date = $2
             AND mpb.active = true) as current_brands`
      : `NULL::text as current_brands`;

    const [employees, pdvs, regions] = await Promise.all([
      query(`
        SELECT e.id, e.full_name, e.position, e.worker_profile, e.work_schedule, e.photo_url,
          e.home_latitude, e.home_longitude,
          ${liveLocationSelect}
          (SELECT COUNT(*) FROM time_punches tp WHERE tp.employee_id = e.id AND tp.punched_at::date = $2) as punch_count,
          (SELECT tp.punch_type FROM time_punches tp WHERE tp.employee_id = e.id AND tp.punched_at::date = $2 ORDER BY tp.punched_at DESC LIMIT 1) as last_punch_type,
          (SELECT tp.punched_at FROM time_punches tp WHERE tp.employee_id = e.id AND tp.punched_at::date = $2 ORDER BY tp.punched_at DESC LIMIT 1) as last_punch_at,
          (SELECT tp.pdv_id FROM time_punches tp WHERE tp.employee_id = e.id AND tp.punched_at::date = $2 ORDER BY tp.punched_at DESC LIMIT 1) as last_pdv_id,
          (SELECT p.name FROM time_punches tp JOIN pdvs p ON p.id = tp.pdv_id WHERE tp.employee_id = e.id AND tp.punched_at::date = $2 ORDER BY tp.punched_at DESC LIMIT 1) as last_pdv_name,
          ${currentBrandsSelect}
        FROM employees e
        ${liveLocationJoin}
        WHERE e.organization_id = $1 AND e.status = 'ativo'
        ORDER BY e.full_name
      `, [orgId, today]),
      query(`SELECT id, name, client_name, address, city, state, latitude, longitude, radius_meters, active FROM pdvs WHERE organization_id = $1 AND active = true`, [orgId]),
      hasServiceRegions
        ? query(`SELECT sr.*, e.full_name as supervisor_name FROM service_regions sr LEFT JOIN employees e ON e.id = sr.supervisor_id WHERE sr.organization_id = $1 AND sr.active = true`, [orgId])
        : Promise.resolve({ rows: [] }),
    ]);

    res.json({
      employees: employees.rows,
      pdvs: pdvs.rows,
      regions: regions.rows,
    });
  } catch (err) {
    logError('promotor.live-map', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// RH: LOCATION HISTORY (TRACKING/PLAYBACK)
// =============================================
router.get('/rh/location-history', async (req, res) => {
  try {
    const orgId = await resolveOrganizationId(req);
    if (!orgId) return res.status(401).json({ error: 'organization_id missing' });

    const { employee_id, date } = req.query;
    if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date required' });

    const hasTable = await tableExists('public.employee_location_history');
    if (!hasTable) return res.json({ points: [], employee: null });

    const [points, emp] = await Promise.all([
      query(
        `SELECT latitude, longitude, accuracy_meters, battery_level, is_moving, recorded_at
         FROM employee_location_history
         WHERE organization_id = $1 AND employee_id = $2 AND recorded_at::date = $3
         ORDER BY recorded_at ASC`,
        [orgId, employee_id, date]
      ),
      query(`SELECT id, full_name, photo_url, position FROM employees WHERE id = $1 AND organization_id = $2`, [employee_id, orgId]),
    ]);

    res.json({ points: points.rows, employee: emp.rows[0] || null });
  } catch (err) {
    logError('promotor.location-history', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// =============================================
// RH: LIST EMPLOYEES WITH TRACKING DATA FOR A DATE
// =============================================
router.get('/rh/trackable-employees', async (req, res) => {
  try {
    const orgId = await resolveOrganizationId(req);
    if (!orgId) return res.status(401).json({ error: 'organization_id missing' });

    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const hasTable = await tableExists('public.employee_location_history');
    if (!hasTable) return res.json([]);

    const result = await query(
      `SELECT e.id, e.full_name, e.photo_url, e.position, e.worker_profile,
              COUNT(lh.id)::int as point_count,
              MIN(lh.recorded_at) as first_point,
              MAX(lh.recorded_at) as last_point
       FROM employees e
       JOIN employee_location_history lh ON lh.employee_id = e.id AND lh.recorded_at::date = $2
       WHERE e.organization_id = $1 AND e.status = 'ativo'
       GROUP BY e.id, e.full_name, e.photo_url, e.position, e.worker_profile
       ORDER BY e.full_name`,
      [orgId, targetDate]
    );

    res.json(result.rows);
  } catch (err) {
    logError('promotor.trackable-employees', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// Get facial recognition config for current promotor (used by app to decide if facial verification is required)
router.get('/facial-config', authenticatePromotor, async (req, res) => {
  try {
    const empId = req.employeeId;
    const orgId = req.organizationId;

    // Check if facial recognition is enabled for this org
    let enabled = false;
    let useForAttendance = false;
    let useForCheckin = false;
    let minConfidence = 70;
    try {
      const { rows: cfgRows } = await query(
        `SELECT enabled, use_for_attendance, use_for_checkin, min_confidence FROM facial_recognition_config WHERE organization_id = $1`,
        [orgId]
      );
      if (cfgRows.length) {
        enabled = cfgRows[0].enabled;
        useForAttendance = cfgRows[0].use_for_attendance;
        useForCheckin = cfgRows[0].use_for_checkin;
        minConfidence = parseFloat(cfgRows[0].min_confidence) || 70;
      }
    } catch {
      // table may not exist
    }

    // Per-employee override (true=sempre exigir, false=dispensado, null=segue org)
    let empOverride = null;
    let descriptor = null;
    let photoUrl = null;
    let hasEnrollment = false;
    try {
      const { rows: empRows } = await query(
        `SELECT face_descriptor, face_photo_url, facial_required FROM employees WHERE id = $1`,
        [empId]
      );
      if (empRows.length) {
        empOverride = empRows[0].facial_required;
        if (empRows[0].face_descriptor) {
          const parsedDescriptor = typeof empRows[0].face_descriptor === 'string'
            ? JSON.parse(empRows[0].face_descriptor)
            : empRows[0].face_descriptor;
          descriptor = Array.isArray(parsedDescriptor)
            ? parsedDescriptor
            : Array.isArray(parsedDescriptor?.descriptor)
              ? parsedDescriptor.descriptor
              : null;
          photoUrl = empRows[0].face_photo_url;
          hasEnrollment = Array.isArray(descriptor) && descriptor.length > 0;
        }
      }
    } catch {
      // columns may not exist
    }

    // Se o colaborador está dispensado, retorna desabilitado para este usuário
    if (empOverride === false) {
      return res.json({ enabled: false, employee_exempt: true });
    }
    // Se não está habilitado globalmente e não há override true, desabilitado
    if (!enabled && empOverride !== true) {
      return res.json({ enabled: false });
    }

    const effectiveAttendance = empOverride === true ? true : useForAttendance;
    const effectiveCheckin = empOverride === true ? true : useForCheckin;

    res.json({
      enabled: true,
      use_for_attendance: effectiveAttendance,
      use_for_checkin: effectiveCheckin,
      min_confidence: minConfidence,
      has_enrollment: hasEnrollment,
      descriptor,
      photo_url: photoUrl,
      employee_override: empOverride,
    });
  } catch (err) {
    logError('promotor.facial-config', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== SUPERVISOR ENDPOINTS (used by supervisor in promotor app) =====

// Middleware to verify supervisor role
function requireSupervisor(req, res, next) {
  query(`SELECT worker_profile FROM employees WHERE id = $1`, [req.employeeId])
    .then(r => {
      const profile = r.rows[0]?.worker_profile;
      if (profile === 'supervisor' || profile === 'administrativo') {
        next();
      } else {
        res.status(403).json({ error: 'Acesso restrito a supervisores' });
      }
    })
    .catch(err => res.status(500).json({ error: err.message }));
}

// Get subordinates (team)
router.get('/supervisor/team', authenticatePromotor, requireSupervisor, async (req, res) => {
  try {
    // Base query using only the employees table (always exists)
    let sql = `SELECT e.id, e.full_name, e.position, e.photo_url, e.worker_profile, e.work_schedule,
              e.status, e.phone`;

    // Check which optional tables exist to avoid 500 errors
    const tablesCheck = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('location_tracking', 'attendance_punches', 'merch_routes')`
    );
    const existingTables = new Set(tablesCheck.rows.map(r => r.table_name));

    if (existingTables.has('location_tracking')) {
      sql += `,
              lt.latitude as last_latitude, lt.longitude as last_longitude,
              lt.is_moving, lt.battery_level, lt.recorded_at as last_location_at,
              CASE WHEN lt.recorded_at > NOW() - interval '10 minutes' THEN 'online' ELSE 'offline' END as live_status`;
    } else {
      sql += `, NULL as last_latitude, NULL as last_longitude, NULL as is_moving, NULL as battery_level, NULL as last_location_at, 'offline' as live_status`;
    }

    if (existingTables.has('attendance_punches')) {
      sql += `, (SELECT p2.pdv_name FROM attendance_punches p2 WHERE p2.employee_id = e.id AND p2.punched_at::date = CURRENT_DATE ORDER BY p2.punched_at DESC LIMIT 1) as last_pdv_name`;
    } else {
      sql += `, NULL as last_pdv_name`;
    }

    if (existingTables.has('merch_routes')) {
      sql += `, (SELECT COUNT(*) FROM merch_routes mr WHERE mr.promoter_id = e.id AND mr.visit_date = CURRENT_DATE) as today_routes_count`;
    } else {
      sql += `, 0 as today_routes_count`;
    }

    sql += ` FROM employees e`;

    if (existingTables.has('location_tracking')) {
      sql += ` LEFT JOIN LATERAL (
         SELECT latitude, longitude, is_moving, battery_level, recorded_at
         FROM location_tracking WHERE employee_id = e.id ORDER BY recorded_at DESC LIMIT 1
       ) lt ON true`;
    }

    sql += ` WHERE e.organization_id = $1 AND e.direct_manager_id = $2 AND e.status = 'ativo'
       ORDER BY e.full_name`;

    const result = await query(sql, [req.organizationId, req.employeeId]);
    res.json(result.rows);
  } catch (err) {
    logError('supervisor.team', err);
    res.status(500).json({ error: err.message });
  }
});

// Get pending overtime requests from subordinates
router.get('/supervisor/overtime-requests', authenticatePromotor, requireSupervisor, async (req, res) => {
  try {
    const result = await query(
      `SELECT otr.*, e.full_name as employee_name, e.position, e.work_schedule
       FROM overtime_requests otr
       JOIN employees e ON e.id = otr.employee_id
       WHERE e.direct_manager_id = $1 AND otr.status = 'pendente'
       ORDER BY otr.created_at DESC`,
      [req.employeeId]
    );
    res.json(result.rows);
  } catch (err) {
    logError('supervisor.overtime-requests', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve/reject overtime request
router.put('/supervisor/overtime-requests/:id', authenticatePromotor, requireSupervisor, async (req, res) => {
  try {
    const { status, supervisor_notes } = req.body;
    if (!['aprovado', 'recusado'].includes(status)) return res.status(400).json({ error: 'Status inválido' });

    const result = await query(
      `UPDATE overtime_requests SET status = $1, supervisor_notes = $2, approved_by = $3, approved_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status, supervisor_notes || '', req.employeeId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Solicitação não encontrada' });

    // Notify the employee
    const ot = result.rows[0];
    const supName = await query(`SELECT full_name FROM employees WHERE id = $1`, [req.employeeId]);
    await query(
      `INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type) VALUES ($1, $2, $3, $4, 'punch')`,
      [req.organizationId, ot.employee_id,
       status === 'aprovado' ? '✅ Hora Extra Aprovada' : '❌ Hora Extra Recusada',
       `Supervisor ${supName.rows[0]?.full_name || ''}: ${supervisor_notes || 'Sem observação'}`]
    );

    res.json(result.rows[0]);
  } catch (err) {
    logError('supervisor.approve-overtime', err);
    res.status(500).json({ error: err.message });
  }
});

// Send notification to specific promoter
router.post('/supervisor/send-notification', authenticatePromotor, requireSupervisor, async (req, res) => {
  try {
    const { employee_id, title, message } = req.body;
    if (!employee_id || !title) return res.status(400).json({ error: 'employee_id e title obrigatórios' });

    // Verify subordinate
    const emp = await query(`SELECT id FROM employees WHERE id = $1 AND direct_manager_id = $2`, [employee_id, req.employeeId]);
    if (!emp.rows.length) return res.status(403).json({ error: 'Promotor não é seu subordinado' });

    await query(
      `INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type) VALUES ($1, $2, $3, $4, 'info')`,
      [req.organizationId, employee_id, title, message || '']
    );
    res.json({ success: true });
  } catch (err) {
    logError('supervisor.send-notification', err);
    res.status(500).json({ error: err.message });
  }
});

// Send document/file to RH
router.post('/supervisor/send-to-rh', authenticatePromotor, requireSupervisor, async (req, res) => {
  try {
    const { title, message, file_url, category } = req.body;
    if (!title) return res.status(400).json({ error: 'Título obrigatório' });

    const result = await query(
      `INSERT INTO collaborator_inbound_documents (organization_id, employee_id, category, description, file_url, status)
       VALUES ($1, $2, $3, $4, $5, 'pendente') RETURNING *`,
      [req.organizationId, req.employeeId, category || 'geral', `${title}${message ? ': ' + message : ''}`, file_url || '']
    );

    // Notify RH admins
    await query(
      `INSERT INTO collaborator_notifications (organization_id, employee_id, title, message, type)
       SELECT $1, e.id, 'Documento do supervisor', $3, 'document'
       FROM employees e WHERE e.organization_id = $1 AND e.worker_profile IN ('administrativo') LIMIT 5`,
      [req.organizationId, req.employeeId, title]
    );

    res.json(result.rows[0]);
  } catch (err) {
    logError('supervisor.send-to-rh', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
