import express from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logInfo, logError } from '../logger.js';

const router = express.Router();
router.use(authenticate);

async function getOrgInfo(userId) {
  const r = await query('SELECT organization_id, brand_id FROM organization_members WHERE user_id=$1 LIMIT 1', [userId]);
  return r.rows[0];
}

async function ensureTables() {
  await query(`CREATE TABLE IF NOT EXISTS merchan_kpi_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL,
    snapshot_date DATE NOT NULL, total_routes INT DEFAULT 0, completed_routes INT DEFAULT 0,
    partial_routes INT DEFAULT 0, pending_routes INT DEFAULT 0, total_products INT DEFAULT 0,
    executed_products INT DEFAULT 0, brands_served INT DEFAULT 0, pdvs_served INT DEFAULT 0,
    active_promoters INT DEFAULT 0, photos_captured INT DEFAULT 0, damages_registered INT DEFAULT 0,
    stockouts_registered INT DEFAULT 0, price_research_completed INT DEFAULT 0, price_research_pending INT DEFAULT 0,
    stock_counts INT DEFAULT 0, expiry_counts INT DEFAULT 0, avg_visit_duration_min NUMERIC(6,1),
    avg_photos_per_route NUMERIC(5,1), operational_score NUMERIC(5,2), metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(organization_id, snapshot_date)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS merchan_ai_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL,
    summary_type VARCHAR(50) NOT NULL, reference_id UUID, reference_type VARCHAR(50),
    period_start DATE, period_end DATE, summary TEXT NOT NULL, highlights JSONB,
    filters_applied JSONB, generated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS merchan_ai_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL,
    alert_type VARCHAR(50) NOT NULL, severity VARCHAR(20) DEFAULT 'medium', title VARCHAR(255) NOT NULL,
    description TEXT, reference_id UUID, reference_type VARCHAR(50), data JSONB,
    acknowledged BOOLEAN DEFAULT false, acknowledged_by UUID, acknowledged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS merchan_operational_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL,
    entity_type VARCHAR(50) NOT NULL, entity_id UUID, score_date DATE NOT NULL,
    score NUMERIC(5,2) NOT NULL, breakdown JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

async function ensureOrganizationSettingsTable() {
  await query(`CREATE TABLE IF NOT EXISTS organization_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    setting_key TEXT NOT NULL,
    config JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, setting_key)
  )`);
}

function normalizePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function getInactivityConfig(orgId) {
  const defaults = {
    enabled: true,
    threshold_minutes: 20,
  };

  if (!orgId) return defaults;

  await ensureOrganizationSettingsTable();
  const result = await query(
    `SELECT config FROM organization_settings WHERE organization_id = $1 AND setting_key = 'merch_inactivity_config'`,
    [orgId]
  );

  const stored = result.rows[0]?.config || {};
  return {
    enabled: stored.enabled !== false,
    threshold_minutes: normalizePositiveInt(stored.threshold_minutes, defaults.threshold_minutes),
  };
}

// Helper: build date filter
function buildDateFilter(params, paramIdx, dateFrom, dateTo, dateCol = 'r.visit_date') {
  let sql = '';
  if (dateFrom) { sql += ` AND ${dateCol} >= $${paramIdx}`; params.push(dateFrom); paramIdx++; }
  if (dateTo) { sql += ` AND ${dateCol} <= $${paramIdx}`; params.push(dateTo); paramIdx++; }
  return { sql, paramIdx };
}

function buildRouteFiltersFromQuery(queryParams, params, startIdx, routeAlias = 'r') {
  const { date_from, date_to, brand_id, pdv_id, promoter_id } = queryParams;
  let idx = startIdx;
  let filters = '';

  if (date_from) { filters += ` AND ${routeAlias}.visit_date >= $${idx}`; params.push(date_from); idx++; }
  if (date_to) { filters += ` AND ${routeAlias}.visit_date <= $${idx}`; params.push(date_to); idx++; }
  if (brand_id) { filters += ` AND ${routeAlias}.brand_id = $${idx}`; params.push(brand_id); idx++; }
  if (pdv_id) { filters += ` AND ${routeAlias}.pdv_id = $${idx}`; params.push(pdv_id); idx++; }
  if (promoter_id) { filters += ` AND ${routeAlias}.promoter_id = $${idx}`; params.push(promoter_id); idx++; }

  return { filters, idx };
}

const tableExistsCache = new Map();

async function tableExists(tableName) {
  if (tableExistsCache.has(tableName)) return tableExistsCache.get(tableName);

  const result = await query('SELECT to_regclass($1) as table_name', [`public.${tableName}`]);
  const exists = Boolean(result.rows[0]?.table_name);
  tableExistsCache.set(tableName, exists);
  return exists;
}

// ===== Dashboard KPIs (real-time from existing tables) =====
router.get('/dashboard', async (req, res) => {
  try {
    await ensureTables();
    const orgInfo = await getOrgInfo(req.userId);
    if (!orgInfo?.organization_id) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgInfo.organization_id;

    let { date_from, date_to, brand_id, pdv_id, promoter_id } = req.query;
    // Force brand filter if user is linked to a specific brand
    if (orgInfo.brand_id) brand_id = orgInfo.brand_id;
    const params = [orgId];
    let idx = 2;
    let dateFilter = '';
    let brandFilter = '';
    let pdvFilter = '';
    let promoterFilter = '';

    if (date_from) { dateFilter += ` AND r.visit_date >= $${idx}`; params.push(date_from); idx++; }
    if (date_to) { dateFilter += ` AND r.visit_date <= $${idx}`; params.push(date_to); idx++; }
    if (brand_id) { brandFilter = ` AND r.brand_id = $${idx}`; params.push(brand_id); idx++; }
    if (pdv_id) { pdvFilter = ` AND r.pdv_id = $${idx}`; params.push(pdv_id); idx++; }
    if (promoter_id) { promoterFilter = ` AND r.promoter_id = $${idx}`; params.push(promoter_id); idx++; }

    const extraFilter = dateFilter + brandFilter + pdvFilter + promoterFilter;

    // Route KPIs
    const routeKpis = (await query(`
      SELECT 
        COUNT(*) as total_routes,
        COUNT(*) FILTER (WHERE r.status = 'completed') as completed_routes,
        COUNT(*) FILTER (WHERE r.status = 'in_progress') as partial_routes,
        COUNT(*) FILTER (WHERE r.status IN ('scheduled','confirmed','pending')) as pending_routes,
        COUNT(*) FILTER (WHERE r.status NOT IN ('completed','in_progress','scheduled','confirmed','pending')) as other_routes,
        COUNT(DISTINCT r.brand_id) as brands_served,
        COUNT(DISTINCT r.pdv_id) as pdvs_served,
        COUNT(DISTINCT r.promoter_id) as active_promoters,
        AVG(EXTRACT(EPOCH FROM (r.checkout_at - r.checkin_at))/60) FILTER (WHERE r.checkin_at IS NOT NULL AND r.checkout_at IS NOT NULL) as avg_visit_min
      FROM merch_routes r WHERE r.organization_id = $1 ${extraFilter}
    `, params)).rows[0];

    // Product execution KPIs
    let productKpis = { total_products: 0, executed_products: 0 };
    try {
      const pRes = (await query(`
        SELECT COUNT(*) as total_products,
          COUNT(*) FILTER (WHERE rpe.status = 'completed') as executed_products
        FROM route_product_executions rpe
        JOIN merch_routes r ON r.id = rpe.route_id
        WHERE r.organization_id = $1 ${extraFilter}
      `, params)).rows[0];
      productKpis = pRes;
    } catch {}

    // Photo count
    let photosCount = 0;
    try {
      const phRes = (await query(`
        SELECT COUNT(*) as cnt FROM route_photos rp
        JOIN merch_routes r ON r.id = rp.route_id
        WHERE r.organization_id = $1 ${extraFilter}
      `, params)).rows[0];
      photosCount = parseInt(phRes.cnt) || 0;
    } catch {}

    // Damages & stockouts
    let damages = 0, stockouts = 0, stockCounts = 0, expiryCounts = 0;
    try {
      const dRes = (await query(`
        SELECT 
          (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_damages pd JOIN merch_routes r2 ON r2.id = pd.route_id WHERE r2.organization_id = $1 ${extraFilter.replace(/r\./g, 'r2.')}) as damages,
          (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_ruptures pr JOIN merch_routes r2 ON r2.id = pr.route_id WHERE r2.organization_id = $1 ${extraFilter.replace(/r\./g, 'r2.')}) as stockouts,
          (SELECT COUNT(*) FROM route_product_executions rpe JOIN merch_routes r2 ON r2.id = rpe.route_id WHERE r2.organization_id = $1 ${extraFilter.replace(/r\./g, 'r2.')} AND (rpe.qty_store > 0 OR rpe.qty_stock > 0)) as stock_counts,
          (SELECT COUNT(*) FROM product_validity_entries pve JOIN merch_routes r2 ON r2.id = pve.route_id WHERE r2.organization_id = $1 ${extraFilter.replace(/r\./g, 'r2.')}) as expiry_counts
      `, params)).rows[0];
      damages = parseInt(dRes.damages) || 0;
      stockouts = parseInt(dRes.stockouts) || 0;
      stockCounts = parseInt(dRes.stock_counts) || 0;
      expiryCounts = parseInt(dRes.expiry_counts) || 0;
    } catch (err) { logError('dashboard.stats_fail', err); }

    // Price research
    let priceCompleted = 0, pricePending = 0;
    try {
      const prRes = (await query(`
        SELECT 
          COUNT(*) FILTER (WHERE e.status IN ('completed','validated')) as completed,
          COUNT(*) FILTER (WHERE e.status IN ('pending','scheduled')) as pending
        FROM price_research_executions e
        WHERE e.organization_id = $1
      `, [orgId])).rows[0];
      priceCompleted = parseInt(prRes.completed) || 0;
      pricePending = parseInt(prRes.pending) || 0;
    } catch {}

    // Derived metrics
    const totalRoutes = parseInt(routeKpis.total_routes) || 0;
    const completedRoutes = parseInt(routeKpis.completed_routes) || 0;
    const totalProducts = parseInt(productKpis.total_products) || 0;
    const executedProducts = parseInt(productKpis.executed_products) || 0;

    const completionRate = totalRoutes > 0 ? Math.round((completedRoutes / totalRoutes) * 100) : 0;
    const productExecutionRate = totalProducts > 0 ? Math.round((executedProducts / totalProducts) * 100) : 0;
    const avgPhotosPerRoute = totalRoutes > 0 ? Math.round((photosCount / totalRoutes) * 10) / 10 : 0;

    // Operational score (weighted average)
    const routeScore = completionRate;
    const productScore = productExecutionRate;
    const damageScore = totalProducts > 0 ? Math.max(0, 100 - (damages / totalProducts) * 100) : 100;
    const stockoutScore = totalProducts > 0 ? Math.max(0, 100 - (stockouts / totalProducts) * 100) : 100;
    const operationalScore = Math.round((routeScore * 0.3 + productScore * 0.3 + damageScore * 0.2 + stockoutScore * 0.2));

    res.json({
      kpis: {
        total_routes: totalRoutes,
        completed_routes: completedRoutes,
        partial_routes: parseInt(routeKpis.partial_routes) || 0,
        pending_routes: parseInt(routeKpis.pending_routes) || 0,
        total_products: totalProducts,
        executed_products: executedProducts,
        brands_served: parseInt(routeKpis.brands_served) || 0,
        pdvs_served: parseInt(routeKpis.pdvs_served) || 0,
        active_promoters: parseInt(routeKpis.active_promoters) || 0,
        photos_captured: photosCount,
        damages_registered: damages,
        stockouts_registered: stockouts,
        price_research_completed: priceCompleted,
        price_research_pending: pricePending,
        stock_counts: stockCounts,
        expiry_counts: expiryCounts,
      },
      derived: {
        completion_rate: completionRate,
        product_execution_rate: productExecutionRate,
        avg_visit_duration_min: Math.round(parseFloat(routeKpis.avg_visit_min) || 0),
        avg_photos_per_route: avgPhotosPerRoute,
        damage_rate: totalProducts > 0 ? Math.round((damages / totalProducts) * 10000) / 100 : 0,
        stockout_rate: totalProducts > 0 ? Math.round((stockouts / totalProducts) * 10000) / 100 : 0,
        operational_score: operationalScore,
      },
    });
  } catch (err) { logError('merch-analytics.dashboard', err); res.status(500).json({ error: 'Erro ao carregar dashboard' }); }
});

// ===== Report by PDV =====
router.get('/report/pdv', async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    if (!orgInfo?.organization_id) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgInfo.organization_id;
    let { date_from, date_to, pdv_id, brand_id, promoter_id } = req.query;
    if (orgInfo.brand_id) brand_id = orgInfo.brand_id;
    const params = [orgId];
    let idx = 2;
    let filters = '';
    if (date_from) { filters += ` AND r.visit_date >= $${idx}`; params.push(date_from); idx++; }
    if (date_to) { filters += ` AND r.visit_date <= $${idx}`; params.push(date_to); idx++; }
    if (pdv_id) { filters += ` AND r.pdv_id = $${idx}`; params.push(pdv_id); idx++; }
    if (brand_id) { filters += ` AND r.brand_id = $${idx}`; params.push(brand_id); idx++; }
    if (promoter_id) { filters += ` AND r.promoter_id = $${idx}`; params.push(promoter_id); idx++; }

    const rows = (await query(`
      SELECT p.id as pdv_id, p.name as pdv_name, p.city,
        (SELECT STRING_AGG(DISTINCT mr.name, ', ' ORDER BY mr.name)
         FROM merch_rede_pdvs mrp
         JOIN merch_redes mr ON mr.id = mrp.rede_id
         WHERE mrp.pdv_id = p.id AND mr.organization_id = p.organization_id) as network,
        COUNT(DISTINCT r.id) as total_visits,
        COUNT(DISTINCT r.brand_id) as brands_served,
        COUNT(DISTINCT r.promoter_id) as promoters,
        COUNT(*) FILTER (WHERE r.status = 'completed') as completed,
        AVG(EXTRACT(EPOCH FROM (r.checkout_at - r.checkin_at))/60) FILTER (WHERE r.checkin_at IS NOT NULL AND r.checkout_at IS NOT NULL) as avg_duration_min
      FROM merch_routes r
      JOIN pdvs p ON p.id = r.pdv_id
      WHERE r.organization_id = $1 ${filters}
      GROUP BY p.id, p.name, p.city
      ORDER BY total_visits DESC
      LIMIT 200
    `, params)).rows;

    // Enrich with product execution stats (rebuild filters per-row with fresh param indexes)
    for (const row of rows) {
      try {
        const p2 = [row.pdv_id, orgId];
        let i2 = 3;
        let f2 = '';
        if (date_from) { f2 += ` AND r2.visit_date >= $${i2}`; p2.push(date_from); i2++; }
        if (date_to) { f2 += ` AND r2.visit_date <= $${i2}`; p2.push(date_to); i2++; }
        if (brand_id) { f2 += ` AND r2.brand_id = $${i2}`; p2.push(brand_id); i2++; }
        if (promoter_id) { f2 += ` AND r2.promoter_id = $${i2}`; p2.push(promoter_id); i2++; }
        const stats = (await query(`
          SELECT 
            (SELECT COUNT(*) FROM route_product_executions rpe JOIN merch_routes r2 ON r2.id = rpe.route_id WHERE r2.pdv_id = $1 AND r2.organization_id = $2 ${f2}) as total,
            (SELECT COUNT(*) FROM route_product_executions rpe JOIN merch_routes r2 ON r2.id = rpe.route_id WHERE r2.pdv_id = $1 AND r2.organization_id = $2 AND rpe.status = 'completed' ${f2}) as executed,
            (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_damages pd JOIN merch_routes r2 ON r2.id = pd.route_id WHERE r2.pdv_id = $1 AND r2.organization_id = $2 ${f2}) as damages,
            (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_ruptures pr JOIN merch_routes r2 ON r2.id = pr.route_id WHERE r2.pdv_id = $1 AND r2.organization_id = $2 ${f2}) as stockouts
        `, p2)).rows[0];
        
        row.total_products = parseInt(stats?.total) || 0;
        row.executed_products = parseInt(stats?.executed) || 0;
        row.damages = parseInt(stats?.damages) || 0;
        row.stockouts = parseInt(stats?.stockouts) || 0;
      } catch (e) { 
        logError('pdv_report_enrich', e);
        row.total_products = 0; row.executed_products = 0; row.damages = 0; row.stockouts = 0; 
      }
      row.score = row.total_visits > 0 ? Math.round((parseInt(row.completed) / parseInt(row.total_visits)) * 100) : 0;
    }
    res.json(rows);
  } catch (err) { logError('merch-analytics.report.pdv', err); res.status(500).json({ error: 'Erro ao carregar relatório de PDV' }); }
});

// ===== Report by Brand =====
router.get('/report/brand', async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    if (!orgInfo?.organization_id) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgInfo.organization_id;
    let { date_from, date_to, brand_id } = req.query;
    if (orgInfo.brand_id) brand_id = orgInfo.brand_id;
    const params = [orgId];
    let idx = 2;
    let filters = '';
    if (date_from) { filters += ` AND r.visit_date >= $${idx}`; params.push(date_from); idx++; }
    if (date_to) { filters += ` AND r.visit_date <= $${idx}`; params.push(date_to); idx++; }
    if (brand_id) { filters += ` AND r.brand_id = $${idx}`; params.push(brand_id); idx++; }

    const rows = (await query(`
      SELECT b.id as brand_id, b.name as brand_name,
        COUNT(DISTINCT r.id) as total_routes,
        COUNT(DISTINCT r.pdv_id) as pdvs_served,
        COUNT(DISTINCT r.promoter_id) as promoters,
        COUNT(*) FILTER (WHERE r.status = 'completed') as completed
      FROM merch_routes r
      JOIN merch_brands b ON b.id = r.brand_id
      WHERE r.organization_id = $1 ${filters}
      GROUP BY b.id, b.name
      ORDER BY total_routes DESC
    `, params)).rows;

    for (const row of rows) {
      try {
        const stats = (await query(`
          SELECT 
            (SELECT COUNT(*) FROM route_product_executions rpe JOIN merch_routes r2 ON r2.id = rpe.route_id WHERE r2.brand_id = $1 AND r2.organization_id = $2) as total,
            (SELECT COUNT(*) FROM route_product_executions rpe JOIN merch_routes r2 ON r2.id = rpe.route_id WHERE r2.brand_id = $1 AND r2.organization_id = $2 AND rpe.status = 'completed') as executed,
            (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_damages pd JOIN merch_routes r2 ON r2.id = pd.route_id WHERE r2.brand_id = $1 AND r2.organization_id = $2) as damages,
            (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_ruptures pr JOIN merch_routes r2 ON r2.id = pr.route_id WHERE r2.brand_id = $1 AND r2.organization_id = $2) as stockouts
        `, [row.brand_id, orgId])).rows[0];
        
        row.total_products = parseInt(stats?.total) || 0;
        row.executed_products = parseInt(stats?.executed) || 0;
        row.damages = parseInt(stats?.damages) || 0;
        row.stockouts = parseInt(stats?.stockouts) || 0;
      } catch (e) { 
        logError('brand_report_enrich', e);
        row.total_products = 0; row.executed_products = 0; row.damages = 0; row.stockouts = 0; 
      }
      row.score = parseInt(row.total_routes) > 0 ? Math.round((parseInt(row.completed) / parseInt(row.total_routes)) * 100) : 0;
    }
    res.json(rows);
  } catch (err) { logError('merch-analytics.report.brand', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== Report by Promoter =====
router.get('/report/promoter', async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    if (!orgInfo?.organization_id) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgInfo.organization_id;
    const { date_from, date_to, promoter_id } = req.query;
    const params = [orgId];
    let idx = 2;
    let filters = '';
    if (date_from) { filters += ` AND r.visit_date >= $${idx}`; params.push(date_from); idx++; }
    if (date_to) { filters += ` AND r.visit_date <= $${idx}`; params.push(date_to); idx++; }
    if (promoter_id) { filters += ` AND r.promoter_id = $${idx}`; params.push(promoter_id); idx++; }

    const rows = (await query(`
      SELECT e.id as promoter_id, e.full_name as promoter_name,
        COUNT(DISTINCT r.id) as total_routes,
        COUNT(*) FILTER (WHERE r.status = 'completed') as completed_routes,
        COUNT(*) FILTER (WHERE r.status IN ('scheduled','confirmed','pending')) as pending_routes,
        COUNT(DISTINCT r.brand_id) as brands_served,
        COUNT(DISTINCT r.pdv_id) as pdvs_visited,
        AVG(EXTRACT(EPOCH FROM (r.checkout_at - r.checkin_at))/60) FILTER (WHERE r.checkin_at IS NOT NULL AND r.checkout_at IS NOT NULL) as avg_visit_min
      FROM merch_routes r
      JOIN employees e ON e.id = r.promoter_id
      WHERE r.organization_id = $1 ${filters}
      GROUP BY e.id, e.full_name
      ORDER BY total_routes DESC
    `, params)).rows;

    for (const row of rows) {
      try {
        const stats = (await query(`
          SELECT 
            (SELECT COUNT(*) FROM route_product_executions rpe JOIN merch_routes r2 ON r2.id = rpe.route_id WHERE r2.promoter_id = $1 AND r2.organization_id = $2) as executed,
            (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_damages pd JOIN merch_routes r2 ON r2.id = pd.route_id WHERE r2.promoter_id = $1 AND r2.organization_id = $2) as damages,
            (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_ruptures pr JOIN merch_routes r2 ON r2.id = pr.route_id WHERE r2.promoter_id = $1 AND r2.organization_id = $2) as stockouts
        `, [row.promoter_id, orgId])).rows[0];
        
        row.products_executed = parseInt(stats?.executed) || 0;
        row.damages = parseInt(stats?.damages) || 0;
        row.stockouts = parseInt(stats?.stockouts) || 0;
      } catch (e) { 
        logError('promoter_report_enrich', e);
        row.products_executed = 0; row.damages = 0; row.stockouts = 0; 
      }

      // Photos
      try {
        const ph = (await query(`SELECT COUNT(*) as cnt FROM route_photos rp JOIN merch_routes r ON r.id = rp.route_id WHERE r.promoter_id=$1 AND r.organization_id=$2`, [row.promoter_id, orgId])).rows[0];
        row.photos = parseInt(ph?.cnt) || 0;
      } catch { row.photos = 0; }

      row.score = parseInt(row.total_routes) > 0 ? Math.round((parseInt(row.completed_routes) / parseInt(row.total_routes)) * 100) : 0;
    }
    res.json(rows);
  } catch (err) { logError('merch-analytics.report.promoter', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== Report by Product =====
router.get('/report/product', authenticate, async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    if (!orgInfo?.organization_id) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgInfo.organization_id;
    const { product_id } = req.query;
    const groupPdv = ['1', 'true', 'yes'].includes(String(req.query.group_pdv || '').toLowerCase());

    const routeParams = [orgId];
    const { filters: routeFilters } = buildRouteFiltersFromQuery(req.query, routeParams, 2);

    const productParams = [...routeParams];
    let productFilter = '';
    if (product_id) {
      productFilter = ` AND rpe.product_id = $${productParams.length + 1}`;
      productParams.push(product_id);
    }

    const rowKey = (productId, pdvId) => (groupPdv ? `${productId}|${pdvId || ''}` : String(productId));

    const rows = (await query(`
      SELECT p.id as product_id, p.name as product_name, p.sku, p.image_url as photo_url,
        ${groupPdv
          ? `b.name as brand_name, pv.id as pdv_id, pv.name as pdv_name,`
          : `COALESCE(STRING_AGG(DISTINCT b.name, ', ' ORDER BY b.name), '') as brand_name,
             COALESCE(STRING_AGG(DISTINCT pv.name, ', ' ORDER BY pv.name), '') as pdv_name,`}
        COUNT(DISTINCT r.pdv_id) as pdvs,
        COUNT(DISTINCT r.id) as routes,
        COUNT(*) FILTER (WHERE rpe.status='completed') as executed,
        COALESCE(SUM(rpe.qty_store),0) as stock_store,
        COALESCE(SUM(rpe.qty_stock),0) as stock_stock,
        COUNT(DISTINCT r.promoter_id) as promoters_count,
        COALESCE(STRING_AGG(DISTINCT e.full_name, ', ' ORDER BY e.full_name), '') as promoters
      FROM route_product_executions rpe
      JOIN merch_routes r ON r.id = rpe.route_id
      JOIN merch_products p ON p.id = rpe.product_id
      LEFT JOIN employees e ON e.id = r.promoter_id
      LEFT JOIN merch_brands b ON b.id = r.brand_id
      LEFT JOIN pdvs pv ON pv.id = r.pdv_id
      WHERE r.organization_id = $1 ${routeFilters} ${productFilter}
      GROUP BY p.id, p.name, p.sku, p.image_url${groupPdv ? ', b.name, pv.id, pv.name' : ''}
      ORDER BY ${groupPdv ? 'pv.name ASC, p.name ASC' : 'routes DESC, p.name ASC'}
      LIMIT ${groupPdv ? 1000 : 200}
    `, productParams)).rows;

    rows.forEach((row) => {
      row.photo_url = row.photo_url || row.image_url || null;
      row.damages = 0;
      row.stockouts = 0;
      row.expiries = 0;
      row.next_expiry_date = null;
      row.next_expiry_qty_store = 0;
      row.next_expiry_qty_stock = 0;
      row.next_expiry_total = 0;
    });


    const extraSelect = groupPdv ? ', r.pdv_id' : '';
    const extraGroup = groupPdv ? ', r.pdv_id' : '';
    const byProductId = new Map(rows.map((row) => [rowKey(row.product_id, row.pdv_id), row]));

    if (rows.length > 0 && await tableExists('product_damages')) {
      try {
        const damageParams = [...routeParams];
        let damageFilter = '';
        if (product_id) {
          damageFilter = ` AND pd.product_id = $${damageParams.length + 1}`;
          damageParams.push(product_id);
        }

        const damageRows = (await query(`
          SELECT pd.product_id${extraSelect}, COALESCE(SUM(pd.qty_store + pd.qty_stock), 0) as damages
          FROM product_damages pd
          JOIN merch_routes r ON r.id = pd.route_id
          WHERE r.organization_id = $1 ${routeFilters} ${damageFilter}
          GROUP BY pd.product_id${extraGroup}
        `, damageParams)).rows;

        damageRows.forEach((row) => {
          const product = byProductId.get(rowKey(row.product_id, row.pdv_id));
          if (product) product.damages = parseInt(row.damages, 10) || 0;
        });
      } catch (error) {
        logInfo('merch-analytics.report.product.damage-fallback', { error: error.message });
      }
    }

    if (rows.length > 0 && await tableExists('product_ruptures')) {
      try {
        const ruptureParams = [...routeParams];
        let ruptureFilter = '';
        if (product_id) {
          ruptureFilter = ` AND pr.product_id = $${ruptureParams.length + 1}`;
          ruptureParams.push(product_id);
        }

        const ruptureRows = (await query(`
          SELECT pr.product_id${extraSelect}, COALESCE(SUM(pr.qty_store + pr.qty_stock), 0) as stockouts
          FROM product_ruptures pr
          JOIN merch_routes r ON r.id = pr.route_id
          WHERE r.organization_id = $1 ${routeFilters} ${ruptureFilter}
          GROUP BY pr.product_id${extraGroup}
        `, ruptureParams)).rows;

        ruptureRows.forEach((row) => {
          const product = byProductId.get(rowKey(row.product_id, row.pdv_id));
          if (product) product.stockouts = parseInt(row.stockouts, 10) || 0;
        });
      } catch (error) {
        logInfo('merch-analytics.report.product.rupture-fallback', { error: error.message });
      }
    }

    if (rows.length > 0 && await tableExists('product_validity_entries')) {
      try {
        const expiryParams = [...routeParams];
        let expiryFilter = '';
        if (product_id) {
          expiryFilter = ` AND pve.product_id = $${expiryParams.length + 1}`;
          expiryParams.push(product_id);
        }

        const expiryRows = (await query(`
          SELECT pve.product_id${extraSelect}, COALESCE(SUM(pve.qty_store + pve.qty_stock), 0) as expiries
          FROM product_validity_entries pve
          JOIN merch_routes r ON r.id = pve.route_id
          WHERE r.organization_id = $1 ${routeFilters} ${expiryFilter}
          GROUP BY pve.product_id${extraGroup}
        `, expiryParams)).rows;

        expiryRows.forEach((row) => {
          const product = byProductId.get(rowKey(row.product_id, row.pdv_id));
          if (product) product.expiries = parseInt(row.expiries, 10) || 0;
        });
      } catch (error) {
        logInfo('merch-analytics.report.product.expiry-fallback', { error: error.message });
      }

      // Nearest expiry date per product (with quantities in that date)
      try {
        const nearParams = [...routeParams];
        let nearFilter = '';
        if (product_id) {
          nearFilter = ` AND pve.product_id = $${nearParams.length + 1}`;
          nearParams.push(product_id);
        }

        const nearRows = (await query(`
          SELECT DISTINCT ON (pve.product_id${extraSelect})
            pve.product_id${extraSelect},
            pve.expiry_date,
            SUM(pve.qty_store) OVER (PARTITION BY pve.product_id${extraSelect}, pve.expiry_date) as qty_store,
            SUM(pve.qty_stock) OVER (PARTITION BY pve.product_id${extraSelect}, pve.expiry_date) as qty_stock
          FROM product_validity_entries pve
          JOIN merch_routes r ON r.id = pve.route_id
          WHERE r.organization_id = $1 ${routeFilters} ${nearFilter}
            AND pve.expiry_date IS NOT NULL
          ORDER BY pve.product_id${extraSelect}, pve.expiry_date ASC
        `, nearParams)).rows;

        nearRows.forEach((row) => {
          const product = byProductId.get(rowKey(row.product_id, row.pdv_id));
          if (!product) return;
          product.next_expiry_date = row.expiry_date;
          product.next_expiry_qty_store = parseInt(row.qty_store, 10) || 0;
          product.next_expiry_qty_stock = parseInt(row.qty_stock, 10) || 0;
          product.next_expiry_total = product.next_expiry_qty_store + product.next_expiry_qty_stock;
        });
      } catch (error) {
        logInfo('merch-analytics.report.product.next-expiry-fallback', { error: error.message });
      }
    }

    res.json(rows);
  } catch (err) { logError('merch-analytics.report.product', err); res.status(500).json({ error: 'Erro' }); }
});


// ===== Report by Category =====
router.get('/report/category', authenticate, async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });
    const { date_from, date_to } = req.query;
    const params = [orgId];
    let idx = 2;
    let filters = '';
    if (date_from) { filters += ` AND r.visit_date >= $${idx}`; params.push(date_from); idx++; }
    if (date_to) { filters += ` AND r.visit_date <= $${idx}`; params.push(date_to); idx++; }

    const rows = (await query(`
      SELECT c.id as category_id, c.name as category_name,
        COUNT(DISTINCT p.id) as total_products,
        COUNT(DISTINCT rpe.id) as total_executions,
        COUNT(*) FILTER (WHERE rpe.status='completed') as executed,
        (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_damages pd JOIN merch_routes r2 ON r2.id = pd.route_id JOIN merch_products p2 ON p2.id = pd.product_id WHERE p2.category_id = c.id AND r2.organization_id = $1 ${filters.replace(/r\./g, 'r2.')}) as damages,
        (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM product_ruptures pr JOIN merch_routes r2 ON r2.id = pr.route_id JOIN merch_products p2 ON p2.id = pr.product_id WHERE p2.category_id = c.id AND r2.organization_id = $1 ${filters.replace(/r\./g, 'r2.')}) as stockouts,
        COALESCE(SUM(rpe.qty_store + rpe.qty_stock),0) as total_stock,
        (SELECT COUNT(*) FROM product_validity_entries pve JOIN merch_routes r2 ON r2.id = pve.route_id JOIN merch_products p2 ON p2.id = pve.product_id WHERE p2.category_id = c.id AND r2.organization_id = $1 ${filters.replace(/r\./g, 'r2.')}) as expiries
      FROM route_product_executions rpe
      JOIN merch_routes r ON r.id = rpe.route_id
      JOIN merch_products p ON p.id = rpe.product_id
      LEFT JOIN merch_categories c ON c.id = p.category_id
      WHERE r.organization_id = $1 ${filters}
      GROUP BY c.id, c.name
      ORDER BY total_executions DESC
    `, params)).rows;
    res.json(rows);
  } catch (err) { logError('merch-analytics.report.category', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== Report: Stockouts / Ruptures Details =====

router.get('/report/stockouts', async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });
    
    const params = [orgId];
    const { filters } = buildRouteFiltersFromQuery(req.query, params, 2);

    const rows = (await query(`
      SELECT 
        r.id as route_id,
        r.visit_date,
        p.name as pdv_name,
        p.city as pdv_city,
        e.full_name as promoter_name,
        b.name as brand_name,
        pr.name as product_name,
        pr.sku as product_sku,
        COALESCE(rup.qty_store, 0) + COALESCE(rup.qty_stock, 0) as qty,
        rup.reason as reason
      FROM product_ruptures rup
      JOIN merch_routes r ON r.id = rup.route_id
      JOIN pdvs p ON p.id = r.pdv_id
      JOIN employees e ON e.id = r.promoter_id
      LEFT JOIN merch_brands b ON b.id = r.brand_id
      JOIN merch_products pr ON pr.id = rup.product_id
      WHERE r.organization_id = $1 ${filters}
      ORDER BY r.visit_date DESC, p.name ASC
      LIMIT 1000
    `, params)).rows;

    res.json(rows);
  } catch (err) {
    logError('merch-analytics.report.stockouts', err);
    res.status(500).json({ error: 'Erro ao gerar relatório de rupturas' });
  }
});


// ===== Charts: Route completion over time =====
router.get('/charts/routes-timeline', authenticate, async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });
    const { date_from, date_to } = req.query;
    const params = [orgId];
    let idx = 2;
    let filters = '';
    if (date_from) { filters += ` AND r.visit_date >= $${idx}`; params.push(date_from); idx++; }
    if (date_to) { filters += ` AND r.visit_date <= $${idx}`; params.push(date_to); idx++; }

    const rows = (await query(`
      SELECT r.visit_date::text as date,
        COUNT(*) as total,
        COUNT(*) as scheduled,
        COUNT(*) FILTER (WHERE r.status='completed') as completed,
        COUNT(*) FILTER (WHERE r.status='in_progress') as partial,
        COUNT(*) FILTER (WHERE r.status IN ('scheduled','confirmed','pending')) as pending
      FROM merch_routes r
      WHERE r.organization_id = $1 ${filters}
      GROUP BY r.visit_date ORDER BY r.visit_date
    `, params)).rows;
    res.json(rows);
  } catch (err) { logError('merch-analytics.charts.routes', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== Alerts =====
router.get('/alerts', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });
    const rows = (await query(
      'SELECT * FROM merchan_ai_alerts WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50', [orgId]
    )).rows;
    res.json(rows);
  } catch (err) { logError('merch-analytics.alerts', err); res.status(500).json({ error: 'Erro' }); }
});

router.get('/inactivity/config', authenticate, async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });

    const config = await getInactivityConfig(orgId);
    res.json(config);
  } catch (err) {
    logError('merch-analytics.inactivity-config.get', err);
    res.status(500).json({ error: 'Erro ao carregar configuração de inatividade' });
  }
});

router.put('/inactivity/config', authenticate, async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });

    const payload = {
      enabled: req.body?.enabled !== false,
      threshold_minutes: Math.min(720, Math.max(1, normalizePositiveInt(req.body?.threshold_minutes, 20))),
    };

    await ensureOrganizationSettingsTable();
    await query(
      `INSERT INTO organization_settings (organization_id, setting_key, config, updated_at)
       VALUES ($1, 'merch_inactivity_config', $2, NOW())
       ON CONFLICT (organization_id, setting_key) DO UPDATE
       SET config = $2, updated_at = NOW()`,
      [orgId, JSON.stringify(payload)]
    );

    res.json({ success: true, config: payload });
  } catch (err) {
    logError('merch-analytics.inactivity-config.put', err);
    res.status(500).json({ error: 'Erro ao salvar configuração de inatividade' });
  }
});

router.get('/inactivity/report', authenticate, async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });

    let { brand_id } = req.query;
    if (orgInfo.brand_id) brand_id = orgInfo.brand_id;

    const config = await getInactivityConfig(orgId);
    const params = [orgId];
    const { filters } = buildRouteFiltersFromQuery({ ...req.query, brand_id }, params, 2);

    const rows = (await query(`
      WITH active_routes AS (
        SELECT
          r.id AS route_id,
          r.visit_date,
          r.status,
          r.checkin_at,
          r.checkout_at,
          r.completed_at,
          r.promoter_id,
          r.pdv_id,
          r.brand_id,
          COALESCE(p.name, '') AS pdv_name,
          COALESCE(p.city, '') AS pdv_city,
          COALESCE(p.state, '') AS pdv_state,
          COALESCE(e.full_name, '') AS promoter_name,
          COALESCE(b.name, '') AS brand_name
        FROM merch_routes r
        LEFT JOIN pdvs p ON p.id = r.pdv_id
        LEFT JOIN employees e ON e.id = r.promoter_id
        LEFT JOIN merch_brands b ON b.id = r.brand_id
        WHERE r.organization_id = $1
          AND r.checkin_at IS NOT NULL
          AND r.checkout_at IS NULL
          AND r.completed_at IS NULL
          AND r.status = 'in_progress'
          ${filters}
      )
      SELECT
        ar.*,
        last_photo.last_photo_at,
        ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(last_photo.last_photo_at, ar.checkin_at))) / 60.0)::int AS inactivity_minutes,
        ROUND(EXTRACT(EPOCH FROM (NOW() - ar.checkin_at)) / 60.0)::int AS minutes_since_checkin
      FROM active_routes ar
      LEFT JOIN LATERAL (
        SELECT MAX(COALESCE(rp.captured_at, rp.created_at)) AS last_photo_at
        FROM route_photos rp
        WHERE rp.route_id = ar.route_id
          AND rp.photo_url IS NOT NULL
          AND rp.photo_url NOT LIKE 'blob:%'
          AND rp.photo_url NOT LIKE 'local-file:%'
          AND COALESCE(rp.captured_at, rp.created_at) >= ar.checkin_at
      ) last_photo ON TRUE
      ORDER BY inactivity_minutes DESC, ar.checkin_at ASC
    `, params)).rows;

    const threshold = config.threshold_minutes;
    const normalizedRows = rows.map((row) => {
      const inactivityMinutes = parseInt(row.inactivity_minutes, 10) || 0;
      const minutesSinceCheckin = parseInt(row.minutes_since_checkin, 10) || 0;
      const isAlert = config.enabled && inactivityMinutes >= threshold;
      const severity = !config.enabled
        ? 'disabled'
        : inactivityMinutes >= threshold * 2
          ? 'critical'
          : inactivityMinutes >= threshold
            ? 'high'
            : 'normal';

      return {
        ...row,
        inactivity_minutes: inactivityMinutes,
        minutes_since_checkin: minutesSinceCheckin,
        is_alert: isAlert,
        severity,
        has_photo_after_checkin: Boolean(row.last_photo_at),
      };
    });

    const alertRows = normalizedRows.filter((row) => row.is_alert);
    const summary = {
      monitored_routes: normalizedRows.length,
      alert_routes: alertRows.length,
      threshold_minutes: threshold,
      enabled: config.enabled,
      max_inactivity_minutes: normalizedRows.length ? Math.max(...normalizedRows.map((row) => row.inactivity_minutes || 0)) : 0,
      avg_inactivity_minutes: normalizedRows.length
        ? Math.round(normalizedRows.reduce((sum, row) => sum + (row.inactivity_minutes || 0), 0) / normalizedRows.length)
        : 0,
    };

    res.json({ summary, rows: normalizedRows, config });
  } catch (err) {
    logError('merch-analytics.inactivity-report', err);
    res.status(500).json({ error: 'Erro ao gerar relatório de inatividade' });
  }
});

// ===== Analytical Report (same content as PDF) =====
router.get('/analytical', async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });

    const params = [orgId];
    const { filters } = buildRouteFiltersFromQuery(req.query, params, 2);

    // Summary
    const summaryQ = `
      SELECT
        COUNT(*)::int AS scheduled,
        COUNT(*) FILTER (WHERE r.status='completed')::int AS completed,
        COUNT(*) FILTER (
          WHERE r.status IN ('cancelled','justified','no_show','skipped')
             OR (r.status NOT IN ('completed','in_progress') AND r.visit_date < CURRENT_DATE)
        )::int AS not_done,
        COUNT(*) FILTER (WHERE r.status='in_progress')::int AS in_progress,
        COUNT(*) FILTER (
          WHERE r.status NOT IN ('completed','cancelled','justified','no_show','skipped')
            AND r.visit_date >= CURRENT_DATE
        )::int AS upcoming
      FROM merch_routes r
      WHERE r.organization_id=$1 ${filters}
    `;
    const summaryRow = (await query(summaryQ, params)).rows[0] || {};
    const scheduled = summaryRow.scheduled || 0;
    const completed = summaryRow.completed || 0;
    const summary = {
      scheduled,
      completed,
      not_done: summaryRow.not_done || 0,
      in_progress: summaryRow.in_progress || 0,
      upcoming: summaryRow.upcoming || 0,
      completion_pct: scheduled > 0 ? Math.round((completed / scheduled) * 100) : 0,
    };

    // Detail rows — one per route, grouped by PDV
    const baseSelect = (itemsExpr, brandExpr) => `
      SELECT
        r.id,
        to_char(r.visit_date, 'YYYY-MM-DD') AS visit_date,
        r.status, COALESCE(r.progress_pct,0) AS progress_pct,
        COALESCE(p.id::text, '') AS pdv_id,
        COALESCE(p.name, '') AS pdv_name,
        COALESCE(p.city, '') AS pdv_city,
        COALESCE(p.state, '') AS pdv_state,
        COALESCE(e.full_name, '') AS promoter_name,
        ${brandExpr} AS brand_name,
        ${itemsExpr.scheduled} AS items_scheduled,
        ${itemsExpr.executed} AS items_executed
      FROM merch_routes r
      LEFT JOIN pdvs p ON p.id = r.pdv_id
      LEFT JOIN employees e ON e.id = r.promoter_id
      LEFT JOIN merch_brands b ON b.id = r.brand_id
      WHERE r.organization_id=$1 ${filters}
      ORDER BY p.name NULLS LAST, r.visit_date
    `;
    const brandWithMulti = `COALESCE(NULLIF(b.name,''), (SELECT string_agg(b2.name, ', ' ORDER BY b2.name) FROM route_brands rb JOIN merch_brands b2 ON b2.id = rb.brand_id WHERE rb.route_id = r.id), '')`;
    const brandSimple = `COALESCE(b.name, '')`;
    const withExec = {
      scheduled: `(SELECT COUNT(*)::int FROM route_product_executions rpe WHERE rpe.route_id=r.id)`,
      executed: `(SELECT COUNT(*)::int FROM route_product_executions rpe WHERE rpe.route_id=r.id AND rpe.checked=true)`,
    };
    const noExec = { scheduled: '0', executed: '0' };
    const fallbacks = [
      baseSelect(withExec, brandWithMulti),
      baseSelect(withExec, brandSimple),
      baseSelect(noExec, brandWithMulti),
      baseSelect(noExec, brandSimple),
    ];

    let rows = [];
    for (const q of fallbacks) {
      try { rows = (await query(q, params)).rows; break; }
      catch (e) { /* fallback */ }
    }

    res.json({ summary, rows });
  } catch (err) {
    logError('merch-analytics.analytical', err);
    res.status(500).json({ error: 'Erro ao gerar relatório analítico' });
  }
});

// ===== Ranking: Top PDVs by issues =====
router.get('/ranking/issues', authenticate, async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });
    const params = [orgId];
    const { filters } = buildRouteFiltersFromQuery(req.query, params, 2);

    const rows = (await query(`
      WITH filtered_pdvs AS (
        SELECT DISTINCT r.pdv_id
        FROM merch_routes r
        WHERE r.organization_id = $1 ${filters}
      )
      SELECT p.id as pdv_id, p.name as pdv_name
      FROM filtered_pdvs fp
      JOIN pdvs p ON p.id = fp.pdv_id
      ORDER BY p.name ASC
      LIMIT 200
    `, params)).rows.map((row) => ({ ...row, damages: 0, stockouts: 0, total_issues: 0 }));

    const byPdvId = new Map(rows.map((row) => [row.pdv_id, row]));

    if (rows.length > 0 && await tableExists('product_damages')) {
      try {
        const damageRows = (await query(`
          SELECT r.pdv_id, COALESCE(SUM(pd.qty_store + pd.qty_stock), 0) as damages
          FROM product_damages pd
          JOIN merch_routes r ON r.id = pd.route_id
          WHERE r.organization_id = $1 ${filters}
          GROUP BY r.pdv_id
        `, params)).rows;

        damageRows.forEach((row) => {
          const pdv = byPdvId.get(row.pdv_id);
          if (pdv) pdv.damages = parseInt(row.damages, 10) || 0;
        });
      } catch (error) {
        logInfo('merch-analytics.ranking.damage-fallback', { error: error.message });
      }
    }

    if (rows.length > 0 && await tableExists('product_ruptures')) {
      try {
        const ruptureRows = (await query(`
          SELECT r.pdv_id, COALESCE(SUM(pr.qty_store + pr.qty_stock), 0) as stockouts
          FROM product_ruptures pr
          JOIN merch_routes r ON r.id = pr.route_id
          WHERE r.organization_id = $1 ${filters}
          GROUP BY r.pdv_id
        `, params)).rows;

        ruptureRows.forEach((row) => {
          const pdv = byPdvId.get(row.pdv_id);
          if (pdv) pdv.stockouts = parseInt(row.stockouts, 10) || 0;
        });
      } catch (error) {
        logInfo('merch-analytics.ranking.rupture-fallback', { error: error.message });
      }
    }

    const rankedRows = rows
      .map((row) => ({
        ...row,
        total_issues: (parseInt(row.damages, 10) || 0) + (parseInt(row.stockouts, 10) || 0),
      }))
      .filter((row) => row.total_issues > 0)
      .sort((a, b) => b.total_issues - a.total_issues || a.pdv_name.localeCompare(b.pdv_name))
      .slice(0, 20);

    res.json(rankedRows);
  } catch (err) { logError('merch-analytics.ranking', err); res.status(500).json({ error: 'Erro' }); }
});

// ===== Brand Record (Prontuário) =====
router.get('/brand-record/:brandId', async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    const orgId = orgInfo?.organization_id;
    if (!orgId) return res.status(403).json({ error: 'Sem organização' });
    const { brandId } = req.params;
    const { date_from, date_to } = req.query;

    const params = [orgId, brandId];
    let idx = 3;
    let dateFilter = '';
    if (date_from) { dateFilter += ` AND r.visit_date >= $${idx}`; params.push(date_from); idx++; }
    if (date_to) { dateFilter += ` AND r.visit_date <= $${idx}`; params.push(date_to); idx++; }

    // 1. Brand Info
    const brand = (await query('SELECT id, name FROM merch_brands WHERE id=$1 AND organization_id=$2', [brandId, orgId])).rows[0];
    if (!brand) return res.status(404).json({ error: 'Marca não encontrada' });

    // 2. Summary & KPIs
    const summary = (await query(`
      SELECT 
        COUNT(DISTINCT r.id) as total_routes,
        COUNT(DISTINCT r.pdv_id) as pdvs_served,
        COUNT(DISTINCT r.promoter_id) as promoters,
        COUNT(*) FILTER (WHERE r.status = 'completed') as completed_routes
      FROM merch_routes r WHERE r.organization_id = $1 AND r.brand_id = $2 ${dateFilter}
    `, params)).rows[0];

    // 3. Recent/Current Routes
    const routes = (await query(`
      SELECT r.id, r.visit_date, r.status, r.scheduled_time,
             p.name as pdv_name, p.city as pdv_city,
             e.full_name as promoter_name,
             (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_id = r.id) as total_products,
             (SELECT COUNT(*) FROM route_product_executions rpe WHERE rpe.route_id = r.id AND rpe.status = 'completed') as completed_products
      FROM merch_routes r
      JOIN pdvs p ON p.id = r.pdv_id
      JOIN employees e ON e.id = r.promoter_id
      WHERE r.organization_id = $1 AND r.brand_id = $2 ${dateFilter}
      ORDER BY r.visit_date DESC, r.scheduled_time DESC
      LIMIT 50
    `, params)).rows;

    // 4. PDVs List with Details
    const pdvs = (await query(`
      SELECT p.id, p.name, p.city, p.address, p.latitude, p.longitude,
             COUNT(DISTINCT r.id) as visit_count,
             MAX(r.visit_date) as last_visit,
             (SELECT COUNT(*) FROM merch_products mp WHERE mp.brand_id = $2) as product_count
      FROM pdvs p
      JOIN merch_routes r ON r.pdv_id = p.id
      WHERE r.organization_id = $1 AND r.brand_id = $2 ${dateFilter}
      GROUP BY p.id, p.name, p.city, p.address, p.latitude, p.longitude
      ORDER BY p.name ASC
    `, params)).rows;

    // 5. Audited Products Execution Data
    const auditedProducts = (await query(`
      SELECT mp.id, mp.name, mp.sku,
             COUNT(rpe.id) as executions,
             COUNT(*) FILTER (WHERE rpe.status = 'completed') as completed,
             (SELECT COALESCE(SUM(qty_store + qty_stock), 0) FROM route_product_executions rpe2 WHERE rpe2.product_id = mp.id AND rpe2.route_id IN (SELECT id FROM merch_routes r2 WHERE r2.brand_id = $2 AND r2.organization_id = $1 ${dateFilter.replace(/r\./g, 'r2.')})) as total_stock,
             (SELECT COUNT(*) FROM product_ruptures pr JOIN merch_routes r2 ON r2.id = pr.route_id WHERE pr.product_id = mp.id AND r2.brand_id = $2 AND r2.organization_id = $1 ${dateFilter.replace(/r\./g, 'r2.')}) as total_ruptures,
             (SELECT COUNT(*) FROM product_damages pd JOIN merch_routes r2 ON r2.id = pd.route_id WHERE pd.product_id = mp.id AND r2.brand_id = $2 AND r2.organization_id = $1 ${dateFilter.replace(/r\./g, 'r2.')}) as total_damages
      FROM merch_products mp
      LEFT JOIN route_product_executions rpe ON rpe.product_id = mp.id
      LEFT JOIN merch_routes r ON r.id = rpe.route_id
      WHERE mp.brand_id = $2 AND r.organization_id = $1 ${dateFilter}
      GROUP BY mp.id, mp.name, mp.sku
      ORDER BY mp.name ASC
    `, params)).rows;

    // 6. Detailed Ruptures
    const stockouts = (await query(`
      SELECT pr.id, pr.qty_store, pr.qty_stock, pr.reason, pr.observation, pr.photo_url, pr.created_at as report_date,
             p.name as pdv_name, mp.name as product_name, mp.sku as product_sku,
             e.full_name as promoter_name
      FROM product_ruptures pr
      JOIN merch_routes r ON r.id = pr.route_id
      JOIN pdvs p ON p.id = r.pdv_id
      JOIN merch_products mp ON mp.id = pr.product_id
      JOIN employees e ON e.id = pr.recorded_by
      WHERE r.organization_id = $1 AND r.brand_id = $2 ${dateFilter}
      ORDER BY pr.created_at DESC
    `, params)).rows;

    // 7. Detailed Damages
    const damages = (await query(`
      SELECT pd.id, pd.qty_store, pd.qty_stock, pd.reason, pd.description, pd.photo_url, pd.created_at as report_date,
             p.name as pdv_name, mp.name as product_name, mp.sku as product_sku,
             e.full_name as promoter_name
      FROM product_damages pd
      JOIN merch_routes r ON r.id = pd.route_id
      JOIN pdvs p ON p.id = r.pdv_id
      JOIN merch_products mp ON mp.id = pd.product_id
      JOIN employees e ON e.id = pd.promoter_id
      WHERE r.organization_id = $1 AND r.brand_id = $2 ${dateFilter}
      ORDER BY pd.created_at DESC
    `, params)).rows;

    // 8. Scheduled Future Routes
    const scheduledRoutes = (await query(`
      SELECT r.id, r.visit_date, r.status, r.scheduled_time,
             p.name as pdv_name, e.full_name as promoter_name
      FROM merch_routes r
      JOIN pdvs p ON p.id = r.pdv_id
      JOIN employees e ON e.id = r.promoter_id
      WHERE r.organization_id = $1 AND r.brand_id = $2 AND r.visit_date > CURRENT_DATE
      ORDER BY r.visit_date ASC
      LIMIT 20
    `, [orgId, brandId])).rows;

    res.json({
      brand,
      summary,
      routes,
      pdvs,
      auditedProducts,
      stockouts,
      damages,
      scheduledRoutes
    });
  } catch (err) { 
    logError('merch-analytics.brand-record', err); 
    res.status(500).json({ error: 'Erro ao carregar prontuário da marca' }); 
  }
});

// ============================================================
// AI Chat — perguntas em linguagem natural sobre os relatórios
// ============================================================
async function gatherAiContext(orgId, filters = {}) {
  const { date_from, date_to, brand_id, pdv_id, promoter_id } = filters;
  const params = [orgId];
  let idx = 2;
  let extra = '';
  if (date_from) { extra += ` AND r.visit_date >= $${idx++}`; params.push(date_from); }
  if (date_to) { extra += ` AND r.visit_date <= $${idx++}`; params.push(date_to); }
  if (brand_id) { extra += ` AND r.brand_id = $${idx++}`; params.push(brand_id); }
  if (pdv_id) { extra += ` AND r.pdv_id = $${idx++}`; params.push(pdv_id); }
  if (promoter_id) { extra += ` AND r.promoter_id = $${idx++}`; params.push(promoter_id); }

  const kpi = (await query(`
    SELECT
      COUNT(*)::int AS total_routes,
      COUNT(*) FILTER (WHERE r.status='completed')::int AS completed,
      COUNT(*) FILTER (WHERE r.status='in_progress')::int AS partial,
      COUNT(*) FILTER (WHERE r.status IN ('scheduled','confirmed','pending'))::int AS pending,
      COUNT(DISTINCT r.brand_id)::int AS brands_served,
      COUNT(DISTINCT r.pdv_id)::int AS pdvs_served,
      COUNT(DISTINCT r.promoter_id)::int AS active_promoters
    FROM merch_routes r WHERE r.organization_id=$1 ${extra}
  `, params)).rows[0] || {};

  const topBrands = (await query(`
    SELECT COALESCE(b.name,'—') AS brand,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE r.status='completed')::int AS completed
    FROM merch_routes r
    LEFT JOIN merch_brands b ON b.id=r.brand_id
    WHERE r.organization_id=$1 ${extra}
    GROUP BY b.name ORDER BY total DESC LIMIT 10
  `, params)).rows;

  const topPdvs = (await query(`
    SELECT COALESCE(p.name,'—') AS pdv, COALESCE(p.city,'') AS city,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE r.status='completed')::int AS completed
    FROM merch_routes r
    LEFT JOIN pdvs p ON p.id=r.pdv_id
    WHERE r.organization_id=$1 ${extra}
    GROUP BY p.name, p.city ORDER BY total DESC LIMIT 15
  `, params)).rows;

  const topPromoters = (await query(`
    SELECT COALESCE(e.full_name,'—') AS promoter,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE r.status='completed')::int AS completed
    FROM merch_routes r
    LEFT JOIN employees e ON e.id=r.promoter_id
    WHERE r.organization_id=$1 ${extra}
    GROUP BY e.full_name ORDER BY completed DESC LIMIT 10
  `, params)).rows;

  let issues = { damages: 0, stockouts: 0 };
  try {
    const r = (await query(`
      SELECT
        (SELECT COALESCE(SUM(qty_store+qty_stock),0)::int FROM product_damages pd JOIN merch_routes r2 ON r2.id=pd.route_id WHERE r2.organization_id=$1 ${extra.replace(/r\./g,'r2.')}) AS damages,
        (SELECT COALESCE(SUM(qty_store+qty_stock),0)::int FROM product_ruptures pr JOIN merch_routes r2 ON r2.id=pr.route_id WHERE r2.organization_id=$1 ${extra.replace(/r\./g,'r2.')}) AS stockouts
    `, params)).rows[0];
    issues = r || issues;
  } catch {}

  return { filters, kpi, topBrands, topPdvs, topPromoters, issues };
}

router.post('/ai-chat', async (req, res) => {
  try {
    const orgInfo = await getOrgInfo(req.userId);
    if (!orgInfo?.organization_id) return res.status(403).json({ error: 'Sem organização' });
    const orgId = orgInfo.organization_id;

    const { messages = [], filters = {} } = req.body || {};
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'LOVABLE_API_KEY não configurada' });

    const context = await gatherAiContext(orgId, filters);

    const system = `Você é um analista de merchandising da Ayratech. Responda em português (pt-BR), de forma clara, objetiva e com números.
