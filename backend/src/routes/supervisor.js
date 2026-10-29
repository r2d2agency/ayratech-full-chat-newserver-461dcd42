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

export default router;
