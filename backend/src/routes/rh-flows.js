// RH Flows — Admissão, Demissão (com cálculo de rescisão), Dependentes, eSocial (fila)
import express from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logError } from '../logger.js';

const router = express.Router();
router.use(authenticate);

async function getUserOrgId(userId) {
  const r = await query(
    `SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return r.rows[0]?.organization_id;
}

let tablesReady = false;

async function ensureEmployeeDependentsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS employee_dependents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID,
      employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      full_name VARCHAR(255),
      cpf VARCHAR(20),
      birth_date DATE,
      relationship VARCHAR(50),
      ir_deduction BOOLEAN DEFAULT false,
      family_allowance BOOLEAN DEFAULT false,
      disabled BOOLEAN DEFAULT false,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS organization_id UUID`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS full_name VARCHAR(255)`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS cpf VARCHAR(20)`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS birth_date DATE`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS relationship VARCHAR(50)`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS ir_deduction BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS family_allowance BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS disabled BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS notes TEXT`);
  await query(`ALTER TABLE employee_dependents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // Legacy: coluna "name" existia com NOT NULL. Remover NOT NULL e sincronizar valores.
  await query(`ALTER TABLE employee_dependents ALTER COLUMN name DROP NOT NULL`).catch(() => {});
  await query(`UPDATE employee_dependents SET full_name = name WHERE full_name IS NULL AND name IS NOT NULL`).catch(() => {});
  await query(`UPDATE employee_dependents SET name = full_name WHERE name IS NULL AND full_name IS NOT NULL`).catch(() => {});
  await query(`UPDATE employee_dependents d SET organization_id = e.organization_id
               FROM employees e WHERE d.employee_id = e.id AND d.organization_id IS NULL`);

  await query(`CREATE INDEX IF NOT EXISTS idx_dependents_emp ON employee_dependents(employee_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dependents_org ON employee_dependents(organization_id)`);
}

async function ensureTables() {
  if (tablesReady) return;

  await ensureEmployeeDependentsSchema();

  await query(`
    CREATE TABLE IF NOT EXISTS esocial_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
      event_type VARCHAR(20) NOT NULL, -- S-2200, S-2230, S-2299, S-1200, S-3000
      reference_period VARCHAR(7),      -- YYYY-MM
      status VARCHAR(20) DEFAULT 'pendente', -- pendente, gerado, enviado, aceito, erro, retificado
      xml_content TEXT,
      protocol VARCHAR(100),
      receipt VARCHAR(100),
      environment VARCHAR(20) DEFAULT 'homologacao', -- producao, homologacao
      error_message TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_esocial_org ON esocial_events(organization_id);
    CREATE INDEX IF NOT EXISTS idx_esocial_emp ON esocial_events(employee_id);
    CREATE INDEX IF NOT EXISTS idx_esocial_status ON esocial_events(status);
    CREATE INDEX IF NOT EXISTS idx_esocial_type ON esocial_events(event_type);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS employee_terminations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      termination_date DATE NOT NULL,
      reason_code VARCHAR(30) NOT NULL,
      -- sem_justa_causa, justa_causa, pedido_colaborador, acordo_484a, fim_experiencia, fim_exp_colaborador, fim_exp_empresa, aposentadoria, morte, pj_encerramento
      notice_type VARCHAR(20) DEFAULT 'indenizado', -- trabalhado, indenizado, dispensado
      notice_start DATE,
      notice_end DATE,
      last_worked_date DATE,
      salary_balance NUMERIC(12,2) DEFAULT 0,
      vacation_due NUMERIC(12,2) DEFAULT 0,
      vacation_proportional NUMERIC(12,2) DEFAULT 0,
      vacation_bonus NUMERIC(12,2) DEFAULT 0,
      thirteenth_proportional NUMERIC(12,2) DEFAULT 0,
      notice_indemnity NUMERIC(12,2) DEFAULT 0,
      fgts_fine NUMERIC(12,2) DEFAULT 0,
      other_credits NUMERIC(12,2) DEFAULT 0,
      other_debits NUMERIC(12,2) DEFAULT 0,
      total_net NUMERIC(12,2) DEFAULT 0,
      checklist JSONB DEFAULT '[]'::jsonb,
      notes TEXT,
      trct_url TEXT,
      esocial_event_id UUID REFERENCES esocial_events(id) ON DELETE SET NULL,
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_terminations_emp ON employee_terminations(employee_id);
    CREATE INDEX IF NOT EXISTS idx_terminations_org ON employee_terminations(organization_id);
  `);

  await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS termination_date DATE`);
  await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS termination_reason VARCHAR(30)`);

  tablesReady = true;
}

