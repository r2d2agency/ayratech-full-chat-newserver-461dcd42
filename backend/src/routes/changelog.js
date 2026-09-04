import express from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logError } from '../logger.js';

const router = express.Router();
router.use(authenticate);

// Changelog do produto: registro interno (visível para qualquer admin autenticado,
// independente da organização) de bugs corrigidos e melhorias entregues no app.
// Não é escopado por organization_id de propósito — documenta mudanças na
// plataforma compartilhada, não dados de um cliente específico.
let ensured = false;
const SEED_ENTRIES = [
  {
    entry_date: '2026-09-04', type: 'melhoria', area: "Fotos e marca d'água",
    title: 'Nome da categoria não aparecia na foto',
    problem_text: "A marca d'água mostrava PDV, marca e promotor, mas não o nome da categoria fotografada.",
    solution_text: 'A categoria agora aparece na foto, nos três pontos de captura (categoria antes, ponto extra e categoria depois).',
    ref: '13898751',
  },
  {
    entry_date: '2026-09-04', type: 'bug', area: "Fotos e marca d'água",
    title: 'Nome do promotor ausente no check-in/checkout da loja',
    problem_text: 'Nas fotos de fachada (check-in e checkout do PDV), o nome do promotor só aparecia no texto abaixo da foto — nunca gravado na própria imagem.',
    solution_text: "Nome do promotor incluído na marca d'água dessas duas fotos.",
    ref: '7fea989e',
  },
  {
    entry_date: '2026-09-04', type: 'bug', area: 'Checklist e conclusão de categoria',
    title: 'Checklist errado sendo aplicado',
    problem_text: 'Quando um PDV tinha mais de um checklist configurado para o mesmo dia, o sistema misturava as regras dos dois. Um checklist "somente foto de Depois" acabava exigindo também a foto de Antes, vinda de um checklist antigo.',
    solution_text: 'O checklist mais específico para aquele dia passa a valer sozinho, sem ser misturado com um checklist genérico de "todos os dias" configurado anteriormente.',
    ref: '3dbd0608',
  },
  {
    entry_date: '2026-09-04', type: 'bug', area: 'Perímetro do PDV e GPS',
    title: 'Check-in recusado mesmo dentro do raio cadastrado',
    problem_text: 'Em PDVs com um polígono de perímetro desenhado manualmente no mapa, o polígono substituía totalmente o raio na validação. Se o polígono tivesse qualquer imprecisão, promotores no local certo eram recusados.',
    solution_text: 'O raio cadastrado agora funciona como margem de segurança extra: o check-in é aceito dentro do polígono OU do raio.',
    ref: '6bcae4b4',
  },
  {
    entry_date: '2026-09-04', type: 'bug', area: 'Checklist e conclusão de categoria',
    title: 'Atalho fechava categoria com menos fotos que o exigido',
    problem_text: 'O painel "Fotos", ao lado do nome da categoria, marcava a categoria como concluída com apenas 1 foto extra, mesmo quando o checklist exigia mais de uma foto de Depois.',
    solution_text: 'Esse atalho agora respeita o mesmo mínimo de fotos configurado no checklist, igual ao fluxo principal.',
    ref: 'fe58eef4',
  },
  {
    entry_date: '2026-09-04', type: 'bug', area: 'Checklist e conclusão de categoria',
    title: 'Barra de progresso demorava para atualizar',
    problem_text: 'Depois de uma categoria ser liberada ou concluída, a rota só buscava dados atualizados do servidor a cada 30 minutos — a barra de progresso ficava parada até lá.',
    solution_text: 'A rota agora atualiza sozinha logo após cada categoria concluída.',
    ref: '34fe48dc',
  },
  {
    entry_date: '2026-09-04', type: 'melhoria', area: 'Checklist e conclusão de categoria',
    title: 'Falha no envio da foto não avisava ninguém',
    problem_text: 'Se o envio de uma foto falhasse por qualquer motivo, o app não mostrava nenhum aviso — a foto simplesmente "sumia" da tela, sem explicação e sem opção de tentar de novo.',
    solution_text: 'Agora, quando um envio falha, aparece um aviso claro na tela e a câmera libera na hora para tirar a foto de novo.',
    ref: 'c4e88dde',
  },
  {
    entry_date: '2026-09-04', type: 'melhoria', area: 'Checklist e conclusão de categoria',
    title: 'Sem botão para confirmar o envio da foto',
    problem_text: 'Ao atingir o mínimo de fotos, o envio acontecia sozinho, em segundo plano — sem nenhum botão, dificultando saber se a foto realmente tinha sido enviada.',
    solution_text: 'Agora existe um botão verde "Confirmar foto": o promotor vê e controla o momento exato do envio.',
    ref: 'faca42d2',
  },
  {
    entry_date: '2026-09-04', type: 'bug', area: 'Checklist e conclusão de categoria',
    title: 'Causa raiz: falha ao anexar a localização travava o envio da foto',
    problem_text: 'O app tentava ler a localização de GPS de um jeito incompatível com a função usada ao montar o envio da foto de Depois, travando o processo antes mesmo de a foto sair do celular — por isso a categoria nunca fechava.',
    solution_text: 'Corrigido nos três pontos afetados (foto Depois da categoria, foto de ponto extra, e o painel de fotos). Esta era a causa real por trás da categoria nunca fechar.',
    ref: 'ef4ca8a5',
  },
  {
    entry_date: '2026-09-04', type: 'bug', area: "Fotos e marca d'água",
    title: 'Nome do promotor ausente na foto da categoria',
    problem_text: "Mesmo com o dado existindo no sistema, um nome de campo divergente entre o app e o servidor fazia o nome do promotor nunca chegar até a foto da categoria — só aparecia nos metadados fora da imagem, vindos de outra origem.",
    solution_text: "Corrigido dos dois lados (app e servidor). O nome do promotor agora é gravado corretamente na marca d'água de toda foto de categoria.",
    ref: '0bdb0a01',
  },
];

