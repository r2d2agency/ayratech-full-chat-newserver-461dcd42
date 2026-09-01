
import express from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logError } from '../logger.js';
import { resyncChecklistOnFutureRoutes } from './merch-routes.js';


const router = express.Router();
router.use(authenticate);

// Ensure all checklist config columns exist
async function ensureChecklistTypeColumn() {
  try {
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS checklist_type VARCHAR(20) DEFAULT 'standard'`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS require_stock_count BOOLEAN DEFAULT false`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS require_validity_check BOOLEAN DEFAULT false`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS require_extra_point BOOLEAN DEFAULT false`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS require_category_photos BOOLEAN DEFAULT true`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS category_photo_mode VARCHAR(20) DEFAULT 'both'`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_before INT DEFAULT 1`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS min_category_photos_after INT DEFAULT 1`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS stock_count_frequency VARCHAR(20) DEFAULT 'every_visit'`);
    await query(`ALTER TABLE brand_checklists ADD COLUMN IF NOT EXISTS validity_check_frequency VARCHAR(20) DEFAULT 'every_visit'`);
  } catch (e) {
    logError('merch-checklists.ensureType', e);
  }
}

// Normalize the full checklist payload
function normalizeChecklist(body = {}) {
  const type = body.checklist_type === 'checkin_only' ? 'checkin_only' : 'standard';
  const isCheckinOnly = type === 'checkin_only';
  const mode = ['before', 'after', 'both'].includes(body.category_photo_mode) ? body.category_photo_mode : 'both';
  return {
    checklist_type: type,
    require_checkin_photo: body.require_checkin_photo ?? true,
    require_checkout_photo: body.require_checkout_photo ?? false,
    require_stock_count: isCheckinOnly ? false : !!body.require_stock_count,
    require_validity_check: isCheckinOnly ? false : !!body.require_validity_check,
    require_extra_point: isCheckinOnly ? false : !!body.require_extra_point,
    require_category_photos: isCheckinOnly ? false : (body.require_category_photos !== false),
    category_photo_mode: isCheckinOnly ? 'both' : mode,
    min_category_photos_before: mode === 'after' ? 0 : Math.max(1, parseInt(body.min_category_photos_before) || 1),
    min_category_photos_after: mode === 'before' ? 0 : Math.max(1, parseInt(body.min_category_photos_after) || 1),
    stock_count_frequency: body.stock_count_frequency || 'every_visit',
    validity_check_frequency: body.validity_check_frequency || 'every_visit',
  };
}


// Middleware: attach orgId to every request
router.use(async (req, res, next) => {
  try {
    const orgRes = await query(
      `SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`,
      [req.userId]
    );
    if (!orgRes.rows.length) return res.status(403).json({ error: 'Organização não encontrada' });
    req.orgId = orgRes.rows[0].organization_id;
    await ensureChecklistTypeColumn();
    next();
  } catch (e) {
    logError('merch checklist middleware', e);
    res.status(500).json({ error: 'Erro ao resolver organização' });
  }
});

// List checklists
router.get('/', async (req, res) => {
  try {
    const { brand_id } = req.query;
    let sql = 'SELECT * FROM brand_checklists WHERE organization_id = $1';
    const params = [req.orgId];
    if (brand_id) {
      sql += ' AND brand_id = $2';
      params.push(brand_id);
    }
    sql += ' ORDER BY name';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (e) {
    logError('get checklists', e);
    res.status(500).json({ error: e.message });
  }
});

// Create checklist
router.post('/', async (req, res) => {
  try {
    const { name, brand_id, description } = req.body;
    const c = normalizeChecklist(req.body);
    const r = await query(
      `INSERT INTO brand_checklists (organization_id, brand_id, name, description,
        require_checkin_photo, require_checkout_photo, checklist_type,
        require_stock_count, require_validity_check, require_extra_point,
        require_category_photos, category_photo_mode,
        min_category_photos_before, min_category_photos_after,
        stock_count_frequency, validity_check_frequency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.orgId, brand_id, name, description,
       c.require_checkin_photo, c.require_checkout_photo, c.checklist_type,
       c.require_stock_count, c.require_validity_check, c.require_extra_point,
       c.require_category_photos, c.category_photo_mode,
       c.min_category_photos_before, c.min_category_photos_after,
       c.stock_count_frequency, c.validity_check_frequency]
    );
    res.json(r.rows[0]);
  } catch (e) {
    logError('create checklist', e);
    res.status(500).json({ error: e.message });
  }
});

// Update checklist
router.put('/:id', async (req, res) => {
  try {
    const { name, description, active } = req.body;
    const c = normalizeChecklist(req.body);
    const r = await query(
      `UPDATE brand_checklists SET name=$1, description=$2, require_checkin_photo=$3, require_checkout_photo=$4,
        active=$5, checklist_type=$6, require_stock_count=$7, require_validity_check=$8, require_extra_point=$9,
        require_category_photos=$10, category_photo_mode=$11,
        min_category_photos_before=$12, min_category_photos_after=$13,
        stock_count_frequency=$14, validity_check_frequency=$15, updated_at=NOW()
       WHERE id=$16 AND organization_id=$17 RETURNING *`,
      [name, description, c.require_checkin_photo, c.require_checkout_photo, active ?? true, c.checklist_type,
       c.require_stock_count, c.require_validity_check, c.require_extra_point,
       c.require_category_photos, c.category_photo_mode,
       c.min_category_photos_before, c.min_category_photos_after,
       c.stock_count_frequency, c.validity_check_frequency,
       req.params.id, req.orgId]
    );
    res.json(r.rows[0]);
  } catch (e) {
    logError('update checklist', e);
    res.status(500).json({ error: e.message });
  }
});


// Delete checklist
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM brand_checklists WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