router.use(async (_req, _res, next) => { try { await ensureTables(); } catch (e) { logError('rh-flows.ensureTables', e); } next(); });

// ===================== CARGOS (sugestões) =====================
// Retorna cargos já cadastrados na organização + lista curada
router.get('/positions', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    const curated = [
      'Promotor de Vendas','Supervisor','Coordenador','Gerente','Analista de RH',
      'Assistente Administrativo','Auxiliar Administrativo','Motorista','Repositor',
      'Vendedor','Operador de Caixa','Estoquista','Analista Financeiro','Contador',
      'Auxiliar de Limpeza','Assistente de Marketing'
    ];
    let existing = [];
    if (orgId) {
      const r = await query(
        `SELECT DISTINCT position FROM employees
          WHERE organization_id=$1 AND position IS NOT NULL AND position <> ''
          ORDER BY position`, [orgId]);
      existing = r.rows.map(x => x.position);
    }
    const all = Array.from(new Set([...existing, ...curated])).sort((a,b)=>a.localeCompare(b));
    res.json(all);
  } catch (e) { logError('rh-flows.positions', e); res.json([]); }
});



// ===================== DEPENDENTES =====================
router.get('/dependents/:employeeId', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM employee_dependents WHERE employee_id = $1 ORDER BY birth_date NULLS LAST`,
      [req.params.employeeId]
    );
    res.json(r.rows);
  } catch (err) { logError('rh-flows.dependents.list', err); res.status(500).json({ error: 'Erro ao listar dependentes' }); }
});

router.post('/dependents', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    const b = req.body || {};
    if (!b.employee_id || !b.full_name || !b.relationship) return res.status(400).json({ error: 'Campos obrigatórios: employee_id, full_name, relationship' });
    const r = await query(
      `INSERT INTO employee_dependents (organization_id, employee_id, full_name, name, cpf, birth_date, relationship, ir_deduction, family_allowance, disabled, notes)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [orgId, b.employee_id, b.full_name, b.cpf || null, b.birth_date || null, b.relationship,
       !!b.ir_deduction, !!b.family_allowance, !!b.disabled, b.notes || null]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('rh-flows.dependents.create', err); res.status(500).json({ error: 'Erro ao criar dependente' }); }
});