Use SOMENTE os dados do CONTEXTO abaixo (JSON) para responder. Se a informação não estiver disponível, diga que não há dados suficientes no período/filtros atuais.
Formate com listas e destaques em Markdown quando fizer sentido. Sempre cite números e percentuais quando aplicável.

CONTEXTO (JSON):
${JSON.stringify(context).slice(0, 12000)}`;

    const chatMessages = [
      { role: 'system', content: system },
      ...messages.filter(m => m && m.role && m.content).map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
    ];

    const r = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: chatMessages,
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      if (r.status === 429) return res.status(429).json({ error: 'Limite temporário de IA atingido. Tente novamente em instantes.' });
      if (r.status === 402) return res.status(402).json({ error: 'Créditos de IA esgotados. Adicione créditos em Configurações.' });
      logError('merch-analytics.ai_chat_gateway', new Error(txt.slice(0, 500)));
      return res.status(500).json({ error: 'Falha na IA', detail: txt.slice(0, 300) });
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content || 'Sem resposta.';
    res.json({ reply, context_summary: { ...context.kpi, damages: context.issues.damages, stockouts: context.issues.stockouts } });
  } catch (err) {
    logError('merch-analytics.ai_chat', err);
    res.status(500).json({ error: 'Erro na análise IA' });
  }
});

export default router;
