import express from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logInfo, logError, logWarn } from '../logger.js';
import { sendStockCountSummaryForRoute } from './stock-count.js';
import { validatePdvLocation, ensurePdvGeofenceColumn } from '../lib/geofence.js';


const router = express.Router();
router.use((req, res, next) => {
  // Public/tolerant endpoints (handle their own auth)
  if (req.method === 'GET' && req.path === '/photo-quality-config') return next();
  return authenticate(req, res, next);
});

async function getOrgInfo(userId) {
  const r = await query('SELECT organization_id, brand_id FROM organization_members WHERE user_id=$1 LIMIT 1', [userId]);
  return r.rows[0];
}

async function hasColumn(tableName, columnName) {
  const result = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
}

async function hasTable(tableName) {
  const result = await query(`SELECT to_regclass($1) AS table_ref`, [`public.${tableName}`]);
  return Boolean(result.rows[0]?.table_ref);
}

function getDatePart(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function parseDateAtNoon(value) {
  const part = getDatePart(value);
  const match = part.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function computeStockPeriodWindow(date, frequency = 'weekly', interval = 1, customDays = null) {
  const d = parseDateAtNoon(date);
  const monthsMap = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, annual: 12 };
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const weeks = frequency === 'biweekly' ? 2 : 1;
    const dow = (d.getDay() + 6) % 7;
    const monday = new Date(d); monday.setDate(d.getDate() - dow);
    const anchor = new Date(1970, 0, 5, 12, 0, 0, 0);
    const diffWeeks = Math.floor((monday - anchor) / (7 * 86400000));
    const bucketIdx = Math.floor(diffWeeks / (weeks * (interval || 1)));
    const start = new Date(anchor.getTime() + bucketIdx * weeks * (interval || 1) * 7 * 86400000);
    const end = new Date(start); end.setDate(start.getDate() + weeks * (interval || 1) * 7 - 1);
    return { start: formatLocalDate(start), end: formatLocalDate(end) };
  }
  if (monthsMap[frequency]) {
    const step = monthsMap[frequency] * (interval || 1);
    const monthsSinceAnchor = (d.getFullYear() - 1970) * 12 + d.getMonth();
    const bucketIdx = Math.floor(monthsSinceAnchor / step);
    const startMonthAbs = bucketIdx * step;
    const startYear = 1970 + Math.floor(startMonthAbs / 12);
    const startMonth = startMonthAbs % 12;
    const start = new Date(startYear, startMonth, 1, 12);
    const end = new Date(startYear, startMonth + step, 0, 12);
    return { start: formatLocalDate(start), end: formatLocalDate(end) };
  }
  if (frequency === 'custom' && customDays && customDays > 0) {
    const anchor = new Date(1970, 0, 5, 12, 0, 0, 0);
    const diffDays = Math.floor((d - anchor) / 86400000);
    const bucketIdx = Math.floor(diffDays / customDays);
    const start = new Date(anchor.getTime() + bucketIdx * customDays * 86400000);
    const end = new Date(start.getTime() + (customDays - 1) * 86400000);
    return { start: formatLocalDate(start), end: formatLocalDate(end) };
  }
  const dow = (d.getDay() + 6) % 7;
  const monday = new Date(d); monday.setDate(d.getDate() - dow);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return { start: formatLocalDate(monday), end: formatLocalDate(sunday) };
}

function parseJsonMaybe(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

// ============================================================
// Multi-checklist por marca/rota (checklists complementares)
// Uma rota pode ter vários checklists da mesma marca, cada um com
// sua própria recorrência (dias da semana). Na data da visita os
// checklists aplicáveis são mesclados num "checklist efetivo".
// ============================================================

const EFF_CHECKLIST_COLUMNS = [
  ['eff_require_checkin_photo', 'BOOLEAN'],
  ['eff_require_checkout_photo', 'BOOLEAN'],
  ['eff_require_stock_count', 'BOOLEAN'],
  ['eff_require_validity_check', 'BOOLEAN'],
  ['eff_require_extra_point', 'BOOLEAN'],
  ['eff_require_category_photos', 'BOOLEAN'],
  ['eff_category_photo_mode', 'VARCHAR(20)'],
  ['eff_min_category_photos_before', 'INT'],
  ['eff_min_category_photos_after', 'INT'],
  ['eff_checklist_type', 'VARCHAR(20)'],
];

let checklistMergeColumnsReady = null;
async function ensureChecklistMergeColumns() {
  if (checklistMergeColumnsReady) return checklistMergeColumnsReady;
  checklistMergeColumnsReady = (async () => {
    for (const table of ['merch_routes', 'route_brands']) {
      try {
        await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS checklist_ids JSONB`);
        for (const [col, type] of EFF_CHECKLIST_COLUMNS) {
          await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`);
        }
      } catch (e) { /* tabela pode não existir ainda */ }
    }
  })().catch(() => {});
  return checklistMergeColumnsReady;
}

// Normaliza o payload de checklists de uma marca:
// aceita { checklists: [{checklist_id, weekdays}] } ou o legado { checklist_id, weekdays }
function normalizeBrandChecklists(mb) {
  if (!mb) return [];
  if (Array.isArray(mb.checklists) && mb.checklists.length > 0) {
    return mb.checklists
      .filter((c) => c && c.checklist_id)
      .map((c) => ({
        checklist_id: c.checklist_id,
        weekdays: Array.isArray(c.weekdays) ? c.weekdays.map(Number) : [],
      }));
  }
  if (mb.checklist_id) {
    return [{ checklist_id: mb.checklist_id, weekdays: Array.isArray(mb.weekdays) ? mb.weekdays.map(Number) : [] }];
  }
  return [];
}

// Retorna os checklists da marca aplicáveis numa data (0=Dom..6=Sáb).
// Checklist sem dias definidos aplica-se em todas as datas geradas.
function checklistsForWeekday(entries, weekday) {
  if (!entries || entries.length === 0) return [];
  const applicable = entries.filter((c) => !c.weekdays || c.weekdays.length === 0 || c.weekdays.includes(weekday));
  return applicable;
}

function mergePhotoModes(modes) {
  const set = new Set(modes.filter(Boolean));
  if (set.size === 0) return null;
  if (set.has('both')) return 'both';
  if (set.has('before') && set.has('after')) return 'both';
  return [...set][0];
}

// Mescla N checklists num objeto efetivo (união das exigências)
async function computeMergedChecklist(checklistIds) {
  const ids = [...new Set((checklistIds || []).filter(Boolean))];
  if (ids.length === 0) return null;
  let rows = [];
  try {
    const r = await query(`SELECT * FROM brand_checklists WHERE id = ANY($1::uuid[])`, [ids]);
    rows = r.rows;
  } catch (e) { return null; }
  if (rows.length === 0) return null;

  const anyTrue = (field, def = false) => rows.some((r) => (r[field] === undefined || r[field] === null ? def : r[field]) === true);
  const maxInt = (field, def) => rows.reduce((acc, r) => {
    const v = r[field] == null ? def : parseInt(r[field], 10);
    return Number.isFinite(v) ? Math.max(acc, v) : acc;
  }, 0);
  // Determina o tipo efetivo: se QUALQUER checklist for "standard" (exige produtos),
  // domina. Apenas retorna checkin_only se TODOS forem checkin_only.
  const allCheckinOnly = rows.every((r) => (r.checklist_type || 'standard') === 'checkin_only');
  const effChecklistType = allCheckinOnly && rows.length > 0 ? 'checkin_only' : 'standard';

  return {
    checklist_ids: ids,
    eff_require_checkin_photo: anyTrue('require_checkin_photo', true),
    eff_require_checkout_photo: anyTrue('require_checkout_photo', false),
    eff_require_stock_count: effChecklistType === 'standard' ? anyTrue('require_stock_count', false) : false,
    eff_require_validity_check: effChecklistType === 'standard' ? anyTrue('require_validity_check', false) : false,
    eff_require_extra_point: anyTrue('require_extra_point', false),
    eff_require_category_photos: effChecklistType === 'standard' ? anyTrue('require_category_photos', true) : false,
    eff_category_photo_mode: mergePhotoModes(rows.map((r) => r.category_photo_mode || 'both')) || 'both',
    eff_min_category_photos_before: maxInt('min_category_photos_before', 1) || 0,
    eff_min_category_photos_after: maxInt('min_category_photos_after', 1) || 0,
    eff_checklist_type: effChecklistType,
  };
}

// Persiste o checklist efetivo mesclado numa linha de merch_routes ou route_brands
async function persistMergedChecklist(table, rowId, checklistIds) {
  try {
    await ensureChecklistMergeColumns();
    const merged = await computeMergedChecklist(checklistIds);
    if (!merged) {
      await query(`UPDATE ${table} SET checklist_ids=NULL WHERE id=$1`, [rowId]).catch(() => {});
      return null;
    }
    const cols = EFF_CHECKLIST_COLUMNS.map(([c]) => c);
    const sets = cols.map((c, i) => `${c}=$${i + 3}`).join(', ');
    await query(
      `UPDATE ${table} SET checklist_ids=$2::jsonb, ${sets} WHERE id=$1`,
      [rowId, JSON.stringify(merged.checklist_ids), ...cols.map((c) => merged[c])]
    );
    return merged;
  } catch (e) {
    logWarn('persistMergedChecklist.failed', { table, rowId, error: e?.message });
    return null;
  }
}

// Re-aplica o checklist efetivo nas rotas FUTURAS/não concluídas que usam este checklist.
// Necessário para que ajustes no checklist (ex.: "só foto DEPOIS") valham imediatamente
// em rotas já agendadas, cujos campos eff_* foram congelados na criação.
export async function resyncChecklistOnFutureRoutes(checklistId) {
  if (!checklistId) return;
  try {
    await ensureChecklistMergeColumns();
    const routes = await query(
      `SELECT id, checklist_ids, checklist_id FROM merch_routes
       WHERE status NOT IN ('completed','cancelled')
         AND visit_date >= CURRENT_DATE
         AND (checklist_id = $1 OR checklist_ids @> to_jsonb($1::text))`,
      [checklistId]
    ).catch(() => ({ rows: [] }));
    for (const r of routes.rows) {
      const ids = Array.isArray(r.checklist_ids) && r.checklist_ids.length ? r.checklist_ids : [r.checklist_id].filter(Boolean);
      await persistMergedChecklist('merch_routes', r.id, ids);
    }

    const brands = await query(
      `SELECT rb.id, rb.checklist_ids, rb.checklist_id FROM route_brands rb
       JOIN merch_routes r ON r.id = rb.route_id
       WHERE r.status NOT IN ('completed','cancelled')
         AND r.visit_date >= CURRENT_DATE
         AND (rb.checklist_id = $1 OR rb.checklist_ids @> to_jsonb($1::text))`,
      [checklistId]
    ).catch(() => ({ rows: [] }));
    for (const rb of brands.rows) {
      const ids = Array.isArray(rb.checklist_ids) && rb.checklist_ids.length ? rb.checklist_ids : [rb.checklist_id].filter(Boolean);
      await persistMergedChecklist('route_brands', rb.id, ids);
    }
  } catch (e) {
    logWarn('resyncChecklistOnFutureRoutes.failed', { checklistId, error: e?.message });
  }
}


// Marca has_stock_count também quando o CHECKLIST da rota (ou de qualquer marca da
// rota) exige contagem de saldo — não só quando existe regra em stock_count_rules.
// Assim o ícone/tag de saldo fica visual no dia e na rota.
async function enrichStockCountFromChecklists(rows) {
  try {
    if (!Array.isArray(rows) || rows.length === 0) return;
    if (!(await hasTable('brand_checklists'))) return;
    await ensureChecklistMergeColumns();
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (!ids.length) return;
    const r = await query(
      `SELECT rt.id,
              (
                COALESCE(rt.eff_require_stock_count, false)
                OR COALESCE(rc.require_stock_count, false)
                OR EXISTS (
                  SELECT 1 FROM route_brands rb
                   LEFT JOIN brand_checklists bc ON bc.id = rb.checklist_id
                   WHERE rb.route_id = rt.id
                     AND (COALESCE(rb.eff_require_stock_count, false) OR COALESCE(bc.require_stock_count, false))
                )
              ) AS checklist_stock_count
         FROM merch_routes rt
         LEFT JOIN brand_checklists rc ON rc.id = rt.checklist_id
        WHERE rt.id = ANY($1::uuid[])`,
      [ids]
    );
    const flag = new Map(r.rows.map((x) => [x.id, x.checklist_stock_count === true]));
    for (const row of rows) {
      if (flag.get(row.id)) {
        row.has_stock_count = true;
        if (!row.stock_count_source) row.stock_count_source = 'checklist';
      }
    }
  } catch (e) {
    logWarn('routes.stock_count_checklist_flag_failed', { error: e?.message });
  }
}


// Fallback: create stock_count_executions on-demand for any matching rule that
// doesn't have one yet (covers routes scheduled before the rule was created).
async function ensureStockCountExecutionsForRoute(route) {
  try {
    if (!(await hasTable('stock_count_rules')) || !(await hasTable('stock_count_executions'))) return;
    const brandIds = new Set();
    if (route.brand_id) brandIds.add(route.brand_id);
    try {
      const rb = await query('SELECT brand_id FROM route_brands WHERE route_id=$1', [route.id]);
      for (const row of rb.rows) if (row.brand_id) brandIds.add(row.brand_id);
    } catch {}
    if (!brandIds.size) return;

    const rules = (await query(
      `SELECT * FROM stock_count_rules WHERE organization_id=$1 AND enabled=true AND brand_id = ANY($2::uuid[])`,
      [route.organization_id, Array.from(brandIds)]
    )).rows;
    const visitDow = parseDateAtNoon(route.visit_date).getDay();
    for (const rule of rules) {
      const overrides = parseJsonMaybe(rule.pdv_overrides, null);
      const pdvOv = overrides && route.pdv_id ? overrides[route.pdv_id] : null;
      const effectiveWd = pdvOv && Array.isArray(pdvOv.weekdays)
        ? pdvOv.weekdays
        : parseJsonMaybe(rule.weekdays, Array.isArray(rule.weekdays) ? rule.weekdays : null);
      if (effectiveWd && effectiveWd.length && !effectiveWd.map(Number).includes(visitDow)) continue;
      const { start, end } = computeStockPeriodWindow(route.visit_date, rule.frequency, rule.frequency_interval || 1, rule.custom_days);
      const existing = (await query(
        `SELECT id, status, route_id FROM stock_count_executions
         WHERE organization_id=$1 AND brand_id=$2 AND pdv_id=$3 AND week_start=$4 LIMIT 1`,
        [route.organization_id, rule.brand_id, route.pdv_id, start]
      )).rows[0];
      if (existing) {
        // Self-heal: if marked justified/postponed without any actual record, revert to pending
        if (existing.status === 'justified' || existing.status === 'postponed') {
          let hasRecord = false;
          try {
            const table = existing.status === 'justified' ? 'stock_count_justifications' : 'stock_count_postponements';
            const rec = await query(`SELECT 1 FROM ${table} WHERE execution_id=$1 LIMIT 1`, [existing.id]);
            hasRecord = rec.rowCount > 0;
          } catch { hasRecord = true; /* if table missing, don't reset */ }
          if (!hasRecord) {
            await query(
              `UPDATE stock_count_executions SET status='pending', route_id=$1, updated_at=NOW() WHERE id=$2`,
              [route.id, existing.id]
            );
          }
        }
        continue;
      }
      await query(
        `INSERT INTO stock_count_executions
         (organization_id, route_id, brand_id, pdv_id, promoter_id, rule_id, status, week_start, week_end)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
        [route.organization_id, route.id, rule.brand_id, route.pdv_id, route.promoter_id, rule.id, start, end]
      );
    }
  } catch (err) {
    logWarn('stock_count.ensure_executions_failed', err);
  }
}

async function getMissingMandatoryStockCountsForRoute(route) {
  try {
    if (!(await hasTable('stock_count_rules')) || !(await hasTable('stock_count_executions'))) return [];
    const brandIds = new Set();
    if (route.brand_id) brandIds.add(route.brand_id);
    try {
      const rb = await query('SELECT brand_id FROM route_brands WHERE route_id=$1', [route.id]);
      for (const row of rb.rows) if (row.brand_id) brandIds.add(row.brand_id);
    } catch {}
    if (!brandIds.size) return [];

    const rules = (await query(
      `SELECT * FROM stock_count_rules WHERE organization_id=$1 AND enabled=true AND brand_id = ANY($2::uuid[])`,
      [route.organization_id, Array.from(brandIds)]
    )).rows;
    const visitDow = parseDateAtNoon(route.visit_date).getDay();
    const missing = [];
    for (const rule of rules) {
      const mustBlock = rule.block_route_completion === true || rule.allow_postpone === false;
      if (!mustBlock) continue;
      const overrides = parseJsonMaybe(rule.pdv_overrides, null);
      const pdvOv = overrides && route.pdv_id ? overrides[route.pdv_id] : null;
      const effectiveWd = pdvOv && Array.isArray(pdvOv.weekdays)
        ? pdvOv.weekdays
        : parseJsonMaybe(rule.weekdays, Array.isArray(rule.weekdays) ? rule.weekdays : null);
      if (effectiveWd && effectiveWd.length && !effectiveWd.map(Number).includes(visitDow)) continue;
      const { start } = computeStockPeriodWindow(route.visit_date, rule.frequency, rule.frequency_interval || 1, rule.custom_days);
      const exec = (await query(
        `SELECT status FROM stock_count_executions
         WHERE organization_id=$1 AND brand_id=$2 AND pdv_id=$3 AND week_start=$4
         ORDER BY (route_id=$5) DESC, updated_at DESC LIMIT 1`,
        [route.organization_id, rule.brand_id, route.pdv_id, start, route.id]
      )).rows[0];
      if (!exec || !['completed', 'justified'].includes(exec.status)) missing.push(rule.brand_id);
    }
    return missing;
  } catch (err) {
    logWarn('stock_count.mandatory_check_failed', err);
    return [];
  }
}

// ===== ADMIN ROUTES =====

// List routes with filters
router.get('/routes', async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    if (!orgInfo?.organization_id) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgInfo.organization_id;

    let { promoter_id, brand_id, pdv_id, status, date_from, date_to, supervisor_id } = req.query;
    // Force brand filter if user is linked to a specific brand
    if (orgInfo.brand_id) brand_id = orgInfo.brand_id;
    
    // Safety check for photos table
    let checkinCol = 'checkin_photo_url';
    let checkoutCol = 'checkout_photo_url';
    try {
      const colCheck = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='merch_routes' AND column_name='checkin_photo'`);
      if (colCheck.rows.length) checkinCol = 'checkin_photo';
      const colCheck2 = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='merch_routes' AND column_name='checkout_photo'`);
      if (colCheck2.rows.length) checkoutCol = 'checkout_photo';
    } catch {}

    const hasProductExecutions = await hasTable('route_product_executions').catch(() => false);
    const productCountSelect = hasProductExecutions
      ? `COALESCE(pc.total_products, 0) as total_products,
                COALESCE(pc.completed_products, 0) as completed_products`
      : `0 as total_products,
                0 as completed_products`;
    const productCountJoin = hasProductExecutions
      ? `LEFT JOIN LATERAL (
                 SELECT COUNT(*)::int as total_products,
                        COUNT(*) FILTER (WHERE status = 'completed')::int as completed_products
                 FROM route_product_executions rpe
                 WHERE rpe.route_id = r.id
               ) pc ON true`
      : '';

    let sql = `SELECT r.*, e.full_name as promoter_name, p.name as pdv_name, p.city as pdv_city, b.name as brand_name,
               sv.full_name as supervisor_name, bc.name as checklist_name,
               r.checkin_at, r.checkout_at, r.completed_at, COALESCE(r.progress_pct, 0) as progress_pct,
               r.${checkinCol} as checkin_photo,
               r.${checkoutCol} as checkout_photo,
                ${productCountSelect}
               FROM merch_routes r
               LEFT JOIN employees e ON e.id = r.promoter_id
               LEFT JOIN pdvs p ON p.id = r.pdv_id
               LEFT JOIN merch_brands b ON b.id = r.brand_id
               LEFT JOIN employees sv ON sv.id = r.supervisor_id
               LEFT JOIN brand_checklists bc ON bc.id = r.checklist_id
                ${productCountJoin}
               WHERE r.organization_id = $1`;
    const params = [orgId];
    let idx = 2;

    if (promoter_id) { sql += ` AND r.promoter_id = $${idx++}`; params.push(promoter_id); }
    if (brand_id) { sql += ` AND r.brand_id = $${idx++}`; params.push(brand_id); }
    if (pdv_id) { sql += ` AND r.pdv_id = $${idx++}`; params.push(pdv_id); }
    if (status) { sql += ` AND r.status = $${idx++}`; params.push(status); }
    if (supervisor_id) { sql += ` AND r.supervisor_id = $${idx++}`; params.push(supervisor_id); }
    
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
    const rows = result.rows;

    // Attach route_brands for multi-brand routes
    if (rows.length > 0) {
      try {
        const ids = rows.map(r => r.id);
        const rbRes = await query(
          `SELECT rb.route_id, rb.id, rb.brand_id, rb.checklist_id, rb.sort_order,
                  rb.progress_pct as stored_progress_pct, rb.status as stored_status,
                  b.name as brand_name, bc.name as checklist_name,
                  COALESCE(rb.eff_checklist_type, bc.checklist_type, 'standard') as checklist_type,
                  COALESCE(rb.eff_require_checkin_photo, bc.require_checkin_photo, true) as require_checkin_photo,
                  COALESCE(rb.eff_require_checkout_photo, bc.require_checkout_photo, false) as require_checkout_photo,
                  COALESCE(rb.eff_require_stock_count, bc.require_stock_count, false) as require_stock_count,
                  COALESCE(rb.eff_require_validity_check, bc.require_validity_check, false) as require_validity_check,
                  COALESCE(rb.eff_require_extra_point, bc.require_extra_point, false) as require_extra_point,
                  COALESCE(rb.eff_require_category_photos, bc.require_category_photos, true) as require_category_photos,
                  COALESCE(rb.eff_category_photo_mode, bc.category_photo_mode, 'both') as category_photo_mode,
                  COALESCE(rb.eff_min_category_photos_before, bc.min_category_photos_before, 1) as min_category_photos_before,
                  COALESCE(rb.eff_min_category_photos_after, bc.min_category_photos_after, 1) as min_category_photos_after,
                  (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_brand_id = rb.id) as total_products,
                  (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_brand_id = rb.id AND rpe.status = 'completed') as completed_products,
                  -- Conta apenas fotos realmente sincronizadas (ignora blob:/local-file: pendentes)
                  -- e desduplica URLs repetidas por reenvio do app.
                  (SELECT COUNT(DISTINCT rph.photo_url) FROM route_photos rph
                    WHERE rph.route_brand_id = rb.id
                      AND rph.photo_url IS NOT NULL
                      AND rph.photo_url NOT LIKE 'blob:%'
                      AND rph.photo_url NOT LIKE 'local-file:%') as photos_count
           FROM route_brands rb
           LEFT JOIN merch_brands b ON b.id = rb.brand_id
           LEFT JOIN brand_checklists bc ON bc.id = rb.checklist_id
           WHERE rb.route_id = ANY($1::uuid[])
           ORDER BY rb.sort_order`,
          [ids]
        );
        const map = {};
        for (const rb of rbRes.rows) {
          const total = Number(rb.total_products || 0);
          const done = Number(rb.completed_products || 0);
          rb.total_products = total;
          rb.completed_products = done;
          rb.photos_count = Number(rb.photos_count || 0);
          // Prefer stored progress_pct (from refreshRouteProgress) — it accounts for
          // required ANTES/DEPOIS category photos. Fallback only when nothing was stored.
          const stored = rb.stored_progress_pct != null ? Number(rb.stored_progress_pct) : null;
          if (stored != null && !Number.isNaN(stored)) {
            rb.progress_pct = stored;
          } else {
            rb.progress_pct = total > 0 ? Math.round((done / total) * 100) : (rb.photos_count > 0 ? 100 : 0);
          }
          (map[rb.route_id] = map[rb.route_id] || []).push(rb);
        }

        for (const r of rows) {
          const list = map[r.id] || [];
          // If parent route is completed, ensure brands reflect 100% (fallback for routes without product/photo tracking)
          if (r.status === 'completed') {
            for (const rb of list) {
              if (!rb.progress_pct || rb.progress_pct < 100) rb.progress_pct = 100;
            }
          } else if (list.length > 0) {
            // Keep the route-level progress consistent with the sum of brand progresses,
            // avoiding cases where the stored route.progress_pct is stale (e.g. 100%) while
            // the brands still show partial (e.g. 73%). The detail endpoint recomputes this
            // on the fly, so we align the list view here too.
            const avg = list.reduce((sum, rb) => sum + Number(rb.progress_pct || 0), 0) / list.length;
            r.progress_pct = Math.round(avg * 100) / 100;
          }
          r.route_brands = list;
          if (list.length > 0) {
            r.is_multi_brand = list.length > 1;
            if (list.length > 1) {
              r.brand_name = list.map(x => x.brand_name).filter(Boolean).join(' + ');
            }
          }
        }

      } catch (e) { logWarn('routes.list.route_brands_failed', e); }

      // Attach co-executors (route_person_assignments)
      try {
        const ids = rows.map(r => r.id);
        const cpRes = await query(
          `SELECT rpa.route_id, rpa.employee_id, rpa.role, rpa.assigned_at,
                  e.full_name as employee_name
             FROM route_person_assignments rpa
             LEFT JOIN employees e ON e.id = rpa.employee_id
            WHERE rpa.route_id = ANY($1::uuid[]) AND COALESCE(rpa.active, true) = true
            ORDER BY rpa.assigned_at`,
          [ids]
        );
        const cpMap = {};
        for (const cp of cpRes.rows) {
          (cpMap[cp.route_id] = cpMap[cp.route_id] || []).push(cp);
        }
        for (const r of rows) {
          const list = (cpMap[r.id] || []).filter(x => x.employee_id !== r.promoter_id);
          r.co_promoters = list;
        }
      } catch (e) {
        if (e.code !== '42P01') logWarn('routes.list.co_promoters_failed', e);
        for (const r of rows) r.co_promoters = [];
      }
    }

    // Enrich with stock-count flag (has active rule for the brand+weekday+pdv)
    try {
      const rulesRes = await query(
        `SELECT brand_id, weekdays, pdv_overrides FROM stock_count_rules WHERE organization_id = $1 AND enabled=true`,
        [orgId]
      );
      const rulesByBrand = new Map();
      for (const rule of rulesRes.rows) {
        const wd = Array.isArray(rule.weekdays) ? rule.weekdays : (rule.weekdays ? (typeof rule.weekdays === 'string' ? JSON.parse(rule.weekdays) : rule.weekdays) : null);
        const pov = rule.pdv_overrides ? (typeof rule.pdv_overrides === 'object' ? rule.pdv_overrides : JSON.parse(rule.pdv_overrides)) : null;
        rulesByBrand.set(rule.brand_id, { weekdays: wd, pdv_overrides: pov });
      }
      for (const r of rows) {
        if (!r.visit_date) { r.has_stock_count = false; continue; }
        const dow = parseDateAtNoon(r.visit_date).getDay();
        const brandIds = [];
        if (r.brand_id) brandIds.push(r.brand_id);
        if (Array.isArray(r.route_brands)) for (const rb of r.route_brands) if (rb.brand_id) brandIds.push(rb.brand_id);
        let has = false;
        for (const bid of brandIds) {
          const rule = rulesByBrand.get(bid);
          if (!rule) continue;
          const pdvOv = rule.pdv_overrides && r.pdv_id ? rule.pdv_overrides[r.pdv_id] : null;
          const eff = (pdvOv && Array.isArray(pdvOv.weekdays)) ? pdvOv.weekdays : rule.weekdays;
          if (!eff || !eff.length || eff.map(Number).includes(dow)) { has = true; break; }
        }
        r.has_stock_count = has;
        if (has) r.stock_count_source = 'rule';
      }
    } catch (e) { logWarn('routes.list.stock_count_flag_failed', e); }

    await enrichStockCountFromChecklists(rows);


    // Enrich with stock_count_status (aggregate) for rows that have has_stock_count
    try {
      const scRouteIds = rows.filter(r => r.has_stock_count).map(r => r.id);
      if (scRouteIds.length && (await hasTable('stock_count_executions'))) {
        // Self-heal: revert justified/postponed executions without records back to pending
        try {
          if (await hasTable('stock_count_justifications')) {
            await query(
              `UPDATE stock_count_executions e SET status='pending', updated_at=NOW()
               WHERE e.route_id = ANY($1::uuid[]) AND e.status='justified'
                 AND NOT EXISTS (SELECT 1 FROM stock_count_justifications j WHERE j.execution_id = e.id)`,
              [scRouteIds]
            );
          }
          if (await hasTable('stock_count_postponements')) {
            await query(
              `UPDATE stock_count_executions e SET status='pending', updated_at=NOW()
               WHERE e.route_id = ANY($1::uuid[]) AND e.status='postponed'
                 AND NOT EXISTS (SELECT 1 FROM stock_count_postponements p WHERE p.execution_id = e.id)`,
              [scRouteIds]
            );
          }
        } catch (e) { logWarn('routes.list.stock_count_selfheal_failed', e); }

        const execRes = await query(
          `SELECT route_id, status FROM stock_count_executions WHERE route_id = ANY($1::uuid[])`,
          [scRouteIds]
        );
        const byRoute = new Map();
        for (const e of execRes.rows) {
          if (!byRoute.has(e.route_id)) byRoute.set(e.route_id, []);
          byRoute.get(e.route_id).push(e.status);
        }
        for (const r of rows) {
          if (!r.has_stock_count) continue;
          const statuses = byRoute.get(r.id) || [];
          if (!statuses.length) r.stock_count_status = 'pending';
          else if (statuses.every(s => s === 'completed')) r.stock_count_status = 'completed';
          else if (statuses.some(s => s === 'postponed')) r.stock_count_status = 'postponed';
          else if (statuses.some(s => s === 'justified')) r.stock_count_status = 'justified';
          else if (statuses.some(s => s === 'in_progress')) r.stock_count_status = 'in_progress';
          else r.stock_count_status = 'pending';
        }
      }
    } catch (e) { logWarn('routes.list.stock_count_status_failed', e); }

    res.json(rows);
  } catch (err) {
    logError('routes.list', err);
    res.status(500).json({ error: err.message || 'Erro ao listar rotas' });
  }
});


// Create route (with recurrence support)
router.post('/routes', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    const { promoter_id, supervisor_id, pdv_id, brand_id, checklist_id, visit_date, scheduled_time,
            window_start, window_end, estimated_duration_min, priority, visit_type, notes,
            recurrence_type, recurrence_interval, recurrence_until, recurrence_weekdays,
            brands: multiBrands } = req.body;

    // Determine if truly multi-brand. The frontend also sends `brands` for a
    // single selected brand, but old databases still require merch_routes.brand_id.
    const isMultiBrand = Array.isArray(multiBrands) && multiBrands.length > 1;
    const primaryBrandId = isMultiBrand ? multiBrands[0].brand_id : brand_id;

    if (isMultiBrand) {
      await ensureRouteBrandsTables();
    }

    // Determine brands to include (exclude inactive ones)
    const brandIds = new Set();
    if (primaryBrandId) brandIds.add(primaryBrandId);
    if (Array.isArray(multiBrands)) {
      for (const mb of multiBrands) if (mb.brand_id) brandIds.add(mb.brand_id);
    }

    const activeBrandsRes = await query(
      `SELECT id FROM merch_brands WHERE id = ANY($1::uuid[]) AND status = 'active'`,
      [Array.from(brandIds)]
    );
    const activeBrandIds = new Set(activeBrandsRes.rows.map(r => r.id));

    if (primaryBrandId && !activeBrandIds.has(primaryBrandId)) {
      return res.status(400).json({ error: 'A marca principal está inativa e não pode ser usada em novos roteiros.' });
    }

    let filteredMultiBrands = multiBrands;
    if (Array.isArray(multiBrands)) {
      filteredMultiBrands = multiBrands.filter(mb => activeBrandIds.has(mb.brand_id));
      if (filteredMultiBrands.length === 0) {
        return res.status(400).json({ error: 'Nenhuma das marcas selecionadas está ativa.' });
      }
    }

    // Resolve effective checklist for this brand when not explicitly passed
    let effectiveChecklistId = checklist_id || null;
    if (!effectiveChecklistId && primaryBrandId && !isMultiBrand) {
      try {
        const checklistRes = await query(
          `SELECT id FROM brand_checklists
           WHERE organization_id=$1 AND brand_id=$2 AND active=true
           ORDER BY created_at DESC LIMIT 1`,
          [orgId, primaryBrandId]
        );
        effectiveChecklistId = checklistRes.rows[0]?.id || null;
      } catch (e) { logError('checklist resolve fail', e); }
    }

    // Checklists por marca (podem ser vários, cada um com sua recorrência)
    const hasBrandsArray = Array.isArray(filteredMultiBrands) && filteredMultiBrands.length > 0;
    const brandChecklists = {}; // brand_id -> [{ checklist_id, weekdays[] }]
    if (hasBrandsArray) {
      for (const mb of filteredMultiBrands) brandChecklists[mb.brand_id] = normalizeBrandChecklists(mb);
    }

    // Per-brand weekdays (for weekly recurrence — applies for single or multi-brand)
    // Encoding: Sun=0, Mon=1..Sat=6 (matches JS getUTCDay)
    const brandWeekdays = {}; // brand_id -> Set<number> (empty set = applies to all dates)
    if (hasBrandsArray && recurrence_type === 'weekly') {
      for (const mb of filteredMultiBrands) {
        const wds = new Set(Array.isArray(mb.weekdays) ? mb.weekdays.map(Number) : []);
        // A marca também precisa rodar nos dias exigidos por qualquer um dos seus checklists
        const entries = brandChecklists[mb.brand_id] || [];
        const anyChecklistAllDays = entries.length > 0 && entries.some((c) => !c.weekdays || c.weekdays.length === 0);
        if (!anyChecklistAllDays) {
          for (const c of entries) for (const w of (c.weekdays || [])) wds.add(Number(w));
        } else {
          wds.clear();
        }
        brandWeekdays[mb.brand_id] = wds;
      }
    }


    // Effective weekdays for date generation = union of brand weekdays (fallback to recurrence_weekdays)
    let effectiveWeekdays = recurrence_weekdays;
    if (hasBrandsArray && recurrence_type === 'weekly') {
      const union = new Set();
      let anyBrandWithoutWeekdays = false;
      for (const mb of filteredMultiBrands) {
        const set = brandWeekdays[mb.brand_id];
        if (!set || set.size === 0) { anyBrandWithoutWeekdays = true; }
        else { for (const w of set) union.add(w); }
      }
      if (anyBrandWithoutWeekdays && Array.isArray(recurrence_weekdays)) {
        for (const w of recurrence_weekdays) union.add(w);
      }
      if (union.size > 0) effectiveWeekdays = [...union];
    }

    // Build list of dates to create
    const dates = [];
    const startDate = new Date(visit_date + 'T12:00:00Z');
    
    if (!recurrence_type || recurrence_type === 'none') {
      dates.push(visit_date);
    } else {
      const endDate = recurrence_until ? new Date(recurrence_until + 'T12:00:00Z') : new Date(startDate);
      if (!recurrence_until) endDate.setMonth(endDate.getMonth() + 3); // default 3 months
      const interval = recurrence_interval || 1;
      
      let current = new Date(startDate);
      while (current <= endDate) {
        if (recurrence_type === 'daily') {
          dates.push(current.toISOString().split('T')[0]);
          current.setDate(current.getDate() + interval);
        } else if (recurrence_type === 'weekly') {
          if (effectiveWeekdays && effectiveWeekdays.length > 0) {
            const weekStart = new Date(current);
            const dow = weekStart.getUTCDay(); // 0=Sun..6=Sat
            const daysBackToMonday = dow === 0 ? 6 : dow - 1;
            weekStart.setUTCDate(weekStart.getUTCDate() - daysBackToMonday);
            for (const wd of effectiveWeekdays) {
              const offset = wd === 0 ? 6 : wd - 1; // Mon=0..Sun=6
              const d = new Date(weekStart);
              d.setUTCDate(d.getUTCDate() + offset);
              if (d >= startDate && d <= endDate) {
                dates.push(d.toISOString().split('T')[0]);
              }
            }
            current.setDate(current.getDate() + 7 * interval);
          } else {
            dates.push(current.toISOString().split('T')[0]);
            current.setDate(current.getDate() + 7 * interval);
          }
        } else if (recurrence_type === 'monthly') {
          dates.push(current.toISOString().split('T')[0]);
          current.setMonth(current.getMonth() + interval);
        }
      }
      const uniqueDates = [...new Set(dates)];
      dates.length = 0;
      dates.push(...uniqueDates.sort());
    }

    const recurrence = (recurrence_type && recurrence_type !== 'none')
      ? JSON.stringify({ type: recurrence_type, interval: recurrence_interval || 1, until: recurrence_until, weekdays: recurrence_weekdays })
      : null;

    const created = [];
    for (const d of dates) {
      const dWeekday = new Date(d + 'T12:00:00Z').getUTCDay(); // 0=Sun..6=Sat

      // For multi-brand weekly: determine which brands apply on this date
      let applicableBrands = isMultiBrand ? filteredMultiBrands : null;
      if (isMultiBrand && recurrence_type === 'weekly') {
        applicableBrands = filteredMultiBrands.filter(mb => {
          const set = brandWeekdays[mb.brand_id];
          if (!set || set.size === 0) {
            // No per-brand weekdays -> applies on all generated dates (already filtered by global)
            return true;
          }
          return set.has(dWeekday);
        });
        if (applicableBrands.length === 0) continue; // skip date if no brand applies
      }

      // Checklists aplicáveis nesta data para a marca única
      let singleBrandChecklistIds = [];
      if (!isMultiBrand) {
        const entries = brandChecklists[primaryBrandId] || [];
        if (entries.length > 0) {
          singleBrandChecklistIds = checklistsForWeekday(entries, dWeekday).map((c) => c.checklist_id);
          if (singleBrandChecklistIds.length === 0 && (recurrence_type === 'daily' || recurrence_type === 'weekly')) {
            continue; // nenhum checklist aplica nesta data
          }
        } else if (effectiveChecklistId) {
          singleBrandChecklistIds = [effectiveChecklistId];
        }
      }
      const singlePrimaryChecklistId = singleBrandChecklistIds[0] || effectiveChecklistId || null;

      const result = await query(
        `INSERT INTO merch_routes (organization_id, promoter_id, supervisor_id, pdv_id, brand_id, checklist_id,
         visit_date, scheduled_time, window_start, window_end, estimated_duration_min, priority, visit_type,
         recurrence, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [orgId, promoter_id, supervisor_id, pdv_id, isMultiBrand ? null : (primaryBrandId || null), isMultiBrand ? null : singlePrimaryChecklistId, d, scheduled_time,
         window_start, window_end, estimated_duration_min || 60, priority || 'normal', visit_type || 'regular',
          recurrence, notes || null, req.userId]
      );

      const routeId = result.rows[0].id;

      if (isMultiBrand) {
        const brandsForThisDate = applicableBrands || filteredMultiBrands;
        let insertedBrands = 0;
        for (let i = 0; i < brandsForThisDate.length; i++) {
          const mb = brandsForThisDate[i];
          const entries = brandChecklists[mb.brand_id] || [];
          let ids = entries.length > 0 ? checklistsForWeekday(entries, dWeekday).map((c) => c.checklist_id) : [];
          if (entries.length > 0 && ids.length === 0) continue; // marca sem checklist válido nesta data
          if (ids.length === 0 && mb.brand_id) {
            try {
              const cr = await query(`SELECT id FROM brand_checklists WHERE organization_id=$1 AND brand_id=$2 AND active=true ORDER BY created_at DESC LIMIT 1`, [orgId, mb.brand_id]);
              if (cr.rows[0]?.id) ids = [cr.rows[0].id];
            } catch {}
          }
          const rbRes = await query(
            `INSERT INTO route_brands (route_id, brand_id, checklist_id, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
            [routeId, mb.brand_id, ids[0] || null, i]
          );
          if (rbRes.rows[0]) {
            insertedBrands++;
            await persistMergedChecklist('route_brands', rbRes.rows[0].id, ids);
            await hydrateRouteBrandProducts(routeId, rbRes.rows[0].id, pdv_id, mb.brand_id);
          }
        }
        if (insertedBrands === 0) {
          await query('DELETE FROM merch_routes WHERE id=$1', [routeId]).catch(() => {});
          continue;
        }
        logInfo('routes.multi_brand_created', { route_id: routeId, brand_count: insertedBrands, date: d });
      } else {
        await persistMergedChecklist('merch_routes', routeId, singleBrandChecklistIds);
        try {
          const mixProducts = await query(
            `SELECT pbp.product_id, p.category_id FROM merch_pdv_brand_products pbp
             JOIN merch_products p ON p.id = pbp.product_id
             WHERE pbp.pdv_id=$1 AND pbp.brand_id=$2 AND pbp.active=true`,
            [pdv_id, primaryBrandId]
          );
          for (const mp of mixProducts.rows) {
            await query(`INSERT INTO route_product_executions (route_id, product_id, category_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [routeId, mp.product_id, mp.category_id]);
          }
          logInfo('routes.products_hydrated', { route_id: routeId, count: mixProducts.rows.length });
        } catch (e) { logError('routes.hydrate_products', e); }
      }


      created.push(result.rows[0]);
    }

    logInfo('routes.created', { count: created.length, first_id: created[0]?.id, checklist_id: effectiveChecklistId });
    res.json(created.length === 1 ? created[0] : { routes: created, count: created.length });
  } catch (err) { logError('routes.create', err); res.status(500).json({ error: 'Erro ao criar rota' }); }
});