router.put('/dependents/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await query(
      `UPDATE employee_dependents SET full_name=COALESCE($2,full_name), cpf=$3, birth_date=$4,
        relationship=COALESCE($5,relationship), ir_deduction=COALESCE($6,ir_deduction),
        family_allowance=COALESCE($7,family_allowance), disabled=COALESCE($8,disabled),
        notes=$9, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, b.full_name, b.cpf || null, b.birth_date || null, b.relationship,
       b.ir_deduction, b.family_allowance, b.disabled, b.notes || null]
    );
    res.json(r.rows[0]);
  } catch (err) { logError('rh-flows.dependents.update', err); res.status(500).json({ error: 'Erro ao atualizar dependente' }); }
});

router.delete('/dependents/:id', async (req, res) => {
  try { await query(`DELETE FROM employee_dependents WHERE id = $1`, [req.params.id]); res.json({ ok: true }); }
  catch (err) { logError('rh-flows.dependents.delete', err); res.status(500).json({ error: 'Erro ao deletar dependente' }); }
});

// ===================== eSOCIAL — FILA =====================
async function enqueueEsocialEvent({ orgId, employeeId, eventType, payload, referencePeriod }) {
  const r = await query(
    `INSERT INTO esocial_events (organization_id, employee_id, event_type, reference_period, status, payload)
     VALUES ($1,$2,$3,$4,'pendente',$5) RETURNING *`,
    [orgId, employeeId || null, eventType, referencePeriod || null, JSON.stringify(payload || {})]
  );
  return r.rows[0];
}

router.get('/esocial', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const { status, event_type, employee_id } = req.query;
    let sql = `SELECT ev.*, e.full_name as employee_name, e.cpf as employee_cpf
               FROM esocial_events ev LEFT JOIN employees e ON e.id = ev.employee_id
               WHERE ev.organization_id = $1`;
    const params = [orgId]; let i = 2;
    if (status) { sql += ` AND ev.status = $${i++}`; params.push(status); }
    if (event_type) { sql += ` AND ev.event_type = $${i++}`; params.push(event_type); }
    if (employee_id) { sql += ` AND ev.employee_id = $${i++}`; params.push(employee_id); }
    sql += ` ORDER BY ev.created_at DESC LIMIT 500`;
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) { logError('rh-flows.esocial.list', err); res.status(500).json({ error: 'Erro ao listar eventos eSocial' }); }
});

router.post('/esocial/:id/generate-xml', async (req, res) => {
  try {
    const ev = (await query(`SELECT ev.*, e.* FROM esocial_events ev LEFT JOIN employees e ON e.id = ev.employee_id WHERE ev.id=$1`, [req.params.id])).rows[0];
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const xml = buildEsocialXml(ev);
    await query(`UPDATE esocial_events SET xml_content=$2, status='gerado', updated_at=NOW() WHERE id=$1`, [req.params.id, xml]);
    res.json({ ok: true, xml });
  } catch (err) { logError('rh-flows.esocial.generate-xml', err); res.status(500).json({ error: 'Erro ao gerar XML' }); }
});

router.post('/esocial/:id/mark-sent', async (req, res) => {
  try {
    const { protocol, receipt } = req.body || {};
    await query(`UPDATE esocial_events SET status='enviado', protocol=$2, receipt=$3, sent_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.params.id, protocol || null, receipt || null]);
    res.json({ ok: true });
  } catch (err) { logError('rh-flows.esocial.mark-sent', err); res.status(500).json({ error: 'Erro ao marcar enviado' }); }
});

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function buildEsocialXml(ev) {
  const p = ev.payload || {};
  const empCpf = String(ev.cpf || p.cpf || '').replace(/\D/g,'');
  const empName = ev.full_name || p.full_name || '';
  const now = new Date().toISOString();
  if (ev.event_type === 'S-2200') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtAdmissao/v_S_01_02_00">
  <evtAdmissao Id="ID${Date.now()}">
    <ideEvento><indRetif>1</indRetif><nrRecibo/><tpAmb>${ev.environment === 'producao' ? 1 : 2}</tpAmb><procEmi>1</procEmi><verProc>1.0</verProc></ideEvento>
    <ideEmpregador><tpInsc>1</tpInsc><nrInsc>${esc(p.cnpj || '')}</nrInsc></ideEmpregador>
    <trabalhador>
      <cpfTrab>${empCpf}</cpfTrab>
      <nmTrab>${esc(empName)}</nmTrab>
      <sexo>${p.gender === 'F' ? 'F' : 'M'}</sexo>
      <dtNascto>${esc(p.birth_date || '')}</dtNascto>
      <vinculo>
        <matricula>${esc(p.registration_number || '')}</matricula>
        <tpRegTrab>1</tpRegTrab>
        <infoRegimeTrab><infoCeletista>
          <dtAdm>${esc(p.admission_date || '')}</dtAdm>
          <tpAdmissao>1</tpAdmissao>
          <indAdmissao>1</indAdmissao>
          <tpRegJor>1</tpRegJor>
          <natAtividade>1</natAtividade>
        </infoCeletista></infoRegimeTrab>
      </vinculo>
    </trabalhador>
  </evtAdmissao>
</eSocial>`;
  }
  if (ev.event_type === 'S-2299') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtDeslig/v_S_01_02_00">
  <evtDeslig Id="ID${Date.now()}">
    <ideEvento><indRetif>1</indRetif><tpAmb>${ev.environment === 'producao' ? 1 : 2}</tpAmb><procEmi>1</procEmi><verProc>1.0</verProc></ideEvento>
    <ideEmpregador><tpInsc>1</tpInsc><nrInsc>${esc(p.cnpj || '')}</nrInsc></ideEmpregador>
    <ideVinculo><cpfTrab>${empCpf}</cpfTrab><matricula>${esc(p.registration_number || '')}</matricula></ideVinculo>
    <infoDeslig>
      <mtvDeslig>${esc(p.reason_code_esocial || '02')}</mtvDeslig>
      <dtDeslig>${esc(p.termination_date || '')}</dtDeslig>
      <indPagtoAPI>N</indPagtoAPI>
    </infoDeslig>
  </evtDeslig>
</eSocial>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><eSocial><meta type="${esc(ev.event_type)}" generatedAt="${now}"/></eSocial>`;
}

