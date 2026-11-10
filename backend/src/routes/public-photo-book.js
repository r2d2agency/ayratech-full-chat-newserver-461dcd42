import express from 'express';
import { query } from '../db.js';

const router = express.Router();

router.get('/photo-book/:token', async (req, res) => {
  try {
    const { token } = req.params;

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

    const shareRes = await query(`SELECT * FROM photo_book_shares WHERE token=$1`, [token]);
    if (!shareRes.rows.length) return res.status(404).json({ error: 'Não encontrado ou expirado' });

    const share = shareRes.rows[0];
    const photoIds = share.photo_ids || [];
    const captions = share.captions || {};

    try { await query(`UPDATE photo_book_shares SET views=COALESCE(views,0)+1 WHERE id=$1`, [share.id]); } catch(_) {}

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

export default router;
