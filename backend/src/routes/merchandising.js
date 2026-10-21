import express from 'express';
import { query, pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logInfo, logError } from '../logger.js';

const router = express.Router();
router.use(authenticate);

// Helper: resolve organization_id from token user
async function getUserOrgId(userId) {
  const r = await query(
    `SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return r.rows[0]?.organization_id || null;
}

// Middleware: attach orgId to every request
router.use(async (req, res, next) => {
  try {
    const orgId = req.query.org_id || req.body?.organization_id || await getUserOrgId(req.userId);
    if (!orgId) return res.status(400).json({ error: 'Organização não encontrada para o usuário' });
    req.orgId = orgId;
    next();
  } catch (e) {
    logError('merch org middleware', e);
    res.status(500).json({ error: 'Erro ao resolver organização' });
  }
});

let infraDone = false;

const normalizeMerchText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalizeMerchKey = (value) => normalizeMerchText(value).toLowerCase();
const normalizeMerchCode = (value) => normalizeMerchText(value).replace(/\.0+$/, '');
const buildProductImportError = (item, index, error) => ({
  line: Number(item?.__line) || index + 2,
  row: Number(item?.__line) || index + 2,
  sku: normalizeMerchText(item?.sku || item?.codigo),
  name: normalizeMerchText(item?.name || item?.descricao || item?.product_name),
  brand_name: normalizeMerchText(item?.brand_name || item?.brand || item?.marca || item?.brand_code || item?.id_familia || item?.familia || item?.codigo_familia || item?.codigo),
  category_name: normalizeMerchText(item?.category_name || item?.category || item?.categoria),
  subcategory_name: normalizeMerchText(item?.subcategory_name || item?.subcategory || item?.subcategoria),
  error,
});

async function ensureMerchandisingInfra() {
  logInfo('Checking merchandising infrastructure');
  if (infraDone) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS merch_brands (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      razao_social VARCHAR(255),
      cnpj VARCHAR(20),
      logo_url TEXT,
      description TEXT,
      segment VARCHAR(100),
      responsible VARCHAR(255),
      phone VARCHAR(30),
      email VARCHAR(255),
      status VARCHAR(20) DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS merch_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS merch_subcategories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      category_id UUID NOT NULL REFERENCES merch_categories(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS merch_products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      brand_id UUID NOT NULL REFERENCES merch_brands(id) ON DELETE CASCADE,
      category_id UUID REFERENCES merch_categories(id) ON DELETE RESTRICT,
      subcategory_id UUID REFERENCES merch_subcategories(id) ON DELETE RESTRICT,
      name VARCHAR(255) NOT NULL,
      sku VARCHAR(100),
      internal_code VARCHAR(100),
      barcode VARCHAR(100),
      description TEXT,
      image_url TEXT,
      unit VARCHAR(20) DEFAULT 'un',
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS merch_pdv_brands (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      pdv_id UUID NOT NULL,
      brand_id UUID NOT NULL REFERENCES merch_brands(id) ON DELETE CASCADE,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(pdv_id, brand_id)
    )`,
    `CREATE TABLE IF NOT EXISTS merch_pdv_brand_products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      pdv_id UUID NOT NULL,
      brand_id UUID NOT NULL REFERENCES merch_brands(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES merch_products(id) ON DELETE CASCADE,
      active BOOLEAN DEFAULT true,
      mandatory BOOLEAN DEFAULT false,
      priority VARCHAR(10) DEFAULT 'media',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(pdv_id, brand_id, product_id)
    )`,
    `CREATE TABLE IF NOT EXISTS merch_redes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS merch_rede_pdvs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      rede_id UUID NOT NULL REFERENCES merch_redes(id) ON DELETE CASCADE,
      pdv_id UUID NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(rede_id, pdv_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_merch_brands_org ON merch_brands(organization_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_brands_code ON merch_brands(organization_id, internal_code)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_products_brand ON merch_products(brand_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_products_category ON merch_products(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_pdv_brands_pdv ON merch_pdv_brands(pdv_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_pdv_brands_brand ON merch_pdv_brands(brand_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_pdv_bp_pdv ON merch_pdv_brand_products(pdv_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_pdv_bp_brand ON merch_pdv_brand_products(brand_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_redes_org ON merch_redes(organization_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_rede_pdvs_rede ON merch_rede_pdvs(rede_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merch_rede_pdvs_pdv ON merch_rede_pdvs(pdv_id)`,
    `DO $$ BEGIN ALTER TABLE merch_redes ADD COLUMN IF NOT EXISTS description TEXT; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_redes ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_redes ADD COLUMN IF NOT EXISTS organization_id UUID; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_redes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(); EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_rede_pdvs ADD COLUMN IF NOT EXISTS organization_id UUID; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merch_redes_org_name_unique') THEN
         BEGIN
           ALTER TABLE merch_redes ADD CONSTRAINT merch_redes_org_name_unique UNIQUE (organization_id, name);
         EXCEPTION WHEN others THEN NULL;
         END;
       END IF;
     END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS internal_code VARCHAR(100); EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS street VARCHAR(255); EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS number VARCHAR(50); EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(255); EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS city VARCHAR(255); EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS zip VARCHAR(20); EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS show_routes BOOLEAN DEFAULT true; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS show_photos BOOLEAN DEFAULT true; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS show_stock BOOLEAN DEFAULT true; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS show_damages BOOLEAN DEFAULT true; EXCEPTION WHEN others THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE merch_brands ADD COLUMN IF NOT EXISTS show_stockouts BOOLEAN DEFAULT true; EXCEPTION WHEN others THEN NULL; END $$`,
    // Marcas antigas podem ter ficado com `status` NULL (o PUT aceitava
    // `status` vazio e gravava NULL). O gate de criação de rotas exige
    // `status = 'active'`, então um NULL derrubava a criação da rota.
    `UPDATE merch_brands SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''`,
    `ALTER TABLE merch_products ALTER COLUMN category_id DROP NOT NULL`,
    `ALTER TABLE merch_products ALTER COLUMN subcategory_id DROP NOT NULL`,
    // Backfill: gera código interno automático para marcas sem código
    `WITH ranked AS (
       SELECT id, organization_id,
         COALESCE((SELECT MAX(NULLIF(regexp_replace(b2.internal_code, '\\D', '', 'g'), '')::int)
                   FROM merch_brands b2
                   WHERE b2.organization_id = b.organization_id
                     AND b2.internal_code ~ '^[0-9]+$'), 0)
         + ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS n
       FROM merch_brands b
       WHERE internal_code IS NULL OR TRIM(internal_code) = ''
     )
     UPDATE merch_brands m
     SET internal_code = LPAD(ranked.n::text, 4, '0'), updated_at = NOW()
     FROM ranked WHERE m.id = ranked.id`,
  ];
  for (const sql of statements) {
    try { await query(sql); } catch (err) { logError('merch infra stmt', err, { sql: sql.slice(0, 80) }); }
  }
  infraDone = true;
}

// ==================== BRANDS ====================
router.get('/brands', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const orgId = req.orgId;
    const { status, search } = req.query;
    let sql = 'SELECT * FROM merch_brands WHERE organization_id = $1';
    const params = [orgId];
    if (status && status !== 'all') { params.push(status); sql += ` AND status = $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (name ILIKE $${params.length} OR razao_social ILIKE $${params.length} OR cnpj ILIKE $${params.length} OR internal_code ILIKE $${params.length})`;
    }
    sql += ' ORDER BY name';
    const r = await query(sql, params);

    // If user is restricted to a brand, ensure they only see their own brand details
    const member = await query('SELECT brand_id FROM organization_members WHERE user_id=$1 AND organization_id=$2', [req.userId, orgId]);
    const restrictedBrandId = member.rows[0]?.brand_id;
    
    if (restrictedBrandId) {
      return res.json(r.rows.filter(b => b.id === restrictedBrandId));
    }

    res.json(r.rows);
  } catch (e) { logError('get brands', e); res.status(500).json({ error: e.message }); }
});