// ===================== ADMISSÃO — Wizard finish =====================
// Cria colaborador, dependentes, ativa acesso ao app (opcional), enfileira S-2200
router.post('/admission', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada' });
    const b = req.body || {};
    if (!b.employee_id) return res.status(400).json({ error: 'employee_id é obrigatório (crie o colaborador primeiro)' });

    // Dependentes em lote
    if (Array.isArray(b.dependents)) {
      for (const d of b.dependents) {
        if (!d.full_name || !d.relationship) continue;
        await query(
          `INSERT INTO employee_dependents (organization_id, employee_id, full_name, name, cpf, birth_date, relationship, ir_deduction, family_allowance, disabled)
           VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9)`,
          [orgId, b.employee_id, d.full_name, d.cpf || null, d.birth_date || null, d.relationship,
           !!d.ir_deduction, !!d.family_allowance, !!d.disabled]
        );
      }
    }

    // Dados do colaborador para payload
    const empRow = (await query(`SELECT * FROM employees WHERE id = $1`, [b.employee_id])).rows[0];
    if (!empRow) return res.status(404).json({ error: 'Colaborador não encontrado' });

    // Ativar acesso ao app (se marcado)
    if (b.enable_app_access) {
      await query(`
        CREATE TABLE IF NOT EXISTS collaborator_app_access (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id UUID NOT NULL,
          employee_id UUID UNIQUE NOT NULL,
          access_status VARCHAR(30) DEFAULT 'liberado',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await query(
        `INSERT INTO collaborator_app_access (organization_id, employee_id, access_status)
         VALUES ($1,$2,'liberado')
         ON CONFLICT (employee_id) DO UPDATE SET access_status='liberado', updated_at=NOW()`,
        [orgId, b.employee_id]
      );
    }

    // Atribuir jornada (opcional)
    if (b.schedule_id) {
      try {
        await query(
          `UPDATE employee_schedules SET active=false, end_date=CURRENT_DATE
             WHERE employee_id=$1 AND active=true`, [b.employee_id]);
        await query(
          `INSERT INTO employee_schedules (organization_id, employee_id, schedule_id, start_date, active)
           VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE), true)`,
          [orgId, b.employee_id, b.schedule_id, empRow.admission_date || null]
        );
      } catch (e) { logError('rh-flows.admission.schedule', e); }
    }

    // Documentos de admissão em lote
    if (Array.isArray(b.documents)) {
      for (const d of b.documents) {
        if (!d?.doc_type || !d?.file_url) continue;
        try {
          await query(
            `INSERT INTO employee_documents (employee_id, doc_type, title, file_url, expiry_date, notes)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [b.employee_id, d.doc_type, d.title || d.doc_type, d.file_url, d.expiry_date || null, d.notes || null]
          );
        } catch (e) { logError('rh-flows.admission.doc', e); }
      }
    }


    // Enfileira S-2200
    const event = await enqueueEsocialEvent({
      orgId, employeeId: b.employee_id, eventType: 'S-2200',
      payload: {
        cpf: empRow.cpf, full_name: empRow.full_name, birth_date: empRow.birth_date,
        gender: empRow.gender, admission_date: empRow.admission_date,
        registration_number: empRow.registration_number,
        cnpj: empRow.cnpj, salary: empRow.salary,
      },
    });

    res.json({ ok: true, employee_id: b.employee_id, esocial_event_id: event.id, message: 'Admissão finalizada. Evento S-2200 enfileirado.' });
  } catch (err) {
    logError('rh-flows.admission', err, { body: req.body });
    res.status(500).json({ error: 'Erro ao finalizar admissão', details: err?.message });
  }
});