// Update route (supports scope: 'single' | 'future')
router.put('/routes/:id', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    const existing = await query('SELECT * FROM merch_routes WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });

    const old = existing.rows[0];
    const scope = req.body._scope || 'single';

    // Block edits when the route is already being executed by the promoter.
    // We allow reassigning promoter/supervisor (does NOT wipe progress — fotos,
    // execuções e check-in ficam vinculados à rota, não ao promotor) e ajustes
    // de notas/observações. Mudanças estruturais (marca, PDV, checklist, data,
    // janela de horário, tipo de visita, lista de marcas) são bloqueadas para
    // não zerar o trabalho já feito.
    const LOCKED_STATUSES = ['in_progress', 'completed'];
    if (LOCKED_STATUSES.includes(old.status)) {
      const forbidden = ['pdv_id','brand_id','checklist_id','visit_date','scheduled_time','window_start','window_end','visit_type'];
      const attempted = forbidden.filter((f) => req.body[f] !== undefined && JSON.stringify(req.body[f]) !== JSON.stringify(old[f]));
      const hasBrandsChange = Array.isArray(req.body.brands);
      if (attempted.length || hasBrandsChange) {
        return res.status(409).json({
          error: old.status === 'in_progress'
            ? 'Esta rota já está em execução. Você pode reatribuir o promotor/supervisor ou adicionar observações, mas não pode alterar PDV, marcas, checklist, data ou janela de horário sem cancelar a rota antes.'
            : 'Esta rota já foi concluída. Reatribuição de promotor é permitida; alterações estruturais não.',
          code: 'ROUTE_LOCKED',
          status: old.status,
          fields: hasBrandsChange ? [...attempted, 'brands'] : attempted,
        });
      }
    }


    // Remove internal field
    delete req.body._scope;

    // Multi-brand sync (replace route_brands when brands array is provided)
    let brandsPayload = Array.isArray(req.body.brands) ? req.body.brands : null;
    if (brandsPayload) {
      const bIds = brandsPayload.map(b => b.brand_id).filter(Boolean);
      if (bIds.length > 0) {
        const activeRes = await query(`SELECT id FROM merch_brands WHERE id = ANY($1::uuid[]) AND status = 'active'`, [bIds]);
        const activeSet = new Set(activeRes.rows.map(r => r.id));
        brandsPayload = brandsPayload.filter(b => activeSet.has(b.brand_id));
      }
      if (brandsPayload.length === 0) {
        return res.status(400).json({ error: 'Nenhuma das marcas selecionadas está ativa.' });
      }
    }
    delete req.body.brands;
    if (brandsPayload) {
      try {
        await query(`CREATE TABLE IF NOT EXISTS route_brands (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          route_id UUID NOT NULL,
          brand_id UUID NOT NULL,
          checklist_id UUID,
          status VARCHAR(30) DEFAULT 'pending',
          progress_pct NUMERIC(5,2) DEFAULT 0,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          sort_order INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(route_id, brand_id)
        )`);
        await query('DELETE FROM route_brands WHERE route_id=$1', [req.params.id]);
        // Clear stale route_brand_id refs on executions so we can re-link cleanly
        try { await query('UPDATE route_product_executions SET route_brand_id=NULL WHERE route_id=$1', [req.params.id]); } catch {}
        const pdvIdForHydrate = req.body.pdv_id || old.pdv_id;
        const editDate = getDatePart(req.body.visit_date || old.visit_date);
        const editWeekday = editDate ? new Date(editDate + 'T12:00:00Z').getUTCDay() : null;
        let singleIds = [];
        for (let i = 0; i < brandsPayload.length; i++) {
          const mb = brandsPayload[i];
          if (!mb?.brand_id) continue;
          const entries = normalizeBrandChecklists(mb);
          let ids = entries.length > 0 && editWeekday !== null
            ? checklistsForWeekday(entries, editWeekday).map((c) => c.checklist_id)
            : entries.map((c) => c.checklist_id);
          if (ids.length === 0) {
            try {
              const cr = await query(`SELECT id FROM brand_checklists WHERE organization_id=$1 AND brand_id=$2 AND active=true ORDER BY created_at DESC LIMIT 1`, [orgId, mb.brand_id]);
              if (cr.rows[0]?.id) ids = [cr.rows[0].id];
            } catch {}
          }
          if (brandsPayload.length === 1) singleIds = ids;
          const rbRes = await query(
            `INSERT INTO route_brands (route_id, brand_id, checklist_id, sort_order) VALUES ($1,$2,$3,$4)
             ON CONFLICT (route_id, brand_id) DO UPDATE SET checklist_id=EXCLUDED.checklist_id, sort_order=EXCLUDED.sort_order
             RETURNING *`,
            [req.params.id, mb.brand_id, ids[0] || null, i]
          );
          // Hydrate products from PDV mix for this brand
          if (rbRes.rows[0]) {
            await persistMergedChecklist('route_brands', rbRes.rows[0].id, ids);
            if (pdvIdForHydrate) await hydrateRouteBrandProducts(req.params.id, rbRes.rows[0].id, pdvIdForHydrate, mb.brand_id);
          }
        }
        // If multi-brand, null root brand/checklist; if single, keep as scalar
        if (brandsPayload.length > 1) {
          req.body.brand_id = null;
          req.body.checklist_id = null;
          await persistMergedChecklist('merch_routes', req.params.id, []);
        } else if (brandsPayload.length === 1) {
          req.body.brand_id = brandsPayload[0].brand_id;
          req.body.checklist_id = singleIds[0] ?? (brandsPayload[0].checklist_id !== undefined ? brandsPayload[0].checklist_id : req.body.checklist_id);
          await persistMergedChecklist('merch_routes', req.params.id, singleIds);
        }

        logInfo('routes.brands_synced', { route_id: req.params.id, count: brandsPayload.length });
      } catch (e) { logError('routes.brands_sync', e); }
    }

    const fields = ['promoter_id','supervisor_id','pdv_id','brand_id','checklist_id','visit_date','scheduled_time',
                    'window_start','window_end','estimated_duration_min','priority','visit_type','notes','status'];

    const updates = [];
    const params = [req.params.id];
    let idx = 2;

    for (const f of fields) {
      if (req.body[f] !== undefined && req.body[f] !== old[f]) {
        await query(
          `INSERT INTO route_edit_audit_logs (route_id, field_changed, old_value, new_value, edited_by, editor_role, source, reason, route_was_completed)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.params.id, f, String(old[f] || ''), String(req.body[f] || ''), req.userId, 'admin', 'web', req.body.edit_reason || null, old.status === 'completed']
        );
        updates.push(`${f}=$${idx++}`);
        params.push(req.body[f]);
      }
    }

    if (!updates.length) {
      // Still return route with refreshed brands list
      return res.json(old);
    }
    updates.push(`updated_at=NOW()`);


    // Apply to single or future sibling routes
    if (scope === 'future') {
      // Build SET clause for siblings (exclude visit_date and status for bulk)
      const bulkFields = ['promoter_id','supervisor_id','pdv_id','brand_id','checklist_id','scheduled_time',
                          'window_start','window_end','estimated_duration_min','priority','visit_type','notes'];
      const bulkUpdates = [];
      const bulkParams = [];
      let bIdx = 1;
      for (const f of bulkFields) {
        if (req.body[f] !== undefined && req.body[f] !== old[f]) {
          bulkUpdates.push(`${f}=$${bIdx++}`);
          bulkParams.push(req.body[f]);
        }
      }
      if (bulkUpdates.length > 0) {
        bulkUpdates.push(`updated_at=NOW()`);
        bulkParams.push(orgId, old.promoter_id, old.pdv_id, old.brand_id, old.visit_date);
        const whereStart = bIdx;
        const bulkSql = `UPDATE merch_routes SET ${bulkUpdates.join(',')}
          WHERE organization_id=$${whereStart} AND promoter_id=$${whereStart+1} AND pdv_id=$${whereStart+2}
          AND brand_id=$${whereStart+3} AND visit_date >= $${whereStart+4}
          AND status IN ('scheduled','confirmed')`;
        await query(bulkSql, bulkParams);
        logInfo('routes.bulk_updated', { base_route: req.params.id, scope: 'future' });
      }

      // Shift future siblings' visit_date by the same delta when the recurring
      // day of week changes (e.g. Tuesday → Monday shifts every future occurrence).
      if (req.body.visit_date !== undefined && req.body.visit_date !== old.visit_date) {
        const toYMD = (v) => {
          if (!v) return null;
          if (v instanceof Date) return v.toISOString().slice(0, 10);
          const s = String(v);
          return s.length >= 10 ? s.slice(0, 10) : s;
        };
        const oldYMD = toYMD(old.visit_date);
        const newYMD = toYMD(req.body.visit_date);
        if (oldYMD && newYMD && oldYMD !== newYMD) {
          const dOld = new Date(oldYMD + 'T12:00:00Z');
          const dNew = new Date(newYMD + 'T12:00:00Z');
          const deltaDays = Math.round((dNew - dOld) / 86400000);
          if (deltaDays !== 0) {
            // Only shift future occurrences that share the SAME weekday as the
            // edited route. This preserves other weekdays in multi-day recurrences
            // (e.g. editing the Wednesday of a Wed+Thu series must not drag Thu).
            await query(
              `UPDATE merch_routes
                 SET visit_date = (visit_date::date + ($1 || ' days')::interval)::date,
                     updated_at = NOW()
               WHERE organization_id=$2 AND promoter_id IS NOT DISTINCT FROM $3
                 AND pdv_id IS NOT DISTINCT FROM $4 AND brand_id IS NOT DISTINCT FROM $5
                 AND visit_date > $6 AND status IN ('scheduled','confirmed')
                 AND id <> $7
                 AND EXTRACT(DOW FROM visit_date) = EXTRACT(DOW FROM $6::date)`,
              [String(deltaDays), orgId, old.promoter_id, old.pdv_id, old.brand_id, old.visit_date, req.params.id]
            );
            logInfo('routes.bulk_date_shifted', { base_route: req.params.id, delta_days: deltaDays });
          }
        }
      }
    }

    // Always update the current route with all changes
    const result = await query(`UPDATE merch_routes SET ${updates.join(',')} WHERE id=$1 RETURNING *`, params);

    // Re-hydrate products when pdv or brand changed
    const newPdv = req.body.pdv_id || old.pdv_id;
    const newBrand = req.body.brand_id || old.brand_id;
    if (req.body.pdv_id !== undefined || req.body.brand_id !== undefined) {
      try {
        await query(`DELETE FROM route_product_executions WHERE route_id=$1 AND (status IS NULL OR status='pending')`, [req.params.id]);
        const mixProducts = await query(
          `SELECT pbp.product_id, p.category_id
           FROM merch_pdv_brand_products pbp
           JOIN merch_products p ON p.id = pbp.product_id
           WHERE pbp.pdv_id=$1 AND pbp.brand_id=$2 AND pbp.active=true`,
          [newPdv, newBrand]
        );
        for (const mp of mixProducts.rows) {
          await query(
            `INSERT INTO route_product_executions (route_id, product_id, category_id) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`,
            [req.params.id, mp.product_id, mp.category_id]
          );
        }
        logInfo('routes.products_rehydrated', { route_id: req.params.id, count: mixProducts.rows.length });
      } catch (e) { logError('routes.rehydrate_products', e); }
    }

    res.json(result.rows[0]);
  } catch (err) { logError('routes.update', err); res.status(500).json({ error: 'Erro ao atualizar rota' }); }
});

// Admin/Supervisor: Manually complete a route
router.post('/routes/:id/complete', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    const { notes } = req.body;

    const route = await query('SELECT * FROM merch_routes WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const old = route.rows[0];

    // Update the route status to completed
    const result = await query(
      `UPDATE merch_routes 
       SET status='completed', 
           completed_at=NOW(), 
           checkout_at=COALESCE(checkout_at, NOW()),
           progress_pct=100,
           completion_notes=COALESCE($3, completion_notes),
           updated_at=NOW() 
       WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [req.params.id, orgId, notes]
    );

    // Audit log
    await query(
      `INSERT INTO route_edit_audit_logs (route_id, field_changed, old_value, new_value, edited_by, editor_role, source, reason, route_was_completed)
       VALUES ($1,'status',$2,'completed',$3,'supervisor','web',$4,$5)`,
      [req.params.id, old.status, req.userId, notes || 'Finalização manual pelo supervisor', old.status === 'completed']
    );

    // Execution author
    await query(
      `INSERT INTO execution_authors (route_id, action, performed_by, performer_role, source, details)
       VALUES ($1,'route_manually_completed',$2,'supervisor','web',$3)`,
      [req.params.id, req.userId, JSON.stringify({ notes, old_status: old.status })]
    );

    // Add to execution logs
    await query(
      `INSERT INTO route_execution_logs (route_id, action, details, performed_by, source)
       VALUES ($1,'route_completed',$2,$3,'web_admin')`,
      [req.params.id, JSON.stringify({ manual: true, notes }), req.userId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    logError('routes.manual_complete', err);
    res.status(500).json({ error: 'Erro ao finalizar rota manualmente' });
  }
});

// Admin/Supervisor: justify a route as not_done (promoter did not go / could not complete)
router.post('/routes/:id/justify', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Motivo obrigatório' });

    try {
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS not_done_reason TEXT`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS not_done_at TIMESTAMPTZ`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS not_done_by UUID`);
      await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS has_alert BOOLEAN DEFAULT false`);
    } catch (_) {}

    const route = await query('SELECT * FROM merch_routes WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const old = route.rows[0];
    if (!['scheduled', 'confirmed', 'in_progress'].includes(old.status)) {
      return res.status(400).json({ error: 'Rota não pode ser justificada neste status' });
    }

    const result = await query(
      `UPDATE merch_routes
       SET status='not_done', not_done_reason=$3, not_done_at=NOW(), not_done_by=$4,
           has_alert=true, completed_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [req.params.id, orgId, String(reason).trim(), req.userId]
    );

    try {
      await query(
        `INSERT INTO route_edit_audit_logs (route_id, field_changed, old_value, new_value, edited_by, editor_role, source, reason, route_was_completed)
         VALUES ($1,'status',$2,'not_done',$3,'supervisor','web',$4,false)`,
        [req.params.id, old.status, req.userId, String(reason).trim()]
      );
    } catch (_) {}
    try {
      await query(
        `INSERT INTO execution_authors (route_id, action, performed_by, performer_role, source, details)
         VALUES ($1,'route_justified_not_done',$2,'supervisor','web',$3)`,
        [req.params.id, req.userId, JSON.stringify({ reason: String(reason).trim(), old_status: old.status })]
      );
    } catch (_) {}

    res.json(result.rows[0]);
  } catch (err) {
    logError('routes.admin_justify', err);
    res.status(500).json({ error: 'Erro ao justificar rota' });
  }
});



// Delete route (supports scope: 'single' | 'future')
// Bulk delete (superadmin only) - delete selected routes and optionally all future scheduled siblings
router.post('/routes/bulk-delete', async (req, res) => {
  try {
    const su = await query('SELECT is_superadmin FROM users WHERE id=$1', [req.userId]);
    const isSu = !!su.rows[0]?.is_superadmin;
    const mem = await query(`SELECT role FROM organization_members WHERE user_id=$1`, [req.userId]);
    const isAdmin = mem.rows.some(r => ['owner', 'admin'].includes(r.role));
    if (!isSu && !isAdmin) return res.status(403).json({ error: 'Apenas admin ou superadmin' });
    const { ids = [], include_future = false } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids requerido' });

    // Superadmin: NÃO filtrar por organização — pode apagar rotas de qualquer org
    let futureDeleted = 0;
    let futureIds = [];
    if (include_future) {
      const rows = await query(
        `SELECT organization_id, promoter_id, pdv_id, brand_id, visit_date FROM merch_routes WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      for (const r of rows.rows) {
        const sel = await query(
          `SELECT id FROM merch_routes
           WHERE organization_id=$1 AND promoter_id IS NOT DISTINCT FROM $2
             AND pdv_id IS NOT DISTINCT FROM $3 AND brand_id IS NOT DISTINCT FROM $4
             AND visit_date > $5 AND status IN ('scheduled','confirmed')`,
          [r.organization_id, r.promoter_id, r.pdv_id, r.brand_id, r.visit_date]
        );
        for (const f of sel.rows) futureIds.push(f.id);
      }
    }
    const allIds = Array.from(new Set([...ids, ...futureIds]));

    // Apagar dependências conhecidas antes (FKs sem cascade)
    const tryDel = async (sql, params) => { try { return await query(sql, params); } catch (e) { return { rowCount: 0 }; } };
    await tryDel(`DELETE FROM merch_route_executions WHERE route_id = ANY($1::uuid[])`, [allIds]);
    await tryDel(`DELETE FROM merch_route_products WHERE route_id = ANY($1::uuid[])`, [allIds]);
    await tryDel(`DELETE FROM merch_route_brands WHERE route_id = ANY($1::uuid[])`, [allIds]);
    await tryDel(`DELETE FROM merch_route_audit WHERE route_id = ANY($1::uuid[])`, [allIds]);
    await tryDel(`DELETE FROM merch_route_authors WHERE route_id = ANY($1::uuid[])`, [allIds]);
    await tryDel(`DELETE FROM merch_route_assignment_history WHERE route_id = ANY($1::uuid[])`, [allIds]);
    await tryDel(`DELETE FROM merch_route_photos WHERE route_id = ANY($1::uuid[])`, [allIds]);
    await tryDel(`DELETE FROM merch_route_categories WHERE route_id = ANY($1::uuid[])`, [allIds]);

    const del = await query(
      `DELETE FROM merch_routes WHERE id = ANY($1::uuid[])`,
      [allIds]
    );
    futureDeleted = Math.max(0, (del.rowCount || 0) - ids.length);
    res.json({ ok: true, deleted: del.rowCount, future_deleted: futureDeleted });
  } catch (err) {
    logError('routes.bulk_delete', err);
    res.status(500).json({ error: 'Erro ao excluir rotas', detail: err.message });
  }
});

router.delete('/routes/:id', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;
    const scope = req.query.scope || 'single';

    let ids = [req.params.id];
    if (scope === 'future') {
      const current = await query('SELECT * FROM merch_routes WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
      if (!current.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
      const r = current.rows[0];
      const sel = await query(
        `SELECT id FROM merch_routes
         WHERE organization_id=$1 AND promoter_id IS NOT DISTINCT FROM $2
           AND pdv_id IS NOT DISTINCT FROM $3 AND brand_id IS NOT DISTINCT FROM $4
           AND visit_date >= $5 AND status IN ('scheduled','confirmed')`,
        [orgId, r.promoter_id, r.pdv_id, r.brand_id, r.visit_date]
      );
      ids = Array.from(new Set([req.params.id, ...sel.rows.map(x => x.id)]));
    }

    // Apagar dependências (FKs sem cascade)
    const tryDel = async (sql, params) => { try { return await query(sql, params); } catch (e) { return { rowCount: 0 }; } };
    await tryDel(`DELETE FROM merch_route_executions WHERE route_id = ANY($1::uuid[])`, [ids]);
    await tryDel(`DELETE FROM merch_route_products WHERE route_id = ANY($1::uuid[])`, [ids]);
    await tryDel(`DELETE FROM merch_route_brands WHERE route_id = ANY($1::uuid[])`, [ids]);
    await tryDel(`DELETE FROM merch_route_audit WHERE route_id = ANY($1::uuid[])`, [ids]);
    await tryDel(`DELETE FROM merch_route_authors WHERE route_id = ANY($1::uuid[])`, [ids]);
    await tryDel(`DELETE FROM merch_route_assignment_history WHERE route_id = ANY($1::uuid[])`, [ids]);
    await tryDel(`DELETE FROM merch_route_photos WHERE route_id = ANY($1::uuid[])`, [ids]);
    await tryDel(`DELETE FROM merch_route_categories WHERE route_id = ANY($1::uuid[])`, [ids]);

    const del = await query(`DELETE FROM merch_routes WHERE id = ANY($1::uuid[]) AND organization_id=$2`, [ids, orgId]);
    res.json({ ok: true, deleted: del.rowCount });
  } catch (err) { logError('routes.delete', err); res.status(500).json({ error: 'Erro ao excluir', detail: err.message }); }
});


// Get mix preview for a PDV+Brand (what products would be added)
router.get('/routes/mix-preview', async (req, res) => {
  try {
    const { pdv_id, brand_id } = req.query;
    if (!pdv_id || !brand_id) return res.json([]);
    const result = await query(
      `SELECT pbp.id as mix_id, pbp.product_id, pbp.mandatory, pbp.priority,
       p.name as product_name, p.sku, p.barcode, p.image_url,
       pc.name as category_name, ps.name as subcategory_name
       FROM merch_pdv_brand_products pbp
       JOIN merch_products p ON p.id = pbp.product_id
       LEFT JOIN merch_categories pc ON pc.id = p.category_id
       LEFT JOIN merch_subcategories ps ON ps.id = p.subcategory_id
       WHERE pbp.pdv_id=$1 AND pbp.brand_id=$2 AND pbp.active=true
       ORDER BY pc.name, ps.name, p.name`,
      [pdv_id, brand_id]
    );
    res.json(result.rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    logError('routes.mix_preview', err); res.status(500).json({ error: 'Erro' });
  }
});

// Get route products (executions)
router.get('/routes/:id/products', async (req, res) => {
  try {
    const result = await query(
      `SELECT rpe.*, p.name as product_name, p.sku, p.barcode, p.image_url,
       pc.name as category_name, ps.name as subcategory_name
       FROM route_product_executions rpe
       JOIN merch_products p ON p.id = rpe.product_id
       LEFT JOIN merch_categories pc ON pc.id = rpe.category_id
       LEFT JOIN merch_subcategories ps ON ps.id = p.subcategory_id
       WHERE rpe.route_id=$1 ORDER BY pc.name, ps.name, p.name`, [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    logError('routes.products', err); res.status(500).json({ error: 'Erro' });
  }
});

// Add product to route
router.post('/routes/:id/products', async (req, res) => {
  try {
    const { product_id, category_id } = req.body;
    const result = await query(
      `INSERT INTO route_product_executions (route_id, product_id, category_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`,
      [req.params.id, product_id, category_id]
    );
    res.json(result.rows[0] || { ok: true });
  } catch (err) { logError('routes.add_product', err); res.status(500).json({ error: 'Erro' }); }
});

// Remove product from route
router.delete('/routes/:id/products/:productId', authenticate, async (req, res) => {
  try {
    await query('DELETE FROM route_product_executions WHERE route_id=$1 AND product_id=$2', [req.params.id, req.params.productId]);
    res.json({ ok: true });
  } catch (err) { logError('routes.remove_product', err); res.status(500).json({ error: 'Erro' }); }
});

// Sync route products from mix (re-hydrate)
router.post('/routes/:id/sync-products', async (req, res) => {
  try {
    const route = await query('SELECT pdv_id, brand_id FROM merch_routes WHERE id=$1', [req.params.id]);
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const { pdv_id, brand_id } = route.rows[0];
    
    await query(`DELETE FROM route_product_executions WHERE route_id=$1 AND (status IS NULL OR status='pending')`, [req.params.id]);
    
    const mixProducts = await query(
      `SELECT pbp.product_id, p.category_id
       FROM merch_pdv_brand_products pbp
       JOIN merch_products p ON p.id = pbp.product_id
       WHERE pbp.pdv_id=$1 AND pbp.brand_id=$2 AND pbp.active=true`,
      [pdv_id, brand_id]
    );
    for (const mp of mixProducts.rows) {
      await query(
        `INSERT INTO route_product_executions (route_id, product_id, category_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [req.params.id, mp.product_id, mp.category_id]
      );
    }
    
    const result = await query(
      `SELECT rpe.*, p.name as product_name, p.sku, p.barcode, p.image_url,
       pc.name as category_name, ps.name as subcategory_name
       FROM route_product_executions rpe
       JOIN merch_products p ON p.id = rpe.product_id
       LEFT JOIN merch_categories pc ON pc.id = rpe.category_id
       LEFT JOIN merch_subcategories ps ON ps.id = p.subcategory_id
       WHERE rpe.route_id=$1 ORDER BY pc.name, ps.name, p.name`, [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { logError('routes.sync_products', err); res.status(500).json({ error: 'Erro' }); }
});

// Duplicate route
router.post('/routes/:id/duplicate', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const original = await query('SELECT * FROM merch_routes WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    if (!original.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });

    const o = original.rows[0];

    // Check if the brand(s) are still active before duplicating
    const brandIds = new Set();
    if (o.brand_id) brandIds.add(o.brand_id);
    const rbRes = await query(`SELECT brand_id FROM route_brands WHERE route_id = $1`, [o.id]);
    for (const row of rbRes.rows) brandIds.add(row.brand_id);

    if (brandIds.size > 0) {
      const activeRes = await query(`SELECT id FROM merch_brands WHERE id = ANY($1::uuid[]) AND status = 'active'`, [Array.from(brandIds)]);
      const activeSet = new Set(activeRes.rows.map(r => r.id));
      
      if (o.brand_id && !activeSet.has(o.brand_id) && rbRes.rows.length === 0) {
        return res.status(400).json({ error: 'Não é possível duplicar: a marca desta rota está inativa.' });
      }
      
      // Filter out inactive brands from route_brands duplication (simplified logic for duplicate)
      if (rbRes.rows.length > 0) {
        const activeBrandIds = rbRes.rows.map(r => r.brand_id).filter(id => activeSet.has(id));
        if (activeBrandIds.length === 0) {
          return res.status(400).json({ error: 'Não é possível duplicar: todas as marcas desta rota estão inativas.' });
        }
      }
    }

    const newDate = req.body.visit_date || o.visit_date;

    const result = await query(
      `INSERT INTO merch_routes (organization_id, promoter_id, supervisor_id, pdv_id, brand_id, checklist_id,
       visit_date, scheduled_time, window_start, window_end, estimated_duration_min, priority, visit_type, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [orgId, o.promoter_id, o.supervisor_id, o.pdv_id, o.brand_id || null, o.checklist_id || null,
       newDate, o.scheduled_time, o.window_start, o.window_end, o.estimated_duration_min,
       o.priority, o.visit_type, o.notes, req.userId]
    );

    const newRouteId = result.rows[0].id;

    // Copy product executions
    const execs = await query('SELECT product_id, category_id FROM route_product_executions WHERE route_id=$1', [req.params.id]);
    for (const e of execs.rows) {
      await query('INSERT INTO route_product_executions (route_id, product_id, category_id) VALUES ($1,$2,$3)',
        [newRouteId, e.product_id, e.category_id]);
    }
    
    // Copy route_brands (only active ones)
    for (const rb of rbRes.rows) {
      // We check activeSet here
      // (Actually we already fetched activeSet above)
      const brandIdsArr = Array.from(brandIds);
      const activeRes = await query(`SELECT id FROM merch_brands WHERE id = ANY($1::uuid[]) AND status = 'active'`, [brandIdsArr]);
      const activeSet = new Set(activeRes.rows.map(r => r.id));

      if (activeSet.has(rb.brand_id)) {
        await query(`INSERT INTO route_brands (route_id, brand_id, checklist_id, sort_order)
                     SELECT $1, brand_id, checklist_id, sort_order FROM route_brands WHERE id = $2`, 
                     [newRouteId, rb.id]);
      }
    }

    res.json(result.rows[0]);
  } catch (err) { logError('routes.duplicate', err); res.status(500).json({ error: 'Erro ao duplicar rota' }); }
});

// Get route detail with executions
router.get('/routes/:id', authenticate, async (req, res) => {
  try {
    const route = await query(
      `SELECT r.*, e.full_name as promoter_name, p.name as pdv_name, b.name as brand_name,
       sv.full_name as supervisor_name,
       p.latitude as pdv_lat, p.longitude as pdv_lng, p.address as pdv_address, p.city as pdv_city
       FROM merch_routes r
       LEFT JOIN employees e ON e.id = r.promoter_id
       LEFT JOIN employees sv ON sv.id = r.supervisor_id
       LEFT JOIN pdvs p ON p.id = r.pdv_id
       LEFT JOIN merch_brands b ON b.id = r.brand_id
       WHERE r.id=$1`, [req.params.id]
    );
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });

    const executions = await query(
      `SELECT rpe.*, pr.name as product_name, pr.sku, pr.barcode, pr.image_url,
       pc.name as category_name, ps.name as subcategory_name
       FROM route_product_executions rpe
       JOIN merch_products pr ON pr.id = rpe.product_id
       LEFT JOIN merch_categories pc ON pc.id = rpe.category_id
       LEFT JOIN merch_subcategories ps ON ps.id = pr.subcategory_id
       WHERE rpe.route_id=$1 ORDER BY pc.name, ps.name, pr.name`, [req.params.id]
    );

    // Somente fotos sincronizadas (URLs válidas) e sem duplicatas de reenvio
    const photos = await query(
      `SELECT DISTINCT ON (photo_url) * FROM route_photos
       WHERE route_id=$1
         AND photo_url IS NOT NULL
         AND photo_url NOT LIKE 'blob:%'
         AND photo_url NOT LIKE 'local-file:%'
       ORDER BY photo_url, captured_at`, [req.params.id]);
    photos.rows.sort((a, b) => new Date(a.captured_at || a.created_at || 0) - new Date(b.captured_at || b.created_at || 0));
    const logs = await query(
      `SELECT rel.*, e.full_name as performer_name FROM route_execution_logs rel
       LEFT JOIN employees e ON e.id = rel.performed_by
       WHERE rel.route_id=$1 ORDER BY rel.created_at`, [req.params.id]
    );
    const damages = await query('SELECT pd.*, pr.name as product_name FROM product_damages pd JOIN merch_products pr ON pr.id=pd.product_id WHERE pd.route_id=$1', [req.params.id]);
    const ruptures = await query('SELECT pr2.*, p.name as product_name FROM product_ruptures pr2 JOIN merch_products p ON p.id=pr2.product_id WHERE pr2.route_id=$1', [req.params.id]);

    // Load route brands (multi-brand)
    let routeBrands = [];
    try {
      const rbRes = await query(
        `SELECT rb.*, b.name as brand_name, bc.name as checklist_name,
         (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_brand_id = rb.id) as total_products,
         (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_brand_id = rb.id AND rpe.status = 'completed') as completed_products,
         (SELECT COUNT(DISTINCT rph.photo_url) FROM route_photos rph
           WHERE rph.route_brand_id = rb.id
             AND rph.photo_url IS NOT NULL
             AND rph.photo_url NOT LIKE 'blob:%'
             AND rph.photo_url NOT LIKE 'local-file:%') as photos_count
         FROM route_brands rb
         LEFT JOIN merch_brands b ON b.id = rb.brand_id
         LEFT JOIN brand_checklists bc ON bc.id = rb.checklist_id
         WHERE rb.route_id = $1 ORDER BY rb.sort_order`, [req.params.id]);
      routeBrands = rbRes.rows;
    } catch {}

    res.json({
      ...route.rows[0],
      executions: executions.rows,
      photos: photos.rows,
      logs: logs.rows,
      damages: damages.rows,
      ruptures: ruptures.rows,
      route_brands: routeBrands,
      is_multi_brand: routeBrands.length > 0,
    });
  } catch (err) { logError('routes.detail', err); res.status(500).json({ error: 'Erro' }); }
});

// Route execution timeline (real-time panel)
router.get('/routes/live', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.json([]);
    const orgId = orgRes.rows[0].organization_id;

    // Check if supporting tables/columns exist to avoid schema drift crashes
    let hasExecCategories = false;
    let hasProductExecs = false;
    let brandTable = 'brands';
    let checkinPhotoColumn = 'checkin_photo';
    let checkoutPhotoColumn = 'checkout_photo';
    try {
      await query(`SELECT 1 FROM merch_execution_categories LIMIT 0`);
      hasExecCategories = true;
    } catch {}
    try {
      await query(`SELECT 1 FROM route_product_executions LIMIT 0`);
      hasProductExecs = true;
    } catch {}
    try {
      await query(`SELECT 1 FROM merch_brands LIMIT 0`);
      brandTable = 'merch_brands';
    } catch {}
    try {
      // Check for checkin_photo_url first, then checkin_photo
      const checkinColRes = await query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name='merch_routes' AND column_name IN ('checkin_photo_url', 'checkin_photo')
        ORDER BY column_name='checkin_photo_url' DESC LIMIT 1
      `);
      if (checkinColRes.rows.length) checkinPhotoColumn = checkinColRes.rows[0].column_name;

      const checkoutColRes = await query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name='merch_routes' AND column_name IN ('checkout_photo_url', 'checkout_photo')
        ORDER BY column_name='checkout_photo_url' DESC LIMIT 1
      `);
      if (checkoutColRes.rows.length) checkoutPhotoColumn = checkoutColRes.rows[0].column_name;
    } catch (e) { logWarn('live_routes.column_check_failed', e); }

    const productCountSql = hasProductExecs
      ? `(SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_id = r.id)`
      : `0`;
    const completedCountSql = hasProductExecs
      ? `(SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_id = r.id AND rpe.status = 'completed')`
      : `0`;
    const categoryProgressSql = hasExecCategories
      ? `(SELECT COALESCE(json_agg(json_build_object(
                'category_id', mec.category_id,
                'category_name', COALESCE(mec.category_name,''),
                'point_type', mec.point_type,
                'products_unlocked', COALESCE(mec.products_unlocked, false),
                'completed', COALESCE(mec.completed, false),
                'before_photo', mec.category_before_photo,
                'after_photo', mec.category_after_photo
              )), '[]'::json) FROM merch_execution_categories mec WHERE mec.route_id = r.id)`
      : `'[]'::json`;

    const result = await query(
      `SELECT r.*, e.full_name as promoter_name, p.name as pdv_name, p.city as pdv_city, p.client_name as pdv_client, b.name as brand_name,
              COALESCE(bc.name,'') as checklist_name,
              r.checkin_at, r.checkout_at, r.completed_at, COALESCE(r.progress_pct, 0) as progress_pct,
              r.${checkinPhotoColumn} as checkin_photo,
              r.${checkoutPhotoColumn} as checkout_photo,
              ${productCountSql} as total_products,
              ${completedCountSql} as completed_products,
              ${categoryProgressSql} as category_progress
       FROM merch_routes r
       LEFT JOIN employees e ON e.id = r.promoter_id
       LEFT JOIN pdvs p ON p.id = r.pdv_id
       LEFT JOIN ${brandTable} b ON b.id = r.brand_id
       LEFT JOIN brand_checklists bc ON bc.id = r.checklist_id
       WHERE r.organization_id=$1
         AND r.visit_date BETWEEN COALESCE($2::date, CURRENT_DATE) AND COALESCE($3::date, CURRENT_DATE)
       ORDER BY 
         r.visit_date DESC, 
         CASE r.status 
           WHEN 'in_progress' THEN 0 
           WHEN 'completed' THEN 1
           WHEN 'scheduled' THEN 2 
           WHEN 'confirmed' THEN 3 
           ELSE 4 
         END, 
         r.scheduled_time`,
      [orgId, req.query.date_from || null, req.query.date_to || null]
    );

    // Resolve photo URLs to absolute paths
    const base = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
    const rows = result.rows.map(r => {
      // Fix category progress photo URLs
      if (Array.isArray(r.category_progress)) {
        r.category_progress = r.category_progress.map(cp => ({
          ...cp,
          before_photo: cp.before_photo && !cp.before_photo.startsWith('http') ? `${base}${cp.before_photo.startsWith('/') ? '' : '/'}${cp.before_photo}` : cp.before_photo,
          after_photo: cp.after_photo && !cp.after_photo.startsWith('http') ? `${base}${cp.after_photo.startsWith('/') ? '' : '/'}${cp.after_photo}` : cp.after_photo,
        }));
      }
      // Fix checkin/checkout photos
      if (r.checkin_photo && !r.checkin_photo.startsWith('http')) {
        r.checkin_photo = `${base}${r.checkin_photo.startsWith('/') ? '' : '/'}${r.checkin_photo}`;
      }
      if (r.checkout_photo && !r.checkout_photo.startsWith('http')) {
        r.checkout_photo = `${base}${r.checkout_photo.startsWith('/') ? '' : '/'}${r.checkout_photo}`;
      }
      return r;
    });

    res.json(rows);
  } catch (err) {
    console.error('ERROR in /routes/live:', err);
    logError('routes.live', err);
    if (err.code === '42P01' || err.code === '42703') return res.json([]);
    res.status(500).json({ error: err.message || 'Erro interno no servidor' });
  }

});

// ===== BRAND CHECKLISTS =====
router.get('/brand-checklists', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.json([]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id } = req.query;

    let sql = 'SELECT bc.*, b.name as brand_name FROM brand_checklists bc LEFT JOIN merch_brands b ON b.id=bc.brand_id WHERE bc.organization_id=$1';
    const params = [orgId];
    if (brand_id) { sql += ' AND bc.brand_id=$2'; params.push(brand_id); }
    sql += ' ORDER BY b.name, bc.name';
    res.json((await query(sql, params)).rows);
  } catch (err) { logError('checklists.list', err); res.status(500).json({ error: 'Erro' }); }
});

