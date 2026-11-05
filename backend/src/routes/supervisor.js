import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { logError } from '../logger.js';
import { setRequestContext } from '../request-context.js';

const router = express.Router();

export const authenticateSupervisor = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.appType !== 'supervisor') return res.status(403).json({ error: 'Token inválido para este app' });
    req.employeeId = decoded.employeeId;
    req.organizationId = decoded.organizationId;
    setRequestContext({ employee_id: decoded.employeeId, organization_id: decoded.organizationId });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login e senha obrigatórios' });

    const cleaned = login.replace(/\D/g, '');
    const isCpf = cleaned.length === 11;

    const emp = await query(
      `SELECT e.id, e.full_name, e.cpf, e.email, e.organization_id, e.worker_profile, e.photo_url,
              a.password_hash, a.access_status, a.temp_password, a.force_password_change
       FROM employees e
       JOIN collaborator_app_access a ON a.employee_id = e.id
       WHERE ${isCpf ? "REPLACE(REPLACE(REPLACE(e.cpf, '.', ''), '-', ''), ' ', '') = $1" : 'LOWER(e.email) = LOWER($1)'}
         AND a.access_status IN ('liberado', 'aguardando_login', 'ativo')`,
      [isCpf ? cleaned : login]
    );

    if (!emp.rows[0]) return res.status(401).json({ error: 'Credenciais inválidas ou acesso não liberado' });
    const employee = emp.rows[0];

    const isSupervisor = ['supervisor', 'administrativo'].includes(employee.worker_profile);
    if (!isSupervisor) return res.status(403).json({ error: 'Acesso restrito a supervisores' });

    const valid = await bcrypt.compare(password, employee.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });

    await query(
      `UPDATE collaborator_app_access SET access_status = 'ativo', last_login = NOW(), last_device = $2, last_ip = $3, updated_at = NOW() WHERE employee_id = $1`,
      [employee.id, req.headers['user-agent'] || '', req.ip]
    );

    const token = jwt.sign(
      { employeeId: employee.id, organizationId: employee.organization_id, appType: 'supervisor' },
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
    logError('supervisor.login', err);
    res.status(500).json({ error: 'Erro no login' });
  }
});

router.post('/change-password', authenticateSupervisor, async (req, res) => {
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
    res.json({ ok: true });
  } catch (err) {
    logError('supervisor.change-password', err);
    res.status(500).json({ error: 'Erro' });
  }
});