// ===================== DEMISSÃO =====================
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function monthsBetween(from, to) {
  if (!from || !to) return 0;
  const f = new Date(from), t = new Date(to);
  return (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth()) + (t.getDate() >= f.getDate() ? 0 : -1);
}
function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth()+1, 0).getDate(); }

function calcRescission({ salary, admission_date, termination_date, reason_code, notice_type, fgts_balance }) {
  const s = num(salary); if (!s || !admission_date || !termination_date) return null;
  const adm = new Date(admission_date); const term = new Date(termination_date);
  const yearsThisJob = (term - adm) / (365.25 * 86400000);
  const acquisitiveMonths = monthsBetween(adm, term) % 12; // simplificado
  const yearMonthsWorked = term.getMonth() + 1; // meses no ano de saída (para 13º)
  const dayOfMonth = term.getDate();
  const daysWorkedMonth = dayOfMonth;
  const dailyRate = s / 30;

  const salary_balance = +(dailyRate * daysWorkedMonth).toFixed(2);
  // Férias vencidas: se >= 12 meses e não gozadas — simplificado 0 (o RH informa)
  const vacation_due = 0;
  const vacation_proportional = +((s / 12) * (acquisitiveMonths || 0)).toFixed(2);
  const vacation_bonus = +((vacation_due + vacation_proportional) / 3).toFixed(2);
  const thirteenth_proportional = +((s / 12) * yearMonthsWorked).toFixed(2);

  let notice_indemnity = 0;
  if (notice_type === 'indenizado' && ['sem_justa_causa', 'acordo_484a'].includes(reason_code)) {
    // Aviso prévio proporcional: 30d + 3d/ano após 1º ano (Lei 12.506) — cap 90d
    const yearsFull = Math.max(0, Math.floor(yearsThisJob));
    const totalDays = Math.min(90, 30 + 3 * yearsFull);
    let factor = 1;
    if (reason_code === 'acordo_484a') factor = 0.5;
    notice_indemnity = +((s / 30) * totalDays * factor).toFixed(2);
  }

  let fgts_fine = 0;
  const bal = num(fgts_balance);
  if (bal > 0) {
    if (reason_code === 'sem_justa_causa') fgts_fine = +(bal * 0.4).toFixed(2);
    else if (reason_code === 'acordo_484a') fgts_fine = +(bal * 0.2).toFixed(2);
  }

  const total_net = +(salary_balance + vacation_due + vacation_proportional + vacation_bonus +
    thirteenth_proportional + notice_indemnity + fgts_fine).toFixed(2);

  return { salary_balance, vacation_due, vacation_proportional, vacation_bonus, thirteenth_proportional, notice_indemnity, fgts_fine, total_net };
}

router.post('/termination/preview', async (req, res) => {
  try {
    const b = req.body || {};
    let salary = b.salary, admission = b.admission_date;
    if (b.employee_id && (!salary || !admission)) {
      const emp = (await query(`SELECT salary, admission_date FROM employees WHERE id=$1`, [b.employee_id])).rows[0];
      if (emp) { salary = salary ?? emp.salary; admission = admission ?? emp.admission_date; }
    }
    const calc = calcRescission({ salary, admission_date: admission, termination_date: b.termination_date, reason_code: b.reason_code, notice_type: b.notice_type, fgts_balance: b.fgts_balance });
    res.json(calc || { error: 'Dados insuficientes' });
  } catch (err) { logError('rh-flows.termination.preview', err); res.status(500).json({ error: 'Erro no cálculo' }); }
});