async function ensureChangelogTable() {
  if (ensured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS product_changelog (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        type VARCHAR(20) NOT NULL DEFAULT 'bug',
        area VARCHAR(120),
        title TEXT NOT NULL,
        problem_text TEXT,
        solution_text TEXT,
        ref VARCHAR(40),
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const count = await query('SELECT COUNT(*)::int AS n FROM product_changelog');
    if (count.rows[0]?.n === 0) {
      for (const e of SEED_ENTRIES) {
        await query(
          `INSERT INTO product_changelog (entry_date, type, area, title, problem_text, solution_text, ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [e.entry_date, e.type, e.area, e.title, e.problem_text, e.solution_text, e.ref]
        );
      }
    }
    ensured = true;
  } catch (e) {
    logError('changelog.ensureTable', e);
  }
}

router.use(async (req, res, next) => {
  await ensureChangelogTable();
  next();
});

// List + filter
router.get('/', async (req, res) => {
  try {
    const { type, area, q, date_from, date_to } = req.query;
    let sql = 'SELECT * FROM product_changelog WHERE 1=1';
    const params = [];
    if (type && type !== 'all') { params.push(type); sql += ` AND type=$${params.length}`; }
    if (area && area !== 'all') { params.push(area); sql += ` AND area=$${params.length}`; }
    if (date_from) { params.push(date_from); sql += ` AND entry_date >= $${params.length}`; }
    if (date_to) { params.push(date_to); sql += ` AND entry_date <= $${params.length}`; }
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (title ILIKE $${params.length} OR problem_text ILIKE $${params.length} OR solution_text ILIKE $${params.length} OR area ILIKE $${params.length})`;
    }
    sql += ' ORDER BY entry_date DESC, created_at DESC';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (e) {
    logError('changelog.list', e);
    res.status(500).json({ error: e.message });
  }
});

// Distinct areas, for the filter dropdown
router.get('/areas', async (req, res) => {
  try {
    const r = await query('SELECT DISTINCT area FROM product_changelog WHERE area IS NOT NULL ORDER BY area');
    res.json(r.rows.map((row) => row.area));
  } catch (e) {
    logError('changelog.areas', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { entry_date, type, area, title, problem_text, solution_text, ref } = req.body;
    if (!title) return res.status(400).json({ error: 'Título é obrigatório' });
    const r = await query(
      `INSERT INTO product_changelog (entry_date, type, area, title, problem_text, solution_text, ref, created_by)
       VALUES (COALESCE($1, CURRENT_DATE), $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        entry_date || null,
        type === 'melhoria' ? 'melhoria' : 'bug',
        area || null,
        title,
        problem_text || null,
        solution_text || null,
        ref || null,
        req.userId || null,
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    logError('changelog.create', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { entry_date, type, area, title, problem_text, solution_text, ref } = req.body;
    if (!title) return res.status(400).json({ error: 'Título é obrigatório' });
    const r = await query(
      `UPDATE product_changelog SET
        entry_date=COALESCE($1, entry_date), type=$2, area=$3, title=$4,
        problem_text=$5, solution_text=$6, ref=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [
        entry_date || null,
        type === 'melhoria' ? 'melhoria' : 'bug',
        area || null,
        title,
        problem_text || null,
        solution_text || null,
        ref || null,
        req.params.id,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Registro não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    logError('changelog.update', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM product_changelog WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    logError('changelog.delete', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