router.post('/brand-checklists', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id, name, description, require_checkin_photo, require_checkout_photo, require_stock_count,
            require_validity_check, require_extra_point, require_category_photos, category_photo_mode,
            min_category_photos_before, min_category_photos_after,
            stock_count_frequency, validity_check_frequency } = req.body;

    // Ensure table exists
    await query(`CREATE TABLE IF NOT EXISTS brand_checklists (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      brand_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      require_checkin_photo BOOLEAN DEFAULT true,
      require_checkout_photo BOOLEAN DEFAULT false,
      require_stock_count BOOLEAN DEFAULT false,
       require_validity_check BOOLEAN DEFAULT false,
       require_extra_point BOOLEAN DEFAULT false,
       require_category_photos BOOLEAN DEFAULT true,
       category_photo_mode VARCHAR(20) DEFAULT 'both',
       stock_count_frequency VARCHAR(20) DEFAULT 'every_visit',
      validity_check_frequency VARCHAR(20) DEFAULT 'every_visit',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS require_category_photos BOOLEAN DEFAULT true`).catch(() => {});
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS category_photo_mode VARCHAR(20) DEFAULT 'both'`).catch(() => {});
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_before INT DEFAULT 1`).catch(() => {});
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_after INT DEFAULT 1`).catch(() => {});

    const result = await query(
      `INSERT INTO brand_checklists (organization_id, brand_id, name, description, require_checkin_photo,
       require_checkout_photo, require_stock_count, require_validity_check, require_extra_point, require_category_photos,
       category_photo_mode, min_category_photos_before, min_category_photos_after,
       stock_count_frequency, validity_check_frequency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [orgId, brand_id, name, description, require_checkin_photo ?? true, require_checkout_photo ?? false,
       require_stock_count ?? false, require_validity_check ?? false, require_extra_point ?? false, require_category_photos ?? true,
       category_photo_mode || 'both',
       parseInt(min_category_photos_before, 10) || 0,
       parseInt(min_category_photos_after, 10) || 0,
       stock_count_frequency || 'every_visit', validity_check_frequency || 'every_visit']
    );
    res.json(result.rows[0]);
  } catch (err) { logError('checklists.create', err); res.status(500).json({ error: 'Erro' }); }
});