router.post('/termination', async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    const b = req.body || {};
    if (!b.employee_id || !b.termination_date || !b.reason_code) return res.status(400).json({ error: 'Campos obrigatórios: employee_id, termination_date, reason_code' });

    const emp = (await query(`SELECT * FROM employees WHERE id = $1`, [b.employee_id])).rows[0];
    if (!emp) return res.status(404).json({ error: 'Colaborador não encontrado' });

    const calc = calcRescission({
      salary: emp.salary, admission_date: emp.admission_date, termination_date: b.termination_date,
      reason_code: b.reason_code, notice_type: b.notice_type || 'indenizado', fgts_balance: b.fgts_balance,
    }) || {};

    // Persistir rescisão
    const t = await query(
      `INSERT INTO employee_terminations (organization_id, employee_id, termination_date, reason_code, notice_type, notice_start, notice_end, last_worked_date,
        salary_balance, vacation_due, vacation_proportional, vacation_bonus, thirteenth_proportional, notice_indemnity, fgts_fine, other_credits, other_debits, total_net,
        checklist, notes, trct_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [orgId, b.employee_id, b.termination_date, b.reason_code, b.notice_type || 'indenizado',
       b.notice_start || null, b.notice_end || null, b.last_worked_date || null,
       num(b.salary_balance ?? calc.salary_balance), num(b.vacation_due ?? calc.vacation_due),
       num(b.vacation_proportional ?? calc.vacation_proportional), num(b.vacation_bonus ?? calc.vacation_bonus),
       num(b.thirteenth_proportional ?? calc.thirteenth_proportional), num(b.notice_indemnity ?? calc.notice_indemnity),
       num(b.fgts_fine ?? calc.fgts_fine), num(b.other_credits), num(b.other_debits),
       num(b.total_net ?? calc.total_net),
       JSON.stringify(Array.isArray(b.checklist) ? b.checklist : []),
       b.notes || null, b.trct_url || null, req.userId]
    );

    // Atualiza colaborador
    await query(
      `UPDATE employees SET status='desligado', termination_date=$2, termination_reason=$3, updated_at=NOW() WHERE id=$1`,
      [b.employee_id, b.termination_date, b.reason_code]
    );

    // Revoga acesso ao app
    await query(`UPDATE collaborator_app_access SET access_status='desligado', updated_at=NOW() WHERE employee_id=$1`, [b.employee_id]).catch(()=>{});

    // Enfileira S-2299
    const reason_code_esocial_map = { sem_justa_causa: '02', justa_causa: '03', pedido_colaborador: '07', acordo_484a: '11', fim_experiencia: '02', fim_exp_colaborador: '07', fim_exp_empresa: '02', aposentadoria: '09', morte: '17', pj_encerramento: '05' };
    const event = await enqueueEsocialEvent({
      orgId, employeeId: b.employee_id, eventType: 'S-2299',
      payload: {
        cpf: emp.cpf, full_name: emp.full_name,
        registration_number: emp.registration_number, cnpj: emp.cnpj,
        termination_date: b.termination_date, reason_code: b.reason_code,
        reason_code_esocial: reason_code_esocial_map[b.reason_code] || '02',
      },
    });

    await query(`UPDATE employee_terminations SET esocial_event_id=$2 WHERE id=$1`, [t.rows[0].id, event.id]);

    res.json({ ok: true, termination: t.rows[0], esocial_event_id: event.id });
  } catch (err) {
    logError('rh-flows.termination', err, { body: req.body });
    res.status(500).json({ error: 'Erro ao processar demissão', details: err?.message });
  }
});

router.get('/terminations', async (req, res) => {
  try {
    const orgId = req.query.org_id || await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);
    const r = await query(
      `SELECT t.*, e.full_name as employee_name, e.cpf as employee_cpf, e.position
       FROM employee_terminations t JOIN employees e ON e.id = t.employee_id
       WHERE t.organization_id = $1 ORDER BY t.termination_date DESC LIMIT 500`, [orgId]);
    res.json(r.rows);
  } catch (err) { logError('rh-flows.terminations.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/terminations/:id', async (req, res) => {
  try {
    const r = await query(
      `SELECT t.*, e.full_name as employee_name, e.cpf as employee_cpf, e.position, e.admission_date, e.salary
       FROM employee_terminations t JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`,
      [req.params.id]);
    res.json(r.rows[0] || null);
  } catch (err) { logError('rh-flows.terminations.get', err); res.status(500).json({ error: 'Erro' }); }
});

export default router;