router.get('/me', authenticateSupervisor, async (req, res) => {
  try {
    const r = await query(`SELECT id, full_name, email, cpf, photo_url, worker_profile, organization_id FROM employees WHERE id = $1`, [req.employeeId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ employee: r.rows[0] });
  } catch (err) {
    logError('supervisor.me', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// List routes of subordinates
router.get('/routes', authenticateSupervisor, async (req, res) => {
  try {
    const { promoter_id, date_from, date_to } = req.query;
    // Restrict to subordinates
    const subs = await query(`SELECT id FROM employees WHERE (direct_manager_id=$1 OR supervisor_id=$1)`, [req.employeeId]);
    const subIds = subs.rows.map(r => r.id);
    if (!subIds.length) return res.json([]);
    let allowedPromoters = subIds;
    if (promoter_id) {
      if (!subIds.includes(promoter_id)) return res.status(403).json({ error: 'Promotor não é liderado' });
      allowedPromoters = [promoter_id];
    }
    const params = [req.organizationId];
    let sql = `SELECT r.*, COALESCE(r.progress_pct, 0) as progress_pct, e.full_name as promoter_name, p.name as pdv_name, p.city as pdv_city, p.address as pdv_address, p.latitude as pdv_latitude, p.longitude as pdv_longitude, b.name as brand_name,
               COALESCE(pc.total_products, 0)::int as total_products,
               COALESCE(pc.completed_products, 0)::int as completed_products
               FROM merch_routes r
               LEFT JOIN employees e ON e.id = r.promoter_id
               LEFT JOIN pdvs p ON p.id = r.pdv_id
               LEFT JOIN merch_brands b ON b.id = r.brand_id
               LEFT JOIN LATERAL (
                 SELECT COUNT(*)::int as total_products,
                        COUNT(*) FILTER (WHERE rpe.status = 'completed')::int as completed_products
                 FROM route_product_executions rpe
                 WHERE rpe.route_id = r.id
               ) pc ON true
               WHERE r.organization_id = $1 AND r.promoter_id = ANY($2::uuid[])`;
    params.push(allowedPromoters);
    let idx = 3;
    if (date_from && date_to) {
      sql += ` AND r.visit_date BETWEEN $${idx++} AND $${idx++}`;
      params.push(date_from, date_to);
    } else if (date_from) {
      sql += ` AND r.visit_date >= $${idx++}`;
      params.push(date_from);
    } else if (date_to) {
      sql += ` AND r.visit_date <= $${idx++}`;
      params.push(date_to);
    }
    sql += ' ORDER BY r.visit_date DESC, r.scheduled_time';
    let result;
    try {
      result = await query(sql, params);
    } catch (e) {
      // Fallback para instalações antigas sem route_product_executions
      const fallbackSql = sql.replace(/,\s*COALESCE\(pc\.total_products[\s\S]*?\) pc ON true/, '');
      result = await query(fallbackSql, params);
      result.rows = result.rows.map(r => ({ ...r, progress_pct: r.progress_pct ?? 0, total_products: 0, completed_products: 0 }));
    }
    // Garante progress consistente com produtos (evita progress_pct desatualizado)
    result.rows = result.rows.map(r => {
      const total = Number(r.total_products || 0);
      const done = Number(r.completed_products || 0);
      if (total > 0 && (r.progress_pct == null || (r.status === 'completed' && Number(r.progress_pct) < 100))) {
        r.progress_pct = Math.round((done / total) * 100);
      }
      if (r.status === 'completed' && total === 0 && (r.progress_pct == null || Number(r.progress_pct) === 0)) {
        r.progress_pct = 100;
      }
      return r;
    });
    res.json(result.rows);
  } catch (err) {
    logError('supervisor.routes.list', err);
    res.status(500).json({ error: err.message });
  }
});

// Update route (only if promoter is subordinate)
router.put('/routes/:id', authenticateSupervisor, async (req, res) => {
  try {
    const existing = await query(`SELECT * FROM merch_routes WHERE id=$1 AND organization_id=$2`, [req.params.id, req.organizationId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const old = existing.rows[0];
    // verify promoter is subordinate
    const sub = await query(`SELECT 1 FROM employees WHERE id=$1 AND (direct_manager_id=$2 OR supervisor_id=$2)`, [old.promoter_id, req.employeeId]);
    if (!sub.rows.length) return res.status(403).json({ error: 'Rota não pertence a um liderado' });
    const allowed = ['visit_date','scheduled_time','promoter_id','notes','window_start','window_end','pdv_id'];
    const sets = [];
    const params = [];
    let idx = 1;
    for (const f of allowed) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    await query(`UPDATE merch_routes SET ${sets.join(', ')} WHERE id=$${idx}`, params);
    // if promoter changed, ensure new promoter is subordinate
    if (req.body.promoter_id) {
      const newSub = await query(`SELECT 1 FROM employees WHERE id=$1 AND (direct_manager_id=$2 OR supervisor_id=$2)`, [req.body.promoter_id, req.employeeId]);
      if (!newSub.rows.length) return res.status(403).json({ error: 'Novo promotor não é liderado' });
    }
    res.json({ ok: true });
  } catch (err) {
    logError('supervisor.routes.update', err);
    res.status(500).json({ error: err.message });
  }
});

// Add support (apoio) to a route
router.post('/routes/:id/support', authenticateSupervisor, async (req, res) => {
  try {
    const existing = await query(`SELECT promoter_id FROM merch_routes WHERE id=$1 AND organization_id=$2`, [req.params.id, req.organizationId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const sub = await query(`SELECT 1 FROM employees WHERE id=$1 AND (direct_manager_id=$2 OR supervisor_id=$2)`, [existing.rows[0].promoter_id, req.employeeId]);
    if (!sub.rows.length) return res.status(403).json({ error: 'Rota não pertence a um liderado' });
    const { employee_id } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id obrigatório' });
    // Allow adding supervisor themselves or any subordinate as support
    if (employee_id !== req.employeeId) {
      const empSub = await query(`SELECT 1 FROM employees WHERE id=$1 AND (direct_manager_id=$2 OR supervisor_id=$2)`, [employee_id, req.employeeId]);
      if (!empSub.rows.length) return res.status(403).json({ error: 'Apoio não é liderado' });
    }
    // Avoid duplicate active assignment
    const exists = await query(`SELECT 1 FROM route_person_assignments WHERE route_id=$1 AND employee_id=$2 AND role='apoio' AND active=true`, [req.params.id, employee_id]);
    if (exists.rows.length) return res.json({ ok: true });
    await query(`INSERT INTO route_person_assignments (route_id, employee_id, role, assigned_by, active) VALUES ($1,$2,'apoio',$3,true)`, [req.params.id, employee_id, req.employeeId]);
    res.json({ ok: true });
  } catch (err) {
    logError('supervisor.routes.support', err);
    res.status(500).json({ error: err.message });
  }
});

// List route executions (checkins) for subordinate route
router.get('/routes/:id/executions', authenticateSupervisor, async (req, res) => {
  try {
    const route = await query(`SELECT promoter_id FROM merch_routes WHERE id=$1 AND organization_id=$2`, [req.params.id, req.organizationId]);
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const sub = await query(`SELECT 1 FROM employees WHERE id=$1 AND (direct_manager_id=$2 OR supervisor_id=$2)`, [route.rows[0].promoter_id, req.employeeId]);
    if (!sub.rows.length) return res.status(403).json({ error: 'Rota não pertence a um liderado' });
    const execs = await query(`SELECT * FROM route_executions WHERE route_id=$1 ORDER BY created_at ASC`, [req.params.id]);
    res.json(execs.rows);
  } catch (err) {
    logError('supervisor.routes.executions', err);
    res.status(500).json({ error: err.message });
  }
});

// List route photos for subordinate route
router.get('/routes/:id/photos', authenticateSupervisor, async (req, res) => {
  try {
    const route = await query(`SELECT promoter_id FROM merch_routes WHERE id=$1 AND organization_id=$2`, [req.params.id, req.organizationId]);
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const sub = await query(`SELECT 1 FROM employees WHERE id=$1 AND (direct_manager_id=$2 OR supervisor_id=$2)`, [route.rows[0].promoter_id, req.employeeId]);
    if (!sub.rows.length) return res.status(403).json({ error: 'Rota não pertence a um liderado' });
    const photos = await query(`SELECT DISTINCT ON (photo_url) * FROM route_photos WHERE route_id=$1 ORDER BY photo_url, captured_at DESC`, [req.params.id]);
    res.json(photos.rows);
  } catch (err) {
    logError('supervisor.routes.photos', err);
    res.status(500).json({ error: err.message });
  }
});

// List PDVs for supervisor organization
router.get('/pdvs', authenticateSupervisor, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, city, address, latitude, longitude FROM pdvs WHERE organization_id=$1 AND active=true ORDER BY name`,
      [req.organizationId]
    );
    res.json(result.rows);
  } catch (err) {
    logError('supervisor.pdvs', err);
    res.status(500).json({ error: err.message });
  }
});

// Team (subordinates) for supervisor app
router.get('/team', authenticateSupervisor, async (req, res) => {
  try {
    const tablesCheck = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('location_tracking', 'merch_routes')`
    );
    const existingTables = new Set(tablesCheck.rows.map(r => r.table_name));
    let sql = `SELECT e.id, e.full_name, e.position, e.photo_url, e.worker_profile, e.work_schedule, e.status, e.phone`;
    if (existingTables.has('location_tracking')) {
      sql += `,
              lt.latitude as last_latitude, lt.longitude as last_longitude,
              lt.is_moving, lt.battery_level, lt.recorded_at as last_location_at,
              CASE WHEN lt.recorded_at > NOW() - interval '10 minutes' THEN 'online' ELSE 'offline' END as live_status`;
    } else {
      sql += `, NULL as last_latitude, NULL as last_longitude, NULL as is_moving, NULL as battery_level, NULL as last_location_at, 'offline' as live_status`;
    }
    if (existingTables.has('merch_routes')) {
      sql += `, (SELECT COUNT(*) FROM merch_routes mr WHERE mr.promoter_id = e.id AND mr.visit_date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date) as today_routes_count`;
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
    sql += ` WHERE e.organization_id = $1 AND (e.direct_manager_id = $2 OR e.supervisor_id = $2) AND e.status = 'ativo'
       ORDER BY e.full_name`;
    const result = await query(sql, [req.organizationId, req.employeeId]);
    res.json(result.rows);
  } catch (err) {
    logError('supervisor.team', err);
    res.status(500).json({ error: err.message });
  }
});

// Punches of the team (time_punches of subordinates)
router.get('/team/punches', authenticateSupervisor, async (req, res) => {
  try {
    const { employee_id, date } = req.query;
    const subs = await query(
      `SELECT id, full_name FROM employees WHERE organization_id=$1 AND (direct_manager_id=$2 OR supervisor_id=$2) AND status='ativo'`,
      [req.organizationId, req.employeeId]
    );
    const subIds = subs.rows.map(r => r.id);
    if (!subIds.length) return res.json([]);
    const names = new Map(subs.rows.map(r => [r.id, r.full_name]));
    let allowed = subIds;
    if (employee_id) {
      if (!subIds.includes(employee_id)) return res.status(403).json({ error: 'Promotor não é liderado' });
      allowed = [employee_id];
    }
    let sql = `SELECT tp.*, p.name as pdv_name FROM time_punches tp LEFT JOIN pdvs p ON p.id = tp.pdv_id WHERE tp.employee_id = ANY($1)`;
    const params = [allowed];
    let idx = 2;
    if (date) { sql += ` AND (tp.punched_at AT TIME ZONE 'America/Sao_Paulo')::date = $${idx++}`; params.push(date); }
    else {
      const days = parseInt(req.query.days || '7', 10);
      sql += ` AND tp.punched_at >= NOW() - ($${idx++} || ' days')::interval`; params.push(String(Math.min(Math.max(days, 1), 31)));
    }
    sql += ` ORDER BY tp.punched_at DESC LIMIT 500`;
    const result = await query(sql, params);
    res.json(result.rows.map(r => ({ ...r, employee_name: names.get(r.employee_id) || null })));
  } catch (err) {
    logError('supervisor.team.punches', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