async function nextBrandInternalCode(orgId) {
  const r = await query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(internal_code, '\\D', '', 'g'), '')::int), 0) AS m
       FROM merch_brands WHERE organization_id = $1 AND internal_code ~ '^[0-9]+$'`,
    [orgId]
  );
  const next = (Number(r.rows[0]?.m) || 0) + 1;
  return String(next).padStart(4, '0');
}

router.post('/brands', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const orgId = req.orgId;
    const { name, internal_code, razao_social, cnpj, logo_url, description, segment, responsible, phone, email, status, notes, street, number, neighborhood, city, zip, show_routes, show_photos, show_stock, show_damages, show_stockouts } = req.body;
    const code = (internal_code && String(internal_code).trim()) || await nextBrandInternalCode(orgId);
    const r = await query(
      `INSERT INTO merch_brands (organization_id, name, internal_code, razao_social, cnpj, logo_url, description, segment, responsible, phone, email, status, notes, street, number, neighborhood, city, zip, show_routes, show_photos, show_stock, show_damages, show_stockouts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
      [orgId, name, code, razao_social, cnpj, logo_url, description, segment, responsible, phone, email, status || 'active', notes, street, number, neighborhood, city, zip, show_routes ?? true, show_photos ?? true, show_stock ?? true, show_damages ?? true, show_stockouts ?? true]
    );
    res.json(r.rows[0]);
  } catch (e) { logError('create brand', e); res.status(500).json({ error: e.message }); }
});

