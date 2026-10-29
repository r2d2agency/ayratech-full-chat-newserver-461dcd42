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
    let sql = `SELECT r.*, e.full_name as promoter_name, p.name as pdv_name, p.city as pdv_city, b.name as brand_name
               FROM merch_routes r
               LEFT JOIN employees e ON e.id = r.promoter_id
               LEFT JOIN pdvs p ON p.id = r.pdv_id
               LEFT JOIN merch_brands b ON b.id = r.brand_id
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
    const result = await query(sql, params);
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
    const allowed = ['visit_date','scheduled_time','promoter_id','notes','window_start','window_end'];
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
    const empSub = await query(`SELECT 1 FROM employees WHERE id=$1 AND (direct_manager_id=$2 OR supervisor_id=$2)`, [employee_id, req.employeeId]);
    if (!empSub.rows.length) return res.status(403).json({ error: 'Apoio não é liderado' });
    await query(`INSERT INTO route_person_assignments (route_id, employee_id, role, assigned_by, active) VALUES ($1,$2,'apoio',$3,true)`, [req.params.id, employee_id, req.employeeId]);
    res.json({ ok: true });
  } catch (err) {
    logError('supervisor.routes.support', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