router.put('/brand-checklists/:id', authenticate, async (req, res) => {
  try {
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS require_category_photos BOOLEAN DEFAULT true`).catch(() => {});
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS category_photo_mode VARCHAR(20) DEFAULT 'both'`).catch(() => {});
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_before INT DEFAULT 1`).catch(() => {});
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_after INT DEFAULT 1`).catch(() => {});
    const { name, description, require_checkin_photo, require_checkout_photo, require_stock_count,
            require_validity_check, require_extra_point, require_category_photos, category_photo_mode,
            min_category_photos_before, min_category_photos_after,
            stock_count_frequency, validity_check_frequency, active } = req.body;
    const minBefore = (min_category_photos_before === undefined || min_category_photos_before === null)
      ? null : Math.max(0, parseInt(min_category_photos_before, 10) || 0);
    const minAfter = (min_category_photos_after === undefined || min_category_photos_after === null)
      ? null : Math.max(0, parseInt(min_category_photos_after, 10) || 0);
    const result = await query(
      `UPDATE brand_checklists SET 
       name=COALESCE($2,name), 
       description=COALESCE($3,description),
       require_checkin_photo=$4, 
       require_checkout_photo=$5,
       require_stock_count=$6, 
       require_validity_check=$7,
       require_extra_point=$8, 
       stock_count_frequency=COALESCE($9,stock_count_frequency),
       validity_check_frequency=COALESCE($10,validity_check_frequency), 
       active=COALESCE($11,active),
       require_category_photos=$12,
       min_category_photos_before=COALESCE($13,min_category_photos_before),
       min_category_photos_after=COALESCE($14,min_category_photos_after),
       category_photo_mode=COALESCE($15,category_photo_mode),
       updated_at=(NOW() AT TIME ZONE 'America/Sao_Paulo' AT TIME ZONE 'UTC')
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, description, 
       require_checkin_photo ?? true, require_checkout_photo ?? false, 
       require_stock_count ?? false, require_validity_check ?? false,
       require_extra_point ?? false, stock_count_frequency, validity_check_frequency, active,
       require_category_photos ?? true, minBefore, minAfter, category_photo_mode]
    );
    res.json(result.rows[0]);
  } catch (err) { logError('checklists.update', err); res.status(500).json({ error: 'Erro' }); }
});

router.delete('/brand-checklists/:id', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    
    // Safety check: ensure it belongs to org
    const check = await query('SELECT id FROM brand_checklists WHERE id=$1 AND organization_id=$2', [req.params.id, orgId]);
    if (!check.rows.length) return res.status(404).json({ error: 'Não encontrado' });

    await query('DELETE FROM brand_checklists WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { logError('checklists.delete', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== DAMAGES (admin) =====
router.get('/damages', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id, pdv_id, product_id, status } = req.query;
    let sql = `SELECT pd.*, pr.name as product_name, p.name as pdv_name, b.name as brand_name, e.full_name as promoter_name
               FROM product_damages pd
               JOIN merch_products pr ON pr.id=pd.product_id
               JOIN pdvs p ON p.id=pd.pdv_id
               JOIN merch_brands b ON b.id=pd.brand_id
               JOIN employees e ON e.id=pd.promoter_id
               WHERE pd.organization_id=$1`;
    const params = [orgId];
    let idx = 2;
    if (brand_id) { sql += ` AND pd.brand_id=$${idx++}`; params.push(brand_id); }
    if (pdv_id) { sql += ` AND pd.pdv_id=$${idx++}`; params.push(pdv_id); }
    if (product_id) { sql += ` AND pd.product_id=$${idx++}`; params.push(product_id); }
    if (status) { sql += ` AND pd.status=$${idx++}`; params.push(status); }
    sql += ' ORDER BY pd.created_at DESC';
    res.json((await query(sql, params)).rows);
  } catch (err) { logError('damages.list', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== PHOTO QUALITY SETTINGS =====
router.get('/photo-settings', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    res.json((await query('SELECT * FROM photo_quality_settings WHERE organization_id=$1', [orgId])).rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/photo-settings', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id, blur_tolerance, min_brightness, max_brightness, compression_quality, max_file_size_mb,
            require_checkin_photo, require_category_photo, require_checkout_photo, watermark_enabled } = req.body;
    const result = await query(
      `INSERT INTO photo_quality_settings (organization_id, brand_id, blur_tolerance, min_brightness, max_brightness,
       compression_quality, max_file_size_mb, require_checkin_photo, require_category_photo, require_checkout_photo, watermark_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [orgId, brand_id, blur_tolerance ?? 50, min_brightness ?? 30, max_brightness ?? 90,
       compression_quality ?? 80, max_file_size_mb ?? 5, require_checkin_photo ?? true,
       require_category_photo ?? true, require_checkout_photo ?? false, watermark_enabled ?? true]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ===== BRAND PROMOTER ASSIGNMENTS =====
router.get('/brand-promoters', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id } = req.query;
    let sql = `SELECT bpa.*, e.full_name as promoter_name, b.name as brand_name
               FROM brand_promoter_assignments bpa
               JOIN employees e ON e.id=bpa.employee_id
               JOIN merch_brands b ON b.id=bpa.brand_id
               WHERE bpa.organization_id=$1 AND bpa.active=true`;
    const params = [orgId];
    if (brand_id) { sql += ' AND bpa.brand_id=$2'; params.push(brand_id); }
    res.json((await query(sql, params)).rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

// Create brand-promoter assignment
router.post('/brand-promoters', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id, employee_id, assignment_type } = req.body;
    const result = await query(
      `INSERT INTO brand_promoter_assignments (organization_id, brand_id, employee_id, assignment_type)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,
      [orgId, brand_id, employee_id, assignment_type || 'preferred']
    );
    res.json(result.rows[0] || { ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// Delete brand-promoter assignment
router.delete('/brand-promoters/:id', authenticate, async (req, res) => {
  try {
    await query('UPDATE brand_promoter_assignments SET active=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ===== SUPERVISOR: CONTINGENCY PHOTO UPLOAD =====
router.post('/routes/:id/contingency-photos', authenticate, async (req, res) => {
  try {
    const { photo_type, category_id, product_id, exposure_point, photo_url, reason, captured_at, route_brand_id } = req.body;
    const route = await query('SELECT * FROM merch_routes WHERE id=$1', [req.params.id]);
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });

    // Parse captured_at (accepts ISO or datetime-local); fallback to now via column default
    let capturedTs = null;
    if (captured_at) {
      const d = new Date(captured_at);
      if (!isNaN(d.getTime())) capturedTs = d.toISOString();
    }

    // Detect optional columns to avoid schema drift
    let hasCapturedAt = false, hasRouteBrandId = false;
    try { await query(`SELECT captured_at FROM route_photos LIMIT 0`); hasCapturedAt = true; } catch {}
    try { await query(`SELECT route_brand_id FROM route_photos LIMIT 0`); hasRouteBrandId = true; } catch {}

    const cols = ['route_id','photo_type','category_id','product_id','exposure_point','photo_url','upload_source','uploaded_by','contingency_reason','contingency_uploaded_by','contingency_device'];
    const vals = [req.params.id, photo_type || 'contingency', category_id || null, product_id || null, exposure_point || null, photo_url, 'web', req.userId, reason || null, req.userId, 'web_upload'];
    if (hasCapturedAt && capturedTs) { cols.push('captured_at'); vals.push(capturedTs); }
    if (hasRouteBrandId && route_brand_id) { cols.push('route_brand_id'); vals.push(route_brand_id); }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
    const photo = await query(
      `INSERT INTO route_photos (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`,
      vals
    );

    // Log contingency (best-effort — do not fail the upload if audit tables drift)
    try {
      await query(
        `INSERT INTO contingency_photo_uploads (route_id, photo_id, uploaded_by, uploader_role, source, reason)
         VALUES ($1,$2,$3,'supervisor','web',$4)`,
        [req.params.id, photo.rows[0].id, req.userId, reason]
      );
    } catch (e) { logError('routes.contingency_photo.audit_contingency', e); }

    try {
      await query(
        `INSERT INTO route_edit_audit_logs (route_id, field_changed, new_value, edited_by, editor_role, source, reason, route_was_completed)
         VALUES ($1,'photo_added',$2,$3,'supervisor','web',$4,$5)`,
        [req.params.id, photo_url, req.userId, reason || 'Contingência operacional', route.rows[0].status === 'completed']
      );
    } catch (e) { logError('routes.contingency_photo.audit_edit', e); }

    try {
      await query(
        `INSERT INTO execution_authors (route_id, action, performed_by, performer_role, source, details)
         VALUES ($1,'contingency_photo',$2,'supervisor','web',$3)`,
        [req.params.id, req.userId, JSON.stringify({ photo_type, reason, captured_at: capturedTs, category_id, route_brand_id })]
      );
    } catch (e) { logError('routes.contingency_photo.author', e); }

    // Mirror to live_photo_books so the Book de Fotos picks it up (best-effort)
    try {
      const orgRes = await query(
        `SELECT organization_id FROM merch_routes WHERE id=$1`, [req.params.id]
      );
      const orgId = orgRes.rows[0]?.organization_id || route.rows[0].organization_id;
      let brandForBook = route.rows[0].brand_id;
      if (route_brand_id) {
        try {
          const rb = await query(`SELECT brand_id FROM route_brands WHERE id=$1`, [route_brand_id]);
          if (rb.rows[0]?.brand_id) brandForBook = rb.rows[0].brand_id;
        } catch {}
      }
      await query(
        `INSERT INTO live_photo_books (organization_id, brand_id, pdv_id, route_id, category_id, product_id,
           photo_type, photo_url, promoter_id, captured_at, upload_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, NOW()), 'web_contingency')`,
        [orgId, brandForBook, route.rows[0].pdv_id, req.params.id,
         category_id || null, product_id || null, photo_type || 'contingency',
         photo_url, route.rows[0].promoter_id, capturedTs]
      );
    } catch (e) { logError('routes.contingency_photo.live_book_mirror', e); }

    res.json(photo.rows[0]);
  } catch (err) { logError('routes.contingency_photo', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== SUPERVISOR: SWAP/ADD/REMOVE PROMOTER =====
router.post('/routes/:id/assign-promoter', authenticate, async (req, res) => {
  try {
    const { employee_id, reason, action } = req.body; // action: 'replace', 'add', 'remove'
    const route = await query('SELECT * FROM merch_routes WHERE id=$1', [req.params.id]);
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const old = route.rows[0];

    // Log history
    await query(
      `INSERT INTO route_person_assignment_history (route_id, employee_id, action, reason, changed_by, progress_at_change)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, action === 'remove' ? old.promoter_id : employee_id, action || 'replace', reason, req.userId, old.progress_pct || 0]
    );

    if (action === 'replace' || !action) {
      // Audit old promoter
      await query(
        `INSERT INTO route_edit_audit_logs (route_id, field_changed, old_value, new_value, edited_by, editor_role, source, reason, route_was_completed)
         VALUES ($1,'promoter_id',$2,$3,$4,'supervisor','web',$5,$6)`,
        [req.params.id, old.promoter_id, employee_id, req.userId, reason, old.status === 'completed']
      );
      await query('UPDATE merch_routes SET promoter_id=$2, updated_at=NOW() WHERE id=$1', [req.params.id, employee_id]);
    }

    // Add to route_person_assignments
    if (action !== 'remove') {
      await query(
        `INSERT INTO route_person_assignments (route_id, employee_id, role, assigned_by)
         VALUES ($1,$2,'executor',$3) ON CONFLICT DO NOTHING`,
        [req.params.id, employee_id, req.userId]
      );
    } else {
      await query(
        `UPDATE route_person_assignments SET active=false, removed_at=NOW(), reason=$3
         WHERE route_id=$1 AND employee_id=$2`,
        [req.params.id, employee_id, reason]
      );
    }

    res.json({ ok: true });
  } catch (err) { logError('routes.assign_promoter', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== STOCK SCHEDULE RULES =====
router.get('/stock-schedule-rules', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id } = req.query;
    let sql = 'SELECT * FROM route_stock_schedule_rules WHERE organization_id=$1 AND active=true';
    const params = [orgId];
    if (brand_id) { sql += ' AND brand_id=$2'; params.push(brand_id); }
    res.json((await query(sql, params)).rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

router.post('/stock-schedule-rules', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id, category_id, product_id, pdv_id, rule_type, frequency, max_postponements } = req.body;
    const result = await query(
      `INSERT INTO route_stock_schedule_rules (organization_id, brand_id, category_id, product_id, pdv_id, rule_type, frequency, max_postponements)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orgId, brand_id, category_id, product_id, pdv_id, rule_type || 'stock_count', frequency || 'every_visit', max_postponements ?? 1]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ===== ROUTE AUDIT LOGS =====
router.get('/routes/:id/audit', authenticate, async (req, res) => {
  try {
    const logs = await query(
      `SELECT rea.*, u.name as editor_name, u.email as editor_email
       FROM route_edit_audit_logs rea
       LEFT JOIN users u ON u.id=rea.edited_by
       WHERE rea.route_id=$1 ORDER BY rea.created_at DESC`, [req.params.id]
    );
    res.json(logs.rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== EXECUTION AUTHORS (who did what) =====
router.get('/routes/:id/authors', authenticate, async (req, res) => {
  try {
    const authors = await query(
      `SELECT ea.*, e.full_name as performer_name
       FROM execution_authors ea
       LEFT JOIN employees e ON e.id=ea.performed_by
       WHERE ea.route_id=$1 ORDER BY ea.created_at`, [req.params.id]
    );
    res.json(authors.rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== ROUTE ASSIGNMENT HISTORY =====
router.get('/routes/:id/assignment-history', authenticate, async (req, res) => {
  try {
    const history = await query(
      `SELECT rpah.*, e.full_name as employee_name, u.name as changed_by_name
       FROM route_person_assignment_history rpah
       LEFT JOIN employees e ON e.id=rpah.employee_id
       LEFT JOIN users u ON u.id=rpah.changed_by
       WHERE rpah.route_id=$1 ORDER BY rpah.created_at DESC`, [req.params.id]
    );
    res.json(history.rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== LIVE PHOTO BOOK =====
router.get('/photo-book', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const { brand_id, pdv_id, date_from, date_to, promoter_id, category_id, photo_type, supervisor_id, rede_id, city } = req.query;

    // Ensure live_photo_books has upload_source column
    try { await query(`ALTER TABLE live_photo_books ADD COLUMN IF NOT EXISTS upload_source VARCHAR(20) DEFAULT 'app'`); } catch(e) {}
    // Ensure rotation column exists on both photo tables
    try { await query(`ALTER TABLE live_photo_books ADD COLUMN IF NOT EXISTS rotation INT DEFAULT 0`); } catch(e) {}
    try { await query(`ALTER TABLE route_photos ADD COLUMN IF NOT EXISTS rotation INT DEFAULT 0`); } catch(e) {}

    // Query from both live_photo_books AND route_photos (union for completeness)
    let sql = `SELECT * FROM (
      SELECT lpb.id, lpb.organization_id, lpb.brand_id, lpb.pdv_id, lpb.route_id, lpb.category_id, lpb.product_id,
             lpb.photo_type, lpb.photo_url, lpb.promoter_id, lpb.captured_at, lpb.upload_source,
             COALESCE(lpb.rotation,0) as rotation,
             e.full_name as promoter_name, e.supervisor_id as supervisor_id,
             sv.full_name as supervisor_name,
             pc.name as category_name, pr.name as product_name,
             p.name as pdv_name, p.city as pdv_city, b.name as brand_name,
             (SELECT rp_.rede_id FROM merch_rede_pdvs rp_ WHERE rp_.pdv_id=lpb.pdv_id LIMIT 1) as rede_id,
             (SELECT rd.name FROM merch_rede_pdvs rp_ JOIN merch_redes rd ON rd.id=rp_.rede_id WHERE rp_.pdv_id=lpb.pdv_id LIMIT 1) as rede_name
      FROM live_photo_books lpb
      LEFT JOIN employees e ON e.id=lpb.promoter_id
      LEFT JOIN employees sv ON sv.id=e.supervisor_id
      LEFT JOIN merch_categories pc ON pc.id=lpb.category_id
      LEFT JOIN merch_products pr ON pr.id=lpb.product_id
      LEFT JOIN pdvs p ON p.id=lpb.pdv_id
      LEFT JOIN merch_brands b ON b.id=lpb.brand_id
      WHERE lpb.organization_id=$1
      UNION ALL
      SELECT rp.id, r.organization_id, r.brand_id, r.pdv_id, rp.route_id, rp.category_id, rp.product_id,
             rp.photo_type, rp.photo_url, r.promoter_id, COALESCE(rp.captured_at, rp.created_at) as captured_at, rp.upload_source,
             COALESCE(rp.rotation,0) as rotation,
             e2.full_name as promoter_name, e2.supervisor_id as supervisor_id,
             sv2.full_name as supervisor_name,
             pc2.name as category_name, pr2.name as product_name,
             p2.name as pdv_name, p2.city as pdv_city, b2.name as brand_name,
             (SELECT rp_.rede_id FROM merch_rede_pdvs rp_ WHERE rp_.pdv_id=r.pdv_id LIMIT 1) as rede_id,
             (SELECT rd.name FROM merch_rede_pdvs rp_ JOIN merch_redes rd ON rd.id=rp_.rede_id WHERE rp_.pdv_id=r.pdv_id LIMIT 1) as rede_name
      FROM route_photos rp
      JOIN merch_routes r ON r.id=rp.route_id
      LEFT JOIN employees e2 ON e2.id=r.promoter_id
      LEFT JOIN employees sv2 ON sv2.id=e2.supervisor_id
      LEFT JOIN merch_categories pc2 ON pc2.id=rp.category_id
      LEFT JOIN merch_products pr2 ON pr2.id=rp.product_id
      LEFT JOIN pdvs p2 ON p2.id=r.pdv_id
      LEFT JOIN merch_brands b2 ON b2.id=r.brand_id
      WHERE r.organization_id=$1
        AND NOT EXISTS (SELECT 1 FROM live_photo_books lpb2 WHERE lpb2.route_id=rp.route_id AND lpb2.photo_url=rp.photo_url)
    ) combined WHERE photo_url IS NOT NULL
      AND photo_url NOT LIKE 'blob:%'
      AND photo_url NOT LIKE 'local-file:%'`;
    const params = [orgId];
    let idx = 2;
    const applyList = (col, val, isUuid = true) => {
      const arr = String(val).split(',').map(s => s.trim()).filter(Boolean);
      if (arr.length === 1) { sql += ` AND ${col}=$${idx++}`; params.push(arr[0]); }
      else if (arr.length > 1) { sql += ` AND ${col} = ANY($${idx++}${isUuid ? '::uuid[]' : '::text[]'})`; params.push(arr); }
    };
    if (brand_id) applyList('brand_id', brand_id);
    if (pdv_id) applyList('pdv_id', pdv_id);
    if (promoter_id) applyList('promoter_id', promoter_id);
    if (category_id) applyList('category_id', category_id);
    if (supervisor_id) applyList('supervisor_id', supervisor_id);
    if (rede_id) applyList('rede_id', rede_id);
    if (photo_type) applyList('photo_type', photo_type, false);
    if (city) applyList('pdv_city', city, false);
    if (date_from) { sql += ` AND captured_at >= $${idx++}`; params.push(date_from); }
    if (date_to) { sql += ` AND captured_at <= $${idx++}`; params.push(date_to + ' 23:59:59'); }
    sql += ' ORDER BY captured_at DESC LIMIT 1000';
    const rows = (await query(sql, params)).rows;
    // Desduplica a mesma foto (mesma URL na mesma rota) que pode existir nas duas tabelas
    const seen = new Set();
    const unique = rows.filter(r => {
      const k = `${r.route_id || ''}|${r.photo_url}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    res.json(unique);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    logError('photo-book', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== PHOTO ROTATION (persistent) =====
router.patch('/photos/:id/rotate', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;
    const id = req.params.id;
    let { rotation, delta } = req.body || {};
    // Ensure columns exist
    try { await query(`ALTER TABLE live_photo_books ADD COLUMN IF NOT EXISTS rotation INT DEFAULT 0`); } catch(e) {}
    try { await query(`ALTER TABLE route_photos ADD COLUMN IF NOT EXISTS rotation INT DEFAULT 0`); } catch(e) {}

    // Try live_photo_books first (scoped by org), then route_photos (scoped via route.org)
    const norm = (v) => {
      let n = Math.round(Number(v) || 0) % 360;
      if (n < 0) n += 360;
      return n;
    };

    // live_photo_books
    let cur = await query(`SELECT rotation FROM live_photo_books WHERE id=$1 AND organization_id=$2`, [id, orgId]);
    if (cur.rows.length) {
      const next = rotation != null ? norm(rotation) : norm((cur.rows[0].rotation || 0) + (Number(delta) || 90));
      await query(`UPDATE live_photo_books SET rotation=$1 WHERE id=$2`, [next, id]);
      return res.json({ ok: true, rotation: next });
    }
    // route_photos
    cur = await query(
      `SELECT rp.rotation FROM route_photos rp JOIN merch_routes r ON r.id=rp.route_id
       WHERE rp.id=$1 AND r.organization_id=$2`,
      [id, orgId]
    );
    if (cur.rows.length) {
      const next = rotation != null ? norm(rotation) : norm((cur.rows[0].rotation || 0) + (Number(delta) || 90));
      await query(`UPDATE route_photos SET rotation=$1 WHERE id=$2`, [next, id]);
      return res.json({ ok: true, rotation: next });
    }
    return res.status(404).json({ error: 'Foto não encontrada' });
  } catch (err) {
    logError('photo-rotate', err);
    res.status(500).json({ error: 'Erro ao girar foto' });
  }
});

// ===== PHOTO BOOK SHARE (create token) =====
router.post('/photo-book/share', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;
    const { title, subtitle, notes, photo_ids, captions, brand_logo_url, photos_per_page, report_branding } = req.body;

    // Create table if not exists
    await query(`CREATE TABLE IF NOT EXISTS photo_book_shares (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      token VARCHAR(64) UNIQUE NOT NULL,
      title TEXT,
      subtitle TEXT,
      notes TEXT,
      photo_ids JSONB,
      captions JSONB,
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days'),
      views INTEGER DEFAULT 0
    )`);
    await query(`ALTER TABLE photo_book_shares ADD COLUMN IF NOT EXISTS brand_logo_url TEXT`);
    await query(`ALTER TABLE photo_book_shares ADD COLUMN IF NOT EXISTS photos_per_page INTEGER DEFAULT 2`);
    await query(`ALTER TABLE photo_book_shares ADD COLUMN IF NOT EXISTS report_branding JSONB`);

    const crypto = await import('crypto');
    const token = crypto.randomBytes(32).toString('hex');

    await query(
      `INSERT INTO photo_book_shares (organization_id, token, title, subtitle, notes, photo_ids, captions, brand_logo_url, photos_per_page, report_branding, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orgId, token, title, subtitle, notes, JSON.stringify(photo_ids), JSON.stringify(captions || {}), brand_logo_url || null, photos_per_page || 2, JSON.stringify(report_branding || null), req.userId]
    );

    res.json({ token, url: `/book/${token}` });
  } catch (err) {
    logError('photo-book-share', err);
    res.status(500).json({ error: 'Erro ao criar link' });
  }
});

// ===== PHOTO BOOK PUBLIC VIEW =====
router.get('/photo-book/public/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Ensure table exists
    await query(`CREATE TABLE IF NOT EXISTS photo_book_shares (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      token TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      subtitle TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      photo_ids TEXT[] DEFAULT '{}',
      captions JSONB DEFAULT '{}',
      brand_logo_url TEXT,
      views INT DEFAULT 0,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);

    const shareRes = await query(
      `SELECT * FROM photo_book_shares WHERE token=$1`,
      [token]
    );
    if (!shareRes.rows.length) return res.status(404).json({ error: 'Não encontrado ou expirado' });

    const share = shareRes.rows[0];
    const photoIds = share.photo_ids || [];
    const captions = share.captions || {};

    // Increment views safely
    try { await query(`UPDATE photo_book_shares SET views=COALESCE(views,0)+1 WHERE id=$1`, [share.id]); } catch(_) {}

    // Get branding safely
    let branding = {};
    try {
      const brandingRes = await query(`SELECT logo_topbar, company_name FROM organization_settings WHERE organization_id=$1 LIMIT 1`, [share.organization_id]);
      branding = brandingRes.rows[0] || {};
    } catch(_) {}

    if (photoIds.length === 0) {
      return res.json({ 
        title: share.title, subtitle: share.subtitle, notes: share.notes, 
        photos: [], created_at: share.created_at, expires_at: share.expires_at,
        logo_url: share.brand_logo_url || branding.logo_topbar || null, company_name: branding.company_name || null 
      });
    }

    // Get photos - try live_photo_books first, fallback to route_photos
    let photosRows = [];
    const placeholders = photoIds.map((_,i) => `$${i+1}`).join(',');
    
    try {
      const photosRes = await query(`
        SELECT * FROM (
          SELECT lpb.id, lpb.photo_url, lpb.photo_type, lpb.captured_at,
                 pr.name as product_name, pc.name as category_name, p.name as pdv_name, 
                 b.name as brand_name, e.full_name as promoter_name
          FROM live_photo_books lpb
          LEFT JOIN merch_products pr ON pr.id=lpb.product_id
          LEFT JOIN merch_categories pc ON pc.id=lpb.category_id
          LEFT JOIN pdvs p ON p.id=lpb.pdv_id
          LEFT JOIN merch_brands b ON b.id=lpb.brand_id
          LEFT JOIN employees e ON e.id=lpb.promoter_id
          WHERE lpb.id IN (${placeholders})
          UNION ALL
          SELECT rp.id, rp.photo_url, rp.photo_type, COALESCE(rp.captured_at, rp.created_at) as captured_at,
                 pr2.name as product_name, pc2.name as category_name, p2.name as pdv_name,
                 b2.name as brand_name, e2.full_name as promoter_name
          FROM route_photos rp
          JOIN merch_routes r ON r.id=rp.route_id
          LEFT JOIN merch_products pr2 ON pr2.id=rp.product_id
          LEFT JOIN merch_categories pc2 ON pc2.id=rp.category_id
          LEFT JOIN pdvs p2 ON p2.id=r.pdv_id
          LEFT JOIN merch_brands b2 ON b2.id=r.brand_id
          LEFT JOIN employees e2 ON e2.id=r.promoter_id
          WHERE rp.id IN (${placeholders})
        ) combined
      `, [...photoIds, ...photoIds]);
      photosRows = photosRes.rows;
    } catch (queryErr) {
      // If union fails (missing table), try each table individually
      console.error('[photo-book-public] union query failed, trying fallback:', queryErr.message);
      try {
        const r1 = await query(`SELECT lpb.id, lpb.photo_url, lpb.photo_type, lpb.captured_at,
          pr.name as product_name, pc.name as category_name, p.name as pdv_name,
          b.name as brand_name, e.full_name as promoter_name
          FROM live_photo_books lpb
          LEFT JOIN merch_products pr ON pr.id=lpb.product_id
          LEFT JOIN merch_categories pc ON pc.id=lpb.category_id
          LEFT JOIN pdvs p ON p.id=lpb.pdv_id
          LEFT JOIN merch_brands b ON b.id=lpb.brand_id
          LEFT JOIN employees e ON e.id=lpb.promoter_id
          WHERE lpb.id IN (${placeholders})`, photoIds);
        photosRows = r1.rows;
      } catch(_) {}
      try {
        const r2 = await query(`SELECT rp.id, rp.photo_url, rp.photo_type, COALESCE(rp.captured_at, rp.created_at) as captured_at,
          pr2.name as product_name, pc2.name as category_name, p2.name as pdv_name,
          b2.name as brand_name, e2.full_name as promoter_name
          FROM route_photos rp
          JOIN merch_routes r ON r.id=rp.route_id
          LEFT JOIN merch_products pr2 ON pr2.id=rp.product_id
          LEFT JOIN merch_categories pc2 ON pc2.id=rp.category_id
          LEFT JOIN pdvs p2 ON p2.id=r.pdv_id
          LEFT JOIN merch_brands b2 ON b2.id=r.brand_id
          LEFT JOIN employees e2 ON e2.id=r.promoter_id
          WHERE rp.id IN (${placeholders})`, photoIds);
        photosRows = [...photosRows, ...r2.rows];
      } catch(_) {}
    }

    // Maintain order from photo_ids and add captions
    const photoMap = new Map(photosRows.map(p => [p.id, p]));
    const orderedPhotos = photoIds
      .map(id => photoMap.get(id))
      .filter(Boolean)
      .map(p => ({ ...p, caption: captions[p.id] || '' }));

    res.json({
      title: share.title, subtitle: share.subtitle, notes: share.notes,
      photos: orderedPhotos, created_at: share.created_at, expires_at: share.expires_at,
      logo_url: share.brand_logo_url || branding.logo_topbar || null, company_name: branding.company_name || null,
    });
  } catch (err) {
    console.error('[photo-book-public] error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao carregar book', detail: err.message });
  }
});

// ===== RETURN REQUESTS =====
router.get('/return-requests', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0].organization_id;
    const result = await query(
      `SELECT drr.*, p.name as pdv_name, b.name as brand_name, e.full_name as promoter_name,
       (SELECT COUNT(*) FROM damage_return_items dri WHERE dri.request_id=drr.id) as item_count,
       (SELECT json_agg(row_to_json(ri)) FROM return_invoices ri WHERE ri.request_id=drr.id) as invoices
       FROM damage_return_requests drr
       JOIN pdvs p ON p.id=drr.pdv_id
       JOIN merch_brands b ON b.id=drr.brand_id
       JOIN employees e ON e.id=drr.promoter_id
       WHERE drr.organization_id=$1
       ORDER BY drr.created_at DESC`, [orgId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ===== PROMOTOR APP ENDPOINTS =====

// Auto-create PDV visit tables
async function ensurePdvVisitTables() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS pdv_visits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      promoter_id UUID NOT NULL,
      pdv_id UUID NOT NULL,
      visit_date DATE NOT NULL DEFAULT CURRENT_DATE,
      checkin_at TIMESTAMPTZ, checkin_latitude DOUBLE PRECISION, checkin_longitude DOUBLE PRECISION,
      checkin_photo_url TEXT, checkin_device TEXT,
      checkout_at TIMESTAMPTZ, checkout_latitude DOUBLE PRECISION, checkout_longitude DOUBLE PRECISION,
      checkout_photo_url TEXT,
      status VARCHAR(20) DEFAULT 'active', notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(promoter_id, pdv_id, visit_date)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS pdv_visit_routes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      visit_id UUID NOT NULL, route_id UUID NOT NULL,
      started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(visit_id, route_id)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS pdv_visit_timeline (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      visit_id UUID NOT NULL, route_id UUID,
      event_type VARCHAR(50) NOT NULL, event_data JSONB DEFAULT '{}',
      performed_by UUID, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  } catch (e) { /* ignore if already exists */ }
}

let execCategoryTablesReady = null;
async function ensureExecutionCategoryTables() {
  // Executa o DDL uma única vez por processo: chamadas paralelas (várias fotos
  // sendo enviadas ao mesmo tempo) causavam corrida na criação do índice (42P07).
  if (execCategoryTablesReady) return execCategoryTablesReady;
  execCategoryTablesReady = (async () => {
  try {
    await query(`CREATE TABLE IF NOT EXISTS merch_execution_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      route_id UUID NOT NULL REFERENCES merch_routes(id) ON DELETE CASCADE,
      category_id UUID REFERENCES merch_categories(id),
      route_brand_id UUID REFERENCES route_brands(id) ON DELETE CASCADE,
      category_name VARCHAR(255),
      point_type VARCHAR(20),
      point_type_at TIMESTAMPTZ,
      category_before_photo TEXT,
      category_photo_at TIMESTAMPTZ,
      category_photo_latitude DOUBLE PRECISION,
      category_photo_longitude DOUBLE PRECISION,
      products_unlocked BOOLEAN DEFAULT false,
      unlocked_at TIMESTAMPTZ,
      completed BOOLEAN DEFAULT false,
      completed_at TIMESTAMPTZ,
      performed_by UUID,
      created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'America/Sao_Paulo' AT TIME ZONE 'UTC'),
      updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'America/Sao_Paulo' AT TIME ZONE 'UTC'),
      UNIQUE NULLS NOT DISTINCT (route_id, category_id, route_brand_id)
    )`);

    // Add route_brand_id if it doesn't exist
    try {
      await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS route_brand_id UUID REFERENCES route_brands(id) ON DELETE CASCADE`);
      // Remove constraints antigas. NÃO recriamos a constraint UNIQUE aqui:
      // o índice único correto (idx_exec_categories_route_cat_brand) é criado abaixo
      // com IF NOT EXISTS — recriar a constraint causava erro 42P07 (índice duplicado).
      await query(`ALTER TABLE merch_execution_categories DROP CONSTRAINT IF EXISTS merch_execution_categories_route_id_category_id_key`);
      await query(`ALTER TABLE merch_execution_categories DROP CONSTRAINT IF EXISTS merch_execution_categories_route_id_category_id_route_brand_id_key`);
    } catch (e) {
      logWarn('failed to update merch_execution_categories schema', e);
    }

    // Ensure category_id is nullable if it was NOT NULL before
    try {
      await query(`ALTER TABLE merch_execution_categories ALTER COLUMN category_id DROP NOT NULL`);
    } catch (e) {}

    // Remove old/conflicting unique constraints and indexes — they block multi-brand rows
    // and don't match the ON CONFLICT expression used by the inserts.
    try { await query(`ALTER TABLE merch_execution_categories DROP CONSTRAINT IF EXISTS merch_execution_categories_route_id_category_id_key`); } catch {}
    try { await query(`ALTER TABLE merch_execution_categories DROP CONSTRAINT IF EXISTS merch_execution_categories_route_unique`); } catch {}
    try { await query(`ALTER TABLE merch_execution_categories DROP CONSTRAINT IF EXISTS merch_execution_categories_route_id_category_id_route_brand_id_key`); } catch {}
    try { await query(`DROP INDEX IF EXISTS idx_exec_categories_route_category`); } catch {}

    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_name VARCHAR(255)`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS point_type VARCHAR(20)`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS point_type_at TIMESTAMPTZ`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_before_photo TEXT`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_photo_at TIMESTAMPTZ`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_photo_latitude DOUBLE PRECISION`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_photo_longitude DOUBLE PRECISION`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS products_unlocked BOOLEAN DEFAULT false`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMPTZ`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_after_photo TEXT`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_after_photo_at TIMESTAMPTZ`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_after_photo_latitude DOUBLE PRECISION`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS category_after_photo_longitude DOUBLE PRECISION`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT false`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS performed_by UUID`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    // Unique expression index matching the ON CONFLICT clause used by the upserts below.
    // Using COALESCE makes NULL route_brand_id values comparable (single-brand routes).
    try {
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_categories_route_cat_brand
        ON merch_execution_categories(route_id, category_id, COALESCE(route_brand_id, '00000000-0000-0000-0000-000000000000'::uuid))`);
    } catch (e) {
      logWarn('failed to create idx_exec_categories_route_cat_brand', { error: e?.message });
    }
    try {
      await query(`CREATE INDEX IF NOT EXISTS idx_exec_categories_route ON merch_execution_categories(route_id)`);
    } catch (e) {
      logWarn('failed to create idx_exec_categories_route', { error: e?.message });
    }
  } catch (e) {
    logWarn('ensureExecutionCategoryTables.failed', { error: e?.message });
  }
  })();
  return execCategoryTablesReady;
}
// Run once on load
ensurePdvVisitTables().catch(() => {});
ensureExecutionCategoryTables().catch(() => {});

// Ensure multi-brand route tables exist
async function ensureRouteBrandsTables() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS route_brands (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      route_id UUID NOT NULL REFERENCES merch_routes(id) ON DELETE CASCADE,
      brand_id UUID NOT NULL,
      checklist_id UUID,
      status VARCHAR(30) DEFAULT 'pending',
      progress_pct NUMERIC(5,2) DEFAULT 0,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'America/Sao_Paulo' AT TIME ZONE 'UTC'),
      updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'America/Sao_Paulo' AT TIME ZONE 'UTC'),
      UNIQUE(route_id, brand_id)
    )`);
    await query(`ALTER TABLE route_product_executions ADD COLUMN IF NOT EXISTS route_brand_id UUID`);
    await query(`ALTER TABLE route_photos ADD COLUMN IF NOT EXISTS route_brand_id UUID`);
    await query(`ALTER TABLE merch_routes ALTER COLUMN brand_id DROP NOT NULL`);
    try { await query(`ALTER TABLE merch_execution_categories ADD COLUMN IF NOT EXISTS route_brand_id UUID`); } catch {}
    await query(`CREATE INDEX IF NOT EXISTS idx_route_brands_route ON route_brands(route_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_route_brands_brand ON route_brands(brand_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_route_product_exec_route_status ON route_product_executions(route_id, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_route_product_exec_route_brand ON route_product_executions(route_brand_id)`);
  } catch (e) { logWarn('ensureRouteBrandsTables.failed', { error: e?.message }); }
}
ensureRouteBrandsTables()
  .catch(() => {})
  .then(() => { checklistMergeColumnsReady = null; return ensureChecklistMergeColumns(); })
  .catch(() => {});


// Helper: hydrate products for a route_brand
async function hydrateRouteBrandProducts(routeId, routeBrandId, pdvId, brandId) {
  try {
    const typeCheck = await query(
      `SELECT COALESCE(rb.eff_checklist_type, bc.checklist_type, 'standard') as checklist_type
       FROM route_brands rb
       LEFT JOIN brand_checklists bc ON bc.id = rb.checklist_id
       WHERE rb.id = $1 LIMIT 1`,
      [routeBrandId]
    ).catch(() => ({ rows: [] }));
    if (typeCheck.rows[0]?.checklist_type === 'checkin_only') return 0;

    const mixProducts = await query(
      `SELECT pbp.product_id, p.category_id
       FROM merch_pdv_brand_products pbp
       JOIN merch_products p ON p.id = pbp.product_id
       WHERE pbp.pdv_id=$1 AND pbp.brand_id=$2 AND pbp.active=true`,
      [pdvId, brandId]
    );
    for (const mp of mixProducts.rows) {
      await query(
        `INSERT INTO route_product_executions (route_id, product_id, category_id, route_brand_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [routeId, mp.product_id, mp.category_id, routeBrandId]
      );
    }
    return mixProducts.rows.length;
  } catch (e) { logError('hydrateRouteBrandProducts', e); return 0; }
}

async function ensureChecklistPhotoColumns() {
  try {
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS require_category_photos BOOLEAN DEFAULT true`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS category_photo_mode VARCHAR(20) DEFAULT 'both'`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_before INT DEFAULT 1`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_after INT DEFAULT 1`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS checklist_type VARCHAR(20) DEFAULT 'standard'`);
  } catch (e) {
    logWarn('ensureChecklistPhotoColumns.failed', { error: e?.message });
  }
}

let pdvGeoColumnsReady = null;
async function ensurePdvGeoColumns() {
  if (pdvGeoColumnsReady) return pdvGeoColumnsReady;
  pdvGeoColumnsReady = (async () => {
    try {
      await query(`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'pdv'`);
      await query(`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS geofence_polygon JSONB`);
    } catch (e) {
      logWarn('ensurePdvGeoColumns.failed', { error: e?.message });
    }
  })().catch(() => {});
  return pdvGeoColumnsReady;
}

async function ensureAllRouteDetailColumns() {
  try {
    await ensureChecklistMergeColumns();
    await ensureChecklistPhotoColumns();
    await ensurePdvGeoColumns();
    await ensureRouteBrandsTables();
  } catch (e) { /* always proceed, we have SQL fallbacks */ }
}

async function calculateRouteExecutionProgress(routeId, routeBrandId = null) {
  await ensureRouteBrandsTables().catch(() => {});
  await ensureExecutionCategoryTables().catch(() => {});
  await ensureChecklistPhotoColumns().catch(() => {});

  const params = [routeId];
  let brandFilter = '';
  if (routeBrandId) {
    params.push(routeBrandId);
    brandFilter = ` AND rpe.route_brand_id = $${params.length}`;
  }

  const progressRes = await query(
    `SELECT rpe.category_id, rpe.route_brand_id,
            COUNT(*)::int as total_products,
            COUNT(*) FILTER (WHERE rpe.status = 'completed')::int as completed_products,
            COALESCE(mec.category_before_photo, '') as category_before_photo,
            COALESCE(mec.category_after_photo, '') as category_after_photo,
            COALESCE(mec.completed, false) as category_completed,
            COALESCE(rb.eff_require_category_photos, r.eff_require_category_photos, bc_rb.require_category_photos, bc_route.require_category_photos, bc_brand.require_category_photos, true) as require_category_photos,
            COALESCE(rb.eff_category_photo_mode, r.eff_category_photo_mode, bc_rb.category_photo_mode, bc_route.category_photo_mode, bc_brand.category_photo_mode, 'both') as category_photo_mode
     FROM route_product_executions rpe
     JOIN merch_routes r ON r.id = rpe.route_id
     LEFT JOIN route_brands rb ON rb.id = rpe.route_brand_id
     LEFT JOIN brand_checklists bc_rb ON bc_rb.id = rb.checklist_id
     LEFT JOIN brand_checklists bc_route ON bc_route.id = r.checklist_id
     LEFT JOIN LATERAL (
       SELECT bc3.* FROM brand_checklists bc3
       WHERE bc3.brand_id = COALESCE(rb.brand_id, r.brand_id) AND bc3.active = true
       ORDER BY bc3.created_at DESC LIMIT 1
     ) bc_brand ON true
     LEFT JOIN merch_execution_categories mec
       ON mec.route_id = rpe.route_id
      AND mec.category_id IS NOT DISTINCT FROM rpe.category_id
      AND mec.route_brand_id IS NOT DISTINCT FROM rpe.route_brand_id
     WHERE rpe.route_id = $1 ${brandFilter}
     GROUP BY rpe.category_id, rpe.route_brand_id, mec.category_before_photo, mec.category_after_photo, mec.completed,
              rb.eff_require_category_photos, r.eff_require_category_photos,
              bc_rb.require_category_photos, bc_route.require_category_photos, bc_brand.require_category_photos,
              rb.eff_category_photo_mode, r.eff_category_photo_mode,
              bc_rb.category_photo_mode, bc_route.category_photo_mode, bc_brand.category_photo_mode`,

    params
  );

  let productTotal = 0;
  let productDone = 0;
  let photoTotal = 0;
  let photoDone = 0;

  for (const row of progressRes.rows) {
    productTotal += Number(row.total_products || 0);
    productDone += Number(row.completed_products || 0);

    if (row.require_category_photos === false) continue;
    const mode = row.category_photo_mode || 'both';
    if (mode === 'before' || mode === 'both') {
      photoTotal += 1;
      if (row.category_before_photo) photoDone += 1;
    }
    if (mode === 'after' || mode === 'both') {
      photoTotal += 1;
      if (row.category_after_photo || row.category_completed) photoDone += 1;
    }
  }

  const totalTasks = productTotal + photoTotal;
  const doneTasks = productDone + photoDone;
  const pct = totalTasks > 0 ? Math.min(100, Math.round((doneTasks / totalTasks) * 10000) / 100) : 0;
  return { pct, totalTasks, doneTasks, productTotal, productDone, photoTotal, photoDone };
}

async function refreshRouteProgress(routeId, routeBrandId = null, refreshAllBrands = false) {
  const routeBrands = {};
  try {
    const params = [routeId];
    let sql = 'SELECT id FROM route_brands WHERE route_id=$1';
    if (routeBrandId && !refreshAllBrands) {
      params.push(routeBrandId);
      sql += ` AND id=$${params.length}`;
    }
    const rbRes = await query(sql, params);
    for (const rb of rbRes.rows) {
      const brandProgress = await calculateRouteExecutionProgress(routeId, rb.id);
      const brandStatus = brandProgress.pct >= 100 ? 'completed' : brandProgress.doneTasks > 0 ? 'in_progress' : 'pending';
      await query(
        `UPDATE route_brands SET progress_pct=$2, status=$3, updated_at=NOW() WHERE id=$1`,
        [rb.id, brandProgress.pct, brandStatus]
      );
      routeBrands[rb.id] = { ...brandProgress, status: brandStatus };
    }
  } catch (e) {
    logWarn('refreshRouteProgress.brands_failed', { routeId, routeBrandId, error: e?.message });
  }

  const routeProgress = await calculateRouteExecutionProgress(routeId);
  await query('UPDATE merch_routes SET progress_pct=$2, updated_at=NOW() WHERE id=$1', [routeId, routeProgress.pct]);
  return { route: routeProgress, routeBrands };
}

// Promotor auth middleware
function promotorAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token obrigatório' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.employeeId = decoded.employeeId || decoded.employee_id;
    req.orgId = decoded.organizationId || decoded.organization_id;
    next();
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
}

// Import jwt at top
import jwt from 'jsonwebtoken';

// Promotor: My agenda
router.get('/promotor/agenda', promotorAuth, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    // Note: NÃO filtramos por organization_id porque um promotor de apoio (agência)
    // pode ter organization_id diferente da rota. A segurança é garantida pelo
    // vínculo em route_person_assignments (ou por promoter_id = ele mesmo).
    let sql = `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
               p.latitude as pdv_lat, p.longitude as pdv_lng,
               b.name as brand_name, b.logo_url as brand_logo,
               bc.name as checklist_name,
               CASE WHEN r.promoter_id = $1 THEN 'titular' ELSE 'apoio' END as promoter_role
               FROM merch_routes r
               LEFT JOIN pdvs p ON p.id = r.pdv_id
               LEFT JOIN merch_brands b ON b.id = r.brand_id
               LEFT JOIN brand_checklists bc ON bc.id = r.checklist_id
               WHERE (
                   r.promoter_id = $1
                   OR EXISTS (
                     SELECT 1 FROM route_person_assignments rpa
                      WHERE rpa.route_id = r.id
                        AND rpa.employee_id = $1
                        AND COALESCE(rpa.active, true) = true
                   )
                 )`;
    const params = [req.employeeId];
    let idx = 2;
    if (date_from) { sql += ` AND r.visit_date >= $${idx++}`; params.push(date_from); }
    if (date_to) { sql += ` AND r.visit_date <= $${idx++}`; params.push(date_to); }
    sql += ' ORDER BY r.visit_date, r.scheduled_time';
    let rows;
    try {
      rows = (await query(sql, params)).rows;
    } catch (e) {
      if (e.code === '42P01') {
        // route_person_assignments missing → fallback to only titular
        const sql2 = sql.replace(/AND \(\s*r\.promoter_id = \$1[\s\S]*?\)\)/, 'AND r.promoter_id = $1');
        rows = (await query(sql2, params)).rows;
      } else { throw e; }
    }
    // Enrich multi-brand
    try {
      const mbIds = rows.filter(r => !r.brand_id).map(r => r.id);
      if (mbIds.length > 0) {
        const rbRes = await query(
          `SELECT rb.route_id, rb.brand_id, rb.status, rb.progress_pct, b.name as brand_name, b.logo_url as brand_logo
           FROM route_brands rb LEFT JOIN merch_brands b ON b.id = rb.brand_id
           WHERE rb.route_id = ANY($1) ORDER BY rb.sort_order`, [mbIds]);
        const rbMap = {};
        for (const rb of rbRes.rows) { if (!rbMap[rb.route_id]) rbMap[rb.route_id] = []; rbMap[rb.route_id].push(rb); }
        for (const r of rows) { if (rbMap[r.id]) { r.route_brands = rbMap[r.id]; r.is_multi_brand = true; r.brand_name = rbMap[r.id].map(b => b.brand_name).join(' + '); } }
      }
    } catch {}
    // Enrich with stock-count flag (has active rule for the brand+weekday+pdv)
    try {
      const orgIds = Array.from(new Set(rows.map(r => r.organization_id).filter(Boolean)));
      const rulesRes = orgIds.length
        ? await query(
            `SELECT brand_id, weekdays, pdv_overrides FROM stock_count_rules WHERE organization_id = ANY($1::uuid[]) AND enabled=true`,
            [orgIds]
          )
        : { rows: [] };
      const rulesByBrand = new Map();
      for (const rule of rulesRes.rows) {
        const wd = Array.isArray(rule.weekdays) ? rule.weekdays : (rule.weekdays ? (typeof rule.weekdays === 'string' ? JSON.parse(rule.weekdays) : rule.weekdays) : null);
        const pov = rule.pdv_overrides ? (typeof rule.pdv_overrides === 'object' ? rule.pdv_overrides : JSON.parse(rule.pdv_overrides)) : null;
        rulesByBrand.set(rule.brand_id, { weekdays: wd, pdv_overrides: pov });
      }
      for (const r of rows) {
        if (!r.visit_date) { r.has_stock_count = false; continue; }
        const dow = parseDateAtNoon(r.visit_date).getDay();
        const brandIds = [];
        if (r.brand_id) brandIds.push(r.brand_id);
        if (Array.isArray(r.route_brands)) for (const rb of r.route_brands) if (rb.brand_id) brandIds.push(rb.brand_id);
        let has = false;
        for (const bid of brandIds) {
          const rule = rulesByBrand.get(bid);
          if (!rule) continue;
          const pdvOv = rule.pdv_overrides && r.pdv_id ? rule.pdv_overrides[r.pdv_id] : null;
          const eff = (pdvOv && Array.isArray(pdvOv.weekdays)) ? pdvOv.weekdays : rule.weekdays;
          if (!eff || !eff.length || eff.map(Number).includes(dow)) { has = true; break; }
        }
        r.has_stock_count = has;
        if (has) r.stock_count_source = 'rule';
      }
      await enrichStockCountFromChecklists(rows);
      // Enrich with stock_count_status (aggregate) for rows that have has_stock_count

      try {
        const scRouteIds = rows.filter(r => r.has_stock_count).map(r => r.id);
        if (scRouteIds.length) {
          const scRes = await query(
            `SELECT route_id, status FROM stock_count_executions WHERE route_id = ANY($1::uuid[])`,
            [scRouteIds]
          );
          const byRoute = new Map();
          for (const row of scRes.rows) {
            const arr = byRoute.get(row.route_id) || [];
            arr.push(row.status);
            byRoute.set(row.route_id, arr);
          }
          for (const r of rows) {
            if (!r.has_stock_count) continue;
            const statuses = byRoute.get(r.id) || [];
            if (!statuses.length) r.stock_count_status = 'pending';
            else if (statuses.every(s => s === 'completed')) r.stock_count_status = 'completed';
            else if (statuses.some(s => s === 'postponed')) r.stock_count_status = 'postponed';
            else if (statuses.some(s => s === 'justified')) r.stock_count_status = 'justified';
            else if (statuses.some(s => s === 'in_progress')) r.stock_count_status = 'in_progress';
            else r.stock_count_status = 'pending';
          }
        }
      } catch (e) { logWarn('promotor.agenda.stock_count_status_failed', e); }
    } catch {}
    res.json(rows);

  } catch (err) {
    logError('promotor.agenda', err);
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

// Promotor: Route detail with products
router.get('/promotor/routes/:id', promotorAuth, async (req, res) => {
  try {
    await ensureAllRouteDetailColumns();

    let routeRes;
    try {
      routeRes = await query(
        `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
         p.latitude as pdv_lat, p.longitude as pdv_lng, p.radius_meters as pdv_radius,
         CASE WHEN p.type IS NOT NULL THEN p.type ELSE 'pdv' END as pdv_type,
         p.geofence_polygon as pdv_geofence_polygon,
         b.name as brand_name,
         COALESCE(bc.name, bc2.name) as checklist_name,
         COALESCE(r.eff_checklist_type, bc.checklist_type, bc2.checklist_type, 'standard') as checklist_type,
         COALESCE(r.eff_require_checkin_photo, bc.require_checkin_photo, bc2.require_checkin_photo, true) as require_checkin_photo,
         COALESCE(r.eff_require_checkout_photo, bc.require_checkout_photo, bc2.require_checkout_photo, false) as require_checkout_photo,
         COALESCE(r.eff_require_stock_count, bc.require_stock_count, bc2.require_stock_count, false) as require_stock_count,
         COALESCE(r.eff_require_validity_check, bc.require_validity_check, bc2.require_validity_check, false) as require_validity_check,
         COALESCE(r.eff_require_extra_point, bc.require_extra_point, bc2.require_extra_point, false) as require_extra_point,
         COALESCE(r.eff_require_category_photos, bc.require_category_photos, bc2.require_category_photos, true) as require_category_photos,
          COALESCE(r.eff_min_category_photos_before, bc.min_category_photos_before, bc2.min_category_photos_before, 1) as min_category_photos_before,
          COALESCE(r.eff_min_category_photos_after, bc.min_category_photos_after, bc2.min_category_photos_after, 1) as min_category_photos_after,
          COALESCE(r.eff_category_photo_mode, bc.category_photo_mode, bc2.category_photo_mode, 'both') as category_photo_mode

         FROM merch_routes r
         LEFT JOIN pdvs p ON p.id = r.pdv_id
         LEFT JOIN merch_brands b ON b.id = r.brand_id
         LEFT JOIN brand_checklists bc ON bc.id = r.checklist_id
         LEFT JOIN brand_checklists bc2 ON bc2.brand_id = r.brand_id AND bc2.active = true
         WHERE r.id=$1 AND (
           r.promoter_id=$2
           OR EXISTS (
             SELECT 1 FROM route_person_assignments rpa
              WHERE rpa.route_id = r.id AND rpa.employee_id = $2 AND COALESCE(rpa.active, true) = true
           )
         )`, [req.params.id, req.employeeId]
      );
    } catch (e) {
      if (e?.code === '42703' || e?.code === '42P01') {
        try {
          routeRes = await query(
            `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
             p.latitude as pdv_lat, p.longitude as pdv_lng, p.radius_meters as pdv_radius,
             'pdv'::text as pdv_type,
             NULL::jsonb as pdv_geofence_polygon,
             b.name as brand_name,
             NULL::text as checklist_name,
             'standard'::text as checklist_type,
             true as require_checkin_photo,
             false as require_checkout_photo,
             false as require_stock_count,
             false as require_validity_check,
             false as require_extra_point,
             true as require_category_photos,
             1 as min_category_photos_before,
             1 as min_category_photos_after,
             'both'::text as category_photo_mode
             FROM merch_routes r
             LEFT JOIN pdvs p ON p.id = r.pdv_id
             LEFT JOIN merch_brands b ON b.id = r.brand_id
             WHERE r.id=$1 AND (
               r.promoter_id=$2
               OR EXISTS (
                 SELECT 1 FROM route_person_assignments rpa
                  WHERE rpa.route_id = r.id AND rpa.employee_id = $2 AND COALESCE(rpa.active, true) = true
               )
             )`, [req.params.id, req.employeeId]
          );
        } catch (e2) {
          if (e2?.code === '42P01') {
            routeRes = await query(
              `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
               p.latitude as pdv_lat, p.longitude as pdv_lng, p.radius_meters as pdv_radius,
               'pdv'::text as pdv_type,
               NULL::jsonb as pdv_geofence_polygon,
               NULL::text as brand_name,
               NULL::text as checklist_name,
               'standard'::text as checklist_type,
               true as require_checkin_photo,
               false as require_checkout_photo,
               false as require_stock_count,
               false as require_validity_check,
               false as require_extra_point,
               true as require_category_photos,
               1 as min_category_photos_before,
               1 as min_category_photos_after,
               'both'::text as category_photo_mode
               FROM merch_routes r
               LEFT JOIN pdvs p ON p.id = r.pdv_id
               WHERE r.id=$1 AND r.promoter_id=$2`, [req.params.id, req.employeeId]
            );
          } else {
            throw e2;
          }
        }
      } else {
        throw e;
      }
    }

    if (!routeRes.rows.length) {
      const basicCheck = await query(
        `SELECT organization_id FROM merch_routes r
          WHERE r.id=$1 AND (
            r.promoter_id=$2
            OR EXISTS (SELECT 1 FROM route_person_assignments rpa WHERE rpa.route_id=r.id AND rpa.employee_id=$2 AND COALESCE(rpa.active,true)=true)
          )`,
        [req.params.id, req.employeeId]
      ).catch(async (e) => {
        if (e.code === '42P01') return await query('SELECT organization_id FROM merch_routes WHERE id=$1 AND promoter_id=$2', [req.params.id, req.employeeId]);
        throw e;
      });
      if (!basicCheck.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });

      let simpleRoute;
      try {
        simpleRoute = await query(
          `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
           p.latitude as pdv_lat, p.longitude as pdv_lng, p.radius_meters as pdv_radius,
           CASE WHEN p.type IS NOT NULL THEN p.type ELSE 'pdv' END as pdv_type,
           p.geofence_polygon as pdv_geofence_polygon,
           'standard' as checklist_type
           FROM merch_routes r
           LEFT JOIN pdvs p ON p.id = r.pdv_id
           WHERE r.id=$1`, [req.params.id]
        );
      } catch (e) {
        if (e?.code === '42703' || e?.code === '42P01') {
          simpleRoute = await query(
            `SELECT r.*, p.name as pdv_name, p.address as pdv_address, p.city as pdv_city,
             p.latitude as pdv_lat, p.longitude as pdv_lng, p.radius_meters as pdv_radius,
             'pdv'::text as pdv_type,
             NULL::jsonb as pdv_geofence_polygon,
             'standard' as checklist_type
             FROM merch_routes r
             LEFT JOIN pdvs p ON p.id = r.pdv_id
             WHERE r.id=$1`, [req.params.id]
          );
        } else {
          throw e;
        }
      }
      if (!simpleRoute.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
      routeRes.rows = simpleRoute.rows;
    }

    const route = routeRes.rows[0];

    let executions;
    try {
      executions = await query(
        `SELECT rpe.*, (COALESCE(rpe.qty_store,0) + COALESCE(rpe.qty_stock,0)) as qty_total,
         pr.name as product_name, pr.sku, pr.barcode, pr.image_url,
         pc.name as category_name, ps.name as subcategory_name,
         (SELECT pve.expiry_date FROM product_validity_entries pve WHERE pve.execution_id = rpe.id ORDER BY pve.expiry_date ASC LIMIT 1) as nearest_expiry_date,
         (SELECT pve.id FROM product_validity_entries pve WHERE pve.execution_id = rpe.id ORDER BY pve.expiry_date ASC LIMIT 1) as nearest_expiry_id,
         (SELECT pve.qty_store FROM product_validity_entries pve WHERE pve.execution_id = rpe.id ORDER BY pve.expiry_date ASC LIMIT 1) as nearest_expiry_qty_store,
         (SELECT pve.qty_stock FROM product_validity_entries pve WHERE pve.execution_id = rpe.id ORDER BY pve.expiry_date ASC LIMIT 1) as nearest_expiry_qty_stock
         FROM route_product_executions rpe
         JOIN merch_products pr ON pr.id = rpe.product_id
         LEFT JOIN merch_categories pc ON pc.id = rpe.category_id
         LEFT JOIN merch_subcategories ps ON ps.id = pr.subcategory_id
         WHERE rpe.route_id=$1 ORDER BY pc.name, ps.name, pr.name`, [req.params.id]
      );
    } catch (e) {
      if (e?.code === '42P01') {
        executions = { rows: [] };
      } else {
        logWarn('promotor.route_detail.executions_failed', e);
        executions = { rows: [] };
      }
    }

    let photos = { rows: [] };
    try {
      photos = await query('SELECT * FROM route_photos WHERE route_id=$1 ORDER BY captured_at', [req.params.id]);
    } catch (e) {
      if (e?.code !== '42P01') logWarn('promotor.route_detail.photos_failed', e);
    }

    // Load route brands (multi-brand support)
    let routeBrands = [];
    try {
      const rbRes = await query(
        `SELECT DISTINCT ON (rb.id) rb.*, b.name as brand_name, 
         COALESCE(bc.name, bc2.name) as checklist_name,
         COALESCE(rb.eff_checklist_type, bc.checklist_type, bc2.checklist_type, 'standard') as checklist_type,
         COALESCE(rb.eff_require_checkin_photo, bc.require_checkin_photo, bc2.require_checkin_photo, true) as require_checkin_photo,
         COALESCE(rb.eff_require_checkout_photo, bc.require_checkout_photo, bc2.require_checkout_photo, false) as require_checkout_photo,
         COALESCE(rb.eff_require_stock_count, bc.require_stock_count, bc2.require_stock_count, false) as require_stock_count,
         COALESCE(rb.eff_require_validity_check, bc.require_validity_check, bc2.require_validity_check, false) as require_validity_check,
         COALESCE(rb.eff_require_extra_point, bc.require_extra_point, bc2.require_extra_point, false) as require_extra_point,
         COALESCE(rb.eff_require_category_photos, bc.require_category_photos, bc2.require_category_photos, true) as require_category_photos,
         COALESCE(rb.eff_category_photo_mode, bc.category_photo_mode, bc2.category_photo_mode, 'both') as category_photo_mode,
         COALESCE(rb.eff_min_category_photos_before, bc.min_category_photos_before, bc2.min_category_photos_before, 1) as min_category_photos_before,
         COALESCE(rb.eff_min_category_photos_after, bc.min_category_photos_after, bc2.min_category_photos_after, 1) as min_category_photos_after,

         (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_brand_id = rb.id) as total_products,
         (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_brand_id = rb.id AND rpe.status = 'completed') as completed_products
         FROM route_brands rb
         LEFT JOIN merch_brands b ON b.id = rb.brand_id
         LEFT JOIN brand_checklists bc ON bc.id = rb.checklist_id
         LEFT JOIN brand_checklists bc2 ON bc2.brand_id = rb.brand_id AND bc2.active = true
         WHERE rb.route_id = $1 ORDER BY rb.id, bc2.created_at DESC`, [req.params.id]);
      routeBrands = rbRes.rows;
      routeBrands.sort((a, b) => (Number.isFinite(a.sort_order) && Number.isFinite(b.sort_order) ? a.sort_order - b.sort_order : 0));
    } catch (e) {
      if (e?.code === '42703' || e?.code === '42P01') {
        try {
          const rbRes2 = await query(
            `SELECT DISTINCT ON (rb.id) rb.*, b.name as brand_name,
             NULL::text as checklist_name,
             'standard'::text as checklist_type,
             true as require_checkin_photo,
             false as require_checkout_photo,
             false as require_stock_count,
             false as require_validity_check,
             false as require_extra_point,
             true as require_category_photos,
             'both'::text as category_photo_mode,
             1 as min_category_photos_before,
             1 as min_category_photos_after,
             (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_brand_id = rb.id) as total_products,
             (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_brand_id = rb.id AND rpe.status = 'completed') as completed_products
             FROM route_brands rb
             LEFT JOIN merch_brands b ON b.id = rb.brand_id
             WHERE rb.route_id = $1 ORDER BY rb.id`, [req.params.id]
          );
          routeBrands = rbRes2.rows;
          routeBrands.sort((a, b) => (Number.isFinite(a.sort_order) && Number.isFinite(b.sort_order) ? a.sort_order - b.sort_order : 0));
        } catch (e2) {
          routeBrands = [];
          if (e2?.code !== '42P01') logWarn('promotor.route_detail.route_brands_fallback_failed', e2);
        }
      } else {
        logWarn('promotor.route_detail.route_brands_failed', e);
        routeBrands = [];
      }
    }

    // Safety net: hydrate products for any route_brand that has zero linked products
    try {
      let needsRefetch = false;
      for (const rb of routeBrands) {
        if (Number(rb.total_products) === 0 && route.pdv_id && rb.brand_id) {
          const added = await hydrateRouteBrandProducts(req.params.id, rb.id, route.pdv_id, rb.brand_id);
          if (added > 0) needsRefetch = true;
        }
      }
      if (needsRefetch) {
        const re = await query(
          `SELECT rpe.*, (COALESCE(rpe.qty_store,0) + COALESCE(rpe.qty_stock,0)) as qty_total,
           pr.name as product_name, pr.sku, pr.barcode, pr.image_url,
           pc.name as category_name, ps.name as subcategory_name,
           (SELECT pve.expiry_date FROM product_validity_entries pve WHERE pve.execution_id = rpe.id ORDER BY pve.expiry_date ASC LIMIT 1) as nearest_expiry_date,
           (SELECT pve.id FROM product_validity_entries pve WHERE pve.execution_id = rpe.id ORDER BY pve.expiry_date ASC LIMIT 1) as nearest_expiry_id,
           (SELECT pve.qty_store FROM product_validity_entries pve WHERE pve.execution_id = rpe.id ORDER BY pve.expiry_date ASC LIMIT 1) as nearest_expiry_qty_store,
           (SELECT pve.qty_stock FROM product_validity_entries pve WHERE pve.execution_id = rpe.id ORDER BY pve.expiry_date ASC LIMIT 1) as nearest_expiry_qty_stock
           FROM route_product_executions rpe
           JOIN merch_products pr ON pr.id = rpe.product_id
           LEFT JOIN merch_categories pc ON pc.id = rpe.category_id
           LEFT JOIN merch_subcategories ps ON ps.id = pr.subcategory_id
           WHERE rpe.route_id=$1 ORDER BY pc.name, ps.name, pr.name`, [req.params.id]
        );
        executions.rows = re.rows;
      }
    } catch (e) { logWarn('promotor.route_detail.hydrate_missing', e); }


    // Check postponed items
    const postponed = await query(
      `SELECT rsp.*, pr.name as product_name, pc.name as category_name
       FROM route_stock_postponements rsp
       LEFT JOIN merch_products pr ON pr.id=rsp.product_id
       LEFT JOIN merch_categories pc ON pc.id=rsp.category_id
       WHERE rsp.next_route_id=$1 AND rsp.status='pending'`, [req.params.id]
    );

    // Category execution status (step-by-step)
    let categoryStatuses = [];
    try {
      const catRes = await query(
        `SELECT * FROM merch_execution_categories WHERE route_id=$1 ORDER BY category_name`, [req.params.id]
      );
      categoryStatuses = catRes.rows;
    } catch (e) { if (e.code !== '42P01') throw e; }

    // Auto-create category entries for categories that have products but no entry yet
    // Para rotas multi-marcas, criamos entradas por (category_id, route_brand_id)
    const existingCatKeys = new Set(categoryStatuses.map(c => `${c.category_id || 'null'}_${c.route_brand_id || 'null'}`));
    
    // Categorias presentes nas execuções (produtos)
    const categoriesByBrand = executions.rows.reduce((acc, exec) => {
      const key = `${exec.category_id || 'null'}_${exec.route_brand_id || 'null'}`;
      if (!acc[key]) {
        acc[key] = {
          catId: exec.category_id,
          catName: exec.category_name || 'Sem nome',
          brandId: exec.route_brand_id
        };
      }
      return acc;
    }, {});

    for (const [key, data] of Object.entries(categoriesByBrand)) {
      if (!existingCatKeys.has(key)) {
        // Encontrar se esta marca específica exige fotos de categoria
        let brandRequirePhotos = route.require_category_photos !== false;
        if (data.brandId) {
          const rb = routeBrands.find(b => b.id === data.brandId);
          if (rb) brandRequirePhotos = rb.require_category_photos !== false;
        }

        try {
          const ins = await query(
            `INSERT INTO merch_execution_categories (route_id, category_id, route_brand_id, category_name, performed_by, products_unlocked)
             SELECT $1,$2::uuid,$3::uuid,$4,$5,$6
             WHERE NOT EXISTS (
               SELECT 1 FROM merch_execution_categories
               WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2::uuid AND route_brand_id IS NOT DISTINCT FROM $3::uuid
             )
             RETURNING *`,
            [req.params.id, data.catId, data.brandId, data.catName, req.employeeId, !brandRequirePhotos]
          );
          if (ins.rows[0]) categoryStatuses.push(ins.rows[0]);
        } catch (e) { if (e.code !== '42P01') logError('promotor.auto_create_cat', e); }
      }
    }

    // Recalcula o progresso antes de devolver a rota: produtos concluídos não bastam
    // para 100% quando o checklist também exige foto de ANTES/DEPOIS da categoria.
    try {
      const refreshed = await refreshRouteProgress(req.params.id, null, true);
      route.progress_pct = refreshed.route.pct;
      routeBrands = routeBrands.map((rb) => ({
        ...rb,
        progress_pct: refreshed.routeBrands[rb.id]?.pct ?? rb.progress_pct,
        status: refreshed.routeBrands[rb.id]?.status ?? rb.status,
      }));
    } catch (e) {
      logWarn('promotor.route_detail.progress_refresh_failed', { routeId: req.params.id, error: e?.message });
    }

    res.json({
      ...route,
      executions: executions.rows,
      photos: photos.rows,
      postponed_items: postponed.rows,
      category_statuses: categoryStatuses,
      route_brands: routeBrands,
      is_multi_brand: routeBrands.length > 0,
    });
  } catch (err) { logError('promotor.route_detail', err); res.status(500).json({ error: 'Erro ao carregar rota' }); }
});

// Ensure not-done justification columns exist
async function ensureNotDoneColumns() {
  try {
    await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS not_done_reason TEXT`);
    await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS not_done_at TIMESTAMPTZ`);
    await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS not_done_by UUID`);
    await query(`ALTER TABLE merch_routes ADD COLUMN IF NOT EXISTS has_alert BOOLEAN DEFAULT false`);
  } catch (e) { /* ignore */ }
}

// Promotor: pending justifications (past open routes)
router.get('/promotor/pending-justifications', promotorAuth, async (req, res) => {
  try {
    await ensureNotDoneColumns();
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayStr = `${nowBR.getFullYear()}-${String(nowBR.getMonth()+1).padStart(2,'0')}-${String(nowBR.getDate()).padStart(2,'0')}`;
    const result = await query(
      `SELECT r.id, r.visit_date, r.scheduled_time, r.status, r.pdv_id, r.brand_id,
              p.name as pdv_name, b.name as brand_name
       FROM merch_routes r
       LEFT JOIN pdvs p ON p.id = r.pdv_id
       LEFT JOIN merch_brands b ON b.id = r.brand_id
       WHERE r.promoter_id=$1
         AND r.visit_date < $2
         AND r.status IN ('scheduled','confirmed','in_progress')
       ORDER BY r.visit_date ASC, r.scheduled_time ASC`,
      [req.employeeId, todayStr]
    );
    res.json(result.rows);
  } catch (err) { logError('promotor.pending_justifications', err); res.status(500).json({ error: 'Erro ao carregar pendências' }); }
});

// Promotor: justify a past open route (closes it as not_done with alert)
router.post('/promotor/routes/:id/justify', promotorAuth, async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Motivo obrigatório' });
    }
    await ensureNotDoneColumns();
    const check = await query(
      `SELECT id, status FROM merch_routes WHERE id=$1 AND promoter_id=$2`,
      [req.params.id, req.employeeId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    if (!['scheduled','confirmed','in_progress'].includes(check.rows[0].status)) {
      return res.status(400).json({ error: 'Rota não pode ser justificada neste status' });
    }
    const result = await query(
      `UPDATE merch_routes
       SET status='not_done', not_done_reason=$2, not_done_at=NOW(), not_done_by=$3,
           has_alert=true, completed_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, String(reason).trim(), req.employeeId]
    );
    res.json(result.rows[0]);
  } catch (err) { logError('promotor.justify_route', err); res.status(500).json({ error: 'Erro ao justificar rota' }); }
});

// Promotor: Check-in (also handles PDV visit creation)
router.post('/promotor/routes/:id/checkin', promotorAuth, async (req, res) => {
  try {
    const { latitude, longitude, device, photo_url, all_routes_at_pdv, geo_justification } = req.body;
    // Geofence validation (polygon-first, radius fallback)
    try {
      
      await ensurePdvGeofenceColumn(query);
      const routeInfo = await query(`SELECT pdv_id FROM merch_routes WHERE id=$1 AND promoter_id=$2`, [req.params.id, req.employeeId]);
      const pdvId0 = routeInfo.rows[0]?.pdv_id;
      if (pdvId0 && latitude != null && longitude != null) {
        const pdvGeo = await query(`SELECT p.id, p.name, p.type, p.latitude, p.longitude, p.radius_meters, p.geofence_polygon
                                    FROM pdvs p WHERE p.id=$1`, [pdvId0]);
        if (pdvGeo.rows[0]) {
          const pdv = pdvGeo.rows[0];
          const v = validatePdvLocation({
            userLat: latitude, userLng: longitude,
            pdvLat: pdv.latitude, pdvLng: pdv.longitude,
            radiusMeters: pdv.radius_meters,
            polygon: pdv.geofence_polygon,
          });
          if (v.status === 'outside' && !geo_justification) {
            const placeLabel = pdv.type === 'sede' ? 'Sede' : `PDV ${pdv.name ? '— ' + pdv.name : ''}`;
            const dist = v.distance != null ? Math.round(v.distance) : null;
            let distStr = '';
            if (dist != null) {
              if (dist >= 1000) {
                const km = (dist / 1000).toFixed(1).replace('.', ',');
                distStr = ` (você está a ~${km} km do local)`;
              } else {
                distStr = ` (você está a ~${dist} m do local)`;
              }
            }
            const hint = distStr;
            const modeHint = v.mode === 'polygon'
              ? 'Você está fora do perímetro (polígono geográfico) cadastrado para este local.'
              : 'Você está fora do raio de alcance (em metros) cadastrado para este local.';
            const hasOrgHeadquarters = await query(
              `SELECT 1 FROM pdvs WHERE organization_id=$1 AND type='sede' AND (latitude IS NOT NULL OR geofence_polygon IS NOT NULL) LIMIT 1`,
              [req.orgId]
            ).catch(() => ({ rows: [] }));
            const hasLinkedSede = await query(
              `SELECT 1 FROM employees e
               JOIN pdvs p ON p.id = e.branch_id OR p.id = e.pdv_id
               WHERE e.id=$1 AND p.type='sede' AND (p.latitude IS NOT NULL OR p.geofence_polygon IS NOT NULL) LIMIT 1`,
              [req.employeeId]
            ).catch(() => ({ rows: [] }));
            const locationOptions = [
              pdv.type === 'sede' ? 'na Sede cadastrada' : `no PDV de destino da rota${pdv.name ? ` (${pdv.name})` : ''}`,
            ];
            if (pdv.type !== 'sede' && (hasOrgHeadquarters.rows.length > 0 || hasLinkedSede.rows.length > 0)) {
              locationOptions.push('ou na Sede da empresa');
            }
            return res.status(400).json({
              error: 'outside_geofence',
              error_code: 'GEO_OUT_OF_RANGE',
              message: `Você precisa estar ${locationOptions.join(' ')} dentro da área permitida para fazer o check-in.${hint}`,
              details: {
                place_type: pdv.type === 'sede' ? 'sede' : 'pdv',
                place_name: pdv.name || null,
                mode: v.mode === 'polygon' ? 'polygon' : 'radius',
                mode_hint: modeHint,
                distance_meters: dist,
                radius_meters: pdv.radius_meters != null ? Number(pdv.radius_meters) : null,
                user_coords: { latitude, longitude },
                accept_justification: true,
              },
            });
          }
        }
      }
    } catch (e) { logError('promotor.checkin.geofence', e); }


    const route = await query(
      `SELECT r.*, bc.require_checkin_photo, r.pdv_id, r.visit_date
       FROM merch_routes r
       LEFT JOIN brand_checklists bc ON bc.id = r.checklist_id
       WHERE r.id=$1 AND r.promoter_id=$2`,
      [req.params.id, req.employeeId]
    );
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    if (route.rows[0].status !== 'scheduled' && route.rows[0].status !== 'confirmed') {
      return res.status(400).json({ error: 'Rota não pode receber check-in neste status' });
    }
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayStr = `${nowBR.getFullYear()}-${String(nowBR.getMonth()+1).padStart(2,'0')}-${String(nowBR.getDate()).padStart(2,'0')}`;

    // Block check-in when there are past open routes still awaiting justification
    try {
      await ensureNotDoneColumns();
      const pending = await query(
        `SELECT COUNT(*)::int AS cnt FROM merch_routes
         WHERE promoter_id=$1 AND visit_date < $2
           AND status IN ('scheduled','confirmed','in_progress')`,
        [req.employeeId, todayStr]
      );
      if (pending.rows[0].cnt > 0) {
        return res.status(409).json({ error: 'pending_justifications', message: 'Existem rotas anteriores em aberto. Justifique antes de iniciar uma nova.' });
      }
    } catch (e) { /* ignore */ }

    const pdvId = route.rows[0].pdv_id;
    let effectivePhotoUrl = photo_url || null;

    // Create or find PDV visit for this PDV + date
    let visitId = null;
    let isFirstRouteAtPdv = false;
    try {
      const existingVisit = await query(
        `SELECT id, checkin_photo_url FROM pdv_visits WHERE promoter_id=$1 AND pdv_id=$2 AND visit_date=$3`,
        [req.employeeId, pdvId, todayStr]
      );
      if (existingVisit.rows.length) {
        visitId = existingVisit.rows[0].id;
        const existingPhoto = existingVisit.rows[0].checkin_photo_url;
        if (!effectivePhotoUrl && existingPhoto) effectivePhotoUrl = existingPhoto;
      } else {
        if (route.rows[0].require_checkin_photo && !effectivePhotoUrl) {
          return res.status(400).json({ error: 'Esta rota exige foto obrigatória no check-in' });
        }
        isFirstRouteAtPdv = true;
        const visitRes = await query(
          `INSERT INTO pdv_visits (organization_id, promoter_id, pdv_id, visit_date, checkin_at, checkin_latitude, checkin_longitude, checkin_photo_url, checkin_device, status)
            VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,'active') RETURNING id`,
          [req.orgId, req.employeeId, pdvId, todayStr, latitude, longitude, effectivePhotoUrl, device]
        );
        visitId = visitRes.rows[0].id;

        // Timeline: PDV check-in
        await query(
          `INSERT INTO pdv_visit_timeline (visit_id, event_type, event_data, performed_by)
           VALUES ($1,'pdv_checkin',$2,$3)`,
          [visitId, JSON.stringify({ latitude, longitude, has_photo: !!effectivePhotoUrl }), req.employeeId]
        );
      }

      // Link route to visit
      await query(
        `INSERT INTO pdv_visit_routes (visit_id, route_id, started_at) VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING`,
        [visitId, req.params.id]
      );

      // Timeline: route started
      await query(
        `INSERT INTO pdv_visit_timeline (visit_id, route_id, event_type, event_data, performed_by)
         VALUES ($1,$2,'route_started',$3,$4)`,
        [visitId, req.params.id, JSON.stringify({ brand: route.rows[0].brand_name }), req.employeeId]
      );
    } catch (e) {
      // Tables may not exist yet, continue without visit tracking
      if (e.code !== '42P01') logError('promotor.checkin.visit', e);
    }

    if (route.rows[0].require_checkin_photo && !effectivePhotoUrl) {
      return res.status(400).json({ error: 'Esta rota exige foto obrigatória no check-in' });
    }

    const result = await query(
      `UPDATE merch_routes SET status='in_progress', checkin_at=NOW(), checkin_latitude=$2,
       checkin_longitude=$3, checkin_device=$4, checkin_photo_url=$5, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, latitude, longitude, device, effectivePhotoUrl]
    );

    if (all_routes_at_pdv) {
      await query(
        `UPDATE merch_routes SET status='in_progress', checkin_at=COALESCE(checkin_at, NOW()), checkin_latitude=$1,
         checkin_longitude=$2, checkin_device=$3, checkin_photo_url=COALESCE(checkin_photo_url, $4), updated_at=NOW()
         WHERE promoter_id=$5 AND pdv_id=$6 AND visit_date=$7 AND status IN ('scheduled','confirmed')`,
        [latitude, longitude, device, effectivePhotoUrl, req.employeeId, pdvId, route.rows[0].visit_date]
      );
    }

    if (effectivePhotoUrl) {
      await query(
        `INSERT INTO route_photos (route_id, photo_type, photo_url, latitude, longitude, upload_source, uploaded_by)
         VALUES ($1,'checkin',$2,$3,$4,'app',$5)`,
        [req.params.id, effectivePhotoUrl, latitude, longitude, req.employeeId]
      );
    }

    await query(
      `INSERT INTO route_execution_logs (route_id, action, details, performed_by, source)
       VALUES ($1,'checkin',$2,$3,'app')`,
      [req.params.id, JSON.stringify({ latitude, longitude, has_photo: !!effectivePhotoUrl, is_first_at_pdv: isFirstRouteAtPdv, visit_id: visitId }), req.employeeId]
    );

    res.json({ ...result.rows[0], visit_id: visitId, is_first_at_pdv: isFirstRouteAtPdv });
  } catch (err) { logError('promotor.checkin', err); res.status(500).json({ error: 'Erro' }); }
});

// Promotor: Update product execution
router.put('/promotor/executions/:id', promotorAuth, async (req, res) => {
  try {
    const { checked, qty_store, qty_stock, exposure_point, observation, status } = req.body;
    // Calculate qty_total
    const currentExec = await query('SELECT * FROM route_product_executions WHERE id=$1', [req.params.id]);
    if (!currentExec.rows.length) {
      return res.status(404).json({ error: 'Execução não encontrada' });
    }
    const newStore = qty_store !== undefined ? qty_store : (currentExec.rows[0]?.qty_store || 0);
    const newStock = qty_stock !== undefined ? qty_stock : (currentExec.rows[0]?.qty_stock || 0);
    const result = await query(
      `UPDATE route_product_executions SET checked=COALESCE($2,checked), qty_store=COALESCE($3,qty_store),
       qty_stock=COALESCE($4,qty_stock), exposure_point=COALESCE($5,exposure_point),
       observation=COALESCE($6,observation), status=COALESCE($7,status),
       executed_by=$8, executed_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING *, (COALESCE(qty_store,0) + COALESCE(qty_stock,0)) as qty_total`,
      [req.params.id, checked, qty_store, qty_stock, exposure_point, observation, status, req.employeeId]
    );

    // Update route and brand progress
    if (result.rows.length) {
      const exec = result.rows[0];
      const routeId = exec.route_id;
      const brandIdInRoute = exec.route_brand_id;
      
      try {
        await refreshRouteProgress(routeId, brandIdInRoute);
      } catch (progressErr) {
        logWarn('promotor.exec_update.progress_failed', { routeId, error: progressErr?.message });
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    logError('promotor.exec_update', err, { id: req.params.id, body: req.body, employeeId: req.employeeId });
    res.status(500).json({ error: err?.message || 'Erro ao atualizar execução' });
  }
});

// Promotor: Add validity entry (upsert when called inline from product checklist)
router.post('/promotor/executions/:id/validity', promotorAuth, async (req, res) => {
  try {
    const exec = await query('SELECT * FROM route_product_executions WHERE id=$1', [req.params.id]);
    if (!exec.rows.length) return res.status(404).json({ error: 'Execução não encontrada' });
    const { expiry_date, qty_store, qty_stock, replace } = req.body;
    if (!expiry_date) return res.status(400).json({ error: 'expiry_date é obrigatório' });
    // Ensure qty columns exist on legacy databases
    if (!(await hasColumn('product_validity_entries', 'qty_store'))) {
      await query(`ALTER TABLE product_validity_entries ADD COLUMN IF NOT EXISTS qty_store INTEGER DEFAULT 0`);
    }
    if (!(await hasColumn('product_validity_entries', 'qty_stock'))) {
      await query(`ALTER TABLE product_validity_entries ADD COLUMN IF NOT EXISTS qty_stock INTEGER DEFAULT 0`);
    }
    // When called inline (replace=true), keep a single validity entry per execution
    if (replace) {
      await query('DELETE FROM product_validity_entries WHERE execution_id=$1', [req.params.id]);
    }
    const qStore = Number.isFinite(Number(qty_store)) ? Number(qty_store) : 0;
    const qStock = Number.isFinite(Number(qty_stock)) ? Number(qty_stock) : 0;
    const result = await query(
      `INSERT INTO product_validity_entries (execution_id, route_id, product_id, expiry_date, qty_store, qty_stock, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, exec.rows[0].route_id, exec.rows[0].product_id, expiry_date, qStore, qStock, req.employeeId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logError('promotor.validity_add', err, { id: req.params.id, body: req.body });
    res.status(500).json({ error: err?.message || 'Erro' });
  }
});

// Promotor: Report rupture
router.post('/promotor/executions/:id/rupture', promotorAuth, async (req, res) => {
  try {
    const exec = await query('SELECT * FROM route_product_executions WHERE id=$1', [req.params.id]);
    if (!exec.rows.length) return res.status(404).json({ error: 'Execução não encontrada' });
    const { qty_store, qty_stock, reason, observation, photo_url } = req.body;
    await query('UPDATE route_product_executions SET has_rupture=true WHERE id=$1', [req.params.id]);
    const result = await query(
      `INSERT INTO product_ruptures (route_id, product_id, execution_id, qty_store, qty_stock, reason, observation, photo_url, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [exec.rows[0].route_id, exec.rows[0].product_id, req.params.id, qty_store||0, qty_stock||0, reason, observation, photo_url, req.employeeId]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// Promotor: Report damage (kind='damage')
router.post('/promotor/executions/:id/damage', promotorAuth, async (req, res) => {
  try {
    await ensurePerdasSchema();
    const exec = await query('SELECT rpe.*, r.pdv_id, r.brand_id, r.organization_id FROM route_product_executions rpe JOIN merch_routes r ON r.id=rpe.route_id WHERE rpe.id=$1', [req.params.id]);
    if (!exec.rows.length) return res.status(404).json({ error: 'Execução não encontrada' });
    const e = exec.rows[0];
    const { qty_store, qty_stock, reason, description, photo_url, location } = req.body;
    await query('UPDATE route_product_executions SET has_damage=true WHERE id=$1', [req.params.id]);
    const result = await query(
      `INSERT INTO product_damages (organization_id, route_id, product_id, pdv_id, brand_id, execution_id, promoter_id,
       location, qty_store, qty_stock, reason, description, photo_url, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'damage') RETURNING *`,
      [e.organization_id, e.route_id, e.product_id, e.pdv_id, e.brand_id, req.params.id, req.employeeId,
       location||'store', qty_store||0, qty_stock||0, reason, description, photo_url]
    );
    res.json(result.rows[0]);
  } catch (err) { logError('promotor.damage', err); res.status(500).json({ error: err?.message || 'Erro' }); }
});

// Promotor: Report discard (now ALSO writes to product_damages with kind='discard' for unified Perdas workflow)
router.post('/promotor/executions/:id/discard', promotorAuth, async (req, res) => {
  try {
    await ensurePerdasSchema();
    const exec = await query('SELECT rpe.*, r.pdv_id, r.brand_id, r.organization_id FROM route_product_executions rpe JOIN merch_routes r ON r.id=rpe.route_id WHERE rpe.id=$1', [req.params.id]);
    if (!exec.rows.length) return res.status(404).json({ error: 'Execução não encontrada' });
    const e = exec.rows[0];
    const { qty_store, qty_stock, reason, photo_url, observation, location } = req.body;
    await query('UPDATE route_product_executions SET has_discard=true WHERE id=$1', [req.params.id]);
    // Legacy table (kept for analytics)
    await query(
      `INSERT INTO product_discards (route_id, product_id, execution_id, qty_store, qty_stock, reason, photo_url, observation, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.route_id, e.product_id, req.params.id, qty_store||0, qty_stock||0, reason, photo_url, observation, req.employeeId]
    );
    // Unified: also create a product_damages row with kind='discard' so it enters the Perdas workflow
    const result = await query(
      `INSERT INTO product_damages (organization_id, route_id, product_id, pdv_id, brand_id, execution_id, promoter_id,
        location, qty_store, qty_stock, reason, description, photo_url, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'discard') RETURNING *`,
      [e.organization_id, e.route_id, e.product_id, e.pdv_id, e.brand_id, req.params.id, req.employeeId,
       location||'store', qty_store||0, qty_stock||0, reason, observation, photo_url]
    );
    res.json(result.rows[0]);
  } catch (err) { logError('promotor.discard', err); res.status(500).json({ error: err?.message || 'Erro' }); }
});

// Promotor: Set category point type
router.post('/promotor/routes/:routeId/categories/:catId/point-type', promotorAuth, async (req, res) => {
  try {
    await ensureExecutionCategoryTables();

    const rawPointType = req.body?.point_type ?? req.body?.pointType;
    const normalizedPointType = String(rawPointType || '').trim().toLowerCase();
    const point_type = normalizedPointType === 'natural' || normalizedPointType === 'extra'
      ? normalizedPointType
      : normalizedPointType === 'ponto natural' || normalizedPointType === 'natural_point'
        ? 'natural'
        : normalizedPointType === 'ponto extra' || normalizedPointType === 'extra_point'
          ? 'extra'
          : null;

    if (!point_type) {
      return res.status(400).json({ error: 'Tipo de ponto inválido. Use: natural ou extra' });
    }

    const { route_brand_id } = req.body;
    const catId = req.params.catId === 'null' ? null : req.params.catId;
    const products_unlocked = !!req.body?.products_unlocked;

    const categoryInRoute = await query(
      `SELECT COUNT(*)::int AS total, COALESCE(MAX(pc.name), 'Sem nome') AS category_name
       FROM route_product_executions rpe
       LEFT JOIN merch_categories pc ON pc.id = rpe.category_id
       WHERE rpe.route_id=$1 AND ${catId ? 'rpe.category_id=$2' : 'rpe.category_id IS NULL'}`,
      catId ? [req.params.routeId, catId] : [req.params.routeId]
    );

    if (!categoryInRoute.rows[0]?.total) {
      return res.status(404).json({ error: 'Categoria não encontrada nesta rota' });
    }

    const result = await query(
      `WITH updated AS (
         UPDATE merch_execution_categories
         SET category_name = $4,
             point_type = $5,
             point_type_at = NOW(),
             performed_by = $6,
             products_unlocked = CASE WHEN $7::boolean = true THEN true ELSE products_unlocked END,
             updated_at = NOW()
         WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2::uuid AND route_brand_id IS NOT DISTINCT FROM $3::uuid
         RETURNING *
       ), inserted AS (
         INSERT INTO merch_execution_categories (
           route_id, category_id, route_brand_id, category_name, point_type, point_type_at, performed_by, products_unlocked, updated_at
         )
         SELECT $1,$2::uuid,$3::uuid,$4,$5,NOW(),$6,$7,NOW()
         WHERE NOT EXISTS (SELECT 1 FROM updated)
         RETURNING *
       )
       SELECT * FROM updated
       UNION ALL
       SELECT * FROM inserted
       LIMIT 1`,
      [req.params.routeId, catId, route_brand_id || null, categoryInRoute.rows[0].category_name, point_type, req.employeeId, products_unlocked]
    );

    try {
      await query(
        `INSERT INTO route_execution_logs (route_id, action, details, performed_by, source)
         VALUES ($1,'category_point_type',$2,$3,'app')`,
        [req.params.routeId, JSON.stringify({ category_id: catId, point_type, products_unlocked, received_body: req.body }), req.employeeId]
      );
    } catch (logErr) {
      logWarn('promotor.cat_point_type.log_failed', { routeId: req.params.routeId, catId: req.params.catId, error: logErr?.message });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logError('promotor.cat_point_type.failed', { routeId: req.params.routeId, catId: req.params.catId, error: err.message }, err);
    res.status(500).json({ error: 'Erro ao registrar tipo de ponto: ' + err.message });
  }
});

// Promotor: Upload category before photo
router.post('/promotor/routes/:routeId/categories/:catId/photo', promotorAuth, async (req, res) => {
  try {
    const { photo_url, photos, latitude, longitude, route_brand_id } = req.body;
    const photoList = Array.isArray(photos) && photos.length ? photos : (photo_url ? [photo_url] : []);
    if (!photoList.length) return res.status(400).json({ error: 'Foto obrigatória' });

    const catId = req.params.catId === 'null' ? null : req.params.catId;

    // Check point_type was set first
    const cat = await query(
      `SELECT * FROM merch_execution_categories WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2 AND route_brand_id IS NOT DISTINCT FROM $3`,
      [req.params.routeId, catId, route_brand_id || null]
    );
    if (!cat.rows.length) return res.status(404).json({ error: 'Categoria não encontrada' });
    if (!cat.rows[0].point_type) return res.status(400).json({ error: 'Selecione o tipo de ponto antes de tirar a foto' });

    // Lookup minimum required from checklist
    let minBefore = 1;
    try {
      // Prioritize brand-specific checklist if multi-brand
      let checklistQuery = `SELECT COALESCE(r.eff_min_category_photos_before, bc.min_category_photos_before) as min_category_photos_before,
           COALESCE(r.eff_category_photo_mode, bc.category_photo_mode) as category_photo_mode FROM merch_routes r
         LEFT JOIN brand_checklists bc ON bc.id = r.checklist_id WHERE r.id=$1`;
      let checklistParams = [req.params.routeId];

      if (route_brand_id) {
        checklistQuery = `SELECT COALESCE(rb.eff_min_category_photos_before, bc.min_category_photos_before) as min_category_photos_before,
             COALESCE(rb.eff_category_photo_mode, bc.category_photo_mode) as category_photo_mode FROM route_brands rb
           LEFT JOIN brand_checklists bc ON bc.id = rb.checklist_id WHERE rb.id=$1`;
        checklistParams = [route_brand_id];
      }


      const minRes = await query(checklistQuery, checklistParams);
      if (minRes.rows[0]?.min_category_photos_before !== undefined) {
        minBefore = Math.max(0, parseInt(minRes.rows[0].min_category_photos_before, 10) || 0);
      }
      if (minRes.rows[0]?.category_photo_mode === 'after') {
        minBefore = 0; // No photos required before if mode is 'after'
      }
    } catch {}

    // Count previously uploaded before photos for this category/brand
    const hasRouteBrandColumn = await hasColumn('route_photos', 'route_brand_id');
    const prevCount = (await query(
      hasRouteBrandColumn
        ? `SELECT COUNT(*)::int as n FROM route_photos
           WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2
             AND route_brand_id IS NOT DISTINCT FROM $3
             AND photo_type='category_before'`
        : `SELECT COUNT(*)::int as n FROM route_photos
           WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2
             AND photo_type='category_before'`,
      hasRouteBrandColumn ? [req.params.routeId, catId, route_brand_id || null] : [req.params.routeId, catId]
    )).rows[0]?.n || 0;
    const totalAfterUpload = prevCount + photoList.length;
    const unlocks = totalAfterUpload >= minBefore;

    // Update primary photo column with the first photo of this batch (if not set yet)
    const primaryPhoto = cat.rows[0].category_before_photo || photoList[0];
    const result = await query(
      `UPDATE merch_execution_categories SET category_before_photo=$3, category_photo_at=COALESCE(category_photo_at,NOW()),
       category_photo_latitude=COALESCE(category_photo_latitude,$4), category_photo_longitude=COALESCE(category_photo_longitude,$5),
       products_unlocked=CASE WHEN $7::boolean THEN true ELSE products_unlocked END,
       unlocked_at=CASE WHEN $7::boolean AND unlocked_at IS NULL THEN NOW() ELSE unlocked_at END,
       performed_by=$6, updated_at=NOW()
       WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2 AND route_brand_id IS NOT DISTINCT FROM $8 RETURNING *`,
      [req.params.routeId, catId, primaryPhoto, latitude, longitude, req.employeeId, unlocks, route_brand_id || null]
    );

    // Persist every photo (dedupe: skip if same URL already stored for this category/type)
    for (const pUrl of photoList) {
      const dup = await query(
        hasRouteBrandColumn
          ? `SELECT 1 FROM route_photos
             WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2
               AND route_brand_id IS NOT DISTINCT FROM $3
               AND photo_type='category_before' AND photo_url=$4 LIMIT 1`
          : `SELECT 1 FROM route_photos
             WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2
               AND photo_type='category_before' AND photo_url=$3 LIMIT 1`,
        hasRouteBrandColumn ? [req.params.routeId, catId, route_brand_id || null, pUrl] : [req.params.routeId, catId, pUrl]
      );
      if (dup.rows.length) continue;
      await query(
        hasRouteBrandColumn
          ? `INSERT INTO route_photos (route_id, photo_type, category_id, photo_url, latitude, longitude, route_brand_id, upload_source, uploaded_by)
             VALUES ($1,'category_before',$2,$3,$4,$5,$6,'app',$7)`
          : `INSERT INTO route_photos (route_id, photo_type, category_id, photo_url, latitude, longitude, upload_source, uploaded_by)
             VALUES ($1,'category_before',$2,$3,$4,$5,'app',$6)`,
        hasRouteBrandColumn
          ? [req.params.routeId, catId, pUrl, latitude, longitude, route_brand_id || null, req.employeeId]
          : [req.params.routeId, catId, pUrl, latitude, longitude, req.employeeId]
      );
      try {
        const routeInfo = await query('SELECT organization_id, brand_id, pdv_id, promoter_id FROM merch_routes WHERE id=$1', [req.params.routeId]);
        if (routeInfo.rows.length) {
          const r = routeInfo.rows[0];
          await query(
            `INSERT INTO live_photo_books (organization_id, brand_id, pdv_id, route_id, category_id, photo_type, photo_url, promoter_id, captured_at, upload_source)
             VALUES ($1,$2,$3,$4,$5,'before',$6,$7,NOW(),'app')`,
            [r.organization_id, r.brand_id, r.pdv_id, req.params.routeId, catId, pUrl, r.promoter_id]
          );
        }
      } catch {}
    }


    await query(
      `INSERT INTO route_execution_logs (route_id, action, details, performed_by, source)
       VALUES ($1,'category_photo',$2,$3,'app')`,
      [req.params.routeId, JSON.stringify({ category_id: req.params.catId, count: photoList.length, total: totalAfterUpload, min: minBefore, unlocked: unlocks }), req.employeeId]
    );

    await refreshRouteProgress(req.params.routeId, route_brand_id || null).catch((e) => {
      logWarn('promotor.cat_photo.progress_failed', { routeId: req.params.routeId, error: e?.message });
    });

    res.json({ ...result.rows[0], total_before_photos: totalAfterUpload, min_before: minBefore, unlocked: unlocks });
  } catch (err) { logError('promotor.cat_photo', err); res.status(500).json({ error: 'Erro' }); }
});

// Promotor: Upload category AFTER photo (to complete/close category)
router.post('/promotor/routes/:routeId/categories/:catId/after-photo', promotorAuth, async (req, res) => {
  try {
    const { photo_url, photos, latitude, longitude, route_brand_id } = req.body;
    const photoList = Array.isArray(photos) && photos.length ? photos : (photo_url ? [photo_url] : []);
    if (!photoList.length) return res.status(400).json({ error: 'Foto obrigatória' });

    const catId = req.params.catId === 'null' ? null : req.params.catId;

    const cat = await query(
      `SELECT * FROM merch_execution_categories WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2 AND route_brand_id IS NOT DISTINCT FROM $3`,
      [req.params.routeId, catId, route_brand_id || null]
    );
    if (!cat.rows.length) return res.status(404).json({ error: 'Categoria não encontrada' });
    if (!cat.rows[0].products_unlocked) return res.status(400).json({ error: 'Produtos ainda não foram liberados (foto do ANTES necessária)' });

    let minAfter = 1;
    try {
      // Prioritize brand-specific checklist if multi-brand
      let checklistQuery = `SELECT COALESCE(r.eff_min_category_photos_after, bc.min_category_photos_after) as min_category_photos_after FROM merch_routes r
         LEFT JOIN brand_checklists bc ON bc.id = r.checklist_id WHERE r.id=$1`;
      let checklistParams = [req.params.routeId];

      if (route_brand_id) {
        checklistQuery = `SELECT COALESCE(rb.eff_min_category_photos_after, bc.min_category_photos_after) as min_category_photos_after FROM route_brands rb
           LEFT JOIN brand_checklists bc ON bc.id = rb.checklist_id WHERE rb.id=$1`;
        checklistParams = [route_brand_id];
      }


      const minRes = await query(checklistQuery, checklistParams);
      if (minRes.rows[0]?.min_category_photos_after) minAfter = Math.max(1, parseInt(minRes.rows[0].min_category_photos_after, 10));
    } catch {}

    const hasRouteBrandColumn = await hasColumn('route_photos', 'route_brand_id');
    const prevCount = (await query(
      hasRouteBrandColumn
        ? `SELECT COUNT(*)::int as n FROM route_photos
           WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2
             AND route_brand_id IS NOT DISTINCT FROM $3
             AND photo_type='category_after'`
        : `SELECT COUNT(*)::int as n FROM route_photos
           WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2
             AND photo_type='category_after'`,
      hasRouteBrandColumn ? [req.params.routeId, catId, route_brand_id || null] : [req.params.routeId, catId]
    )).rows[0]?.n || 0;
    const totalAfterUpload = prevCount + photoList.length;
    const completes = totalAfterUpload >= minAfter;

    const primaryPhoto = cat.rows[0].category_after_photo || photoList[0];
    const result = await query(
      `UPDATE merch_execution_categories SET category_after_photo=$3,
       category_after_photo_at=COALESCE(category_after_photo_at,NOW()),
       category_after_photo_latitude=COALESCE(category_after_photo_latitude,$4),
       category_after_photo_longitude=COALESCE(category_after_photo_longitude,$5),
       completed=CASE WHEN $7::boolean THEN true ELSE completed END,
       completed_at=CASE WHEN $7::boolean AND completed_at IS NULL THEN NOW() ELSE completed_at END,
       performed_by=$6, updated_at=NOW()
       WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2 AND route_brand_id IS NOT DISTINCT FROM $8 RETURNING *`,
      [req.params.routeId, catId, primaryPhoto, latitude, longitude, req.employeeId, completes, route_brand_id || null]
    );

    for (const pUrl of photoList) {
      const dup = await query(
        hasRouteBrandColumn
          ? `SELECT 1 FROM route_photos
             WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2
               AND route_brand_id IS NOT DISTINCT FROM $3
               AND photo_type='category_after' AND photo_url=$4 LIMIT 1`
          : `SELECT 1 FROM route_photos
             WHERE route_id=$1 AND category_id IS NOT DISTINCT FROM $2
               AND photo_type='category_after' AND photo_url=$3 LIMIT 1`,
        hasRouteBrandColumn ? [req.params.routeId, catId, route_brand_id || null, pUrl] : [req.params.routeId, catId, pUrl]
      );
      if (dup.rows.length) continue;
      await query(
        hasRouteBrandColumn
          ? `INSERT INTO route_photos (route_id, photo_type, category_id, photo_url, latitude, longitude, route_brand_id, upload_source, uploaded_by)
             VALUES ($1,'category_after',$2,$3,$4,$5,$6,'app',$7)`
          : `INSERT INTO route_photos (route_id, photo_type, category_id, photo_url, latitude, longitude, upload_source, uploaded_by)
             VALUES ($1,'category_after',$2,$3,$4,$5,'app',$6)`,
        hasRouteBrandColumn
          ? [req.params.routeId, catId, pUrl, latitude, longitude, route_brand_id || null, req.employeeId]
          : [req.params.routeId, catId, pUrl, latitude, longitude, req.employeeId]
      );
      try {
        const routeInfo = await query('SELECT organization_id, brand_id, pdv_id, promoter_id FROM merch_routes WHERE id=$1', [req.params.routeId]);
        if (routeInfo.rows.length) {
          const r = routeInfo.rows[0];
          await query(
            `INSERT INTO live_photo_books (organization_id, brand_id, pdv_id, route_id, category_id, photo_type, photo_url, promoter_id, captured_at, upload_source)
             VALUES ($1,$2,$3,$4,$5,'after',$6,$7,NOW(),'app')`,
            [r.organization_id, r.brand_id, r.pdv_id, req.params.routeId, catId, pUrl, r.promoter_id]
          );
        }
      } catch {}
    }


    await query(
      `INSERT INTO route_execution_logs (route_id, action, details, performed_by, source)
       VALUES ($1,'category_after_photo',$2,$3,'app')`,
      [req.params.routeId, JSON.stringify({ category_id: req.params.catId, count: photoList.length, total: totalAfterUpload, min: minAfter, completed: completes }), req.employeeId]
    );

    await refreshRouteProgress(req.params.routeId, route_brand_id || null).catch((e) => {
      logWarn('promotor.cat_after_photo.progress_failed', { routeId: req.params.routeId, error: e?.message });
    });

    res.json({ ...result.rows[0], total_after_photos: totalAfterUpload, min_after: minAfter, completed: completes });
  } catch (err) { logError('promotor.cat_after_photo', err); res.status(500).json({ error: 'Erro' }); }
});

// Promotor: Upload photo
router.post('/promotor/routes/:id/photos', promotorAuth, async (req, res) => {
  try {
    const { photo_type, category_id, product_id, exposure_point, photo_url, latitude, longitude,
            route_brand_id,
            original_size_bytes, compressed_size_bytes, quality_score, quality_passed } = req.body;
    const hasRouteBrandColumn = await hasColumn('route_photos', 'route_brand_id');
    const insertSql = hasRouteBrandColumn
      ? `INSERT INTO route_photos (route_id, photo_type, category_id, product_id, exposure_point, photo_url,
        latitude, longitude, route_brand_id, original_size_bytes, compressed_size_bytes, quality_score, quality_passed,
        upload_source, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'app',$14) RETURNING *`
      : `INSERT INTO route_photos (route_id, photo_type, category_id, product_id, exposure_point, photo_url,
        latitude, longitude, original_size_bytes, compressed_size_bytes, quality_score, quality_passed,
        upload_source, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'app',$13) RETURNING *`;
    const insertParams = hasRouteBrandColumn
      ? [req.params.id, photo_type, category_id, product_id, exposure_point, photo_url,
         latitude, longitude, route_brand_id || null, original_size_bytes, compressed_size_bytes, quality_score, quality_passed ?? true, req.employeeId]
      : [req.params.id, photo_type, category_id, product_id, exposure_point, photo_url,
         latitude, longitude, original_size_bytes, compressed_size_bytes, quality_score, quality_passed ?? true, req.employeeId];
    const result = await query(
      insertSql,
      insertParams
    );

    await query(
      `INSERT INTO route_execution_logs (route_id, action, details, performed_by, source)
       VALUES ($1,'photo_uploaded',$2,$3,'app')`,
      [req.params.id, JSON.stringify({ photo_type, category_id }), req.employeeId]
    );

    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// Promotor: Complete route (separate from PDV checkout)
router.post('/promotor/routes/:id/checkout', promotorAuth, async (req, res) => {
  try {
    const { latitude, longitude, photo_url, notes } = req.body;
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayStr = `${nowBR.getFullYear()}-${String(nowBR.getMonth()+1).padStart(2,'0')}-${String(nowBR.getDate()).padStart(2,'0')}`;

    // Get route info
    const routeRes = await query('SELECT * FROM merch_routes WHERE id=$1 AND promoter_id=$2', [req.params.id, req.employeeId]);
    if (!routeRes.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const route = routeRes.rows[0];

    // Fallback: materialize executions for rules that didn't exist when route was scheduled
    await ensureStockCountExecutionsForRoute(route);

    // Determina o tipo efetivo do checklist da rota (e suas marcas). Se todas forem checkin_only, pula alguns bloqueios.
    let allBrandsCheckinOnly = true;
    let hasAnyBrand = false;
    try {
      const ctRes = await query(
        `SELECT COALESCE(r.eff_checklist_type, bc_r.checklist_type, 'standard') as route_type,
                COALESCE(rb.eff_checklist_type, bc_b.checklist_type, 'standard') as brand_type
         FROM merch_routes r
         LEFT JOIN brand_checklists bc_r ON bc_r.id = r.checklist_id
         LEFT JOIN route_brands rb ON rb.route_id = r.id
         LEFT JOIN brand_checklists bc_b ON bc_b.id = rb.checklist_id
         WHERE r.id = $1`,
        [req.params.id]
      );
      if (ctRes.rows.length > 0) {
        for (const row of ctRes.rows) {
          hasAnyBrand = true;
          if ((row.route_type || 'standard') !== 'checkin_only' && (row.brand_type || 'standard') !== 'checkin_only') {
            allBrandsCheckinOnly = false;
            break;
          }
        }
      }
      if (!hasAnyBrand) allBrandsCheckinOnly = false;
    } catch { allBrandsCheckinOnly = false; }

    const missingStockCounts = allBrandsCheckinOnly ? [] : await getMissingMandatoryStockCountsForRoute(route);
    if (missingStockCounts.length > 0) {
      return res.status(409).json({
        error: 'stock_count_pending',
        message: `Contagem de estoque obrigatória pendente em ${missingStockCounts.length} marca(s).`,
      });
    }

    // Check pending items (se checkin_only, não conta produtos pois não deve haver nenhum)
    const pending = allBrandsCheckinOnly
      ? { rows: [{ cnt: 0 }] }
      : await query(
          `SELECT COUNT(*) as cnt FROM route_product_executions WHERE route_id=$1 AND status != 'completed'`,
          [req.params.id]
        );

    // Complete the route
    const result = await query(
      `UPDATE merch_routes SET status='completed', checkout_at=NOW(), checkout_latitude=$2,
       checkout_longitude=$3, completion_notes=$4, progress_pct=100,
       completed_at=NOW(), updated_at=NOW() WHERE id=$1 AND promoter_id=$5 RETURNING *`,
      [req.params.id, latitude, longitude, notes, req.employeeId]
    );

    // Timeline: route completed
    try {
      const visitRes = await query(
        `SELECT visit_id FROM pdv_visit_routes WHERE route_id=$1`, [req.params.id]
      );
      if (visitRes.rows.length) {
        const visitId = visitRes.rows[0].visit_id;
        await query(
          `UPDATE pdv_visit_routes SET completed_at=NOW() WHERE route_id=$1`, [req.params.id]
        );
        await query(
          `INSERT INTO pdv_visit_timeline (visit_id, route_id, event_type, event_data, performed_by)
           VALUES ($1,$2,'route_completed',$3,$4)`,
          [visitId, req.params.id, JSON.stringify({ pending_items: parseInt(pending.rows[0].cnt) }), req.employeeId]
        );
      }
    } catch (e) { if (e.code !== '42P01') logError('promotor.checkout.timeline', e); }

    // Check if there are remaining routes at same PDV today
    let remainingRoutesAtPdv = 0;
    let canCheckoutPdv = false;
    try {
      const remaining = await query(
        `SELECT COUNT(*) as cnt FROM merch_routes
         WHERE promoter_id=$1 AND pdv_id=$2 AND visit_date=$3 AND status IN ('scheduled','confirmed','in_progress') AND id != $4`,
        [req.employeeId, route.pdv_id, todayStr, req.params.id]
      );
      remainingRoutesAtPdv = parseInt(remaining.rows[0].cnt);
      canCheckoutPdv = remainingRoutesAtPdv === 0;
    } catch { canCheckoutPdv = true; }

    await query(
      `INSERT INTO route_execution_logs (route_id, action, details, performed_by, source)
       VALUES ($1,'route_completed',$2,$3,'app')`,
      [req.params.id, JSON.stringify({ latitude, longitude, pending: pending.rows[0].cnt, remaining_at_pdv: remainingRoutesAtPdv }), req.employeeId]
    );

    // Fire-and-forget: envia resumo por e-mail para contatos da marca
    try {
      const orgRow = await query('SELECT organization_id FROM employees WHERE id=$1', [req.employeeId]);
      const orgId = orgRow.rows[0]?.organization_id || route.organization_id;
      if (orgId) {
        sendStockCountSummaryForRoute({ routeId: req.params.id, organizationId: orgId, senderUserId: null })
          .catch((e) => logWarn('promotor.checkout.email_summary_failed', e));
      }
    } catch (e) { logWarn('promotor.checkout.email_summary_dispatch_failed', e); }

    res.json({
      ...result.rows[0],
      remaining_routes_at_pdv: remainingRoutesAtPdv,
      can_checkout_pdv: canCheckoutPdv,
      pdv_checkout_message: canCheckoutPdv
        ? 'Esta era a última rota neste PDV. Você pode fazer o checkout da loja.'
        : `Ainda existem ${remainingRoutesAtPdv} rota(s) neste PDV para hoje. O checkout da loja será liberado após a última rota.`,
    });
  } catch (err) { logError('promotor.checkout', err); res.status(500).json({ error: 'Erro' }); }
});


// Promotor: PDV Checkout (physical exit from store)
router.post('/promotor/pdv-checkout', promotorAuth, async (req, res) => {
  try {
    const { pdv_id, latitude, longitude, photo_url, notes } = req.body;
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayStr = `${nowBR.getFullYear()}-${String(nowBR.getMonth()+1).padStart(2,'0')}-${String(nowBR.getDate()).padStart(2,'0')}`;

    // Check if there are still pending routes at this PDV
    const pendingRoutes = await query(
      `SELECT COUNT(*) as cnt FROM merch_routes
       WHERE promoter_id=$1 AND pdv_id=$2 AND visit_date=$3 AND status IN ('scheduled','confirmed','in_progress')`,
      [req.employeeId, pdv_id, todayStr]
    );
    if (parseInt(pendingRoutes.rows[0].cnt) > 0) {
      return res.status(400).json({
        error: 'Ainda existem rotas pendentes neste PDV para hoje. Conclua todas as rotas antes de fazer o checkout.',
        remaining: parseInt(pendingRoutes.rows[0].cnt),
      });
    }

    // Update PDV visit
    try {
      const result = await query(
        `UPDATE pdv_visits SET checkout_at=NOW(), checkout_latitude=$3, checkout_longitude=$4,
         checkout_photo_url=$5, status='completed', notes=$6, updated_at=NOW()
         WHERE promoter_id=$1 AND pdv_id=$2 AND visit_date=$7 RETURNING *`,
        [req.employeeId, pdv_id, latitude, longitude, photo_url, notes, todayStr]
      );

      if (result.rows.length) {
        // Timeline: PDV checkout
        await query(
          `INSERT INTO pdv_visit_timeline (visit_id, event_type, event_data, performed_by)
           VALUES ($1,'pdv_checkout',$2,$3)`,
          [result.rows[0].id, JSON.stringify({ latitude, longitude, has_photo: !!photo_url }), req.employeeId]
        );

        if (photo_url) {
          // Save checkout photo linked to last route at PDV
          const lastRoute = await query(
            `SELECT id FROM merch_routes WHERE promoter_id=$1 AND pdv_id=$2 AND visit_date=$3
             ORDER BY checkout_at DESC NULLS LAST LIMIT 1`,
            [req.employeeId, pdv_id, todayStr]
          );
          if (lastRoute.rows.length) {
            await query(
              `INSERT INTO route_photos (route_id, photo_type, photo_url, latitude, longitude, upload_source, uploaded_by)
               VALUES ($1,'checkout',$2,$3,$4,'app',$5)`,
              [lastRoute.rows[0].id, photo_url, latitude, longitude, req.employeeId]
            );
          }
        }

        res.json(result.rows[0]);
      } else {
        res.json({ ok: true, message: 'PDV visit not found but checkout registered' });
      }
    } catch (e) {
      if (e.code === '42P01') {
        res.json({ ok: true, message: 'PDV visits table not created yet' });
      } else throw e;
    }
  } catch (err) { logError('promotor.pdv_checkout', err); res.status(500).json({ error: 'Erro' }); }
});

// Promotor: Check remaining routes at PDV
router.get('/promotor/pdv-status', promotorAuth, async (req, res) => {
  try {
    const { pdv_id } = req.query;
    if (!pdv_id) return res.status(400).json({ error: 'pdv_id obrigatório' });
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayStr = `${nowBR.getFullYear()}-${String(nowBR.getMonth()+1).padStart(2,'0')}-${String(nowBR.getDate()).padStart(2,'0')}`;

    const routes = await query(
      `SELECT id, brand_id, status, scheduled_time FROM merch_routes
       WHERE promoter_id=$1 AND pdv_id=$2 AND visit_date=$3 ORDER BY scheduled_time`,
      [req.employeeId, pdv_id, todayStr]
    );

    const total = routes.rows.length;
    const completed = routes.rows.filter(r => r.status === 'completed').length;
    const pending = routes.rows.filter(r => ['scheduled','confirmed','in_progress'].includes(r.status)).length;
    const canCheckout = pending === 0 && total > 0;

    let visit = null;
    try {
      const v = await query(
        `SELECT * FROM pdv_visits WHERE promoter_id=$1 AND pdv_id=$2 AND visit_date=$3`,
        [req.employeeId, pdv_id, todayStr]
      );
      visit = v.rows[0] || null;
    } catch { /* table may not exist */ }

    res.json({ routes: routes.rows, total, completed, pending, can_checkout: canCheckout, visit });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// Promotor: PDV visit timeline
router.get('/promotor/pdv-timeline', promotorAuth, async (req, res) => {
  try {
    const { pdv_id, visit_date } = req.query;
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dateStr = visit_date || `${nowBR.getFullYear()}-${String(nowBR.getMonth()+1).padStart(2,'0')}-${String(nowBR.getDate()).padStart(2,'0')}`;

    const visit = await query(
      `SELECT id FROM pdv_visits WHERE promoter_id=$1 AND pdv_id=$2 AND visit_date=$3`,
      [req.employeeId, pdv_id, dateStr]
    );
    if (!visit.rows.length) return res.json([]);

    const timeline = await query(
      `SELECT t.*, r.brand_id, b.name as brand_name
       FROM pdv_visit_timeline t
       LEFT JOIN merch_routes r ON r.id = t.route_id
       LEFT JOIN merch_brands b ON b.id = r.brand_id
       WHERE t.visit_id=$1 ORDER BY t.created_at`,
      [visit.rows[0].id]
    );
    res.json(timeline.rows);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

// Promotor: My damages + discards (unified Perdas list)
router.get('/promotor/damages', promotorAuth, async (req, res) => {
  try {
    await ensurePerdasSchema();
    const { status, kind } = req.query;
    let sql = `SELECT pd.*, COALESCE(pd.kind,'damage') AS kind, pr.name as product_name, p.name as pdv_name, b.name as brand_name,
                      (SELECT dri.request_id FROM damage_return_items dri WHERE dri.damage_id=pd.id ORDER BY dri.created_at DESC LIMIT 1) AS request_id
               FROM product_damages pd
               JOIN merch_products pr ON pr.id=pd.product_id
               JOIN pdvs p ON p.id=pd.pdv_id
               JOIN merch_brands b ON b.id=pd.brand_id
               WHERE pd.promoter_id=$1`;
    const params = [req.employeeId];
    let idx = 2;
    if (status) { sql += ` AND pd.status=$${idx++}`; params.push(status); }
    if (kind) { sql += ` AND pd.kind=$${idx++}`; params.push(kind); }
    sql += ' ORDER BY pd.created_at DESC';
    res.json((await query(sql, params)).rows);
  } catch (err) { logError('promotor.perdas.list', err); res.status(500).json({ error: 'Erro' }); }
});

// Promotor: Request return (group damages+discards by pdv+brand)
router.post('/promotor/return-requests', promotorAuth, async (req, res) => {
  try {
    await ensurePerdasSchema();
    const { damage_ids, pdv_id, brand_id, notes } = req.body;
    const result = await query(
      `INSERT INTO damage_return_requests (organization_id, pdv_id, brand_id, promoter_id, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.orgId, pdv_id, brand_id, req.employeeId, notes]
    );
    for (const did of damage_ids) {
      await query('INSERT INTO damage_return_items (request_id, damage_id) VALUES ($1,$2)', [result.rows[0].id, did]);
      await query('UPDATE product_damages SET status=$2, updated_at=NOW() WHERE id=$1', [did, 'awaiting_invoice']);
    }
    res.json(result.rows[0]);
  } catch (err) { logError('promotor.return-request', err); res.status(500).json({ error: 'Erro' }); }
});

// Promotor: Upload return invoice + divergence handling
router.post('/promotor/return-invoices', promotorAuth, async (req, res) => {
  try {
    await ensurePerdasSchema();
    const { request_id, invoice_number, invoice_date, issuer_name, photo_url, pdf_url, invoice_total_qty, observation } = req.body;

    // Sum of qty registered by promoter in this request
    const sumRes = await query(
      `SELECT COALESCE(SUM(pd.qty_store + pd.qty_stock),0)::int AS total_registered,
              MAX(pd.pdv_id) AS pdv_id, MAX(pd.brand_id) AS brand_id, MAX(pd.organization_id) AS organization_id, MAX(pd.route_id) AS route_id
         FROM damage_return_items dri
         JOIN product_damages pd ON pd.id = dri.damage_id
        WHERE dri.request_id = $1`, [request_id]
    );
    const totalRegistered = sumRes.rows[0]?.total_registered || 0;
    const totalNF = Math.max(0, parseInt(invoice_total_qty || 0, 10));
    const divergence = Math.max(0, totalNF - totalRegistered);

    const inv = await query(
      `INSERT INTO return_invoices (request_id, invoice_number, invoice_date, issuer_name, photo_url, pdf_url,
        invoice_total_qty, total_registered_qty, divergence_qty, observation, review_status, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING *`,
      [request_id, invoice_number, invoice_date, issuer_name, photo_url, pdf_url,
       totalNF, totalRegistered, divergence, observation, req.employeeId]
    );

    await query(`UPDATE damage_return_requests SET status='in_review', updated_at=NOW() WHERE id=$1`, [request_id]);
    const items = await query('SELECT damage_id FROM damage_return_items WHERE request_id=$1', [request_id]);
    for (const item of items.rows) {
      await query(`UPDATE product_damages SET status='in_review', updated_at=NOW() WHERE id=$1`, [item.damage_id]);
    }

    // Auto-create "Descarte PDV" record when divergence > 0
    if (divergence > 0 && sumRes.rows[0]) {
      const s = sumRes.rows[0];
      await query(
        `INSERT INTO pdv_extra_discards (organization_id, request_id, invoice_id, pdv_id, brand_id, qty, recorded_by, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'invoice_divergence')`,
        [s.organization_id, request_id, inv.rows[0].id, s.pdv_id, s.brand_id, divergence, req.employeeId]
      );
    }

    res.json({ ...inv.rows[0], divergence_qty: divergence, total_registered_qty: totalRegistered });
  } catch (err) { logError('promotor.return-invoice', err); res.status(500).json({ error: err?.message || 'Erro' }); }
});

// Promotor: Postpone stock count

// Promotor: Register extra point for a category (duplicate products for extra point execution)
router.post('/promotor/routes/:routeId/categories/:catId/extra-point', promotorAuth, async (req, res) => {
  try {
    const { routeId, catId } = req.params;
    const { product_ids } = req.body; // array of product IDs to duplicate as extra point

    if (!product_ids || !Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(400).json({ error: 'Selecione ao menos um produto para o ponto extra' });
    }

    // Verify route belongs to promoter
    const route = await query('SELECT * FROM merch_routes WHERE id=$1 AND promoter_id=$2', [routeId, req.employeeId]);
    if (!route.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });

    // Insert duplicate executions for extra point
    const created = [];
    for (const productId of product_ids) {
      try {
        // Copy route_brand_id from the original (natural) execution of the same product+category,
        // so that multi-brand routes correctly attribute the extra-point items to the active brand
        // (otherwise the frontend filter hides them and blocks route completion).
        const src = await query(
          `SELECT route_brand_id FROM route_product_executions
            WHERE route_id=$1 AND product_id=$2 AND category_id=$3 AND exposure_point <> 'extra'
            LIMIT 1`,
          [routeId, productId, catId]
        );
        const routeBrandId = src.rows[0]?.route_brand_id || null;

        const result = await query(
          `INSERT INTO route_product_executions (route_id, product_id, category_id, route_brand_id, exposure_point, status)
           VALUES ($1, $2, $3, $4, 'extra', 'pending') RETURNING *`,
          [routeId, productId, catId, routeBrandId]
        );
        if (result.rows[0]) created.push(result.rows[0]);
      } catch (e) {
        // If duplicate, skip
        logWarn('promotor.extra_point.duplicate_skip', { routeId, productId, catId, error: e?.message });
      }
    }

    // Log the extra point registration
    try {
      await query(
        `INSERT INTO route_execution_logs (route_id, action, details, performed_by, source)
         VALUES ($1, 'extra_point_registered', $2, $3, 'app')`,
        [routeId, JSON.stringify({ category_id: catId, product_ids, created_count: created.length }), req.employeeId]
      );
    } catch (logErr) {
      logWarn('promotor.extra_point.log_failed', { error: logErr?.message });
    }

    logInfo('promotor.extra_point.created', { routeId, catId, count: created.length });
    res.json({ created, count: created.length });
  } catch (err) {
    logError('promotor.extra_point', err, { routeId: req.params.routeId, catId: req.params.catId });
    res.status(500).json({ error: 'Erro ao registrar ponto extra' });
  }
});

router.post('/promotor/postpone', promotorAuth, async (req, res) => {
  try {
    const { route_id, product_id, category_id, item_type, reason } = req.body;
    // Find next route for same PDV/brand
    const currentRoute = await query('SELECT * FROM merch_routes WHERE id=$1', [route_id]);
    if (!currentRoute.rows.length) return res.status(404).json({ error: 'Rota não encontrada' });
    const cr = currentRoute.rows[0];

    const nextRoute = await query(
      `SELECT id FROM merch_routes WHERE promoter_id=$1 AND pdv_id=$2 AND brand_id=$3
       AND visit_date > $4 AND status IN ('scheduled','confirmed')
       ORDER BY visit_date LIMIT 1`,
      [req.employeeId, cr.pdv_id, cr.brand_id, cr.visit_date]
    );

    const result = await query(
      `INSERT INTO route_stock_postponements (route_id, product_id, category_id, item_type, reason, postponed_by, next_route_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [route_id, product_id, category_id, item_type, reason, req.employeeId, nextRoute.rows[0]?.id || null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ===== PROMOTER TEAM LIST (admin) =====
router.get('/promoters-team', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    const result = await query(
      `SELECT e.id, e.full_name, e.position, e.photo_url, e.worker_profile,
              e.direct_manager_id as supervisor_id,
              sv.full_name as supervisor_name,
              (SELECT COUNT(*) FROM merch_routes mr WHERE mr.promoter_id = e.id AND mr.visit_date >= CURRENT_DATE - interval '30 days') as total_routes,
              (SELECT COUNT(DISTINCT mr.brand_id) FROM merch_routes mr WHERE mr.promoter_id = e.id AND mr.visit_date >= CURRENT_DATE - interval '90 days') as active_brands,
              (SELECT COUNT(DISTINCT mr.pdv_id) FROM merch_routes mr WHERE mr.promoter_id = e.id AND mr.visit_date >= CURRENT_DATE - interval '90 days') as active_pdvs
       FROM employees e
       LEFT JOIN employees sv ON sv.id = e.direct_manager_id
       WHERE e.organization_id = $1 AND e.worker_profile IN ('promotor','operacional') AND e.status = 'ativo'
       ORDER BY sv.full_name NULLS LAST, e.full_name`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    logError('merch.promoters-team', err);
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== AI ROUTE OPTIMIZATION =====

// Get optimization context data
router.get('/ai/optimization-context', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    const { promoter_ids, brand_id, date_from, date_to, region } = req.query;

    // Get promoters with home location and brand permissions
    let promoterSql = `SELECT e.id, e.full_name, e.home_latitude, e.home_longitude, e.work_schedule,
                        e.direct_manager_id as supervisor_id,
                        COALESCE(
                          (SELECT json_agg(bpa.brand_id) FROM brand_promoter_assignments bpa WHERE bpa.employee_id = e.id AND bpa.active = true), '[]'
                        ) as brand_ids,
                        (SELECT COUNT(*) FROM merch_routes mr WHERE mr.promoter_id = e.id 
                         AND mr.visit_date >= $2 AND mr.visit_date <= $3 AND mr.status != 'cancelled') as existing_routes
                       FROM employees e
                       WHERE e.organization_id = $1 AND e.worker_profile IN ('promotor','operacional') AND e.status = 'ativo'`;
    const promoterParams = [orgId, date_from || 'now()', date_to || 'now()'];
    
    if (promoter_ids) {
      const ids = promoter_ids.split(',');
      promoterSql += ` AND e.id = ANY($4)`;
      promoterParams.push(ids);
    }
    promoterSql += ' ORDER BY e.full_name';
    
    // Get PDVs with brand mix info
    let pdvSql = `SELECT p.id, p.name, p.address, p.city, p.state, p.latitude, p.longitude, p.radius_meters,
                   COALESCE(
                     (SELECT json_agg(json_build_object('brand_id', pbp.brand_id, 'product_count', 
                       (SELECT COUNT(*) FROM merch_pdv_brand_products pbp2 WHERE pbp2.pdv_id = p.id AND pbp2.brand_id = pbp.brand_id AND pbp2.active = true)
                     )) FROM (SELECT DISTINCT brand_id FROM merch_pdv_brand_products WHERE pdv_id = p.id AND active = true) pbp), '[]'
                   ) as brands_mix,
                   (SELECT AVG(EXTRACT(EPOCH FROM (mr.checkout_at - mr.checkin_at))/60) 
                    FROM merch_routes mr WHERE mr.pdv_id = p.id AND mr.checkout_at IS NOT NULL 
                    AND mr.checkin_at IS NOT NULL) as avg_visit_minutes
                  FROM pdvs p WHERE p.organization_id = $1 AND p.active = true`;
    const pdvParams = [orgId];
    
    if (brand_id) {
      pdvSql += ` AND EXISTS (SELECT 1 FROM merch_pdv_brand_products pbp WHERE pbp.pdv_id = p.id AND pbp.brand_id = $2 AND pbp.active = true)`;
      pdvParams.push(brand_id);
    }
    if (region) {
      pdvSql += ` AND p.city ILIKE $${pdvParams.length + 1}`;
      pdvParams.push(`%${region}%`);
    }
    pdvSql += ' ORDER BY p.name';

    // Get existing routes in period
    const existingSql = `SELECT r.id, r.promoter_id, r.pdv_id, r.brand_id, r.visit_date, r.scheduled_time,
                          r.estimated_duration_min, r.status, p.name as pdv_name, b.name as brand_name
                         FROM merch_routes r
                         LEFT JOIN pdvs p ON p.id = r.pdv_id
                         LEFT JOIN merch_brands b ON b.id = r.brand_id
                         WHERE r.organization_id = $1 AND r.visit_date >= $2 AND r.visit_date <= $3 AND r.status != 'cancelled'
                         ORDER BY r.visit_date, r.scheduled_time`;

    // Get brands
    const brandsSql = `SELECT id, name FROM merch_brands WHERE organization_id = $1 ORDER BY name`;

    const [promoters, pdvsList, existing, brands] = await Promise.all([
      query(promoterSql, promoterParams),
      query(pdvSql, pdvParams),
      query(existingSql, [orgId, date_from || new Date().toISOString().split('T')[0], date_to || new Date().toISOString().split('T')[0]]),
      query(brandsSql, [orgId]),
    ]);

    res.json({
      promoters: promoters.rows,
      pdvs: pdvsList.rows,
      existing_routes: existing.rows,
      brands: brands.rows,
    });
  } catch (err) {
    logError('merch.ai.context', err);
    if (err.code === '42P01') return res.json({ promoters: [], pdvs: [], existing_routes: [], brands: [] });
    res.status(500).json({ error: 'Erro ao carregar contexto' });
  }
});

// Generate AI route suggestions
router.post('/ai/optimize', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    // Get org AI config
    const orgConfig = await query('SELECT ai_provider, ai_model, ai_api_key FROM organizations WHERE id=$1', [orgId]);
    if (!orgConfig.rows.length || !orgConfig.rows[0].ai_api_key || orgConfig.rows[0].ai_provider === 'none') {
      return res.status(400).json({ error: 'Configure a IA da organização em Configurações > IA antes de usar o planejamento inteligente.' });
    }

    const { provider, model, apiKey } = {
      provider: orgConfig.rows[0].ai_provider,
      model: orgConfig.rows[0].ai_model,
      apiKey: orgConfig.rows[0].ai_api_key,
    };

    const { promoters, pdvs, existing_routes, date_from, date_to, brand_id, rules } = req.body;

    const systemPrompt = `Você é um assistente especializado em otimização de rotas de merchandising.
Sua tarefa é gerar sugestões de rotas otimizadas para promotores de merchandising.

REGRAS:
- Cada promotor só pode atender marcas para as quais está habilitado
- Distribua as visitas equilibradamente entre os dias do período
- Minimize o tempo de deslocamento agrupando PDVs próximos no mesmo dia
- Considere a localização da casa/base do promotor para a primeira e última visita do dia
- Respeite o limite máximo de ${rules?.max_visits_per_day || 6} visitas por dia
- Respeite o limite máximo de ${rules?.max_hours_per_day || 8} horas por dia
- Duração estimada padrão por visita: ${rules?.default_visit_duration || 60} minutos
- Tempo médio de deslocamento entre PDVs: 30 minutos (ajuste por distância se houver coordenadas)
${rules?.additional_rules || ''}

RESPONDA EXCLUSIVAMENTE em JSON válido com esta estrutura:
{
  "suggestions": [
    {
      "promoter_id": "uuid",
      "promoter_name": "nome",
      "pdv_id": "uuid",
      "pdv_name": "nome",
      "brand_id": "uuid",
      "brand_name": "nome",
      "visit_date": "YYYY-MM-DD",
      "scheduled_time": "HH:MM",
      "estimated_duration_min": 60,
      "reason": "Motivo da sugestão"
    }
  ],
  "insights": [
    "Texto descritivo de cada insight/sugestão de melhoria"
  ],
  "metrics": {
    "total_visits": 0,
    "total_travel_hours_estimated": 0,
    "avg_visits_per_day": 0,
    "conflicts_avoided": 0
  }
}`;

    const userPrompt = `Gere um plano de rotas otimizado para o período de ${date_from} a ${date_to}.

PROMOTORES DISPONÍVEIS:
${JSON.stringify(promoters.map((p) => ({
  id: p.id, nome: p.full_name,
  lat: p.home_latitude, lng: p.home_longitude,
  marcas_autorizadas: p.brand_ids,
  rotas_existentes: p.existing_routes,
})), null, 2)}

PDVs PARA ATENDER:
${JSON.stringify(pdvs.map((p) => ({
  id: p.id, nome: p.name, cidade: p.city,
  lat: p.latitude, lng: p.longitude,
  marcas: p.brands_mix,
  tempo_medio_visita_min: p.avg_visit_minutes || rules?.default_visit_duration || 60,
})), null, 2)}

${brand_id ? `MARCA FOCO: ${brand_id}` : 'TODAS AS MARCAS'}

ROTAS JÁ AGENDADAS NO PERÍODO (evitar conflitos):
${JSON.stringify(existing_routes.map((r) => ({
  promotor: r.promoter_id, pdv: r.pdv_id, data: r.visit_date, hora: r.scheduled_time,
})), null, 2)}

Gere as sugestões de rota otimizadas.`;

    const { callAI: callAIFn } = await import('../lib/ai-caller.js');
    const aiResult = await callAIFn(
      { provider, model, apiKey },
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.3, maxTokens: 4000, responseFormat: { type: 'json_object' } }
    );

    let parsed;
    try {
      parsed = JSON.parse(aiResult.content);
    } catch {
      // Try to extract JSON from response
      const match = aiResult.content.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('IA retornou resposta inválida');
    }

    // Log optimization run
    try {
      await query(
        `INSERT INTO route_ai_optimization_runs (organization_id, run_by, date_from, date_to, brand_id,
         promoter_count, pdv_count, suggestions_count, tokens_used, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed')`,
        [orgId, req.userId, date_from, date_to, brand_id || null,
         promoters.length, pdvs.length, parsed.suggestions?.length || 0, aiResult.tokensUsed || 0]
      );
    } catch { /* table might not exist yet */ }

    res.json({
      suggestions: parsed.suggestions || [],
      insights: parsed.insights || [],
      metrics: parsed.metrics || {},
      tokens_used: aiResult.tokensUsed || 0,
    });
  } catch (err) {
    logError('merch.ai.optimize', err);
    res.status(500).json({ error: err.message || 'Erro na otimização com IA' });
  }
});

// Approve AI suggestions (bulk create routes)
router.post('/ai/approve', async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    const { suggestions } = req.body;
    if (!suggestions?.length) return res.status(400).json({ error: 'Nenhuma sugestão para aprovar' });

    const created = [];
    for (const s of suggestions) {
      let effectiveChecklistId = s.checklist_id || null;
      if (!effectiveChecklistId && s.brand_id) {
        try {
          const checklistRes = await query(
            `SELECT id FROM brand_checklists
             WHERE organization_id=$1 AND brand_id=$2 AND active=true
             ORDER BY created_at DESC LIMIT 1`,
            [orgId, s.brand_id]
          );
          effectiveChecklistId = checklistRes.rows[0]?.id || null;
        } catch { /* ignore */ }
      }

      const result = await query(
        `INSERT INTO merch_routes (organization_id, promoter_id, pdv_id, brand_id, checklist_id,
         visit_date, scheduled_time, estimated_duration_min, priority, visit_type, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'normal','regular',$9,$10) RETURNING *`,
        [orgId, s.promoter_id, s.pdv_id, s.brand_id || null, effectiveChecklistId || null,
         s.visit_date, s.scheduled_time, s.estimated_duration_min || 60,
         `[IA] ${s.reason || ''}`, req.userId]
      );
      created.push(result.rows[0]);

      try {
        const mixProducts = await query(
          `SELECT pbp.product_id, p.category_id
           FROM merch_pdv_brand_products pbp
           JOIN merch_products p ON p.id = pbp.product_id
           WHERE pbp.pdv_id=$1 AND pbp.brand_id=$2 AND pbp.active=true`,
          [s.pdv_id, s.brand_id]
        );
        for (const mp of mixProducts.rows) {
          await query(
            `INSERT INTO route_product_executions (route_id, product_id, category_id) VALUES ($1,$2,$3)`,
            [result.rows[0].id, mp.product_id, mp.category_id]
          );
        }
      } catch { /* ignore */ }
    }

    res.json({ created: created.length, routes: created });
  } catch (err) {
    logError('merch.ai.approve', err);
    res.status(500).json({ error: 'Erro ao aprovar sugestões' });
  }
});

// Workload analysis
router.get('/workload', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    const { promoter_id, date_from, date_to } = req.query;

    const result = await query(
      `SELECT r.visit_date, r.promoter_id, e.full_name as promoter_name,
              COUNT(*) as visits,
              SUM(COALESCE(r.estimated_duration_min, 60)) as total_minutes,
              COUNT(CASE WHEN r.status = 'completed' THEN 1 END) as completed,
              COUNT(CASE WHEN r.status = 'in_progress' THEN 1 END) as in_progress,
              COUNT(CASE WHEN r.status = 'scheduled' THEN 1 END) as scheduled
       FROM merch_routes r
       LEFT JOIN employees e ON e.id = r.promoter_id
       WHERE r.organization_id = $1 AND r.status != 'cancelled'
       ${promoter_id ? 'AND r.promoter_id = $4' : ''}
       AND r.visit_date >= $2 AND r.visit_date <= $3
       GROUP BY r.visit_date, r.promoter_id, e.full_name
       ORDER BY r.visit_date`,
      promoter_id ? [orgId, date_from, date_to, promoter_id] : [orgId, date_from, date_to]
    );

    res.json(result.rows);
  } catch (err) {
    logError('merch.workload', err);
    if (err.code === '42P01') return res.json([]);
    res.status(500).json({ error: 'Erro' });
  }
});

// ===== PHOTO QUALITY CONFIG =====

router.get('/photo-quality-config', async (req, res) => {
  const defaults = {
    blur_tolerance: 30, min_brightness: 40, max_brightness: 220,
    min_resolution_w: 640, min_resolution_h: 480,
    compression_quality: 0.7, max_file_size_kb: 1024,
  };
  try {
    // Accept either main user token or promotor token; fall back to defaults on auth/lookup failure.
    let orgId = null;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        if (decoded.organizationId || decoded.organization_id) {
          orgId = decoded.organizationId || decoded.organization_id;
        } else if (decoded.userId) {
          const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [decoded.userId]);
          orgId = orgRes.rows[0]?.organization_id || null;
        } else if (decoded.employeeId || decoded.employee_id) {
          const empId = decoded.employeeId || decoded.employee_id;
          const orgRes = await query('SELECT organization_id FROM employees WHERE id=$1 LIMIT 1', [empId]);
          orgId = orgRes.rows[0]?.organization_id || null;
        }
      } catch { /* ignore, return defaults */ }
    }
    if (!orgId) return res.json({ config: defaults });

    const result = await query(
      `SELECT config FROM organization_settings WHERE organization_id = $1 AND setting_key = 'photo_quality_config'`,
      [orgId]
    );
    res.json({ config: result.rows[0]?.config || defaults });
  } catch (err) {
    logError('merch.photo-quality-config.get', err);
    res.json({ config: defaults });
  }
});

router.put('/photo-quality-config', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    // Ensure table exists
    await query(`CREATE TABLE IF NOT EXISTS organization_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      setting_key TEXT NOT NULL,
      config JSONB DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id, setting_key)
    )`);

    await query(
      `INSERT INTO organization_settings (organization_id, setting_key, config, updated_at)
       VALUES ($1, 'photo_quality_config', $2, NOW())
       ON CONFLICT (organization_id, setting_key) DO UPDATE SET config = $2, updated_at = NOW()`,
      [orgId, JSON.stringify(req.body)]
    );
    res.json({ success: true });
  } catch (err) {
    logError('merch.photo-quality-config.put', err);
    res.status(500).json({ error: 'Erro ao salvar configuração' });
  }
});

// ===== REPORT BRANDING SETTINGS =====
router.get('/report-branding', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    try {
      const result = await query(
        `SELECT config FROM organization_settings WHERE organization_id = $1 AND setting_key = 'report_branding'`,
        [orgId]
      );
      return res.json(result.rows[0]?.config || {});
    } catch {
      return res.json({});
    }
  } catch (err) {
    logError('merch.report-branding.get', err);
    res.status(500).json({ error: 'Erro ao buscar config' });
  }
});

router.put('/report-branding', authenticate, async (req, res) => {
  try {
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgRes.rows[0].organization_id;

    try {
      await query(`CREATE TABLE IF NOT EXISTS organization_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        setting_key TEXT NOT NULL,
        config JSONB DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(organization_id, setting_key)
      )`);

      await query(
        `INSERT INTO organization_settings (organization_id, setting_key, config, updated_at)
         VALUES ($1, 'report_branding', $2, NOW())
         ON CONFLICT (organization_id, setting_key) DO UPDATE SET config = $2, updated_at = NOW()`,
        [orgId, JSON.stringify(req.body)]
      );
      return res.json({ success: true });
    } catch {
      return res.json({ success: true, skipped: true });
    }
  } catch (err) {
    logError('merch.report-branding.put', err);
    res.status(500).json({ error: 'Erro ao salvar config' });
  }
});

// ============================================================
// PERDAS (Avarias + Descartes) - Conference & Brand Notification
// ============================================================

let _perdasSchemaReady = false;
async function ensurePerdasSchema() {
  if (_perdasSchemaReady) return;
  try {
    await query(`ALTER TABLE product_damages ADD COLUMN IF NOT EXISTS kind VARCHAR(20) DEFAULT 'damage'`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS invoice_total_qty INTEGER DEFAULT 0`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS total_registered_qty INTEGER DEFAULT 0`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS divergence_qty INTEGER DEFAULT 0`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS observation TEXT`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) DEFAULT 'pending'`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS reviewed_by UUID`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS review_notes TEXT`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS sent_to_brand_at TIMESTAMPTZ`);
    await query(`ALTER TABLE return_invoices ADD COLUMN IF NOT EXISTS sent_channels JSONB DEFAULT '[]'`);
    await query(`CREATE TABLE IF NOT EXISTS pdv_extra_discards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      request_id UUID,
      invoice_id UUID,
      pdv_id UUID NOT NULL,
      brand_id UUID NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0,
      source VARCHAR(40) DEFAULT 'invoice_divergence',
      recorded_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS brand_perdas_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      brand_id UUID NOT NULL,
      invoice_id UUID,
      request_id UUID,
      pdv_id UUID,
      channel VARCHAR(20) NOT NULL,
      recipient TEXT,
      status VARCHAR(20) DEFAULT 'sent',
      error TEXT,
      payload JSONB,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    _perdasSchemaReady = true;
  } catch (e) { logError('perdas.schema', e); }
}

// Admin: list pending invoices for supervisor conference
router.get('/perdas/pending-review', authenticate, async (req, res) => {
  try {
    await ensurePerdasSchema();
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0]?.organization_id;
    if (!orgId) return res.json([]);
    const { status } = req.query;
    const reviewFilter = status || 'pending';
    const result = await query(
      `SELECT ri.*, drr.pdv_id, drr.brand_id, drr.promoter_id, drr.notes AS request_notes,
              p.name AS pdv_name, b.name AS brand_name, b.email AS brand_email, b.phone AS brand_phone,
              e.full_name AS promoter_name,
              (SELECT COALESCE(SUM(qty),0)::int FROM pdv_extra_discards WHERE invoice_id=ri.id) AS pdv_discard_qty,
              (SELECT json_agg(json_build_object(
                 'damage_id', pd.id, 'kind', COALESCE(pd.kind,'damage'),
                 'product_name', pr.name, 'qty_store', pd.qty_store, 'qty_stock', pd.qty_stock,
                 'qty_total', pd.qty_store + pd.qty_stock, 'reason', pd.reason, 'photo_url', pd.photo_url
               ))
                 FROM damage_return_items dri
                 JOIN product_damages pd ON pd.id = dri.damage_id
                 JOIN merch_products pr ON pr.id = pd.product_id
                WHERE dri.request_id = drr.id) AS items
         FROM return_invoices ri
         JOIN damage_return_requests drr ON drr.id = ri.request_id
         JOIN pdvs p ON p.id = drr.pdv_id
         JOIN merch_brands b ON b.id = drr.brand_id
         JOIN employees e ON e.id = drr.promoter_id
        WHERE drr.organization_id = $1 AND COALESCE(ri.review_status,'pending') = $2
        ORDER BY ri.created_at DESC`,
      [orgId, reviewFilter]
    );
    res.json(result.rows);
  } catch (err) { logError('perdas.pending', err); res.status(500).json({ error: err?.message || 'Erro' }); }
});

// Admin: review (approve/reject) an invoice
router.post('/perdas/invoices/:id/review', authenticate, async (req, res) => {
  try {
    await ensurePerdasSchema();
    const { decision, notes } = req.body; // 'approved' | 'rejected'
    if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Decisão inválida' });

    const inv = await query(
      `SELECT ri.*, drr.id AS request_id, drr.organization_id, drr.brand_id, drr.pdv_id
         FROM return_invoices ri
         JOIN damage_return_requests drr ON drr.id = ri.request_id
        WHERE ri.id=$1`, [req.params.id]
    );
    if (!inv.rows.length) return res.status(404).json({ error: 'Nota não encontrada' });
    const i = inv.rows[0];

    await query(
      `UPDATE return_invoices SET review_status=$1, reviewed_by=$2, reviewed_at=NOW(), review_notes=$3 WHERE id=$4`,
      [decision, req.userId, notes || null, req.params.id]
    );

    const newStatus = decision === 'approved' ? 'completed' : 'rejected';
    await query(`UPDATE damage_return_requests SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, i.request_id]);
    const items = await query('SELECT damage_id FROM damage_return_items WHERE request_id=$1', [i.request_id]);
    for (const it of items.rows) {
      await query(`UPDATE product_damages SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, it.damage_id]);
    }

    // On approval -> notify brand via panel + email + whatsapp
    if (decision === 'approved') {
      try {
        const brand = await query('SELECT id, name, email, phone FROM merch_brands WHERE id=$1', [i.brand_id]);
        const pdv = await query('SELECT name FROM pdvs WHERE id=$1', [i.pdv_id]);
        const b = brand.rows[0] || {};
        const channels = [];

        // Panel: always recorded
        await query(
          `INSERT INTO brand_perdas_notifications (organization_id, brand_id, invoice_id, request_id, pdv_id, channel, recipient, status, payload)
           VALUES ($1,$2,$3,$4,$5,'panel',$6,'sent',$7)`,
          [i.organization_id, i.brand_id, i.id, i.request_id, i.pdv_id, b.name || null,
           JSON.stringify({ invoice_number: i.invoice_number, total_nf: i.invoice_total_qty, registered: i.total_registered_qty, divergence: i.divergence_qty, pdv: pdv.rows[0]?.name })]
        );
        channels.push('panel');

        // Email (best-effort: just records intent if no provider configured)
        if (b.email) {
          await query(
            `INSERT INTO brand_perdas_notifications (organization_id, brand_id, invoice_id, request_id, pdv_id, channel, recipient, status, payload)
             VALUES ($1,$2,$3,$4,$5,'email',$6,'queued',$7)`,
            [i.organization_id, i.brand_id, i.id, i.request_id, i.pdv_id, b.email,
             JSON.stringify({ subject: `Perdas aprovadas - ${pdv.rows[0]?.name || ''} - NF ${i.invoice_number || ''}` })]
          );
          channels.push('email');
        }

        // WhatsApp via W-API if brand has phone and org has an active connection
        if (b.phone) {
          try {
            const { sendMessage } = await import('../lib/whatsapp-provider.js');
            const conn = await query(
              `SELECT * FROM connections WHERE user_id IN (SELECT user_id FROM organization_members WHERE organization_id=$1) AND status='connected' LIMIT 1`,
              [i.organization_id]
            );
            if (conn.rows.length) {
              const msg = `*Perdas aprovadas*\nMarca: ${b.name}\nPDV: ${pdv.rows[0]?.name || ''}\nNF: ${i.invoice_number || '-'}\nTotal NF: ${i.invoice_total_qty}\nRegistrado: ${i.total_registered_qty}\nDescarte PDV: ${i.divergence_qty}`;
              await sendMessage(conn.rows[0], b.phone, msg, 'text').catch(() => null);
              await query(
                `INSERT INTO brand_perdas_notifications (organization_id, brand_id, invoice_id, request_id, pdv_id, channel, recipient, status)
                 VALUES ($1,$2,$3,$4,$5,'whatsapp',$6,'sent')`,
                [i.organization_id, i.brand_id, i.id, i.request_id, i.pdv_id, b.phone]
              );
              channels.push('whatsapp');
            }
          } catch (waErr) { logWarn('perdas.whatsapp', { error: waErr?.message }); }
        }

        await query(`UPDATE return_invoices SET sent_to_brand_at=NOW(), sent_channels=$1 WHERE id=$2`, [JSON.stringify(channels), i.id]);
      } catch (notifyErr) { logError('perdas.notify', notifyErr); }
    }

    res.json({ success: true, decision });
  } catch (err) { logError('perdas.review', err); res.status(500).json({ error: err?.message || 'Erro' }); }
});

// Brand feed: list approved perdas for a brand
router.get('/perdas/brand-feed', authenticate, async (req, res) => {
  try {
    await ensurePerdasSchema();
    const { brand_id } = req.query;
    const orgRes = await query('SELECT organization_id FROM organization_members WHERE user_id=$1 LIMIT 1', [req.userId]);
    const orgId = orgRes.rows[0]?.organization_id;
    if (!orgId) return res.json([]);
    const params = [orgId];
    let where = `drr.organization_id=$1 AND ri.review_status='approved'`;
    if (brand_id) { params.push(brand_id); where += ` AND drr.brand_id=$${params.length}`; }
    const result = await query(
      `SELECT ri.id, ri.invoice_number, ri.invoice_date, ri.invoice_total_qty, ri.total_registered_qty, ri.divergence_qty,
              ri.photo_url, ri.pdf_url, ri.sent_to_brand_at, ri.sent_channels,
              drr.brand_id, b.name AS brand_name, drr.pdv_id, p.name AS pdv_name, e.full_name AS promoter_name
         FROM return_invoices ri
         JOIN damage_return_requests drr ON drr.id = ri.request_id
         JOIN merch_brands b ON b.id = drr.brand_id
         JOIN pdvs p ON p.id = drr.pdv_id
         JOIN employees e ON e.id = drr.promoter_id
        WHERE ${where}
        ORDER BY ri.reviewed_at DESC NULLS LAST`,
      params
    );
    res.json(result.rows);
  } catch (err) { logError('perdas.feed', err); res.status(500).json({ error: 'Erro' }); }
});

export default router;