router.get('/brands/:id/check-future-routes', async (req, res) => {
  try {
    const r = await query(
      `SELECT COUNT(*)::int as count FROM merch_routes 
       WHERE organization_id=$1 
         AND visit_date >= CURRENT_DATE
         AND (brand_id = $2 OR EXISTS (SELECT 1 FROM route_brands WHERE route_id = merch_routes.id AND brand_id = $2))`,
      [req.orgId, req.params.id]
    );
    res.json({ future_count: r.rows[0]?.count || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/brands/:id', async (req, res) => {
  try {
    const { name, internal_code, razao_social, cnpj, logo_url, description, segment, responsible, phone, email, status, notes, street, number, neighborhood, city, zip, show_routes, show_photos, show_stock, show_damages, show_stockouts } = req.body;
    
    // Se estiver inativando a marca, remove ela de rotas futuras
    if (status === 'inactive') {
      // 1. Remove como marca principal de rotas futuras (set null)
      await query(
        `UPDATE merch_routes SET brand_id = NULL 
         WHERE brand_id = $1 AND organization_id = $2 AND visit_date >= CURRENT_DATE`,
        [req.params.id, req.orgId]
      );
      
      // 2. Remove de multi-marcas de rotas futuras
      await query(
        `DELETE FROM route_brands 
         WHERE brand_id = $1 AND route_id IN (SELECT id FROM merch_routes WHERE organization_id = $2 AND visit_date >= CURRENT_DATE)`,
        [req.params.id, req.orgId]
      );

      // 3. Deleta rotas futuras que ficaram sem nenhuma marca
      await query(
        `DELETE FROM merch_routes 
         WHERE organization_id = $1 
           AND visit_date >= CURRENT_DATE 
           AND brand_id IS NULL 
           AND NOT EXISTS (SELECT 1 FROM route_brands WHERE route_id = merch_routes.id)`,
        [req.orgId]
      );
    }

    const r = await query(
      `UPDATE merch_brands SET name=$1, internal_code=COALESCE(NULLIF($2,''), internal_code), razao_social=$3, cnpj=$4, logo_url=$5, description=$6, segment=$7, responsible=$8, phone=$9, email=$10, status=COALESCE(NULLIF($11,''), status), notes=$12, street=$13, number=$14, neighborhood=$15, city=$16, zip=$17, show_routes=$18, show_photos=$19, show_stock=$20, show_damages=$21, show_stockouts=$22, updated_at=NOW() WHERE id=$23 AND organization_id=$24 RETURNING *`,
      [name, internal_code || '', razao_social, cnpj, logo_url, description, segment, responsible, phone, email, status, notes, street, number, neighborhood, city, zip, show_routes ?? true, show_photos ?? true, show_stock ?? true, show_damages ?? true, show_stockouts ?? true, req.params.id, req.orgId]
    );
    res.json(r.rows[0]);
  } catch (e) { logError('update brand', e); res.status(500).json({ error: e.message }); }
});

router.delete('/brands/:id', async (req, res) => {
  try {
    await query('DELETE FROM merch_brands WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk import brands
router.post('/brands/import', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { items } = req.body; // [{name, internal_code?, razao_social?, cnpj?, phone?, street?, number?, neighborhood?, city?, zip?, status?}]
    if (!items?.length) return res.status(400).json({ error: 'Nenhum item enviado' });
    let created = 0, skipped = 0, updated = 0;
    for (const item of items) {
      const name = normalizeMerchText(item.name);
      const internalCode = normalizeMerchCode(item.internal_code || item.codigo || item.code);
      if (!name) {
        skipped++;
        continue;
      }

      const existing = await query(
        `SELECT id, internal_code FROM merch_brands
         WHERE organization_id=$1
           AND (
             LOWER(name)=LOWER($2)
             OR ($3 <> '' AND COALESCE(TRIM(internal_code), '') = $3)
           )
         LIMIT 1`,
        [req.orgId, name, internalCode]
      );

      const brandData = {
        name,
        internal_code: internalCode || null,
        razao_social: normalizeMerchText(item.razao_social) || null,
        cnpj: normalizeMerchText(item.cnpj) || null,
        phone: normalizeMerchText(item.phone) || null,
        street: normalizeMerchText(item.street) || null,
        number: normalizeMerchText(item.number) || null,
        neighborhood: normalizeMerchText(item.neighborhood) || null,
        city: normalizeMerchText(item.city) || null,
        zip: normalizeMerchText(item.zip) || null,
        status: normalizeMerchText(item.status) || 'active',
      };

      if (existing.rows.length) {
        await query(
          `UPDATE merch_brands
           SET name = COALESCE(NULLIF($2, ''), name),
               internal_code = COALESCE(NULLIF($3, ''), internal_code),
               razao_social = COALESCE(NULLIF($4, ''), razao_social),
               cnpj = COALESCE(NULLIF($5, ''), cnpj),
               phone = COALESCE(NULLIF($6, ''), phone),
               street = COALESCE(NULLIF($7, ''), street),
               number = COALESCE(NULLIF($8, ''), number),
               neighborhood = COALESCE(NULLIF($9, ''), neighborhood),
               city = COALESCE(NULLIF($10, ''), city),
               zip = COALESCE(NULLIF($11, ''), zip),
               status = COALESCE(NULLIF($12, ''), status),
               updated_at = NOW()
           WHERE id = $1`,
          [
            existing.rows[0].id,
            brandData.name,
            brandData.internal_code,
            brandData.razao_social,
            brandData.cnpj,
            brandData.phone,
            brandData.street,
            brandData.number,
            brandData.neighborhood,
            brandData.city,
            brandData.zip,
            brandData.status,
          ]
        );
        updated++;
        continue;
      }

      await query(
        `INSERT INTO merch_brands (
          organization_id, name, internal_code, razao_social, cnpj, phone, 
          street, number, neighborhood, city, zip, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          req.orgId,
          brandData.name,
          brandData.internal_code,
          brandData.razao_social,
          brandData.cnpj,
          brandData.phone,
          brandData.street,
          brandData.number,
          brandData.neighborhood,
          brandData.city,
          brandData.zip,
          brandData.status,
        ]
      );
      created++;
    }
    res.json({ ok: true, created, skipped, updated });
  } catch (e) { logError('import brands', e); res.status(500).json({ error: e.message }); }
});

// Export brands
router.get('/brands/export', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const orgId = req.orgId;
    const { status, search } = req.query;
    let sql = 'SELECT * FROM merch_brands WHERE organization_id = $1';
    const params = [orgId];
    if (status && status !== 'all') { params.push(status); sql += ` AND status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (name ILIKE $${params.length} OR razao_social ILIKE $${params.length})`; }
    sql += ' ORDER BY name';
    
    const result = await query(sql, params);
    
    const headers = ['Código Interno', 'Nome', 'Razão Social', 'CNPJ', 'Segmento', 'Responsável', 'Telefone', 'E-mail', 'Endereço', 'Número', 'Bairro', 'Cidade', 'CEP', 'Status', 'Notas'];
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",;\n]/.test(s) ? `"${s}"` : s;
    };
    
    const lines = [headers.join(';')];
    for (const r of result.rows) {
      lines.push([
        r.internal_code, r.name, r.razao_social, r.cnpj, r.segment, r.responsible, r.phone, r.email,
        r.street, r.number, r.neighborhood, r.city, r.zip, 
        r.status === 'active' ? 'Ativo' : 'Inativo',
        r.notes
      ].map(escape).join(';'));
    }
    
    const csv = '\ufeff' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="marcas_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    logError('merch.brands.export', err);
    res.status(500).json({ error: 'Erro ao exportar marcas' });
  }
});

// ==================== CATEGORIES ====================
router.get('/categories', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const r = await query('SELECT * FROM merch_categories WHERE organization_id=$1 ORDER BY name', [req.orgId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/categories', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { name, description, status } = req.body;
    const r = await query(
      'INSERT INTO merch_categories (organization_id, name, description, status) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.orgId, name, description, status || 'active']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/categories/:id', async (req, res) => {
  try {
    const { name, description, status } = req.body;
    const r = await query(
      'UPDATE merch_categories SET name=$1, description=$2, status=$3 WHERE id=$4 AND organization_id=$5 RETURNING *',
      [name, description, status, req.params.id, req.orgId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    await query('DELETE FROM merch_categories WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk import categories + subcategories
router.post('/categories/import', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { items } = req.body; // [{name, parent?, description?}]
    if (!items?.length) return res.status(400).json({ error: 'Nenhum item enviado' });

    // First pass: create categories (items without parent)
    const catMap = {};
    let catCount = 0, subCount = 0;
    for (const item of items) {
      if (!item.parent) {
        const existing = await query('SELECT id FROM merch_categories WHERE organization_id=$1 AND LOWER(name)=LOWER($2)', [req.orgId, item.name.trim()]);
        if (existing.rows.length) {
          catMap[item.name.trim().toLowerCase()] = existing.rows[0].id;
        } else {
          const r = await query(
            'INSERT INTO merch_categories (organization_id, name, description, status) VALUES ($1,$2,$3,$4) RETURNING id',
            [req.orgId, item.name.trim(), item.description || null, 'active']
          );
          catMap[item.name.trim().toLowerCase()] = r.rows[0].id;
          catCount++;
        }
      }
    }

    // Second pass: create subcategories (items with parent)
    for (const item of items) {
      if (item.parent) {
        const parentId = catMap[item.parent.trim().toLowerCase()];
        if (!parentId) {
          logInfo('import skip', `Parent "${item.parent}" not found for "${item.name}"`);
          continue;
        }
        const existing = await query('SELECT id FROM merch_subcategories WHERE organization_id=$1 AND category_id=$2 AND LOWER(name)=LOWER($3)', [req.orgId, parentId, item.name.trim()]);
        if (!existing.rows.length) {
          await query(
            'INSERT INTO merch_subcategories (organization_id, category_id, name, description, status) VALUES ($1,$2,$3,$4,$5)',
            [req.orgId, parentId, item.name.trim(), item.description || null, 'active']
          );
          subCount++;
        }
      }
    }

    res.json({ ok: true, categories_created: catCount, subcategories_created: subCount });
  } catch (e) { logError('import categories', e); res.status(500).json({ error: e.message }); }
});

// ==================== SUBCATEGORIES ====================
router.get('/subcategories', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { category_id } = req.query;
    let sql = 'SELECT s.*, c.name as category_name FROM merch_subcategories s JOIN merch_categories c ON c.id = s.category_id WHERE s.organization_id=$1';
    const params = [req.orgId];
    if (category_id) { params.push(category_id); sql += ` AND s.category_id=$${params.length}`; }
    sql += ' ORDER BY c.name, s.name';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/subcategories', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { name, category_id, description, status } = req.body;
    const r = await query(
      'INSERT INTO merch_subcategories (organization_id, category_id, name, description, status) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.orgId, category_id, name, description, status || 'active']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/subcategories/:id', async (req, res) => {
  try {
    const { name, category_id, description, status } = req.body;
    const r = await query(
      'UPDATE merch_subcategories SET name=$1, category_id=$2, description=$3, status=$4 WHERE id=$5 AND organization_id=$6 RETURNING *',
      [name, category_id, description, status, req.params.id, req.orgId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/subcategories/:id', async (req, res) => {
  try {
    await query('DELETE FROM merch_subcategories WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== PRODUCTS ====================
router.get('/products', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const orgId = req.orgId;
    const { brand_id, category_id, subcategory_id, status, search } = req.query;
    let sql = `SELECT p.*, b.name as brand_name, b.internal_code as brand_code, c.name as category_name, sc.name as subcategory_name
               FROM merch_products p
               JOIN merch_brands b ON b.id = p.brand_id
               LEFT JOIN merch_categories c ON c.id = p.category_id
               LEFT JOIN merch_subcategories sc ON sc.id = p.subcategory_id
               WHERE p.organization_id = $1`;
    const params = [orgId];
    if (brand_id) { params.push(brand_id); sql += ` AND p.brand_id=$${params.length}`; }
    if (category_id) { params.push(category_id); sql += ` AND p.category_id=$${params.length}`; }
    if (subcategory_id) { params.push(subcategory_id); sql += ` AND p.subcategory_id=$${params.length}`; }
    if (status) { params.push(status); sql += ` AND p.status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR p.barcode ILIKE $${params.length} OR p.internal_code ILIKE $${params.length} OR b.internal_code ILIKE $${params.length})`; }
    sql += ' ORDER BY p.name';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (e) { logError('get products', e); res.status(500).json({ error: e.message }); }
});

router.post('/products', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const orgId = req.orgId;
    const { name, brand_id, category_id, subcategory_id, sku, internal_code, barcode, description, image_url, unit, status } = req.body;
    const safeCat = category_id || null;
    const safeSub = subcategory_id || null;
    const safeBrand = brand_id || null;
    const r = await query(
      `INSERT INTO merch_products (organization_id, brand_id, category_id, subcategory_id, name, sku, internal_code, barcode, description, image_url, unit, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [orgId, safeBrand, safeCat, safeSub, name, sku, internal_code, barcode, description, image_url, unit || 'un', status || 'active']
    );
    res.json(r.rows[0]);
  } catch (e) { logError('create product', e); res.status(500).json({ error: e.message }); }
});

router.put('/products/:id', async (req, res) => {
  try {
    const { name, brand_id, category_id, subcategory_id, sku, internal_code, barcode, description, image_url, unit, status } = req.body;
    const safeSub = subcategory_id || null;
    const safeBrand = brand_id || null;
    const safeCat = category_id || null;
    const r = await query(
      `UPDATE merch_products SET name=$1, brand_id=$2, category_id=$3, subcategory_id=$4, sku=$5, internal_code=$6, barcode=$7, description=$8, image_url=$9, unit=$10, status=$11, updated_at=NOW()
       WHERE id=$12 AND organization_id=$13 RETURNING *`,
      [name, safeBrand, safeCat, safeSub, sku, internal_code, barcode, description, image_url, unit, status, req.params.id, req.orgId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/products/:id', async (req, res) => {
  try {
    await query('DELETE FROM merch_products WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== REDES / PDVs ====================
router.get('/networks', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const r = await query(
      `SELECT r.*, COALESCE(COUNT(rp.pdv_id), 0)::int AS pdv_count
       FROM merch_redes r
       LEFT JOIN merch_rede_pdvs rp ON rp.rede_id = r.id AND rp.organization_id = r.organization_id
       WHERE r.organization_id = $1
       GROUP BY r.id
       ORDER BY r.name`,
      [req.orgId]
    );
    res.json(r.rows);
  } catch (e) { logError('merch.networks.list', e); res.status(500).json({ error: e.message }); }
});

router.post('/networks', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { name, description, status } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
    const r = await query(
      `INSERT INTO merch_redes (organization_id, name, description, status)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, name)
       DO UPDATE SET description = EXCLUDED.description, status = EXCLUDED.status, updated_at = NOW()
       RETURNING *`,
      [req.orgId, String(name).trim(), description || null, status || 'active']
    );
    res.json(r.rows[0]);
  } catch (e) { logError('merch.networks.create', e); res.status(500).json({ error: e.message }); }
});

router.put('/networks/:id', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { name, description, status } = req.body || {};
    const r = await query(
      `UPDATE merch_redes
       SET name=$1, description=$2, status=$3, updated_at=NOW()
       WHERE id=$4 AND organization_id=$5
       RETURNING *`,
      [String(name || '').trim(), description || null, status || 'active', req.params.id, req.orgId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Rede não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { logError('merch.networks.update', e); res.status(500).json({ error: e.message }); }
});

router.delete('/networks/:id', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    await query('DELETE FROM merch_redes WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) { logError('merch.networks.delete', e); res.status(500).json({ error: e.message }); }
});

router.get('/networks/:id/pdvs', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const r = await query(
      `SELECT p.id, p.name, p.client_name, p.address, p.city, p.state
       FROM merch_rede_pdvs rp
       JOIN pdvs p ON p.id = rp.pdv_id
       WHERE rp.rede_id=$1 AND rp.organization_id=$2
       ORDER BY p.name`,
      [req.params.id, req.orgId]
    );
    res.json(r.rows);
  } catch (e) { logError('merch.networks.pdvs', e); res.status(500).json({ error: e.message }); }
});

router.post('/networks/:id/pdvs', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureMerchandisingInfra();
    const pdvIds = Array.isArray(req.body?.pdv_ids) ? req.body.pdv_ids.filter(Boolean) : [];
    await client.query('BEGIN');
    const network = await client.query('SELECT id FROM merch_redes WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    if (!network.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rede não encontrada' });
    }
    await client.query('DELETE FROM merch_rede_pdvs WHERE rede_id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    for (const pdvId of pdvIds) {
      await client.query(
        `INSERT INTO merch_rede_pdvs (organization_id, rede_id, pdv_id)
         SELECT $1, $2, p.id FROM pdvs p WHERE p.id=$3 AND p.organization_id=$1
         ON CONFLICT (rede_id, pdv_id) DO NOTHING`,
        [req.orgId, req.params.id, pdvId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: req.params.id, pdv_ids: pdvIds });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logError('merch.networks.update_pdvs', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/products/bulk-delete', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id) => String(id)).filter(Boolean)
      : [];

    if (!ids.length) {
      return res.status(400).json({ error: 'Nenhum produto selecionado' });
    }

    const deleted = await query(
      'DELETE FROM merch_products WHERE organization_id=$1 AND id = ANY($2::uuid[]) RETURNING id',
      [req.orgId, ids]
    );

    res.json({ ok: true, deleted: deleted.rowCount || 0 });
  } catch (e) {
    logError('bulk delete products', e);
    res.status(500).json({ error: e.message });
  }
});

// Bulk import products
router.post('/products/import', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureMerchandisingInfra();
    const orgId = req.orgId;
    const { items, auto_create } = req.body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Nenhum item enviado' });
    }

    const results = { total: items.length, success: 0, created: 0, updated: 0, errors: [] };

    // Removed explicit transaction to prevent "current transaction is aborted" errors when a single item fails.
    // Each database operation now runs in its own implicit transaction.

    const [brandRows, categoryRows, subcategoryRows, productRows] = await Promise.all([
      client.query('SELECT id, name, internal_code FROM merch_brands WHERE organization_id=$1', [orgId]),
      client.query('SELECT id, name FROM merch_categories WHERE organization_id=$1', [orgId]),
      client.query('SELECT id, category_id, name FROM merch_subcategories WHERE organization_id=$1', [orgId]),
      client.query('SELECT id, brand_id, name FROM merch_products WHERE organization_id=$1', [orgId]),
    ]);

    const brandMap = new Map(brandRows.rows.map((row) => [normalizeMerchKey(row.name), row.id]));
    const brandCodeMap = new Map();
    for (const row of brandRows.rows) {
      const normalizedCode = normalizeMerchCode(row.internal_code);
      if (normalizedCode) brandCodeMap.set(normalizedCode, row.id);
    }
    const categoryMap = new Map(categoryRows.rows.map((row) => [normalizeMerchKey(row.name), row.id]));
    const subcategoryMap = new Map(
      subcategoryRows.rows.map((row) => [`${row.category_id}:${normalizeMerchKey(row.name)}`, row.id])
    );
    const productMap = new Map(
      productRows.rows.map((row) => [`${row.brand_id}:${normalizeMerchKey(row.name)}`, row.id])
    );

    for (const [index, item] of items.entries()) {
      try {
        const name = normalizeMerchText(item.name || item.descricao || item.product_name);
        const brandCode = normalizeMerchCode(item.brand_code || item.id_familia || item.familia || item.codigo_familia || item.codigo);
        const brandName = normalizeMerchText(item.brand_name || item.brand || item.marca);
        const rawCategoryName = normalizeMerchText(item.category_name || item.category || item.categoria);
        const rawSubcategoryName = normalizeMerchText(
          item.subcategory_name || item.subcategory || item.subcategoria || rawCategoryName
        );
        const categoryName = rawCategoryName || 'Sem categoria';
        const subcategoryName = rawSubcategoryName || categoryName;
        const sku = normalizeMerchText(item.sku || item.codigo);
        const internalCode = normalizeMerchText(item.internal_code || item.codigo_interno || item.codigo);
        const barcode = normalizeMerchText(item.barcode || item.codigo_barras);
        const description = normalizeMerchText(item.description);
        const imageUrl = normalizeMerchText(item.image_url || item.imagem || item.foto);
        const unit = normalizeMerchText(item.unit || item.unidade) || 'un';
        const status = normalizeMerchText(item.status) || 'active';

        if (!name) {
          results.errors.push(buildProductImportError(item, index, 'Nome do produto não informado'));
          continue;
        }

        let brandId = item.brand_id || null;
        if (!brandId && brandCode) {
          brandId = brandCodeMap.get(brandCode) || null;
        }
        if (!brandId && brandName) {
          const brandKey = normalizeMerchKey(brandName);
          brandId = brandMap.get(brandKey) || null;
          if (!brandId && auto_create) {
            try {
              const insertedBrand = await client.query(
                'INSERT INTO merch_brands (organization_id, name) VALUES ($1,$2) RETURNING id',
                [orgId, brandName]
              );
              brandId = insertedBrand.rows[0].id;
              brandMap.set(brandKey, brandId);
            } catch (brandErr) {
              results.errors.push(buildProductImportError(item, index, `Erro ao criar marca: ${brandErr.message}`));
              continue;
            }
          }
        }
        if (!brandId) {
          const ref = brandCode || brandName || '?';
          results.errors.push(buildProductImportError(item, index, `Marca "${ref}" não encontrada`));
          continue;
        }

        let categoryId = item.category_id || null;
        if (!categoryId) {
          const categoryKey = normalizeMerchKey(categoryName);
          categoryId = categoryMap.get(categoryKey) || null;
          if (!categoryId && (auto_create || !rawCategoryName)) {
            try {
              const insertedCategory = await client.query(
                'INSERT INTO merch_categories (organization_id, name) VALUES ($1,$2) RETURNING id',
                [orgId, categoryName]
              );
              categoryId = insertedCategory.rows[0].id;
              categoryMap.set(categoryKey, categoryId);
            } catch (catErr) {
              results.errors.push(buildProductImportError(item, index, `Erro ao criar categoria: ${catErr.message}`));
              continue;
            }
          }
        }
        if (!categoryId) {
          results.errors.push(buildProductImportError(item, index, `Categoria "${categoryName}" não encontrada`));
          continue;
        }

        let subcategoryId = item.subcategory_id || null;
        if (!subcategoryId) {
          const subcategoryKey = `${categoryId}:${normalizeMerchKey(subcategoryName)}`;
          subcategoryId = subcategoryMap.get(subcategoryKey) || null;
          if (!subcategoryId && (auto_create || !rawSubcategoryName || !rawCategoryName)) {
            try {
              const insertedSubcategory = await client.query(
                'INSERT INTO merch_subcategories (organization_id, category_id, name) VALUES ($1,$2,$3) RETURNING id',
                [orgId, categoryId, subcategoryName]
              );
              subcategoryId = insertedSubcategory.rows[0].id;
              subcategoryMap.set(subcategoryKey, subcategoryId);
            } catch (subErr) {
              results.errors.push(buildProductImportError(item, index, `Erro ao criar subcategoria: ${subErr.message}`));
              continue;
            }
          }
        }
        if (!subcategoryId) {
          results.errors.push(buildProductImportError(item, index, `Subcategoria "${subcategoryName}" não encontrada`));
          continue;
        }

        const productKey = `${brandId}:${normalizeMerchKey(name)}`;
        const existingProductId = productMap.get(productKey);

        if (existingProductId && typeof existingProductId === 'string') {
          await client.query(
            `UPDATE merch_products 
             SET category_id=$1, subcategory_id=$2, sku=$3, internal_code=$4, barcode=$5, description=$6, image_url=$7, unit=$8, status=$9, updated_at=NOW()
             WHERE id=$10`,
            [categoryId, subcategoryId, sku || null, internalCode || null, barcode || null, description || null, imageUrl || null, unit, status, existingProductId]
          );
          results.updated++;
        } else {
          const insertedProduct = await client.query(
            `INSERT INTO merch_products (organization_id, brand_id, category_id, subcategory_id, name, sku, internal_code, barcode, description, image_url, unit, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING id`,
            [orgId, brandId, categoryId, subcategoryId, name, sku || null, internalCode || null, barcode || null, description || null, imageUrl || null, unit, status]
          );
          productMap.set(productKey, insertedProduct.rows[0].id);
          results.created++;
        }
        
        if (existingProductId && typeof existingProductId === 'string') productMap.set(productKey, existingProductId);
        results.success++;
      } catch (itemErr) {
        results.errors.push(buildProductImportError(item, index, itemErr.message || 'Erro desconhecido'));
        // We don't throw here, allowing other items in the chunk to continue
      }
    }

    // COMMIT not needed as we removed BEGIN
    res.json({ ...results, imported: results.success, failed: results.errors.length });
  } catch (e) {
    // ROLLBACK not needed as we removed BEGIN
    logError('import products', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ==================== BRAND PDVs (which PDVs a brand serves) ====================

// Bulk import brand <-> PDV links from a list of { brand_name, pdv_name } pairs.
// Optionally creates brands when missing (auto_create_brands=true).
router.post('/brand-pdvs/import', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { items, auto_create_brands = true } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Nenhum item enviado' });
    }

    const norm = (s) => String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim().replace(/\s+/g, ' ');

    // Pre-load brands and PDVs for the org
    const brandsRes = await query(
      `SELECT id, name FROM merch_brands WHERE organization_id=$1`, [req.orgId]
    );
    const brandsMap = new Map(brandsRes.rows.map(b => [norm(b.name), b.id]));

    const pdvsRes = await query(
      `SELECT id, name FROM pdvs WHERE organization_id=$1`, [req.orgId]
    );
    const pdvsMap = new Map();
    for (const p of pdvsRes.rows) pdvsMap.set(norm(p.name), p.id);

    let linked = 0, skipped = 0, created_brands = 0, missing_pdvs = 0, already = 0;
    const missing = [];

    for (const it of items) {
      const brandName = String(it.brand_name || it.cliente || it.brand || '').trim();
      const pdvName = String(it.pdv_name || it.pdv || '').trim();
      if (!brandName || !pdvName) { skipped++; continue; }

      let brandId = brandsMap.get(norm(brandName));
      if (!brandId) {
        if (!auto_create_brands) { skipped++; continue; }
        const ins = await query(
          `INSERT INTO merch_brands (organization_id, name, status) VALUES ($1,$2,'active') RETURNING id`,
          [req.orgId, brandName]
        );
        brandId = ins.rows[0].id;
        brandsMap.set(norm(brandName), brandId);
        created_brands++;
      }

      const pdvId = pdvsMap.get(norm(pdvName));
      if (!pdvId) {
        missing_pdvs++;
        if (missing.length < 50) missing.push({ brand: brandName, pdv: pdvName });
        continue;
      }

      const ins = await query(
        `INSERT INTO merch_pdv_brands (organization_id, pdv_id, brand_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (pdv_id, brand_id) DO UPDATE SET active=true
         RETURNING (xmax = 0) AS inserted`,
        [req.orgId, pdvId, brandId]
      );
      if (ins.rows[0]?.inserted) linked++; else already++;
    }

    res.json({ ok: true, linked, already, created_brands, missing_pdvs, skipped, missing_examples: missing });
  } catch (e) {
    logError('import brand-pdvs', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/brand-pdvs/:brandId', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const r = await query(
      `SELECT pb.*, p.id as pdv_id, p.name as pdv_name, p.client_name as network, p.address, p.city, p.state
       FROM merch_pdv_brands pb
       JOIN pdvs p ON p.id = pb.pdv_id
       WHERE pb.brand_id=$1 AND pb.organization_id=$2 AND pb.active=true
       ORDER BY p.name`,
      [req.params.brandId, req.orgId]
    );
    // REMOVED: Auto-fallback that linked all PDVs when none were explicitly linked.
    // The user now selects which PDVs to link manually.
    res.json(r.rows);
  } catch (e) {
    logError('merch.brand_pdvs', e);
    res.status(500).json({ error: e.message });
  }
});
router.get('/pdv-brands/:pdvIds', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const ids = req.params.pdvIds.split(',');
    const r = await query(
      `SELECT DISTINCT pb.brand_id, b.name as brand_name, b.logo_url, b.segment
       FROM merch_pdv_brands pb JOIN merch_brands b ON b.id = pb.brand_id
       WHERE pb.pdv_id = ANY($1::uuid[]) AND pb.organization_id=$2 ORDER BY b.name`,
      [ids, req.orgId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pdv-brands', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { pdv_id, brand_id } = req.body;
    const r = await query(
      `INSERT INTO merch_pdv_brands (organization_id, pdv_id, brand_id) VALUES ($1,$2,$3) ON CONFLICT (pdv_id, brand_id) DO UPDATE SET active=true RETURNING *`,
      [req.orgId, pdv_id, brand_id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk link ALL PDVs of a network (rede) to a brand
router.post('/pdv-brands/by-network', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { brand_id, rede_id } = req.body || {};
    if (!brand_id || !rede_id) return res.status(400).json({ error: 'brand_id e rede_id são obrigatórios' });
    const r = await query(
      `INSERT INTO merch_pdv_brands (organization_id, pdv_id, brand_id)
       SELECT $1, rp.pdv_id, $2
       FROM merch_rede_pdvs rp
       WHERE rp.rede_id = $3 AND rp.organization_id = $1
       ON CONFLICT (pdv_id, brand_id) DO UPDATE SET active=true
       RETURNING pdv_id`,
      [req.orgId, brand_id, rede_id]
    );
    res.json({ ok: true, linked: r.rowCount });
  } catch (e) { logError('bulk brand-pdv by network', e); res.status(500).json({ error: e.message }); }
});

router.delete('/pdv-brands/:id', async (req, res) => {
  try {
    await query('DELETE FROM merch_pdv_brands WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== MIX (PDV BRAND PRODUCTS) ====================

// Bulk import mix entries from spreadsheet rows: { items: [{pdv_name, brand_name, product_name, sku?, mandatory?, priority?}] }
router.post('/mix/import', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Nenhum item enviado' });
    }
    const orgId = req.orgId;
    const norm = (s) => String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim().replace(/\s+/g, ' ');

    const [brandsRes, pdvsRes, productsRes] = await Promise.all([
      query(`SELECT id, name FROM merch_brands WHERE organization_id=$1`, [orgId]),
      query(`SELECT id, name FROM pdvs WHERE organization_id=$1`, [orgId]),
      query(`SELECT id, name, sku, brand_id FROM merch_products WHERE organization_id=$1`, [orgId]),
    ]);
    const brandsMap = new Map(brandsRes.rows.map(b => [norm(b.name), b.id]));
    const pdvsMap = new Map(pdvsRes.rows.map(p => [norm(p.name), p.id]));
    const productsByBrandName = new Map();
    const productsBySku = new Map();
    for (const p of productsRes.rows) {
      productsByBrandName.set(`${p.brand_id}|${norm(p.name)}`, p.id);
      if (p.sku) productsBySku.set(`${p.brand_id}|${norm(p.sku)}`, p.id);
    }

    const linkedBrands = new Set();
    let inserted = 0, updated = 0, skipped = 0;
    const missing_pdvs = [], missing_brands = [], missing_products = [], errors = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const line = it.__line || (i + 2);
      const pdvName = String(it.pdv_name || it.pdv || '').trim();
      const brandName = String(it.brand_name || it.marca || it.cliente || '').trim();
      const productName = String(it.product_name || it.produto || it.name || '').trim();
      const sku = String(it.sku || '').trim();
      const mandatory = ['1','true','sim','obrigatorio','obrigatório','yes'].includes(String(it.mandatory || '').toLowerCase());
      const priority = ['alta','media','média','baixa'].includes(String(it.priority || '').toLowerCase())
        ? String(it.priority).toLowerCase().replace('média','media') : 'media';

      if (!pdvName || !brandName || !productName) { skipped++; continue; }

      const pdvId = pdvsMap.get(norm(pdvName));
      if (!pdvId) {
        if (missing_pdvs.length < 100) missing_pdvs.push({ line, pdv: pdvName });
        continue;
      }
      const brandId = brandsMap.get(norm(brandName));
      if (!brandId) {
        if (missing_brands.length < 100) missing_brands.push({ line, brand: brandName });
        continue;
      }
      let productId = (sku && productsBySku.get(`${brandId}|${norm(sku)}`)) || productsByBrandName.get(`${brandId}|${norm(productName)}`);
      if (!productId) {
        if (missing_products.length < 200) missing_products.push({ line, brand: brandName, product: productName });
        continue;
      }

      try {
        // Ensure pdv-brand link exists (only once per pair)
        const pairKey = `${pdvId}|${brandId}`;
        if (!linkedBrands.has(pairKey)) {
          await query(
            `INSERT INTO merch_pdv_brands (organization_id, pdv_id, brand_id) VALUES ($1,$2,$3)
             ON CONFLICT (pdv_id, brand_id) DO UPDATE SET active=true`,
            [orgId, pdvId, brandId]
          );
          linkedBrands.add(pairKey);
        }

        const r = await query(
          `INSERT INTO merch_pdv_brand_products (organization_id, pdv_id, brand_id, product_id, mandatory, priority)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (pdv_id, brand_id, product_id)
           DO UPDATE SET active=true, mandatory=EXCLUDED.mandatory, priority=EXCLUDED.priority, updated_at=NOW()
           RETURNING (xmax = 0) AS inserted`,
          [orgId, pdvId, brandId, productId, mandatory, priority]
        );
        if (r.rows[0]?.inserted) inserted++; else updated++;
      } catch (err) {
        if (errors.length < 100) errors.push({ line, product: productName, error: err.message });
      }
    }

    res.json({
      ok: true,
      total: items.length,
      inserted,
      updated,
      skipped,
      missing_pdvs,
      missing_brands,
      missing_products,
      errors,
    });
  } catch (e) {
    logError('import mix', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/mix/:pdvId/:brandId', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const r = await query(
      `SELECT pbp.*, p.name as product_name, p.sku, p.barcode, p.image_url, p.unit,
              c.name as category_name, sc.name as subcategory_name
       FROM merch_pdv_brand_products pbp
        JOIN merch_products p ON p.id = pbp.product_id
        LEFT JOIN merch_categories c ON c.id = p.category_id
        LEFT JOIN merch_subcategories sc ON sc.id = p.subcategory_id
       WHERE pbp.pdv_id=$1 AND pbp.brand_id=$2 AND pbp.organization_id=$3
       ORDER BY p.name`,
      [req.params.pdvId, req.params.brandId, req.orgId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mix/clear-by-brand', async (req, res) => {
  try {
    const { brand_id } = req.body;
    if (!brand_id) return res.status(400).json({ error: 'Marca não informada' });
    const r = await query(
      'DELETE FROM merch_pdv_brand_products WHERE brand_id = $1 AND organization_id = $2',
      [brand_id, req.orgId]
    );
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) { logError('clear mix by brand', e); res.status(500).json({ error: e.message }); }
});

router.post('/mix', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { pdv_id, brand_id, product_ids, mandatory, priority } = req.body;
    const orgId = req.orgId;
    const inserted = [];
    for (const pid of product_ids) {
      const r = await query(
        `INSERT INTO merch_pdv_brand_products (organization_id, pdv_id, brand_id, product_id, mandatory, priority)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (pdv_id, brand_id, product_id) DO UPDATE SET active=true, updated_at=NOW() RETURNING *`,
        [orgId, pdv_id, brand_id, pid, mandatory || false, priority || 'media']
      );
      inserted.push(r.rows[0]);
    }
    res.json(inserted);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/mix/:id', async (req, res) => {
  try {
    const { active, mandatory, priority, notes } = req.body;
    const r = await query(
      `UPDATE merch_pdv_brand_products SET active=$1, mandatory=$2, priority=$3, notes=$4, updated_at=NOW() WHERE id=$5 AND organization_id=$6 RETURNING *`,
      [active, mandatory, priority, notes, req.params.id, req.orgId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/mix', async (req, res) => {
  try {
    const { pdv_id, brand_id, product_ids } = req.body;
    for (const pid of product_ids) {
      await query('DELETE FROM merch_pdv_brand_products WHERE pdv_id=$1 AND brand_id=$2 AND product_id=$3 AND organization_id=$4',
        [pdv_id, brand_id, pid, req.orgId]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mix/bulk', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const { network_id, pdv_ids, brand_id, product_ids, mandatory, priority } = req.body;
    const orgId = req.orgId;
    
    let targetPdvIds = pdv_ids || [];
    
    if (network_id) {
      const netPdvs = await query(
        'SELECT pdv_id FROM merch_rede_pdvs WHERE rede_id = $1 AND organization_id = $2',
        [network_id, orgId]
      );
      targetPdvIds = [...new Set([...targetPdvIds, ...netPdvs.rows.map(r => r.pdv_id)])];
    }
    
    if (targetPdvIds.length === 0) {
      return res.status(400).json({ error: 'Nenhum PDV selecionado para o mix bulk' });
    }
    
    let totalLinked = 0;
    
    for (const pdvId of targetPdvIds) {
      // Garante vínculo PDV-Marca
      await query(
        `INSERT INTO merch_pdv_brands (organization_id, pdv_id, brand_id) 
         VALUES ($1,$2,$3) 
         ON CONFLICT (pdv_id, brand_id) DO UPDATE SET active=true`,
        [orgId, pdvId, brand_id]
      );
      
      for (const pid of product_ids) {
        await query(
          `INSERT INTO merch_pdv_brand_products (organization_id, pdv_id, brand_id, product_id, mandatory, priority)
           VALUES ($1,$2,$3,$4,$5,$6) 
           ON CONFLICT (pdv_id, brand_id, product_id) 
           DO UPDATE SET active=true, updated_at=NOW()`,
          [orgId, pdvId, brand_id, pid, mandatory || false, priority || 'media']
        );
        totalLinked++;
      }
    }
    
    res.json({ ok: true, total: totalLinked, pdvs_count: targetPdvIds.length });
  } catch (e) { 
    logError('bulk mix', e);
    res.status(500).json({ error: e.message }); 
  }
});


// ==================== REPORTS ====================
router.get('/reports/brand/:brandId', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const orgId = req.orgId;
    const r = await query(
      `SELECT pb.pdv_id, pb.pdv_id as pdv_name,
              COUNT(pbp.id) as product_count
       FROM merch_pdv_brands pb
       LEFT JOIN merch_pdv_brand_products pbp ON pbp.pdv_id = pb.pdv_id AND pbp.brand_id = pb.brand_id AND pbp.active=true
       WHERE pb.brand_id=$1 AND pb.organization_id=$2 AND pb.active=true
       GROUP BY pb.pdv_id ORDER BY pb.pdv_id`,
      [req.params.brandId, orgId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reports/pdv/:pdvId', async (req, res) => {
  try {
    await ensureMerchandisingInfra();
    const orgId = req.orgId;
    const brands = await query(
      `SELECT b.id, b.name, b.logo_url, COUNT(pbp.id) as product_count
       FROM merch_pdv_brands pb JOIN merch_brands b ON b.id = pb.brand_id
       LEFT JOIN merch_pdv_brand_products pbp ON pbp.pdv_id=pb.pdv_id AND pbp.brand_id=pb.brand_id AND pbp.active=true
       WHERE pb.pdv_id=$1 AND pb.organization_id=$2 AND pb.active=true
       GROUP BY b.id, b.name, b.logo_url ORDER BY b.name`,
      [req.params.pdvId, orgId]
    );
    res.json(brands.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== BRAND CONTRACTS ====================

async function ensureContractInfra() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS merch_brand_contracts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      brand_id UUID NOT NULL REFERENCES merch_brands(id) ON DELETE CASCADE,
      deal_id UUID,
      title VARCHAR(255) NOT NULL,
      status VARCHAR(20) DEFAULT 'draft',
      start_date DATE,
      end_date DATE,
      auto_renew BOOLEAN DEFAULT false,
      hours_per_visit NUMERIC(5,2),
      visits_per_week INTEGER,
      total_monthly_hours NUMERIC(7,2),
      pdv_ids UUID[] DEFAULT '{}',
      contract_value NUMERIC(12,2),
      payment_terms VARCHAR(100),
      clauses JSONB DEFAULT '[]',
      letterhead_url TEXT,
      header_logo_url TEXT,
      footer_text TEXT,
      signed_document_url TEXT,
      signed_at TIMESTAMPTZ,
      signature_document_id UUID,
      compliance_score NUMERIC(5,2),
      last_compliance_check TIMESTAMPTZ,
      notes TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS merch_contract_compliance (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id UUID NOT NULL REFERENCES merch_brand_contracts(id) ON DELETE CASCADE,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      expected_visits INTEGER,
      actual_visits INTEGER,
      expected_hours NUMERIC(7,2),
      actual_hours NUMERIC(7,2),
      compliance_pct NUMERIC(5,2),
      status VARCHAR(20) DEFAULT 'ok',
      details JSONB,
      notified BOOLEAN DEFAULT false,
      notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS merch_org_letterhead (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL UNIQUE,
      logo_url TEXT,
      header_text TEXT,
      footer_text TEXT,
      background_url TEXT,
      primary_color VARCHAR(20),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_brand_contracts_brand ON merch_brand_contracts(brand_id)`,
    `CREATE INDEX IF NOT EXISTS idx_brand_contracts_org ON merch_brand_contracts(organization_id)`,
    `CREATE INDEX IF NOT EXISTS idx_contract_compliance_contract ON merch_contract_compliance(contract_id)`,
  ];
  for (const sql of stmts) {
    try { await query(sql); } catch (e) { /* ignore if exists */ }
  }
}

// List contracts for a brand
router.get('/contracts/brand/:brandId', async (req, res) => {
  try {
    await ensureContractInfra();
    const r = await query(
      'SELECT * FROM merch_brand_contracts WHERE brand_id=$1 AND organization_id=$2 ORDER BY created_at DESC',
      [req.params.brandId, req.orgId]
    );
    res.json(r.rows);
  } catch (e) { logError('get contracts', e); res.status(500).json({ error: e.message }); }
});

// Get single contract
router.get('/contracts/:id', async (req, res) => {
  try {
    await ensureContractInfra();
    const r = await query('SELECT * FROM merch_brand_contracts WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Contrato não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create contract
router.post('/contracts', async (req, res) => {
  try {
    await ensureContractInfra();
    const { brand_id, deal_id, title, status, start_date, end_date, auto_renew,
      hours_per_visit, visits_per_week, total_monthly_hours, pdv_ids,
      contract_value, payment_terms, clauses, letterhead_url, header_logo_url, footer_text, notes } = req.body;
    const r = await query(
      `INSERT INTO merch_brand_contracts (organization_id, brand_id, deal_id, title, status, start_date, end_date,
        auto_renew, hours_per_visit, visits_per_week, total_monthly_hours, pdv_ids,
        contract_value, payment_terms, clauses, letterhead_url, header_logo_url, footer_text, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [req.orgId, brand_id, deal_id || null, title, status || 'draft', start_date, end_date,
        auto_renew || false, hours_per_visit, visits_per_week, total_monthly_hours, pdv_ids || [],
        contract_value, payment_terms, JSON.stringify(clauses || []), letterhead_url, header_logo_url, footer_text, notes, req.userId]
    );
    res.json(r.rows[0]);
  } catch (e) { logError('create contract', e); res.status(500).json({ error: e.message }); }
});

// Update contract
router.put('/contracts/:id', async (req, res) => {
  try {
    const { title, status, start_date, end_date, auto_renew, hours_per_visit, visits_per_week,
      total_monthly_hours, pdv_ids, contract_value, payment_terms, clauses,
      letterhead_url, header_logo_url, footer_text, notes,
      signed_document_url, signed_at, signature_document_id } = req.body;
    const r = await query(
      `UPDATE merch_brand_contracts SET title=$1, status=$2, start_date=$3, end_date=$4, auto_renew=$5,
        hours_per_visit=$6, visits_per_week=$7, total_monthly_hours=$8, pdv_ids=$9,
        contract_value=$10, payment_terms=$11, clauses=$12, letterhead_url=$13, header_logo_url=$14,
        footer_text=$15, notes=$16, signed_document_url=COALESCE($17, signed_document_url),
        signed_at=COALESCE($18, signed_at), signature_document_id=COALESCE($19, signature_document_id),
        updated_at=NOW()
       WHERE id=$20 AND organization_id=$21 RETURNING *`,
      [title, status, start_date, end_date, auto_renew, hours_per_visit, visits_per_week,
        total_monthly_hours, pdv_ids || [], contract_value, payment_terms, JSON.stringify(clauses || []),
        letterhead_url, header_logo_url, footer_text, notes,
        signed_document_url || null, signed_at || null, signature_document_id || null,
        req.params.id, req.orgId]
    );
    res.json(r.rows[0]);
  } catch (e) { logError('update contract', e); res.status(500).json({ error: e.message }); }
});

// Delete contract
router.delete('/contracts/:id', async (req, res) => {
  try {
    await query('DELETE FROM merch_brand_contracts WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compliance history for a contract
router.get('/contracts/:id/compliance', async (req, res) => {
  try {
    await ensureContractInfra();
    const r = await query(
      'SELECT * FROM merch_contract_compliance WHERE contract_id=$1 ORDER BY period_start DESC LIMIT 52',
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Run compliance check for a contract
router.post('/contracts/:id/check-compliance', async (req, res) => {
  try {
    await ensureContractInfra();
    const contract = (await query('SELECT * FROM merch_brand_contracts WHERE id=$1 AND organization_id=$2', [req.params.id, req.orgId])).rows[0];
    if (!contract) return res.status(404).json({ error: 'Contrato não encontrado' });

    const { period_start, period_end } = req.body;
    if (!period_start || !period_end) return res.status(400).json({ error: 'Período obrigatório' });

    // Count actual visits from merch_routes in the period for this brand's PDVs
    const routeResult = await query(
      `SELECT COUNT(DISTINCT r.id) as visit_count,
              COALESCE(SUM(EXTRACT(EPOCH FROM (r.checkout_at - r.checkin_at)) / 3600), 0) as total_hours
       FROM merch_routes r
       WHERE r.brand_id = $1
         AND r.organization_id = $2
         AND r.status IN ('completed', 'in_progress')
         AND r.scheduled_date >= $3
         AND r.scheduled_date <= $4
         AND ($5::uuid[] IS NULL OR array_length($5::uuid[], 1) IS NULL OR r.pdv_id = ANY($5::uuid[]))`,
      [contract.brand_id, req.orgId, period_start, period_end, contract.pdv_ids]
    );

    const actual_visits = parseInt(routeResult.rows[0]?.visit_count || '0');
    const actual_hours = parseFloat(routeResult.rows[0]?.total_hours || '0');

    // Calculate expected
    const days = Math.ceil((new Date(period_end) - new Date(period_start)) / (1000 * 60 * 60 * 24));
    const weeks = days / 7;
    const expected_visits = Math.round((contract.visits_per_week || 0) * weeks * (contract.pdv_ids?.length || 1));
    const expected_hours = parseFloat(contract.total_monthly_hours || 0) * (days / 30);

    const compliance_pct = expected_visits > 0 ? Math.min(100, (actual_visits / expected_visits) * 100) : 100;
    const compStatus = compliance_pct >= 90 ? 'ok' : compliance_pct >= 70 ? 'warning' : 'breach';

    // Upsert compliance record
    const comp = await query(
      `INSERT INTO merch_contract_compliance (contract_id, period_start, period_end, expected_visits, actual_visits, expected_hours, actual_hours, compliance_pct, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING RETURNING *`,
      [contract.id, period_start, period_end, expected_visits, actual_visits, expected_hours, actual_hours, compliance_pct, compStatus]
    );

    // Update contract compliance score
    await query('UPDATE merch_brand_contracts SET compliance_score=$1, last_compliance_check=NOW() WHERE id=$2',
      [compliance_pct, contract.id]);

    res.json({
      compliance_pct, status: compStatus,
      expected_visits, actual_visits, expected_hours, actual_hours,
      record: comp.rows[0] || null
    });
  } catch (e) { logError('check compliance', e); res.status(500).json({ error: e.message }); }
});

// Organization letterhead
router.get('/letterhead', async (req, res) => {
  try {
    await ensureContractInfra();
    const r = await query('SELECT * FROM merch_org_letterhead WHERE organization_id=$1', [req.orgId]);
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/letterhead', async (req, res) => {
  try {
    await ensureContractInfra();
    const { logo_url, header_text, footer_text, background_url, primary_color } = req.body;
    const r = await query(
      `INSERT INTO merch_org_letterhead (organization_id, logo_url, header_text, footer_text, background_url, primary_color)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id) DO UPDATE SET logo_url=$2, header_text=$3, footer_text=$4, background_url=$5, primary_color=$6, updated_at=NOW()
       RETURNING *`,
      [req.orgId, logo_url, header_text, footer_text, background_url, primary_color]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Convert CRM deal to brand contract
router.post('/contracts/from-deal', async (req, res) => {
  try {
    await ensureContractInfra();
    await ensureMerchandisingInfra();
    const { deal_id, brand_id, create_brand, brand_data, contract_data } = req.body;

    let finalBrandId = brand_id;

    // Create new brand if requested
    if (create_brand && brand_data) {
      const br = await query(
        `INSERT INTO merch_brands (organization_id, name, razao_social, cnpj, logo_url, description, segment, responsible, phone, email, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') RETURNING *`,
        [req.orgId, brand_data.name, brand_data.razao_social, brand_data.cnpj, brand_data.logo_url,
         brand_data.description, brand_data.segment, brand_data.responsible, brand_data.phone, brand_data.email]
      );
      finalBrandId = br.rows[0].id;
    }

    if (!finalBrandId) return res.status(400).json({ error: 'brand_id ou brand_data obrigatório' });

    // Create contract
    const cd = contract_data || {};
    const r = await query(
      `INSERT INTO merch_brand_contracts (organization_id, brand_id, deal_id, title, status, start_date, end_date,
        hours_per_visit, visits_per_week, total_monthly_hours, pdv_ids, contract_value, payment_terms, clauses, notes, created_by)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.orgId, finalBrandId, deal_id, cd.title || 'Contrato ' + (brand_data?.name || ''),
        cd.start_date, cd.end_date, cd.hours_per_visit, cd.visits_per_week, cd.total_monthly_hours,
        cd.pdv_ids || [], cd.contract_value, cd.payment_terms, JSON.stringify(cd.clauses || []), cd.notes, req.userId]
    );

    res.json({ brand_id: finalBrandId, contract: r.rows[0] });
  } catch (e) { logError('contract from deal', e); res.status(500).json({ error: e.message }); }
});

export default router;
