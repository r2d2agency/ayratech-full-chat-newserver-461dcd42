import express from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { logInfo, logError } from '../logger.js';

const router = express.Router();
router.use(authenticate);

// ── Self-healing: ensure new company columns exist ──
(async () => {
  const cols = [
    { name: 'razao_social', type: 'VARCHAR(255)' },
    { name: 'nome_fantasia', type: 'VARCHAR(255)' },
    { name: 'inscricao_estadual', type: 'VARCHAR(30)' },
    { name: 'inscricao_municipal', type: 'VARCHAR(30)' },
    { name: 'porte', type: 'VARCHAR(50)' },
    { name: 'cnae', type: 'VARCHAR(255)' },
    { name: 'more_info', type: 'TEXT' },
  ];
  for (const col of cols) {
    try {
      await query(`ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
    } catch (e) {
      // ignore if table doesn't exist yet or column already exists
    }
  }
  logInfo('[CRM] Self-healing company columns check complete');

  // Self-healing: funnel connection_id
  try {
    const hasFunnels = await query(`SELECT to_regclass('public.crm_funnels') IS NOT NULL AS exists`);
    if (hasFunnels.rows[0]?.exists) {
      await query(`ALTER TABLE crm_funnels ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES connections(id) ON DELETE SET NULL`);
    }
  } catch(e) {}

  // Self-healing: automation schedule columns
  try {
    const hasAutomations = await query(`SELECT to_regclass('public.crm_stage_automations') IS NOT NULL AS exists`);
    if (hasAutomations.rows[0]?.exists) {
      const autoCols = [
        { name: 'schedule_days', type: "JSONB DEFAULT '[1,2,3,4,5]'" },
        { name: 'schedule_start_time', type: "VARCHAR(5) DEFAULT '08:00'" },
        { name: 'schedule_end_time', type: "VARCHAR(5) DEFAULT '18:00'" },
      ];
      for (const col of autoCols) {
        await query(`ALTER TABLE crm_stage_automations ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
      }
    }
  } catch(e) {}
  logInfo('[CRM] Self-healing funnel/automation columns check complete');
})();

// Some CRM/Intelligence tables/columns may not exist yet during partial deployments.
// Avoid 500s on dashboards by returning safe empty payloads when schema is missing.
function isMissingSchemaError(error) {
  return ['42P01', '42703'].includes(error?.code);
}

function closedAtSql(alias = 'd') {
  return `COALESCE(${alias}.won_at, ${alias}.lost_at)`;
}

// Helper: Get user's organization
async function getUserOrg(userId) {
  const result = await query(
    `SELECT om.organization_id, om.role 
     FROM organization_members om 
     WHERE om.user_id = $1 
     LIMIT 1`,
    [userId]
  );
  return result.rows[0];
}

// Helper: Deals currently require company_id (DB constraint). When UI treats company as optional,
// we create/reuse a single default company per organization.
async function ensureDefaultCompanyId(organizationId, createdByUserId) {
  const existing = await query(
    `SELECT id FROM crm_companies
     WHERE organization_id = $1 AND name = 'Sem empresa'
     ORDER BY created_at ASC
     LIMIT 1`,
    [organizationId]
  );

  if (existing.rows[0]?.id) return existing.rows[0].id;

  const created = await query(
    `INSERT INTO crm_companies (organization_id, name, created_by)
     VALUES ($1, 'Sem empresa', $2)
     RETURNING id`,
    [organizationId, createdByUserId]
  );
  return created.rows[0].id;
}

// Helper: Check if user can manage CRM (admin/owner/manager)
function canManage(role) {
  return ['owner', 'admin', 'manager'].includes(role);
}

// Helper: Get user's group IDs (for supervisor visibility)
async function getUserGroupIds(userId) {
  const result = await query(
    `SELECT group_id, is_supervisor FROM crm_user_group_members WHERE user_id = $1`,
    [userId]
  );
  return result.rows;
}

// ============================================
// USER GROUPS
// ============================================

// Get current user's groups
router.get('/groups/me', async (req, res) => {
  try {
    const result = await query(
      `SELECT g.id, g.name, g.description, m.is_supervisor
       FROM crm_user_group_members m
       JOIN crm_user_groups g ON g.id = m.group_id
       WHERE m.user_id = $1
       ORDER BY g.name`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching my groups:', error);
    res.status(500).json({ error: error.message });
  }
});

// List groups
router.get('/groups', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT g.*, 
        (SELECT COUNT(*) FROM crm_user_group_members WHERE group_id = g.id) as member_count
       FROM crm_user_groups g 
       WHERE g.organization_id = $1 
       ORDER BY g.name`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create group
router.post('/groups', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { name, description } = req.body;
    const result = await query(
      `INSERT INTO crm_user_groups (organization_id, name, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [org.organization_id, name, description]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update group
router.put('/groups/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { name, description } = req.body;
    const result = await query(
      `UPDATE crm_user_groups SET name = $1, description = $2, updated_at = NOW()
       WHERE id = $3 AND organization_id = $4 RETURNING *`,
      [name, description, req.params.id, org.organization_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete group
router.delete('/groups/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    await query(
      `DELETE FROM crm_user_groups WHERE id = $1 AND organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get group members
router.get('/groups/:id/members', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT gm.*, u.name, u.email 
       FROM crm_user_group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching group members:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add member to group
router.post('/groups/:id/members', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { user_id, is_supervisor } = req.body;
    const result = await query(
      `INSERT INTO crm_user_group_members (group_id, user_id, is_supervisor)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET is_supervisor = $3
       RETURNING *`,
      [req.params.id, user_id, is_supervisor || false]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error adding group member:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove member from group
router.delete('/groups/:groupId/members/:userId', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    await query(
      `DELETE FROM crm_user_group_members WHERE group_id = $1 AND user_id = $2`,
      [req.params.groupId, req.params.userId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing group member:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GROUP FUNNELS (link groups to specific funnels)
// ============================================

// Get funnels assigned to a group
router.get('/groups/:id/funnels', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT gf.funnel_id, f.name, f.color
       FROM crm_group_funnels gf
       JOIN crm_funnels f ON f.id = gf.funnel_id
       WHERE gf.group_id = $1
       ORDER BY f.name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    if (isMissingSchemaError(error)) return res.json([]);
    console.error('Error fetching group funnels:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set funnels for a group (replace all)
router.put('/groups/:id/funnels', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { funnel_ids } = req.body;
    
    // Delete existing
    await query(`DELETE FROM crm_group_funnels WHERE group_id = $1`, [req.params.id]);
    
    // Insert new
    if (funnel_ids && funnel_ids.length > 0) {
      const values = funnel_ids.map((fid, i) => `($1, $${i + 2})`).join(', ');
      await query(
        `INSERT INTO crm_group_funnels (group_id, funnel_id) VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [req.params.id, ...funnel_ids]
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    if (isMissingSchemaError(error)) return res.json({ success: true });
    console.error('Error setting group funnels:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FUNNELS
// ============================================

// List funnels (filtered by user's group access if not admin)
router.get('/funnels', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    // Check if user is a designer (projetista) — they see all funnels
    let isDesignerUser = false;
    try {
      const designerCheck = await query(
        `SELECT 1 FROM crm_user_group_members gm
         JOIN crm_user_groups g ON g.id = gm.group_id
         WHERE gm.user_id = $1 AND g.organization_id = $2 AND LOWER(g.name) LIKE '%projeto%'
         LIMIT 1`,
        [req.userId, org.organization_id]
      );
      isDesignerUser = designerCheck.rows.length > 0;
    } catch (_) {}

    // Admins/owners/managers/designers see all funnels
    if (canManage(org.role) || isDesignerUser) {
      const result = await query(
        `SELECT f.*, 
          (SELECT COUNT(*) FROM crm_deals WHERE funnel_id = f.id AND status = 'open') as open_deals,
          (SELECT COALESCE(SUM(value), 0) FROM crm_deals WHERE funnel_id = f.id AND status = 'open') as total_value
         FROM crm_funnels f 
         WHERE f.organization_id = $1 AND f.is_active = true
         ORDER BY f.name`,
        [org.organization_id]
      );
      return res.json(result.rows);
    }

    // Regular users: check if crm_group_funnels table exists and filter
    try {
      const groupFunnels = await query(
        `SELECT DISTINCT gf.funnel_id 
         FROM crm_group_funnels gf
         JOIN crm_user_group_members gm ON gm.group_id = gf.group_id
         WHERE gm.user_id = $1`,
        [req.userId]
      );
      
      // If user has group funnel restrictions, filter
      if (groupFunnels.rows.length > 0) {
        const funnelIds = groupFunnels.rows.map(r => r.funnel_id);
        const placeholders = funnelIds.map((_, i) => `$${i + 2}`).join(', ');
        const result = await query(
          `SELECT f.*, 
            (SELECT COUNT(*) FROM crm_deals WHERE funnel_id = f.id AND status = 'open') as open_deals,
            (SELECT COALESCE(SUM(value), 0) FROM crm_deals WHERE funnel_id = f.id AND status = 'open') as total_value
           FROM crm_funnels f 
           WHERE f.organization_id = $1 AND f.is_active = true AND f.id IN (${placeholders})
           ORDER BY f.name`,
          [org.organization_id, ...funnelIds]
        );
        return res.json(result.rows);
      }
    } catch (e) {
      // crm_group_funnels table might not exist yet, fall through to show all
    }

    // No group restrictions or table doesn't exist: show all
    const result = await query(
      `SELECT f.*, 
        (SELECT COUNT(*) FROM crm_deals WHERE funnel_id = f.id AND status = 'open') as open_deals,
        (SELECT COALESCE(SUM(value), 0) FROM crm_deals WHERE funnel_id = f.id AND status = 'open') as total_value
       FROM crm_funnels f 
       WHERE f.organization_id = $1 AND f.is_active = true
       ORDER BY f.name`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching funnels:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get funnel with stages
router.get('/funnels/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const funnel = await query(
      `SELECT * FROM crm_funnels WHERE id = $1 AND organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    if (!funnel.rows[0]) return res.status(404).json({ error: 'Funnel not found' });

    const stages = await query(
      `SELECT * FROM crm_stages WHERE funnel_id = $1 ORDER BY position`,
      [req.params.id]
    );

    res.json({ ...funnel.rows[0], stages: stages.rows });
  } catch (error) {
    console.error('Error fetching funnel:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create funnel
router.post('/funnels', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { name, description, color, stages, connection_id } = req.body;
    
    // Create funnel
    const funnelResult = await query(
      `INSERT INTO crm_funnels (organization_id, name, description, color, connection_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [org.organization_id, name, description, color || '#6366f1', connection_id || null]
    );
    const funnel = funnelResult.rows[0];

    // Create stages
    if (stages && stages.length > 0) {
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        await query(
          `INSERT INTO crm_stages (funnel_id, name, color, position, inactivity_hours, inactivity_color, is_final)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [funnel.id, stage.name, stage.color || '#6366f1', i, 
           stage.inactivity_hours || 24, stage.inactivity_color || '#ef4444', stage.is_final || false]
        );
      }
    }

    res.json(funnel);
  } catch (error) {
    console.error('Error creating funnel:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update funnel
router.put('/funnels/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { name, description, color, is_active, stages, connection_id } = req.body;
    
    await query(
      `UPDATE crm_funnels SET name = $1, description = $2, color = $3, is_active = $4, connection_id = $5, updated_at = NOW()
       WHERE id = $6 AND organization_id = $7`,
      [name, description, color, is_active !== false, connection_id || null, req.params.id, org.organization_id]
    );

    // Update stages if provided
    if (stages) {
      // Get existing stages
      const existingStages = await query(
        `SELECT id FROM crm_stages WHERE funnel_id = $1`,
        [req.params.id]
      );
      const existingIds = existingStages.rows.map(s => s.id);
      const newIds = stages.filter(s => s.id).map(s => s.id);
      
      // Delete removed stages
      const toDelete = existingIds.filter(id => !newIds.includes(id));
      if (toDelete.length > 0) {
        await query(`DELETE FROM crm_stages WHERE id = ANY($1)`, [toDelete]);
      }

      // Update or insert stages
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        if (stage.id) {
          await query(
            `UPDATE crm_stages SET name = $1, color = $2, position = $3, 
             inactivity_hours = $4, inactivity_color = $5, is_final = $6, updated_at = NOW()
             WHERE id = $7`,
            [stage.name, stage.color, i, stage.inactivity_hours || 24, 
             stage.inactivity_color || '#ef4444', stage.is_final || false, stage.id]
          );
        } else {
          await query(
            `INSERT INTO crm_stages (funnel_id, name, color, position, inactivity_hours, inactivity_color, is_final)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [req.params.id, stage.name, stage.color || '#6366f1', i,
             stage.inactivity_hours || 24, stage.inactivity_color || '#ef4444', stage.is_final || false]
          );
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating funnel:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete funnel
router.delete('/funnels/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    await query(
      `DELETE FROM crm_funnels WHERE id = $1 AND organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting funnel:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// COMPANIES
// ============================================

// List companies
router.get('/companies', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { search } = req.query;
    let sql = `SELECT c.*, u.name as created_by_name,
      s.name as segment_name, s.color as segment_color,
      ow.name as owner_name, g.name as group_name,
      (SELECT COUNT(*) FROM crm_deals WHERE company_id = c.id) as deals_count
      FROM crm_companies c
      LEFT JOIN users u ON u.id = c.created_by
      LEFT JOIN users ow ON ow.id = c.owner_id
      LEFT JOIN crm_user_groups g ON g.id = c.group_id
      LEFT JOIN crm_segments s ON s.id = c.segment_id
      WHERE c.organization_id = $1`;
    const params = [org.organization_id];

    if (search) {
      sql += ` AND (c.name ILIKE $2 OR c.cnpj ILIKE $2 OR c.email ILIKE $2)`;
      params.push(`%${search}%`);
    }

    sql += ` ORDER BY c.name`;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get company
router.get('/companies/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT c.*, u.name as created_by_name
       FROM crm_companies c
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.id = $1 AND c.organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Company not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching company:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create company
router.post('/companies', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { name, razao_social, nome_fantasia, cnpj, inscricao_estadual, inscricao_municipal, porte, cnae, email, phone, website, address, city, state, zip_code, notes, more_info, segment_id, custom_fields, owner_id, group_id } = req.body;
    
    const result = await query(
      `INSERT INTO crm_companies (organization_id, name, razao_social, nome_fantasia, cnpj, inscricao_estadual, inscricao_municipal, porte, cnae, email, phone, website, address, city, state, zip_code, notes, more_info, segment_id, custom_fields, owner_id, group_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
      [org.organization_id, name, razao_social || null, nome_fantasia || null, cnpj, inscricao_estadual || null, inscricao_municipal || null, porte || null, cnae || null, email, phone, website, address, city, state, zip_code, notes, more_info || null, segment_id || null,
       custom_fields ? JSON.stringify(custom_fields) : '{}', owner_id || null, group_id || null, req.userId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update company
router.put('/companies/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { name, razao_social, nome_fantasia, cnpj, inscricao_estadual, inscricao_municipal, porte, cnae, email, phone, website, address, city, state, zip_code, notes, more_info, segment_id, custom_fields, owner_id, group_id } = req.body;
    
    const result = await query(
      `UPDATE crm_companies SET 
        name = $1, razao_social = $2, nome_fantasia = $3, cnpj = $4, inscricao_estadual = $5, inscricao_municipal = $6,
        porte = $7, cnae = $8, email = $9, phone = $10, website = $11, 
        address = $12, city = $13, state = $14, zip_code = $15, notes = $16, more_info = $17,
        segment_id = $18, custom_fields = $19, owner_id = $20, group_id = $21, updated_at = NOW()
       WHERE id = $22 AND organization_id = $23 RETURNING *`,
      [name, razao_social || null, nome_fantasia || null, cnpj, inscricao_estadual || null, inscricao_municipal || null,
       porte || null, cnae || null, email, phone, website, address, city, state, zip_code, notes, more_info || null, segment_id || null,
       custom_fields ? JSON.stringify(custom_fields) : '{}', owner_id || null, group_id || null, req.params.id, org.organization_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating company:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete company
router.delete('/companies/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    await query(
      `DELETE FROM crm_companies WHERE id = $1 AND organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import companies (bulk)
router.post('/companies/import', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { companies } = req.body;
    if (!companies || !Array.isArray(companies)) {
      return res.status(400).json({ error: 'Invalid companies data' });
    }

    let imported = 0;
    for (const company of companies) {
      try {
        await query(
          `INSERT INTO crm_companies (organization_id, name, cnpj, email, phone, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [org.organization_id, company.name, company.cnpj, company.email, company.phone, req.userId]
        );
        imported++;
      } catch (e) {
        console.error('Error importing company:', e);
      }
    }

    res.json({ success: true, imported });
  } catch (error) {
    console.error('Error importing companies:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DEALS
// ============================================

// Search deals (for linking)
router.get('/deals', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { search } = req.query;
    if (!search || search.length < 2) {
      return res.json([]);
    }

    const userGroups = await getUserGroupIds(req.userId);
    const supervisorGroupIds = userGroups.filter(g => g.is_supervisor).map(g => g.group_id);

    // Build visibility filter based on role
    let visibilityFilter = '';
    const params = [org.organization_id, `%${search}%`];
    
    if (canManage(org.role)) {
      visibilityFilter = '';
    } else if (supervisorGroupIds.length > 0) {
      visibilityFilter = ` AND (d.owner_id = $3 OR d.group_id = ANY($4))`;
      params.push(req.userId, supervisorGroupIds);
    } else {
      visibilityFilter = ` AND d.owner_id = $3`;
      params.push(req.userId);
    }

    const result = await query(
      `SELECT d.*, 
        c.name as company_name,
        u.name as owner_name,
        s.name as stage_name,
        s.color as stage_color
       FROM crm_deals d
       LEFT JOIN crm_companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN crm_stages s ON s.id = d.stage_id
       WHERE d.organization_id = $1 
         AND (d.title ILIKE $2 OR c.name ILIKE $2)
         ${visibilityFilter}
       ORDER BY d.updated_at DESC
       LIMIT 20`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error searching deals:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get deals by contact phone number (for chat integration)
router.get('/deals/by-phone/:phone', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const phone = req.params.phone.replace(/\D/g, '');
    if (!phone || phone.length < 8) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    // Use last 11 digits for matching (handles country code variations)
    const phonePattern = `%${phone.slice(-11)}%`;

     // Search in both contacts table (CRM contacts) AND chat_contacts table
     // Normalize stored phone values to digits-only so we can match regardless of formatting
    // NOTE: This JOIN can duplicate deals (multiple contacts), so we dedupe by deal id.
    // We use DISTINCT ON to keep PostgreSQL happy with ORDER BY expressions.
    const result = await query(
      `SELECT DISTINCT ON (d.id) d.*, 
        c.name as company_name,
        u.name as owner_name,
        s.name as stage_name,
        s.color as stage_color,
        f.name as funnel_name
       FROM crm_deals d
       LEFT JOIN crm_companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN crm_stages s ON s.id = d.stage_id
       LEFT JOIN crm_funnels f ON f.id = d.funnel_id
       JOIN crm_deal_contacts dc ON dc.deal_id = d.id
       LEFT JOIN contacts cnt ON cnt.id = dc.contact_id
       LEFT JOIN chat_contacts cc ON cc.id = dc.contact_id
       WHERE d.organization_id = $1 
          AND (
            regexp_replace(COALESCE(cnt.phone, ''), '\\D', '', 'g') LIKE $2
            OR regexp_replace(COALESCE(cc.phone, ''), '\\D', '', 'g') LIKE $2
          )
       ORDER BY d.id, (d.status = 'open') DESC, d.updated_at DESC
       LIMIT 10`,
      [org.organization_id, phonePattern]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching deals by phone:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get deals for kanban (by funnel)
router.get('/funnels/:funnelId/deals', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const userGroups = await getUserGroupIds(req.userId);
    const supervisorGroupIds = userGroups.filter(g => g.is_supervisor).map(g => g.group_id);
    const memberGroupIds = userGroups.map(g => g.group_id);

    // Check if user is a "projetista" (designer) — they see all deals across all groups
    let isDesignerUser = false;
    try {
      const designerCheck = await query(
        `SELECT 1 FROM crm_user_group_members gm
         JOIN crm_user_groups g ON g.id = gm.group_id
         WHERE gm.user_id = $1 AND g.organization_id = $2 AND LOWER(g.name) LIKE '%projeto%'
         LIMIT 1`,
        [req.userId, org.organization_id]
      );
      isDesignerUser = designerCheck.rows.length > 0;
    } catch (_) {}

    // Build visibility filter based on role
    let visibilityFilter = '';
    const params = [req.params.funnelId, org.organization_id];
    
    if (canManage(org.role) || isDesignerUser) {
      // Admins and designers see all
      visibilityFilter = '';
    } else if (supervisorGroupIds.length > 0) {
      // Supervisors see their group's deals + their own
      visibilityFilter = ` AND (d.owner_id = $3 OR d.group_id = ANY($4))`;
      params.push(req.userId, supervisorGroupIds);
    } else {
      // Regular users see only their own
      visibilityFilter = ` AND d.owner_id = $3`;
      params.push(req.userId);
    }

    const baseSql = `SELECT d.*, 
        c.name as company_name,
        u.name as owner_name,
        s.name as stage_name,
        s.color as stage_color,
        s.inactivity_hours,
        s.inactivity_color,
        g.name as group_name,
        (SELECT COUNT(*) FROM crm_tasks WHERE deal_id = d.id AND status = 'pending') as pending_tasks,
        (SELECT COUNT(*) FROM google_calendar_events WHERE crm_deal_id = d.id AND event_start > NOW() AND sync_status = 'synced') as upcoming_meetings,
        (SELECT COUNT(*) 
         FROM scheduled_messages sm
         JOIN conversations conv ON conv.id = sm.conversation_id
         WHERE sm.status = 'pending'
           AND EXISTS (
             SELECT 1 FROM crm_deal_contacts dc
             JOIN contacts cnt ON cnt.id = dc.contact_id
             WHERE dc.deal_id = d.id
               AND regexp_replace(COALESCE(cnt.phone, ''), '\\D', '', 'g') 
                   LIKE '%' || regexp_replace(conv.contact_phone, '\\D', '', 'g') || '%'
           )
        ) as scheduled_messages,
        (SELECT COUNT(*) FROM projects WHERE deal_id = d.id) as project_count,
        (SELECT json_agg(json_build_object('id', dc.contact_id, 'name', cnt.name, 'phone', cnt.phone, 'is_primary', dc.is_primary))
         FROM crm_deal_contacts dc
         JOIN contacts cnt ON cnt.id = dc.contact_id
         WHERE dc.deal_id = d.id) as contacts
       FROM crm_deals d
       LEFT JOIN crm_companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN crm_stages s ON s.id = d.stage_id
       LEFT JOIN crm_user_groups g ON g.id = d.group_id
       WHERE d.funnel_id = $1 AND d.organization_id = $2${visibilityFilter}`;

    let result;
    try {
      // Prefer Kanban ordering if the 'position' column exists
      result = await query(`${baseSql}\n       ORDER BY d.position ASC NULLS LAST, d.created_at DESC`, params);
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
      // Fallback while migrations are catching up
      result = await query(`${baseSql}\n       ORDER BY d.created_at DESC`, params);
    }

    // Group by stage
    const dealsByStage = {};
    result.rows.forEach(deal => {
      if (!dealsByStage[deal.stage_id]) {
        dealsByStage[deal.stage_id] = [];
      }
      dealsByStage[deal.stage_id].push(deal);
    });

    res.json(dealsByStage);
  } catch (error) {
    console.error('Error fetching deals:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single deal
router.get('/deals/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const deal = await query(
      `SELECT d.*, 
        c.name as company_name, c.cnpj, c.email as company_email, c.phone as company_phone,
        u.name as owner_name,
        f.name as funnel_name,
        s.name as stage_name,
        g.name as group_name
       FROM crm_deals d
       LEFT JOIN crm_companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN crm_funnels f ON f.id = d.funnel_id
       LEFT JOIN crm_stages s ON s.id = d.stage_id
       LEFT JOIN crm_user_groups g ON g.id = d.group_id
       WHERE d.id = $1 AND d.organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    if (!deal.rows[0]) return res.status(404).json({ error: 'Deal not found' });

    // Update last_opened_at
    await query(`UPDATE crm_deals SET last_opened_at = NOW() WHERE id = $1`, [req.params.id]);

    // Get contacts
    const contacts = await query(
      `SELECT dc.*, cnt.name, cnt.phone, cnt.jid
       FROM crm_deal_contacts dc
       JOIN contacts cnt ON cnt.id = dc.contact_id
       WHERE dc.deal_id = $1`,
      [req.params.id]
    );

    // Get history
    const history = await query(
      `SELECT h.*, u.name as user_name
       FROM crm_deal_history h
       LEFT JOIN users u ON u.id = h.user_id
       WHERE h.deal_id = $1
       ORDER BY h.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );

    // Get tasks
    const tasks = await query(
      `SELECT t.*, u.name as assigned_to_name
       FROM crm_tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.deal_id = $1
       ORDER BY t.due_date ASC NULLS LAST`,
      [req.params.id]
    );

    res.json({
      ...deal.rows[0],
      contacts: contacts.rows,
      history: history.rows,
      tasks: tasks.rows
    });
  } catch (error) {
    console.error('Error fetching deal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create deal
router.post('/deals', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { funnel_id, stage_id, company_id, title, value, probability, expected_close_date, 
            description, tags, owner_id, group_id, contact_ids, contact_name, contact_phone } = req.body;

    if (!funnel_id || !stage_id || !title) {
      return res.status(400).json({ error: 'Campos obrigatórios: funil, etapa e título' });
    }

    const resolvedCompanyId = company_id || (await ensureDefaultCompanyId(org.organization_id, req.userId));

    // Determine next position inside the stage (Kanban ordering). Keep compatibility during migrations.
    let nextPosition = 0;
    try {
      const maxPosResult = await query(
        `SELECT COALESCE(MAX(position), -1) + 1 AS new_position
         FROM crm_deals
         WHERE stage_id = $1 AND organization_id = $2`,
        [stage_id, org.organization_id]
      );
      nextPosition = Number(maxPosResult.rows[0]?.new_position ?? 0);
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }

    const result = await query(
      `INSERT INTO crm_deals (organization_id, funnel_id, stage_id, position, company_id, title, value, probability, 
       expected_close_date, description, tags, owner_id, group_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [org.organization_id, funnel_id, stage_id, nextPosition, resolvedCompanyId, title, value || 0, probability || 50,
       expected_close_date, description, tags || [], owner_id || req.userId, group_id, req.userId]
    );
    const deal = result.rows[0];

    // Add contacts by ID
    if (contact_ids && contact_ids.length > 0) {
      for (let i = 0; i < contact_ids.length; i++) {
        await query(
          `INSERT INTO crm_deal_contacts (deal_id, contact_id, is_primary) VALUES ($1, $2, $3)`,
          [deal.id, contact_ids[i], i === 0]
        );
      }
    }
    
    // If contact_phone is provided, find or create contact and link
    if (contact_phone) {
      // Normalize phone
      const normalizedPhone = contact_phone.replace(/\D/g, '');
      
      // Try to find existing contact via contact_lists (join via user membership in organization)
      let contactResult = await query(
        `SELECT c.id FROM contacts c 
         JOIN contact_lists cl ON cl.id = c.list_id 
         JOIN organization_members om ON om.user_id = cl.user_id AND om.organization_id = $2
         WHERE c.phone LIKE $1 
         LIMIT 1`,
        [`%${normalizedPhone.slice(-9)}%`, org.organization_id]
      );
      
      let contactId;
      if (contactResult.rows.length > 0) {
        contactId = contactResult.rows[0].id;
      } else {
        // Ensure CRM contacts list exists
        let crmList = await query(
          `SELECT id FROM contact_lists WHERE organization_id = $1 AND name = 'CRM Contacts' LIMIT 1`,
          [org.organization_id]
        );
        
        if (crmList.rows.length === 0) {
          crmList = await query(
            `INSERT INTO contact_lists (organization_id, user_id, name) VALUES ($1, $2, 'CRM Contacts') RETURNING id`,
            [org.organization_id, req.userId]
          );
        }
        
        // Create new contact in CRM list
        const newContact = await query(
          `INSERT INTO contacts (list_id, name, phone) 
           VALUES ($1, $2, $3) RETURNING id`,
          [crmList.rows[0].id, contact_name || contact_phone, normalizedPhone]
        );
        contactId = newContact.rows[0].id;
      }
      
      // Link contact to deal
      await query(
        `INSERT INTO crm_deal_contacts (deal_id, contact_id, is_primary) 
         VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
        [deal.id, contactId]
      );
    }

    // Log history
    await query(
      `INSERT INTO crm_deal_history (deal_id, user_id, action, to_value) VALUES ($1, $2, 'created', $3)`,
      [deal.id, req.userId, title]
    );

    res.json(deal);
  } catch (error) {
    console.error('Error creating deal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update deal
router.put('/deals/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { stage_id, title, value, probability, expected_close_date, description, 
            tags, owner_id, group_id, status, lost_reason, loss_reason_id, company_id, custom_fields } = req.body;

    // Get current deal for history
    const current = await query(`SELECT * FROM crm_deals WHERE id = $1`, [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'Deal not found' });

    const updates = [];
    const values = [];
    let paramIndex = 1;

    // Build dynamic update
    const fieldsToUpdate = { stage_id, title, value, probability, expected_close_date, 
                             description, tags, owner_id, group_id, status, lost_reason, loss_reason_id, company_id };
    
    for (const [key, val] of Object.entries(fieldsToUpdate)) {
      if (val !== undefined) {
        updates.push(`${key} = $${paramIndex}`);
        values.push(key === 'tags' ? val : val);
        paramIndex++;
      }
    }

    // Handle custom_fields as JSONB
    if (custom_fields !== undefined) {
      updates.push(`custom_fields = $${paramIndex}`);
      values.push(JSON.stringify(custom_fields));
      paramIndex++;
    }
    
    for (const [key, val] of Object.entries(fieldsToUpdate)) {
      if (val !== undefined) {
        updates.push(`${key} = $${paramIndex}`);
        values.push(key === 'tags' ? val : val);
        paramIndex++;
      }
    }

    // Always update activity
    updates.push(`last_activity_at = NOW()`);
    updates.push(`updated_at = NOW()`);

    // Handle won/lost status
    if (status === 'won') {
      updates.push(`won_at = NOW()`);
    } else if (status === 'lost') {
      updates.push(`lost_at = NOW()`);
    }

    values.push(req.params.id, org.organization_id);

    const result = await query(
      `UPDATE crm_deals SET ${updates.join(', ')} WHERE id = $${paramIndex} AND organization_id = $${paramIndex + 1} RETURNING *`,
      values
    );

    // Log history for stage change
    if (stage_id && stage_id !== current.rows[0].stage_id) {
      const oldStage = await query(`SELECT name FROM crm_stages WHERE id = $1`, [current.rows[0].stage_id]);
      const newStage = await query(`SELECT name FROM crm_stages WHERE id = $1`, [stage_id]);
      await query(
        `INSERT INTO crm_deal_history (deal_id, user_id, action, from_value, to_value) VALUES ($1, $2, 'stage_changed', $3, $4)`,
        [req.params.id, req.userId, oldStage.rows[0]?.name, newStage.rows[0]?.name]
      );
    }

    // Log history for status change to lost
    if (status === 'lost' && current.rows[0].status !== 'lost') {
      let reasonName = 'Motivo não informado';
      if (loss_reason_id) {
        const reasonResult = await query(`SELECT name FROM crm_loss_reasons WHERE id = $1`, [loss_reason_id]);
        if (reasonResult.rows[0]) {
          reasonName = reasonResult.rows[0].name;
          // Increment usage count
          await query(`UPDATE crm_loss_reasons SET usage_count = usage_count + 1 WHERE id = $1`, [loss_reason_id]);
        }
      }
      await query(
        `INSERT INTO crm_deal_history (deal_id, user_id, action, from_value, to_value, notes) 
         VALUES ($1, $2, 'status_changed', $3, 'lost', $4)`,
        [req.params.id, req.userId, current.rows[0].status, `Motivo: ${reasonName}${lost_reason ? `. ${lost_reason}` : ''}`]
      );
    }

    // Log history for status change to won
    if (status === 'won' && current.rows[0].status !== 'won') {
      await query(
        `INSERT INTO crm_deal_history (deal_id, user_id, action, from_value, to_value) 
         VALUES ($1, $2, 'status_changed', $3, 'won')`,
        [req.params.id, req.userId, current.rows[0].status]
      );
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating deal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Move deal (drag & drop) - supports stage change and position reorder
router.post('/deals/:id/move', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { stage_id, position, over_deal_id } = req.body;

    // Get current deal info (compatibility: older DBs may not have 'position' yet)
    let current;
    try {
      current = await query(
        `SELECT stage_id, position FROM crm_deals WHERE id = $1 AND organization_id = $2`,
        [req.params.id, org.organization_id]
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;

      // Stage-only move while migrations are catching up (no reorder)
      if (stage_id) {
        await query(
          `UPDATE crm_deals
           SET stage_id = $1, last_activity_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND organization_id = $3`,
          [stage_id, req.params.id, org.organization_id]
        );
      }
      return res.json({ success: true, migrated: false });
    }

    if (!current.rows[0]) return res.status(404).json({ error: 'Deal not found' });

    const oldStageId = current.rows[0].stage_id;
    const oldPosition = current.rows[0].position || 0;
    const isStageChange = stage_id && oldStageId !== stage_id;
    const isSameColumn = !stage_id || oldStageId === stage_id;

    // Handle reordering within the same column
    if (isSameColumn && over_deal_id && over_deal_id !== req.params.id) {
      // Get position of the target deal
      const targetDeal = await query(
        `SELECT position FROM crm_deals WHERE id = $1 AND organization_id = $2`,
        [over_deal_id, org.organization_id]
      );
      
      if (targetDeal.rows[0]) {
        const targetPosition = targetDeal.rows[0].position || 0;
        const targetStageId = stage_id || oldStageId;
        
        if (oldPosition < targetPosition) {
          // Moving down: shift items between old+1 and target up by 1
          await query(
            `UPDATE crm_deals 
             SET position = position - 1, updated_at = NOW()
             WHERE stage_id = $1 AND position > $2 AND position <= $3 AND organization_id = $4`,
            [targetStageId, oldPosition, targetPosition, org.organization_id]
          );
        } else {
          // Moving up: shift items between target and old-1 down by 1
          await query(
            `UPDATE crm_deals 
             SET position = position + 1, updated_at = NOW()
             WHERE stage_id = $1 AND position >= $2 AND position < $3 AND organization_id = $4`,
            [targetStageId, targetPosition, oldPosition, org.organization_id]
          );
        }
        
        // Update the dragged deal's position
        await query(
          `UPDATE crm_deals SET position = $1, last_activity_at = NOW(), updated_at = NOW() 
           WHERE id = $2 AND organization_id = $3`,
          [targetPosition, req.params.id, org.organization_id]
        );
      }
      
      return res.json({ success: true, reordered: true });
    }

    // Handle stage change
    if (isStageChange) {
      // Get max position in new stage
      const maxPosResult = await query(
        `SELECT COALESCE(MAX(position), -1) + 1 as new_position 
         FROM crm_deals WHERE stage_id = $1 AND organization_id = $2`,
        [stage_id, org.organization_id]
      );
      const newPosition = maxPosResult.rows[0].new_position;

      // Shift positions in old stage
      await query(
        `UPDATE crm_deals 
         SET position = position - 1, updated_at = NOW()
         WHERE stage_id = $1 AND position > $2 AND organization_id = $3`,
        [oldStageId, oldPosition, org.organization_id]
      );

      // Update stage and position
      await query(
        `UPDATE crm_deals SET stage_id = $1, position = $2, last_activity_at = NOW(), updated_at = NOW() 
         WHERE id = $3 AND organization_id = $4`,
        [stage_id, newPosition, req.params.id, org.organization_id]
      );

      // Log history
      const oldStage = await query(`SELECT name FROM crm_stages WHERE id = $1`, [oldStageId]);
      const newStage = await query(`SELECT name FROM crm_stages WHERE id = $1`, [stage_id]);
      await query(
        `INSERT INTO crm_deal_history (deal_id, user_id, action, from_value, to_value) VALUES ($1, $2, 'stage_changed', $3, $4)`,
        [req.params.id, req.userId, oldStage.rows[0]?.name, newStage.rows[0]?.name]
      );

      // Trigger automation for new stage (if configured)
      if (oldStageId !== stage_id) {
        try {
          // Check if new stage has automation
          const automationConfig = await query(
            `SELECT sa.* FROM crm_stage_automations sa
             WHERE sa.stage_id = $1 AND sa.is_active = true AND sa.execute_immediately = true`,
            [stage_id]
          );

          if (automationConfig.rows[0]) {
            const config = automationConfig.rows[0];

            // Get contact phone for the deal
            const contactResult = await query(
              `SELECT c.phone FROM crm_deal_contacts dc
               JOIN contacts c ON c.id = dc.contact_id
               WHERE dc.deal_id = $1 AND dc.is_primary = true`,
              [req.params.id]
            );

            const contactPhone = contactResult.rows[0]?.phone;

            // Cancel existing automations
            await query(
              `UPDATE crm_deal_automations 
               SET status = 'cancelled', updated_at = NOW()
               WHERE deal_id = $1 AND status IN ('pending', 'flow_sent', 'waiting')`,
              [req.params.id]
            );

            // Create new automation
            const waitUntil = new Date();
            waitUntil.setHours(waitUntil.getHours() + (config.wait_hours || 24));

            await query(
              `INSERT INTO crm_deal_automations 
               (deal_id, stage_id, automation_id, status, flow_id, wait_until, contact_phone, next_stage_id)
               VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)`,
              [req.params.id, stage_id, config.id, config.flow_id, waitUntil, contactPhone, config.next_stage_id]
            );

            logInfo(`Automation queued for deal ${req.params.id} in stage ${stage_id}`);
          }
        } catch (automationError) {
          // Don't fail the move if automation fails
          logError('Failed to trigger automation:', automationError);
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error moving deal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk operations on deals
router.post('/deals/bulk', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });
    if (!['owner', 'admin', 'manager'].includes(org.role)) return res.status(403).json({ error: 'Permission denied' });

    const { action, deal_ids, target_funnel_id, target_stage_id, owner_id, group_id } = req.body;
    if (!deal_ids || !Array.isArray(deal_ids) || deal_ids.length === 0) {
      return res.status(400).json({ error: 'deal_ids is required' });
    }

    let affected = 0;

    if (action === 'delete') {
      const result = await query(
        `DELETE FROM crm_deals WHERE id = ANY($1) AND organization_id = $2`,
        [deal_ids, org.organization_id]
      );
      affected = result.rowCount;
    } else if (action === 'move_funnel') {
      if (!target_funnel_id || !target_stage_id) return res.status(400).json({ error: 'target_funnel_id and target_stage_id required' });
      const result = await query(
        `UPDATE crm_deals SET funnel_id = $1, stage_id = $2, updated_at = NOW() WHERE id = ANY($3) AND organization_id = $4`,
        [target_funnel_id, target_stage_id, deal_ids, org.organization_id]
      );
      affected = result.rowCount;
    } else if (action === 'reassign') {
      const updates = [];
      const params = [deal_ids, org.organization_id];
      let paramIdx = 3;
      if (owner_id !== undefined) {
        updates.push(`owner_id = $${paramIdx}`);
        params.push(owner_id);
        paramIdx++;
      }
      if (group_id !== undefined) {
        updates.push(`group_id = $${paramIdx}`);
        params.push(group_id);
        paramIdx++;
      }
      if (updates.length === 0) return res.status(400).json({ error: 'owner_id or group_id required' });
      updates.push('updated_at = NOW()');
      const result = await query(
        `UPDATE crm_deals SET ${updates.join(', ')} WHERE id = ANY($1) AND organization_id = $2`,
        params
      );
      affected = result.rowCount;
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }

    res.json({ success: true, affected });
  } catch (error) {
    console.error('Error bulk deals:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add contact to deal
router.post('/deals/:id/contacts', async (req, res) => {
  let contact_id, role, is_primary, finalContactId;
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    ({ contact_id, role, is_primary } = req.body);
    
    // Try to find in chat_contacts first (agenda)
    finalContactId = contact_id;
    const chatContact = await query(
      `SELECT cc.*, c.organization_id 
       FROM chat_contacts cc 
       JOIN connections c ON c.id = cc.connection_id 
       WHERE cc.id = $1 AND c.organization_id = $2`,
      [contact_id, org.organization_id]
    );
    
    if (chatContact.rows.length > 0) {
      // Contact is from chat agenda, we need to create/find in contacts table
      const cc = chatContact.rows[0];
      
      // Try to find existing contact by phone
      const existingContact = await query(
        `SELECT c.id FROM contacts c 
         JOIN contact_lists cl ON cl.id = c.list_id 
         JOIN organization_members om ON om.user_id = cl.user_id AND om.organization_id = $2
         WHERE c.phone = $1 
         LIMIT 1`,
        [cc.phone, org.organization_id]
      );
      
      if (existingContact.rows.length > 0) {
        finalContactId = existingContact.rows[0].id;
      } else {
        // Create contact in a default CRM list
        // First, ensure there's a CRM contacts list for this user
        let crmList = await query(
          `SELECT cl.id FROM contact_lists cl
           JOIN organization_members om ON om.user_id = cl.user_id AND om.organization_id = $1
           WHERE cl.name = 'CRM Contacts' LIMIT 1`,
          [org.organization_id]
        );
        
        if (crmList.rows.length === 0) {
          crmList = await query(
            `INSERT INTO contact_lists (user_id, name) VALUES ($1, 'CRM Contacts') RETURNING id`,
            [req.userId]
          );
        }
        
        const newContact = await query(
          `INSERT INTO contacts (list_id, name, phone) 
           VALUES ($1, $2, $3) RETURNING id`,
          [crmList.rows[0].id, cc.name || cc.phone, cc.phone]
        );
        finalContactId = newContact.rows[0].id;
      }
    } else {
      // Validate contact exists in contacts table
      const contactCheck = await query(
        `SELECT c.id FROM contacts c 
         JOIN contact_lists cl ON cl.id = c.list_id 
         JOIN organization_members om ON om.user_id = cl.user_id AND om.organization_id = $2
         WHERE c.id = $1`,
        [contact_id, org.organization_id]
      );
      
      if (contactCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Contact not found' });
      }
      
      finalContactId = contact_id;
    }
    
    const result = await query(
      `INSERT INTO crm_deal_contacts (deal_id, contact_id, role, is_primary)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (deal_id, contact_id) DO UPDATE SET role = $3, is_primary = $4
       RETURNING *`,
      [req.params.id, finalContactId, role, is_primary || false]
    );
    res.json(result.rows[0]);
  } catch (error) {
     logError('crm.add_contact_to_deal', error, {
      dealId: req.params.id,
      contactId: contact_id,
      finalContactId,
      role,
      is_primary
    });
    res.status(500).json({ 
      error: error.message, 
      details: error.detail,
      context: 'adding_contact_to_deal'
    });
  }
});

// Remove contact from deal
router.delete('/deals/:dealId/contacts/:contactId', async (req, res) => {
  try {
    await query(
      `DELETE FROM crm_deal_contacts WHERE deal_id = $1 AND contact_id = $2`,
      [req.params.dealId, req.params.contactId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing contact from deal:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TASKS
// ============================================

// List tasks (with filters)
router.get('/tasks', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { period, status, assigned_to, deal_id, start_date, end_date, view_all } = req.query;
    
    let sql = `SELECT t.*, 
      d.title as deal_title,
      c.name as company_name,
      u.name as assigned_to_name,
      cu.name as created_by_name,
      'crm' as source
      FROM crm_tasks t
      LEFT JOIN crm_deals d ON d.id = t.deal_id
      LEFT JOIN crm_companies c ON c.id = t.company_id
      LEFT JOIN users u ON u.id = t.assigned_to
      LEFT JOIN users cu ON cu.id = t.created_by
      WHERE t.organization_id = $1`;
    const params = [org.organization_id];
    let paramIndex = 2;

    // Visibility filter - admins can view all or filter by specific user
    const isAdmin = canManage(org.role);
    if (!isAdmin) {
      // Non-admin: only their own tasks
      sql += ` AND t.assigned_to = $${paramIndex}`;
      params.push(req.userId);
      paramIndex++;
    } else if (assigned_to && assigned_to !== 'all') {
      // Admin filtering by specific user
      sql += ` AND t.assigned_to = $${paramIndex}`;
      params.push(assigned_to);
      paramIndex++;
    }
    // If admin and (view_all=true OR assigned_to=all), show all tasks

    // Custom date range filter (takes priority over period)
    if (start_date && end_date) {
      sql += ` AND t.due_date >= $${paramIndex} AND t.due_date < $${paramIndex + 1}::date + INTERVAL '1 day'`;
      params.push(start_date, end_date);
      paramIndex += 2;
    } else if (period === 'today') {
      sql += ` AND DATE(t.due_date) = CURRENT_DATE`;
    } else if (period === 'week') {
      sql += ` AND t.due_date >= CURRENT_DATE AND t.due_date < CURRENT_DATE + INTERVAL '7 days'`;
    } else if (period === 'month') {
      sql += ` AND t.due_date >= CURRENT_DATE AND t.due_date < CURRENT_DATE + INTERVAL '30 days'`;
    } else if (period === 'overdue') {
      sql += ` AND t.due_date < NOW() AND t.status = 'pending'`;
    }

    // Status filter
    if (status) {
      sql += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    // Deal filter
    if (deal_id) {
      sql += ` AND t.deal_id = $${paramIndex}`;
      params.push(deal_id);
      paramIndex++;
    }

    sql += ` ORDER BY t.due_date ASC NULLS LAST, t.priority DESC`;

    const result = await query(sql, params);

    // Also fetch project tasks for this user/org (centralized view)
    let projectTasks = [];
    try {
      let ptSql = `SELECT pt.id, pt.title, pt.description, pt.status, pt.start_date, pt.end_date as due_date,
        pt.assigned_to, pt.completed_at, pt.created_at, pt.project_id,
        u.name as assigned_to_name,
        p.title as project_title, p.priority,
        'project' as source, 'task' as type
        FROM project_tasks pt
        JOIN projects p ON p.id = pt.project_id AND p.organization_id = $1
        LEFT JOIN users u ON u.id = pt.assigned_to
        WHERE p.organization_id = $1`;
      const ptParams = [org.organization_id];
      let ptIdx = 2;

      if (!isAdmin) {
        ptSql += ` AND pt.assigned_to = $${ptIdx}`;
        ptParams.push(req.userId);
        ptIdx++;
      } else if (assigned_to && assigned_to !== 'all') {
        ptSql += ` AND pt.assigned_to = $${ptIdx}`;
        ptParams.push(assigned_to);
        ptIdx++;
      }

      if (status) {
        ptSql += ` AND pt.status = $${ptIdx}`;
        ptParams.push(status === 'completed' ? 'completed' : 'pending');
        ptIdx++;
      }

      if (start_date && end_date) {
        ptSql += ` AND pt.end_date >= $${ptIdx} AND pt.end_date < $${ptIdx + 1}::date + INTERVAL '1 day'`;
        ptParams.push(start_date, end_date);
        ptIdx += 2;
      } else if (period === 'today') {
        ptSql += ` AND DATE(pt.end_date) = CURRENT_DATE`;
      } else if (period === 'week') {
        ptSql += ` AND pt.end_date >= CURRENT_DATE AND pt.end_date < CURRENT_DATE + INTERVAL '7 days'`;
      } else if (period === 'month') {
        ptSql += ` AND pt.end_date >= CURRENT_DATE AND pt.end_date < CURRENT_DATE + INTERVAL '30 days'`;
      } else if (period === 'overdue') {
        ptSql += ` AND pt.end_date < NOW() AND pt.status = 'pending'`;
      }

      ptSql += ` ORDER BY pt.end_date ASC NULLS LAST`;
      const ptResult = await query(ptSql, ptParams);
      projectTasks = ptResult.rows.map(r => ({
        ...r,
        deal_title: r.project_title ? `📁 ${r.project_title}` : null,
        company_name: null,
        created_by_name: null,
      }));
    } catch (_) {}

    res.json([...result.rows, ...projectTasks]);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get task counts
router.get('/tasks/counts', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    let userFilter = '';
    const params = [org.organization_id];
    
    if (!canManage(org.role)) {
      userFilter = ` AND assigned_to = $2`;
      params.push(req.userId);
    }

    const crmResult = await query(
      `SELECT 
        COUNT(*) FILTER (WHERE DATE(due_date) = CURRENT_DATE AND status = 'pending') as today,
        COUNT(*) FILTER (WHERE due_date >= CURRENT_DATE AND due_date < CURRENT_DATE + INTERVAL '7 days' AND status = 'pending') as week,
        COUNT(*) FILTER (WHERE due_date >= CURRENT_DATE AND due_date < CURRENT_DATE + INTERVAL '30 days' AND status = 'pending') as month,
        COUNT(*) FILTER (WHERE due_date < NOW() AND status = 'pending') as overdue,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'completed') as completed
       FROM crm_tasks
       WHERE organization_id = $1${userFilter}`,
      params
    );

    // Also count project tasks
    let ptCounts = { today: 0, week: 0, month: 0, overdue: 0, pending: 0, completed: 0 };
    try {
      let ptUserFilter = '';
      const ptParams = [org.organization_id];
      if (!canManage(org.role)) {
        ptUserFilter = ` AND pt.assigned_to = $2`;
        ptParams.push(req.userId);
      }
      const ptResult = await query(
        `SELECT 
          COUNT(*) FILTER (WHERE DATE(pt.end_date) = CURRENT_DATE AND pt.status = 'pending') as today,
          COUNT(*) FILTER (WHERE pt.end_date >= CURRENT_DATE AND pt.end_date < CURRENT_DATE + INTERVAL '7 days' AND pt.status = 'pending') as week,
          COUNT(*) FILTER (WHERE pt.end_date >= CURRENT_DATE AND pt.end_date < CURRENT_DATE + INTERVAL '30 days' AND pt.status = 'pending') as month,
          COUNT(*) FILTER (WHERE pt.end_date < NOW() AND pt.status = 'pending') as overdue,
          COUNT(*) FILTER (WHERE pt.status = 'pending') as pending,
          COUNT(*) FILTER (WHERE pt.status = 'completed') as completed
         FROM project_tasks pt
         JOIN projects p ON p.id = pt.project_id AND p.organization_id = $1
         WHERE p.organization_id = $1${ptUserFilter}`,
        ptParams
      );
      ptCounts = ptResult.rows[0] || ptCounts;
    } catch (_) {}

    const crm = crmResult.rows[0];
    res.json({
      today: Number(crm.today) + Number(ptCounts.today),
      week: Number(crm.week) + Number(ptCounts.week),
      month: Number(crm.month) + Number(ptCounts.month),
      overdue: Number(crm.overdue) + Number(ptCounts.overdue),
      pending: Number(crm.pending) + Number(ptCounts.pending),
      completed: Number(crm.completed) + Number(ptCounts.completed),
    });
  } catch (error) {
    console.error('Error fetching task counts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create task
router.post('/tasks', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { deal_id, company_id, assigned_to, title, description, type, priority, due_date, reminder_at, reminder_minutes, reminder_whatsapp, reminder_popup } = req.body;
    
    // Calculate reminder_at from due_date and reminder_minutes if provided
    let calculatedReminderAt = reminder_at;
    if (reminder_minutes && due_date && !reminder_at) {
      const dueDateTime = new Date(due_date);
      dueDateTime.setMinutes(dueDateTime.getMinutes() - reminder_minutes);
      calculatedReminderAt = dueDateTime.toISOString();
    }

    const result = await query(
      `INSERT INTO crm_tasks (organization_id, deal_id, company_id, assigned_to, created_by, title, description, type, priority, due_date, reminder_at, reminder_minutes, reminder_whatsapp, reminder_popup)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [org.organization_id, deal_id, company_id, assigned_to || req.userId, req.userId, 
       title, description, type || 'task', priority || 'medium', due_date, calculatedReminderAt,
       reminder_minutes || null, reminder_whatsapp ?? false, reminder_popup ?? true]
    );

    // Also create a card in the Global Kanban board
    try {
      const { createTaskCardInGlobalBoard } = await import('../lib/task-card-helper.js');
      await createTaskCardInGlobalBoard({
        organizationId: org.organization_id,
        createdBy: req.userId,
        assignedTo: assigned_to || req.userId,
        title,
        description,
        priority: priority || 'medium',
        dueDate: due_date,
        sourceModule: 'crm',
        dealId: deal_id,
        companyId: company_id,
        crmTaskId: result.rows[0].id,
      });
    } catch (kanbanErr) {
      console.error('Error creating kanban card from CRM:', kanbanErr);
    }

    // If linked to deal, update last_activity
    if (deal_id) {
      await query(`UPDATE crm_deals SET last_activity_at = NOW() WHERE id = $1`, [deal_id]);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update task
router.put('/tasks/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { assigned_to, title, description, type, priority, due_date, reminder_at, reminder_minutes, reminder_whatsapp, reminder_popup, status } = req.body;

    let extraFields = '';
    if (status === 'completed') {
      extraFields = `, completed_at = NOW(), completed_by = '${req.userId}'`;
    } else if (status === 'pending') {
      extraFields = `, completed_at = NULL, completed_by = NULL`;
    }

    // Calculate reminder_at from due_date and reminder_minutes if provided
    let calculatedReminderAt = reminder_at;
    if (reminder_minutes && due_date && !reminder_at) {
      const dueDateTime = new Date(due_date);
      dueDateTime.setMinutes(dueDateTime.getMinutes() - reminder_minutes);
      calculatedReminderAt = dueDateTime.toISOString();
    }

    const result = await query(
      `UPDATE crm_tasks SET 
        assigned_to = COALESCE($1, assigned_to),
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        type = COALESCE($4, type),
        priority = COALESCE($5, priority),
        due_date = $6,
        reminder_at = $7,
        reminder_minutes = $8,
        reminder_whatsapp = COALESCE($9, reminder_whatsapp),
        reminder_popup = COALESCE($10, reminder_popup),
        reminder_sent = false,
        status = COALESCE($11, status),
        updated_at = NOW()
        ${extraFields}
       WHERE id = $12 AND organization_id = $13 RETURNING *`,
      [assigned_to, title, description, type, priority, due_date, calculatedReminderAt,
       reminder_minutes || null, reminder_whatsapp, reminder_popup, status, req.params.id, org.organization_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete task
router.post('/tasks/:id/complete', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `UPDATE crm_tasks SET status = 'completed', completed_at = NOW(), completed_by = $1, updated_at = NOW()
       WHERE id = $2 AND organization_id = $3 RETURNING *`,
      [req.userId, req.params.id, org.organization_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error completing task:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete task
router.delete('/tasks/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    await query(
      `DELETE FROM crm_tasks WHERE id = $1 AND organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CRM CONFIGURATION (Task Types, Segments, Custom Fields)
// ============================================

// Get all task types (global + org-specific)
router.get('/config/task-types', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT * FROM crm_task_types 
       WHERE is_global = true OR organization_id = $1
       ORDER BY is_global DESC, position, name`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    if (error.code === '42P01') return res.json([]);
    console.error('Error fetching task types:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create task type
router.post('/config/task-types', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { name, icon, color, position } = req.body;
    const result = await query(
      `INSERT INTO crm_task_types (organization_id, name, icon, color, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [org.organization_id, name, icon || 'check-square', color || '#6366f1', position || 0]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating task type:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update task type
router.put('/config/task-types/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { name, icon, color, is_active, position } = req.body;
    const result = await query(
      `UPDATE crm_task_types 
       SET name = COALESCE($1, name), 
           icon = COALESCE($2, icon), 
           color = COALESCE($3, color),
           is_active = COALESCE($4, is_active),
           position = COALESCE($5, position),
           updated_at = NOW()
       WHERE id = $6 AND organization_id = $7 AND is_global = false
       RETURNING *`,
      [name, icon, color, is_active, position, req.params.id, org.organization_id]
    );
    if (!result.rows[0]) {
      return res.status(400).json({ error: 'Não é possível editar tipos globais' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating task type:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete task type (only org-specific, not global)
router.delete('/config/task-types/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    await query(
      `DELETE FROM crm_task_types WHERE id = $1 AND organization_id = $2 AND is_global = false`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting task type:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cleanup duplicate global task types (keep only the first one per name)
router.post('/config/task-types/cleanup', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    // Delete duplicate global task types, keeping only the oldest one per name
    const deletedResult = await query(`
      DELETE FROM crm_task_types
      WHERE id IN (
        SELECT id FROM (
          SELECT id, 
                 ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at ASC) as rn
          FROM crm_task_types
          WHERE is_global = true
        ) sub
        WHERE rn > 1
      )
      RETURNING id, name
    `);

    // Create unique index if not exists (for future prevention)
    try {
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_task_types_global_name 
        ON crm_task_types (name) WHERE is_global = true
      `);
    } catch (e) {
      // Ignore if already exists or fails due to remaining duplicates
    }

    res.json({ 
      success: true, 
      deleted_count: deletedResult.rows.length,
      deleted: deletedResult.rows
    });
  } catch (error) {
    console.error('Error cleaning up task types:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all segments (global + org-specific)
router.get('/config/segments', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT s.*, 
        (SELECT COUNT(*) FROM crm_deal_segments ds WHERE ds.segment_id = s.id) as deals_count
       FROM crm_segments s
       WHERE s.is_global = true OR s.organization_id = $1
       ORDER BY s.is_global DESC, s.position, s.name`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    if (error.code === '42P01') return res.json([]);
    console.error('Error fetching segments:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create segment
router.post('/config/segments', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { name, color, description, position } = req.body;
    const result = await query(
      `INSERT INTO crm_segments (organization_id, name, color, description, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [org.organization_id, name, color || '#6366f1', description, position || 0]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating segment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update segment
router.put('/config/segments/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { name, color, description, is_active, position } = req.body;
    const result = await query(
      `UPDATE crm_segments 
       SET name = COALESCE($1, name), 
           color = COALESCE($2, color), 
           description = COALESCE($3, description),
           is_active = COALESCE($4, is_active),
           position = COALESCE($5, position),
           updated_at = NOW()
       WHERE id = $6 AND (organization_id = $7 OR is_global = false)
       RETURNING *`,
      [name, color, description, is_active, position, req.params.id, org.organization_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating segment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete segment
router.delete('/config/segments/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    await query(
      `DELETE FROM crm_segments WHERE id = $1 AND organization_id = $2 AND is_global = false`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting segment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add segment to deal
router.post('/deals/:dealId/segments', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { segment_id } = req.body;
    const result = await query(
      `INSERT INTO crm_deal_segments (deal_id, segment_id)
       VALUES ($1, $2) 
       ON CONFLICT (deal_id, segment_id) DO NOTHING
       RETURNING *`,
      [req.params.dealId, segment_id]
    );
    res.json(result.rows[0] || { success: true });
  } catch (error) {
    console.error('Error adding segment to deal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove segment from deal
router.delete('/deals/:dealId/segments/:segmentId', async (req, res) => {
  try {
    await query(
      `DELETE FROM crm_deal_segments WHERE deal_id = $1 AND segment_id = $2`,
      [req.params.dealId, req.params.segmentId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing segment from deal:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get custom fields
router.get('/config/custom-fields', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { entity_type } = req.query;
    let sql = `SELECT * FROM crm_custom_fields 
               WHERE is_global = true OR organization_id = $1`;
    const params = [org.organization_id];
    
    if (entity_type) {
      sql += ` AND entity_type = $2`;
      params.push(entity_type);
    }
    sql += ` ORDER BY position, field_label`;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (error) {
    if (error.code === '42P01') return res.json([]);
    console.error('Error fetching custom fields:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create custom field
router.post('/config/custom-fields', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { entity_type, field_name, field_label, field_type, options, is_required, position } = req.body;
    const result = await query(
      `INSERT INTO crm_custom_fields (organization_id, entity_type, field_name, field_label, field_type, options, is_required, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [org.organization_id, entity_type, field_name, field_label, field_type || 'text', options ? JSON.stringify(options) : null, is_required || false, position || 0]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating custom field:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update custom field
router.put('/config/custom-fields/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { field_label, field_type, options, is_required, is_active, position } = req.body;
    const result = await query(
      `UPDATE crm_custom_fields 
       SET field_label = COALESCE($1, field_label), 
           field_type = COALESCE($2, field_type), 
           options = COALESCE($3, options),
           is_required = COALESCE($4, is_required),
           is_active = COALESCE($5, is_active),
           position = COALESCE($6, position),
           updated_at = NOW()
       WHERE id = $7 AND (organization_id = $8 OR is_global = false)
       RETURNING *`,
      [field_label, field_type, options ? JSON.stringify(options) : null, is_required, is_active, position, req.params.id, org.organization_id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating custom field:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete custom field
router.delete('/config/custom-fields/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org || !canManage(org.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    await query(
      `DELETE FROM crm_custom_fields WHERE id = $1 AND organization_id = $2 AND is_global = false`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting custom field:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CRM REPORTS
// ============================================

// Get sales report data
router.get('/reports/sales', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { start_date, end_date, funnel_id, group_by = 'day', group_id, owner_id } = req.query;
    
    // Default to last 30 days
    const endDate = end_date || new Date().toISOString().split('T')[0];
    const startDate = start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get deals by period
    let dateFormat;
    switch (group_by) {
      case 'week': dateFormat = 'IYYY-IW'; break;
      case 'month': dateFormat = 'YYYY-MM'; break;
      default: dateFormat = 'YYYY-MM-DD';
    }

    let funnelFilter = '';
    let groupFilter = '';
    let ownerFilter = '';
    const params = [org.organization_id, startDate, endDate];
    let paramIndex = 4;
    if (funnel_id && funnel_id !== 'all') {
      funnelFilter = ` AND d.funnel_id = $${paramIndex}`;
      params.push(funnel_id);
      paramIndex++;
    }
    if (group_id && group_id !== 'all') {
      groupFilter = ` AND d.group_id = $${paramIndex}`;
      params.push(group_id);
      paramIndex++;
    }
    if (owner_id && owner_id !== 'all') {
      ownerFilter = ` AND d.owner_id = $${paramIndex}`;
      params.push(owner_id);
      paramIndex++;
    }
    const extraFilters = funnelFilter + groupFilter + ownerFilter;

    // Timeline data
    const timelineResult = await query(
      `SELECT 
         TO_CHAR(d.created_at, '${dateFormat}') as period,
         COUNT(*) FILTER (WHERE d.status = 'open') as open_count,
         COUNT(*) FILTER (WHERE d.status = 'won') as won_count,
         COUNT(*) FILTER (WHERE d.status = 'lost') as lost_count,
         COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) as won_value,
         COALESCE(SUM(d.value) FILTER (WHERE d.status = 'lost'), 0) as lost_value,
         COALESCE(SUM(d.value) FILTER (WHERE d.status = 'open'), 0) as open_value
       FROM crm_deals d
       WHERE d.organization_id = $1
         AND d.created_at >= $2::date
         AND d.created_at <= ($3::date + interval '1 day')
         ${extraFilters}
       GROUP BY period
       ORDER BY period`,
      params
    );

    // Summary by status
    const summaryResult = await query(
      `SELECT 
         d.status,
         COUNT(*) as count,
         COALESCE(SUM(d.value), 0) as total_value,
         COALESCE(AVG(d.value), 0) as avg_value
       FROM crm_deals d
       WHERE d.organization_id = $1
         AND d.created_at >= $2::date
         AND d.created_at <= ($3::date + interval '1 day')
         ${extraFilters}
       GROUP BY d.status`,
      params
    );

    // By funnel
    const byFunnelResult = await query(
      `SELECT 
         f.id as funnel_id,
         f.name as funnel_name,
         f.color as funnel_color,
         COUNT(*) FILTER (WHERE d.status = 'open') as open_count,
         COUNT(*) FILTER (WHERE d.status = 'won') as won_count,
         COUNT(*) FILTER (WHERE d.status = 'lost') as lost_count,
         COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) as won_value
       FROM crm_funnels f
       LEFT JOIN crm_deals d ON d.funnel_id = f.id 
         AND d.created_at >= $2::date
         AND d.created_at <= ($3::date + interval '1 day')
       WHERE f.organization_id = $1
       GROUP BY f.id, f.name, f.color
       ORDER BY won_value DESC`,
      [org.organization_id, startDate, endDate]
    );

    // By owner (top performers)
    const byOwnerResult = await query(
      `SELECT 
         u.id as user_id,
         u.name as user_name,
         COUNT(*) FILTER (WHERE d.status = 'won') as won_count,
         COUNT(*) FILTER (WHERE d.status = 'lost') as lost_count,
         COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) as won_value,
         COALESCE(SUM(d.value) FILTER (WHERE d.status = 'lost'), 0) as lost_value,
         COALESCE(SUM(d.value) FILTER (WHERE d.status = 'open'), 0) as open_value,
         COUNT(*) as total_deals,
         COALESCE(AVG(d.value) FILTER (WHERE d.status = 'won'), 0) as avg_ticket
       FROM crm_deals d
       JOIN users u ON u.id = d.owner_id
       WHERE d.organization_id = $1
         AND d.created_at >= $2::date
         AND d.created_at <= ($3::date + interval '1 day')
         ${extraFilters}
       GROUP BY u.id, u.name
       ORDER BY won_value DESC
       LIMIT 20`,
      params
    );

    // By CRM group
    let byGroupResult = { rows: [] };
    try {
      byGroupResult = await query(
        `SELECT 
           g.id as group_id,
           g.name as group_name,
           COUNT(*) FILTER (WHERE d.status = 'open') as open_count,
           COUNT(*) FILTER (WHERE d.status = 'won') as won_count,
           COUNT(*) FILTER (WHERE d.status = 'lost') as lost_count,
           COALESCE(SUM(d.value) FILTER (WHERE d.status = 'open'), 0) as open_value,
           COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) as won_value,
           COALESCE(SUM(d.value) FILTER (WHERE d.status = 'lost'), 0) as lost_value,
           COUNT(*) as total_deals,
           COALESCE(AVG(d.value) FILTER (WHERE d.status = 'won'), 0) as avg_ticket
         FROM crm_user_groups g
         LEFT JOIN crm_deals d ON d.group_id = g.id
           AND d.created_at >= $2::date
           AND d.created_at <= ($3::date + interval '1 day')
         WHERE g.organization_id = $1
         GROUP BY g.id, g.name
         ORDER BY won_value DESC`,
        [org.organization_id, startDate, endDate]
      );
    } catch (e) {
      // Ignore if table doesn't exist
    }

    // Extra KPIs: new leads count (deals created in period), avg ticket, avg cycle
    const extraKpis = await query(
      `SELECT 
         COUNT(*) as new_leads,
         COALESCE(AVG(d.value) FILTER (WHERE d.status = 'won'), 0) as avg_ticket,
         COALESCE(AVG(EXTRACT(EPOCH FROM (${closedAtSql('d')} - d.created_at)) / 86400) FILTER (WHERE d.status = 'won' AND ${closedAtSql('d')} IS NOT NULL), 0) as avg_cycle_days,
         COALESCE(SUM(d.value), 0) as total_pipeline
       FROM crm_deals d
       WHERE d.organization_id = $1
         AND d.created_at >= $2::date
         AND d.created_at <= ($3::date + interval '1 day')
         ${extraFilters}`,
      params
    );

    const kpis = extraKpis.rows[0] || {};

    // Win rate calculation
    const summary = {
      open: { count: 0, value: 0 },
      won: { count: 0, value: 0 },
      lost: { count: 0, value: 0 },
    };
    
    summaryResult.rows.forEach(row => {
      if (summary[row.status]) {
        summary[row.status] = {
          count: parseInt(row.count),
          value: parseFloat(row.total_value),
        };
      }
    });

    const totalClosed = summary.won.count + summary.lost.count;
    const winRate = totalClosed > 0 ? (summary.won.count / totalClosed * 100) : 0;

    res.json({
      timeline: timelineResult.rows.map(row => ({
        period: row.period,
        open: parseInt(row.open_count),
        won: parseInt(row.won_count),
        lost: parseInt(row.lost_count),
        wonValue: parseFloat(row.won_value),
        lostValue: parseFloat(row.lost_value),
        openValue: parseFloat(row.open_value),
      })),
      summary: {
        ...summary,
        winRate: parseFloat(winRate.toFixed(1)),
        totalValue: summary.open.value + summary.won.value + summary.lost.value,
      },
      newLeads: parseInt(kpis.new_leads || 0),
      avgTicket: parseFloat(kpis.avg_ticket || 0),
      avgCycleDays: Math.round(parseFloat(kpis.avg_cycle_days || 0)),
      totalPipeline: parseFloat(kpis.total_pipeline || 0),
      byFunnel: byFunnelResult.rows.map(row => ({
        funnelId: row.funnel_id,
        funnelName: row.funnel_name,
        funnelColor: row.funnel_color,
        open: parseInt(row.open_count),
        won: parseInt(row.won_count),
        lost: parseInt(row.lost_count),
        wonValue: parseFloat(row.won_value),
      })),
      byOwner: byOwnerResult.rows.map(row => ({
        userId: row.user_id,
        userName: row.user_name,
        wonCount: parseInt(row.won_count),
        lostCount: parseInt(row.lost_count || 0),
        wonValue: parseFloat(row.won_value),
        lostValue: parseFloat(row.lost_value || 0),
        openValue: parseFloat(row.open_value || 0),
        totalDeals: parseInt(row.total_deals),
        avgTicket: parseFloat(row.avg_ticket || 0),
      })),
      byGroup: byGroupResult.rows.map(row => ({
        groupId: row.group_id,
        groupName: row.group_name,
        open: parseInt(row.open_count || 0),
        won: parseInt(row.won_count || 0),
        lost: parseInt(row.lost_count || 0),
        openValue: parseFloat(row.open_value || 0),
        wonValue: parseFloat(row.won_value || 0),
        lostValue: parseFloat(row.lost_value || 0),
        totalDeals: parseInt(row.total_deals || 0),
        avgTicket: parseFloat(row.avg_ticket || 0),
      })),
    });
  } catch (error) {
    if (error.code === '42P01') {
      return res.json({ timeline: [], summary: { open: { count: 0, value: 0 }, won: { count: 0, value: 0 }, lost: { count: 0, value: 0 }, winRate: 0, totalValue: 0 }, byFunnel: [], byOwner: [] });
    }
    console.error('Error fetching sales report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get conversion funnel data
router.get('/reports/conversion', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { funnel_id, start_date, end_date } = req.query;
    
    if (!funnel_id) {
      return res.status(400).json({ error: 'funnel_id is required' });
    }

    const endDate = end_date || new Date().toISOString().split('T')[0];
    const startDate = start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get stages with deal counts
    const result = await query(
      `SELECT 
         s.id as stage_id,
         s.name as stage_name,
         s.color as stage_color,
         s.position,
         s.is_final,
         COUNT(d.id) as deal_count,
         COALESCE(SUM(d.value), 0) as total_value
       FROM crm_stages s
       LEFT JOIN crm_deals d ON d.stage_id = s.id 
         AND d.created_at >= $2::date
         AND d.created_at <= ($3::date + interval '1 day')
       WHERE s.funnel_id = $1
       GROUP BY s.id, s.name, s.color, s.position, s.is_final
       ORDER BY s.position`,
      [funnel_id, startDate, endDate]
    );

    res.json(result.rows.map(row => ({
      stageId: row.stage_id,
      stageName: row.stage_name,
      stageColor: row.stage_color,
      position: row.position,
      isFinal: row.is_final,
      dealCount: parseInt(row.deal_count),
      totalValue: parseFloat(row.total_value),
    })));
  } catch (error) {
    if (error.code === '42P01') return res.json([]);
    console.error('Error fetching conversion report:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// PROSPECTS
// =============================================================================

// List all prospects
router.get('/prospects', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT id, name, phone, source, converted_at, converted_deal_id, created_at
       FROM crm_prospects
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    if (error.code === '42P01') return res.json([]);
    console.error('Error fetching prospects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create single prospect
router.post('/prospects', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { name, phone, source, city, state, address, zip_code, is_company } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    // Normalize phone
    let normalizedPhone = phone.replace(/\D/g, '').replace(/^0+/, '');
    if (normalizedPhone.length <= 11) {
      normalizedPhone = '55' + normalizedPhone;
    }

    // Check duplicate
    const existing = await query(
      `SELECT id FROM crm_prospects WHERE organization_id = $1 AND phone = $2`,
      [org.organization_id, normalizedPhone]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Prospect com este telefone já existe' });
    }

    const result = await query(
      `INSERT INTO crm_prospects (organization_id, name, phone, source, city, state, address, zip_code, is_company, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        org.organization_id, 
        name.trim(), 
        normalizedPhone, 
        source?.trim() || null,
        city?.trim() || null,
        state?.trim() || null,
        address?.trim() || null,
        zip_code?.trim() || null,
        is_company === true,
        req.userId
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating prospect:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk create prospects
router.post('/prospects/bulk', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { prospects } = req.body;
    if (!Array.isArray(prospects) || prospects.length === 0) {
      return res.status(400).json({ error: 'Prospects array is required' });
    }

    // Get existing phones
    const existingResult = await query(
      `SELECT phone FROM crm_prospects WHERE organization_id = $1`,
      [org.organization_id]
    );
    const existingPhones = new Set(existingResult.rows.map(r => r.phone));

    let created = 0;
    let duplicates = 0;

    for (const p of prospects) {
      if (!p.name || !p.phone) continue;

      let normalizedPhone = p.phone.replace(/\D/g, '').replace(/^0+/, '');
      if (normalizedPhone.length <= 11) {
        normalizedPhone = '55' + normalizedPhone;
      }

      if (existingPhones.has(normalizedPhone)) {
        duplicates++;
        continue;
      }

      // Extract custom fields (everything except reserved keys)
      const customFields = {};
      const reservedKeys = ['name', 'phone', 'source', 'city', 'state', 'address', 'zip_code', 'is_company'];
      Object.keys(p).forEach(key => {
        if (!reservedKeys.includes(key) && p[key]) {
          customFields[key] = p[key];
        }
      });

      try {
        await query(
          `INSERT INTO crm_prospects (organization_id, name, phone, source, city, state, address, zip_code, is_company, custom_fields, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            org.organization_id, 
            p.name.trim(), 
            normalizedPhone, 
            p.source?.trim() || null, 
            p.city?.trim() || null,
            p.state?.trim() || null,
            p.address?.trim() || null,
            p.zip_code?.trim() || null,
            p.is_company === true || p.is_company === 'true' || p.is_company === '1',
            JSON.stringify(customFields),
            req.userId
          ]
        );
        existingPhones.add(normalizedPhone);
        created++;
      } catch (err) {
        if (err.code === '23505') {
          duplicates++;
        } else {
          console.error('Error inserting prospect:', err);
        }
      }
    }

    res.json({ created, duplicates });
  } catch (error) {
    console.error('Error bulk creating prospects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get prospect custom fields for organization
router.get('/prospect-fields', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT * FROM crm_prospect_fields WHERE organization_id = $1 ORDER BY display_order, field_label`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    if (error.code === '42P01') return res.json([]);
    console.error('Error fetching prospect fields:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create prospect custom field
router.post('/prospect-fields', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { field_key, field_label, field_type } = req.body;
    if (!field_key || !field_label) {
      return res.status(400).json({ error: 'field_key and field_label are required' });
    }

    const result = await query(
      `INSERT INTO crm_prospect_fields (organization_id, field_key, field_label, field_type)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [org.organization_id, field_key.toLowerCase().replace(/\s+/g, '_'), field_label, field_type || 'text']
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Campo já existe' });
    }
    console.error('Error creating prospect field:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete single prospect
router.delete('/prospects/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    await query(
      `DELETE FROM crm_prospects WHERE id = $1 AND organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting prospect:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk delete prospects
router.post('/prospects/bulk-delete', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs array is required' });
    }

    await query(
      `DELETE FROM crm_prospects WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
      [ids, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error bulk deleting prospects:', error);
    res.status(500).json({ error: error.message });
  }
});

// Convert prospect to deal
router.post('/prospects/:id/convert', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { funnel_id, title, create_company, company_name } = req.body;
    if (!funnel_id) {
      return res.status(400).json({ error: 'Funnel ID is required' });
    }

    // Get prospect
    const prospectResult = await query(
      `SELECT * FROM crm_prospects WHERE id = $1 AND organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    if (prospectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Prospect not found' });
    }
    const prospect = prospectResult.rows[0];

    if (prospect.converted_at) {
      return res.status(400).json({ error: 'Prospect already converted' });
    }

    // Get first stage of funnel
    const stageResult = await query(
      `SELECT id FROM crm_stages WHERE funnel_id = $1 ORDER BY position ASC LIMIT 1`,
      [funnel_id]
    );
    if (stageResult.rows.length === 0) {
      return res.status(400).json({ error: 'Funnel has no stages' });
    }
    const stage_id = stageResult.rows[0].id;

    // Create company if requested (either from is_company flag or explicit create_company param)
    let company_id = null;
    const shouldCreateCompany = create_company === true || prospect.is_company;
    if (shouldCreateCompany) {
      const companyNameToUse = company_name?.trim() || prospect.name;
      const companyResult = await query(
        `INSERT INTO crm_companies (organization_id, name, phone, city, state, address, zip_code, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, name) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [org.organization_id, companyNameToUse, prospect.phone, prospect.city, prospect.state, prospect.address, prospect.zip_code, req.userId]
      );
      company_id = companyResult.rows[0].id;
    }

    // Create or find contact
    let contact_id = null;
    const existingContact = await query(
      `SELECT c.id FROM contacts c
       JOIN contact_lists cl ON cl.id = c.list_id
       JOIN organization_members om ON om.user_id = cl.user_id AND om.organization_id = $2
       WHERE c.phone = $1
       LIMIT 1`,
      [prospect.phone, org.organization_id]
    );

    if (existingContact.rows.length > 0) {
      contact_id = existingContact.rows[0].id;
    } else {
      // Create CRM contacts list if needed
      let crmListResult = await query(
        `SELECT cl.id FROM contact_lists cl
         JOIN organization_members om ON om.user_id = cl.user_id AND om.organization_id = $1
         WHERE cl.name = 'CRM Contacts' LIMIT 1`,
        [org.organization_id]
      );
      if (crmListResult.rows.length === 0) {
        crmListResult = await query(
          `INSERT INTO contact_lists (user_id, name) VALUES ($1, 'CRM Contacts') RETURNING id`,
          [req.userId]
        );
      }

      const newContact = await query(
        `INSERT INTO contacts (list_id, name, phone, city, state) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [crmListResult.rows[0].id, prospect.name, prospect.phone, prospect.city, prospect.state]
      );
      contact_id = newContact.rows[0].id;
    }

    // Create deal with company if applicable
    const dealResult = await query(
      `INSERT INTO crm_deals (organization_id, funnel_id, stage_id, title, contact_id, company_id, assigned_to, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'prospect')
       RETURNING id`,
      [org.organization_id, funnel_id, stage_id, title || prospect.name, contact_id, company_id, req.userId]
    );
    const deal_id = dealResult.rows[0].id;

    // Mark prospect as converted
    await query(
      `UPDATE crm_prospects SET converted_at = NOW(), converted_deal_id = $1 WHERE id = $2`,
      [deal_id, req.params.id]
    );

    res.json({ deal_id, company_id });
  } catch (error) {
    console.error('Error converting prospect:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk convert prospects to deals
router.post('/prospects/bulk-convert', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { prospect_ids, funnel_id, create_companies } = req.body;
    if (!Array.isArray(prospect_ids) || prospect_ids.length === 0 || !funnel_id) {
      return res.status(400).json({ error: 'prospect_ids array and funnel_id are required' });
    }

    // Get funnel first stage
    const stageResult = await query(
      `SELECT id FROM crm_stages WHERE funnel_id = $1 ORDER BY position LIMIT 1`,
      [funnel_id]
    );
    if (stageResult.rows.length === 0) {
      return res.status(400).json({ error: 'Funnel has no stages' });
    }
    const stage_id = stageResult.rows[0].id;

    let converted = 0;
    let skipped = 0;
    let companies_created = 0;

    for (const prospect_id of prospect_ids) {
      try {
        // Get prospect
        const prospectResult = await query(
          `SELECT * FROM crm_prospects WHERE id = $1 AND organization_id = $2 AND converted_at IS NULL`,
          [prospect_id, org.organization_id]
        );
        if (prospectResult.rows.length === 0) {
          skipped++;
          continue;
        }
        const prospect = prospectResult.rows[0];

        // Find or create contact using contact_lists via organization membership
        let contactId = null;
        const existingContact = await query(
          `SELECT c.id FROM contacts c 
           JOIN contact_lists cl ON cl.id = c.list_id
           JOIN organization_members om ON om.user_id = cl.user_id AND om.organization_id = $1
           WHERE c.phone = $2
           LIMIT 1`,
          [org.organization_id, prospect.phone]
        );
        if (existingContact.rows.length > 0) {
          contactId = existingContact.rows[0].id;
        } else {
          // Ensure CRM contacts list exists
          let crmListResult = await query(
            `SELECT cl.id FROM contact_lists cl
             JOIN organization_members om ON om.user_id = cl.user_id AND om.organization_id = $1
             WHERE cl.name = 'CRM Contacts' LIMIT 1`,
            [org.organization_id]
          );
          if (crmListResult.rows.length === 0) {
            crmListResult = await query(
              `INSERT INTO contact_lists (user_id, name) VALUES ($1, 'CRM Contacts') RETURNING id`,
              [req.userId]
            );
          }
          
          const newContact = await query(
            `INSERT INTO contacts (list_id, name, phone)
             VALUES ($1, $2, $3) RETURNING id`,
            [crmListResult.rows[0].id, prospect.name, prospect.phone]
          );
          contactId = newContact.rows[0].id;
        }

        // Create company if requested or if prospect is marked as company
        let companyId = null;
        const shouldCreateCompany = create_companies === true || prospect.is_company;
        if (shouldCreateCompany) {
          const companyResult = await query(
            `INSERT INTO crm_companies (organization_id, name, phone, city, state, address, zip_code, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (organization_id, name) DO UPDATE SET updated_at = NOW()
             RETURNING id`,
            [org.organization_id, prospect.name, prospect.phone, prospect.city, prospect.state, prospect.address, prospect.zip_code, req.userId]
          );
          companyId = companyResult.rows[0].id;
          companies_created++;
        }

        // Create deal
        const dealResult = await query(
          `INSERT INTO crm_deals (organization_id, funnel_id, stage_id, title, contact_id, company_id, source, responsible_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'prospect', $7)
           RETURNING id`,
          [org.organization_id, funnel_id, stage_id, prospect.name, contactId, companyId, req.userId]
        );

        // Mark prospect as converted
        await query(
          `UPDATE crm_prospects SET converted_at = NOW(), converted_deal_id = $1 WHERE id = $2`,
          [dealResult.rows[0].id, prospect_id]
        );

        converted++;
      } catch (err) {
        console.error(`Error converting prospect ${prospect_id}:`, err);
        skipped++;
      }
    }

    res.json({ converted, skipped, companies_created });
  } catch (error) {
    console.error('Error bulk converting prospects:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// MAP DATA
// =============================================================================

// Get map data (deals, prospects, companies with location info)
router.get('/map-data', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { owner_id, date_type, date_from, date_to } = req.query;
    const locations = [];

    // State capitals for approximate positioning
    const STATE_CAPITALS = {
      AC: { lat: -9.9753, lng: -67.8243 }, AL: { lat: -9.6499, lng: -35.7089 },
      AM: { lat: -3.1190, lng: -60.0217 }, AP: { lat: 0.0356, lng: -51.0705 },
      BA: { lat: -12.9714, lng: -38.5014 }, CE: { lat: -3.7172, lng: -38.5433 },
      DF: { lat: -15.8267, lng: -47.9218 }, ES: { lat: -20.3155, lng: -40.3128 },
      GO: { lat: -16.6864, lng: -49.2643 }, MA: { lat: -2.5387, lng: -44.2826 },
      MG: { lat: -19.9167, lng: -43.9345 }, MS: { lat: -20.4697, lng: -54.6201 },
      MT: { lat: -15.5989, lng: -56.0949 }, PA: { lat: -1.4558, lng: -48.4902 },
      PB: { lat: -7.1195, lng: -34.8450 }, PE: { lat: -8.0476, lng: -34.8770 },
      PI: { lat: -5.0892, lng: -42.8019 }, PR: { lat: -25.4195, lng: -49.2646 },
      RJ: { lat: -22.9068, lng: -43.1729 }, RN: { lat: -5.7945, lng: -35.2110 },
      RO: { lat: -8.7612, lng: -63.9039 }, RR: { lat: 2.8235, lng: -60.6758 },
      RS: { lat: -30.0346, lng: -51.2177 }, SC: { lat: -27.5954, lng: -48.5480 },
      SE: { lat: -10.9472, lng: -37.0731 }, SP: { lat: -23.5505, lng: -46.6333 },
      TO: { lat: -10.1689, lng: -48.3317 },
    };

    const CITY_COORDS = {
      'são paulo': { lat: -23.5505, lng: -46.6333 }, 'sao paulo': { lat: -23.5505, lng: -46.6333 },
      'rio de janeiro': { lat: -22.9068, lng: -43.1729 }, 'belo horizonte': { lat: -19.9167, lng: -43.9345 },
      'brasília': { lat: -15.8267, lng: -47.9218 }, 'brasilia': { lat: -15.8267, lng: -47.9218 },
      'salvador': { lat: -12.9714, lng: -38.5014 }, 'fortaleza': { lat: -3.7172, lng: -38.5433 },
      'curitiba': { lat: -25.4195, lng: -49.2646 }, 'recife': { lat: -8.0476, lng: -34.8770 },
      'porto alegre': { lat: -30.0346, lng: -51.2177 }, 'manaus': { lat: -3.1190, lng: -60.0217 },
      'belém': { lat: -1.4558, lng: -48.4902 }, 'belem': { lat: -1.4558, lng: -48.4902 },
      'goiânia': { lat: -16.6864, lng: -49.2643 }, 'goiania': { lat: -16.6864, lng: -49.2643 },
      'guarulhos': { lat: -23.4543, lng: -46.5337 }, 'campinas': { lat: -22.9099, lng: -47.0626 },
      'florianópolis': { lat: -27.5954, lng: -48.5480 }, 'florianopolis': { lat: -27.5954, lng: -48.5480 },
      'natal': { lat: -5.7945, lng: -35.2110 }, 'joão pessoa': { lat: -7.1195, lng: -34.8450 },
      'joao pessoa': { lat: -7.1195, lng: -34.8450 }, 'vitória': { lat: -20.3155, lng: -40.3128 },
      'vitoria': { lat: -20.3155, lng: -40.3128 }, 'cuiabá': { lat: -15.5989, lng: -56.0949 },
      'cuiaba': { lat: -15.5989, lng: -56.0949 }, 'campo grande': { lat: -20.4697, lng: -54.6201 },
      'são luís': { lat: -2.5387, lng: -44.2826 }, 'sao luis': { lat: -2.5387, lng: -44.2826 },
      'maceió': { lat: -9.6499, lng: -35.7089 }, 'maceio': { lat: -9.6499, lng: -35.7089 },
      'teresina': { lat: -5.0892, lng: -42.8019 }, 'aracaju': { lat: -10.9472, lng: -37.0731 },
      'londrina': { lat: -23.3103, lng: -51.1628 }, 'uberlândia': { lat: -18.9113, lng: -48.2622 },
      'uberlandia': { lat: -18.9113, lng: -48.2622 }, 'sorocaba': { lat: -23.5015, lng: -47.4526 },
      'ribeirão preto': { lat: -21.1775, lng: -47.8103 }, 'ribeirao preto': { lat: -21.1775, lng: -47.8103 },
      'contagem': { lat: -19.9318, lng: -44.0539 }, 'niterói': { lat: -22.8838, lng: -43.1038 },
      'niteroi': { lat: -22.8838, lng: -43.1038 }, 'joinville': { lat: -26.3045, lng: -48.8487 },
      'santos': { lat: -23.9619, lng: -46.3342 },
      'são josé dos campos': { lat: -23.1896, lng: -45.8841 }, 'sao jose dos campos': { lat: -23.1896, lng: -45.8841 },
      'osasco': { lat: -23.5329, lng: -46.7917 },
      'santo andré': { lat: -23.6737, lng: -46.5432 }, 'santo andre': { lat: -23.6737, lng: -46.5432 },
      'são bernardo do campo': { lat: -23.7117, lng: -46.5653 }, 'sao bernardo do campo': { lat: -23.7117, lng: -46.5653 },
    };

    const getCoords = (city, state) => {
      if (city) {
        const cityLower = city.toLowerCase().trim();
        if (CITY_COORDS[cityLower]) {
          const cap = CITY_COORDS[cityLower];
          const offset = () => (Math.random() - 0.5) * 0.02;
          return { lat: cap.lat + offset(), lng: cap.lng + offset() };
        }
      }
      if (state && STATE_CAPITALS[state.toUpperCase()]) {
        const cap = STATE_CAPITALS[state.toUpperCase()];
        const offset = () => (Math.random() - 0.5) * 0.1;
        return { lat: cap.lat + offset(), lng: cap.lng + offset() };
      }
      return null;
    };

    // Helper to build date filter SQL
    const buildDateFilter = (alias, paramIndex) => {
      let sql = '';
      const params = [];
      if (date_from || date_to) {
        const dateCol = date_type === 'activity' ? `${alias}.last_activity_at` : `${alias}.created_at`;
        if (date_from) {
          sql += ` AND ${dateCol} >= $${paramIndex}`;
          params.push(date_from);
          paramIndex++;
        }
        if (date_to) {
          sql += ` AND ${dateCol} <= $${paramIndex}`;
          params.push(date_to + 'T23:59:59Z');
          paramIndex++;
        }
      }
      return { sql, params, nextIndex: paramIndex };
    };

    // Get deals
    try {
      let dealSql = `SELECT d.id, d.title, d.value, d.owner_id, d.created_at,
              ow.name as owner_name,
              c.phone, c.city, c.state,
              co.name as company_name, co.city as company_city, co.state as company_state, co.address as company_address
       FROM crm_deals d
       LEFT JOIN contacts c ON d.contact_id = c.id
       LEFT JOIN crm_companies co ON d.company_id = co.id
       LEFT JOIN users ow ON ow.id = d.owner_id
       WHERE d.organization_id = $1 AND d.status = 'open'`;
      const dealParams = [org.organization_id];
      let pi = 2;
      if (owner_id) {
        dealSql += ` AND d.owner_id = $${pi}`;
        dealParams.push(owner_id);
        pi++;
      }
      const df = buildDateFilter('d', pi);
      dealSql += df.sql;
      dealParams.push(...df.params);

      const dealsResult = await query(dealSql, dealParams);
      for (const deal of dealsResult.rows) {
        const city = deal.company_city || deal.city;
        const state = deal.company_state || deal.state;
        const coords = getCoords(city, state);
        if (coords) {
          locations.push({
            id: deal.id, type: 'deal', name: deal.title, phone: deal.phone,
            city, state, lat: coords.lat, lng: coords.lng, value: deal.value,
            owner_id: deal.owner_id, owner_name: deal.owner_name, created_at: deal.created_at,
            company_name: deal.company_name, address: deal.company_address,
          });
        }
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.error('Error fetching deals for map:', e.message);
    }

    // Get prospects
    try {
      let prospSql = `SELECT id, name, phone, city, state, created_at FROM crm_prospects WHERE organization_id = $1 AND converted_at IS NULL`;
      const prospParams = [org.organization_id];
      let pi = 2;
      // Prospects don't have owner_id typically, skip owner filter for them
      const df = buildDateFilter('crm_prospects', pi);
      // Use inline alias workaround
      if (date_from || date_to) {
        const dateCol = date_type === 'activity' ? 'created_at' : 'created_at';
        if (date_from) { prospSql += ` AND ${dateCol} >= $${pi}`; prospParams.push(date_from); pi++; }
        if (date_to) { prospSql += ` AND ${dateCol} <= $${pi}`; prospParams.push(date_to + 'T23:59:59Z'); pi++; }
      }

      const prospectsResult = await query(prospSql, prospParams);
      for (const p of prospectsResult.rows) {
        const coords = getCoords(p.city, p.state);
        if (coords) {
          locations.push({
            id: p.id, type: 'prospect', name: p.name, phone: p.phone,
            city: p.city, state: p.state, lat: coords.lat, lng: coords.lng,
            created_at: p.created_at,
          });
        }
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.error('Error fetching prospects for map:', e.message);
    }

    // Get companies
    try {
      let compSql = `SELECT c.id, c.name, c.phone, c.city, c.state, c.address, c.cnpj, c.cnae, c.porte, c.owner_id, c.created_at, ow.name as owner_name
       FROM crm_companies c LEFT JOIN users ow ON ow.id = c.owner_id WHERE c.organization_id = $1`;
      const compParams = [org.organization_id];
      let pi = 2;
      if (owner_id) {
        compSql += ` AND c.owner_id = $${pi}`;
        compParams.push(owner_id);
        pi++;
      }
      if (date_from) { compSql += ` AND c.created_at >= $${pi}`; compParams.push(date_from); pi++; }
      if (date_to) { compSql += ` AND c.created_at <= $${pi}`; compParams.push(date_to + 'T23:59:59Z'); pi++; }

      const companiesResult = await query(compSql, compParams);
      for (const company of companiesResult.rows) {
        const coords = getCoords(company.city, company.state);
        if (coords) {
          locations.push({
            id: company.id, type: 'company', name: company.name, phone: company.phone,
            city: company.city, state: company.state, lat: coords.lat, lng: coords.lng,
            owner_id: company.owner_id, owner_name: company.owner_name, created_at: company.created_at,
            address: company.address, cnpj: company.cnpj, cnae: company.cnae, porte: company.porte,
          });
        }
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') console.error('Error fetching companies for map:', e.message);
    }

    res.json(locations);
  } catch (error) {
    console.error('Error fetching map data:', error);
    res.json([]);
  }
});

// Get users for map filter
router.get('/map-users', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT u.id, u.name FROM users u
       INNER JOIN organization_members om ON om.user_id = u.id
       WHERE om.organization_id = $1 ORDER BY u.name`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching map users:', error);
    res.json([]);
  }
});

// ============================================
// LOSS REASONS (Motivos de Perda)
// ============================================

// List loss reasons
router.get('/config/loss-reasons', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const result = await query(
      `SELECT * FROM crm_loss_reasons 
       WHERE organization_id = $1 OR organization_id IS NULL
       ORDER BY position ASC, name ASC`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    if (error.code === '42P01') {
      return res.json([]);
    }
    console.error('Error fetching loss reasons:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create loss reason
router.post('/config/loss-reasons', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });
    if (!canManage(org.role)) return res.status(403).json({ error: 'Not authorized' });

    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    // Get next position
    const posResult = await query(
      `SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM crm_loss_reasons WHERE organization_id = $1`,
      [org.organization_id]
    );
    const position = posResult.rows[0].next_pos;

    const result = await query(
      `INSERT INTO crm_loss_reasons (organization_id, name, description, position)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [org.organization_id, name.trim(), description || null, position]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating loss reason:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update loss reason
router.put('/config/loss-reasons/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });
    if (!canManage(org.role)) return res.status(403).json({ error: 'Not authorized' });

    const { name, description, is_active, position } = req.body;
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      values.push(name.trim());
      paramIndex++;
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      values.push(description);
      paramIndex++;
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex}`);
      values.push(is_active);
      paramIndex++;
    }
    if (position !== undefined) {
      updates.push(`position = $${paramIndex}`);
      values.push(position);
      paramIndex++;
    }

    updates.push('updated_at = NOW()');
    values.push(req.params.id, org.organization_id);

    const result = await query(
      `UPDATE crm_loss_reasons SET ${updates.join(', ')} 
       WHERE id = $${paramIndex} AND organization_id = $${paramIndex + 1} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating loss reason:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete loss reason
router.delete('/config/loss-reasons/:id', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });
    if (!canManage(org.role)) return res.status(403).json({ error: 'Not authorized' });

    await query(
      `DELETE FROM crm_loss_reasons WHERE id = $1 AND organization_id = $2`,
      [req.params.id, org.organization_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting loss reason:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset loss reasons to defaults
router.post('/config/loss-reasons/reset-defaults', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });
    if (!canManage(org.role)) return res.status(403).json({ error: 'Not authorized' });

    // Delete all existing loss reasons for this organization
    await query(
      `DELETE FROM crm_loss_reasons WHERE organization_id = $1`,
      [org.organization_id]
    );

    // Insert default loss reasons
    const defaultReasons = [
      { name: 'Preço muito alto', description: 'Cliente achou o valor elevado para o orçamento disponível' },
      { name: 'Concorrência', description: 'Cliente optou por outro fornecedor ou solução' },
      { name: 'Sem resposta', description: 'Cliente parou de responder e não retornou contato' },
      { name: 'Timing ruim', description: 'Não é o momento certo para o cliente' },
      { name: 'Desistiu do projeto', description: 'Cliente decidiu não seguir com o projeto ou compra' },
    ];

    for (let i = 0; i < defaultReasons.length; i++) {
      await query(
        `INSERT INTO crm_loss_reasons (organization_id, name, description, position, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [org.organization_id, defaultReasons[i].name, defaultReasons[i].description, i]
      );
    }

    // Return the new list
    const result = await query(
      `SELECT * FROM crm_loss_reasons 
       WHERE organization_id = $1
       ORDER BY position ASC`,
      [org.organization_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error resetting loss reasons:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cleanup duplicate loss reasons (global + organization)
router.post('/config/loss-reasons/cleanup', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });
    if (!canManage(org.role)) return res.status(403).json({ error: 'Not authorized' });

    // 1) Remove duplicate global reasons (organization_id IS NULL), keep oldest per name
    const deletedGlobal = await query(`
      DELETE FROM crm_loss_reasons
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at ASC) AS rn
          FROM crm_loss_reasons
          WHERE organization_id IS NULL
        ) t
        WHERE rn > 1
      )
      RETURNING id, name
    `);

    // 2) Remove duplicate org reasons, keep oldest per name
    const deletedOrg = await query(
      `DELETE FROM crm_loss_reasons
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (PARTITION BY organization_id, name ORDER BY created_at ASC) AS rn
           FROM crm_loss_reasons
           WHERE organization_id = $1
         ) t
         WHERE rn > 1
       )
       RETURNING id, name`,
      [org.organization_id]
    );

    // Best-effort: ensure unique indexes exist (won't expose 500 if already there)
    try {
      await query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_loss_reasons_global_name
         ON crm_loss_reasons (name) WHERE organization_id IS NULL`
      );
    } catch {
      // ignore
    }
    try {
      await query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_loss_reasons_org_name
         ON crm_loss_reasons (organization_id, name) WHERE organization_id IS NOT NULL`
      );
    } catch {
      // ignore
    }

    res.json({
      success: true,
      deleted_count: deletedGlobal.rows.length + deletedOrg.rows.length,
      deleted_global_count: deletedGlobal.rows.length,
      deleted_org_count: deletedOrg.rows.length,
    });
  } catch (error) {
    console.error('Error cleaning up loss reasons:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// REVENUE INTELLIGENCE
// ============================================

// Revenue forecast
router.get('/intelligence/revenue-forecast', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { months = 6 } = req.query;

    // Get current pipeline value by stage
    // Note: crm_lead_scores may not exist in some deployments; fallback gracefully.
    let pipelineData;
    try {
      pipelineData = await query(
        `SELECT 
          f.name as funnel_name,
          s.name as stage_name,
          s.position,
          s.is_final,
          COUNT(d.id) as deal_count,
          COALESCE(SUM(d.value), 0) as total_value,
          COALESCE(SUM(ls.score), 0) / NULLIF(COUNT(d.id), 0) as avg_lead_score
         FROM crm_deals d
         JOIN crm_stages s ON s.id = d.stage_id
         JOIN crm_funnels f ON f.id = d.funnel_id
         LEFT JOIN crm_lead_scores ls ON ls.deal_id = d.id
         WHERE d.organization_id = $1 AND d.status = 'open'
         GROUP BY f.id, f.name, s.id, s.name, s.position, s.is_final
         ORDER BY f.name, s.position`,
        [org.organization_id]
      );
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      pipelineData = await query(
        `SELECT 
          f.name as funnel_name,
          s.name as stage_name,
          s.position,
          s.is_final,
          COUNT(d.id) as deal_count,
          COALESCE(SUM(d.value), 0) as total_value,
          NULL::numeric as avg_lead_score
         FROM crm_deals d
         JOIN crm_stages s ON s.id = d.stage_id
         JOIN crm_funnels f ON f.id = d.funnel_id
         WHERE d.organization_id = $1 AND d.status = 'open'
         GROUP BY f.id, f.name, s.id, s.name, s.position, s.is_final
         ORDER BY f.name, s.position`,
        [org.organization_id]
      );
    }

    // Calculate weighted pipeline (value * probability based on stage position)
    // Get total stages per funnel for probability calculation
    const stagesCounts = await query(
      `SELECT f.id as funnel_id, COUNT(s.id) as total_stages
       FROM crm_funnels f
       JOIN crm_stages s ON s.funnel_id = f.id
       WHERE f.organization_id = $1
       GROUP BY f.id`,
      [org.organization_id]
    );

    const stageTotals = {};
    stagesCounts.rows.forEach(r => { stageTotals[r.funnel_id] = parseInt(r.total_stages); });

    // Historical win rates by month
    const historicalWins = await query(
      `SELECT 
        DATE_TRUNC('month', ${closedAtSql('d')}) as month,
        COUNT(*) as won_count,
        COALESCE(SUM(value), 0) as won_value
       FROM crm_deals d
       WHERE d.organization_id = $1 AND d.status = 'won' AND ${closedAtSql('d')} IS NOT NULL
         AND ${closedAtSql('d')} >= NOW() - INTERVAL '12 months'
       GROUP BY DATE_TRUNC('month', ${closedAtSql('d')})
       ORDER BY month DESC`,
      [org.organization_id]
    );

    // Average deal value
    const avgDeal = await query(
      `SELECT 
        AVG(value) as avg_value,
        AVG(EXTRACT(EPOCH FROM (${closedAtSql('d')} - d.created_at)) / 86400) as avg_days_to_close
       FROM crm_deals d
       WHERE d.organization_id = $1 AND d.status = 'won' AND d.value > 0`,
      [org.organization_id]
    );

    // Monthly projection based on current pipeline and historical conversion
    const avgMonthlyWon = historicalWins.rows.length > 0
      ? historicalWins.rows.reduce((sum, r) => sum + parseFloat(r.won_value || 0), 0) / historicalWins.rows.length
      : 0;

    // Generate forecast for next N months
    const forecast = [];
    const currentPipelineValue = pipelineData.rows.reduce((sum, r) => sum + parseFloat(r.total_value || 0), 0);
    
    for (let i = 0; i < parseInt(months); i++) {
      const date = new Date();
      date.setMonth(date.getMonth() + i);
      const monthStr = date.toISOString().substring(0, 7);
      
      // Weighted forecast: blend of historical average and current pipeline probability
      const historicalWeight = 0.6;
      const pipelineWeight = 0.4;
      const pipelineMonthlyProjection = currentPipelineValue / 3; // Assume 3-month avg cycle
      
      const projectedValue = (avgMonthlyWon * historicalWeight) + (pipelineMonthlyProjection * pipelineWeight);
      const confidenceFactor = Math.max(0.5, 1 - (i * 0.1)); // Lower confidence further out
      
      forecast.push({
        month: monthStr,
        projected: Math.round(projectedValue * confidenceFactor),
        optimistic: Math.round(projectedValue * confidenceFactor * 1.3),
        pessimistic: Math.round(projectedValue * confidenceFactor * 0.7),
        confidence: Math.round(confidenceFactor * 100)
      });
    }

    res.json({
      pipeline: pipelineData.rows,
      historical_wins: historicalWins.rows,
      avg_deal_value: parseFloat(avgDeal.rows[0]?.avg_value || 0),
      avg_days_to_close: parseFloat(avgDeal.rows[0]?.avg_days_to_close || 0),
      current_pipeline_value: currentPipelineValue,
      forecast
    });
  } catch (error) {
    console.error('Revenue forecast error:', error);
    if (isMissingSchemaError(error)) {
      return res.json({
        pipeline: [],
        historical_wins: [],
        avg_deal_value: 0,
        avg_days_to_close: 0,
        current_pipeline_value: 0,
        forecast: [],
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// Pipeline velocity
router.get('/intelligence/pipeline-velocity', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { funnel_id } = req.query;

    let funnelFilter = '';
    const params = [org.organization_id];
    if (funnel_id) {
      funnelFilter = 'AND d.funnel_id = $2';
      params.push(funnel_id);
    }

    // Velocity metrics
    // Use won_at/lost_at instead of closed_at (which doesn't exist in this schema)
    const velocityMetrics = await query(
      `SELECT 
        COUNT(*) FILTER (WHERE status = 'won') as won_deals,
        COUNT(*) FILTER (WHERE status = 'open') as open_deals,
        AVG(value) FILTER (WHERE status = 'won') as avg_deal_value,
        AVG(EXTRACT(EPOCH FROM (${closedAtSql('d')} - d.created_at)) / 86400) FILTER (WHERE status = 'won' AND ${closedAtSql('d')} IS NOT NULL) as avg_cycle_days,
        (COUNT(*) FILTER (WHERE status = 'won')::decimal / NULLIF(COUNT(*) FILTER (WHERE status IN ('won', 'lost')), 0)) * 100 as win_rate
       FROM crm_deals d
       WHERE d.organization_id = $1 ${funnelFilter}`,
      params
    );

    // Stage conversion rates
    const stageConversion = await query(
      `WITH stage_moves AS (
        SELECT 
          s.id as stage_id,
          s.name as stage_name,
          s.position,
          COUNT(DISTINCT d.id) as deals_entered,
          COUNT(DISTINCT CASE WHEN d.status = 'won' THEN d.id END) as deals_won
        FROM crm_stages s
        JOIN crm_funnels f ON f.id = s.funnel_id
        LEFT JOIN crm_deals d ON d.stage_id = s.id AND d.organization_id = $1 ${funnel_id ? 'AND d.funnel_id = $2' : ''}
        WHERE f.organization_id = $1 ${funnel_id ? 'AND s.funnel_id = $2' : ''}
        GROUP BY s.id, s.name, s.position
      )
      SELECT *, 
        ROUND((deals_won::decimal / NULLIF(deals_entered, 0)) * 100, 1) as conversion_rate
      FROM stage_moves
      ORDER BY position`,
      params
    );

    // Time in each stage (avg days)
    const stageTime = await query(
      `SELECT 
        s.name as stage_name,
        s.position,
        AVG(EXTRACT(EPOCH FROM (
          COALESCE(${closedAtSql('d')}, NOW()) - d.updated_at
        )) / 86400) as avg_days_in_stage
       FROM crm_deals d
       JOIN crm_stages s ON s.id = d.stage_id
       WHERE d.organization_id = $1 ${funnelFilter}
       GROUP BY s.id, s.name, s.position
       ORDER BY s.position`,
      params
    );

    // Pipeline velocity = (# of deals * avg deal value * win rate) / avg cycle length
    const metrics = velocityMetrics.rows[0];
    const velocity = metrics.avg_cycle_days > 0
      ? ((parseFloat(metrics.open_deals) * parseFloat(metrics.avg_deal_value || 0) * (parseFloat(metrics.win_rate || 0) / 100)) / parseFloat(metrics.avg_cycle_days))
      : 0;

    res.json({
      velocity: Math.round(velocity),
      metrics: {
        won_deals: parseInt(metrics.won_deals || 0),
        open_deals: parseInt(metrics.open_deals || 0),
        avg_deal_value: parseFloat(metrics.avg_deal_value || 0),
        avg_cycle_days: Math.round(parseFloat(metrics.avg_cycle_days || 0)),
        win_rate: Math.round(parseFloat(metrics.win_rate || 0))
      },
      stage_conversion: stageConversion.rows,
      stage_time: stageTime.rows
    });
  } catch (error) {
    console.error('Pipeline velocity error:', error);
    if (isMissingSchemaError(error)) {
      return res.json({
        velocity: 0,
        metrics: {
          won_deals: 0,
          open_deals: 0,
          avg_deal_value: 0,
          avg_cycle_days: 0,
          win_rate: 0,
        },
        stage_conversion: [],
        stage_time: [],
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// Win/Loss analysis
router.get('/intelligence/win-loss-analysis', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const { start_date, end_date, funnel_id } = req.query;

    let dateFilter = '';
    let funnelFilter = '';
    const params = [org.organization_id];
    let paramIndex = 2;

    if (start_date && end_date) {
      dateFilter = `AND ${closedAtSql('d')} BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(start_date, end_date);
      paramIndex += 2;
    }
    if (funnel_id) {
      funnelFilter = `AND d.funnel_id = $${paramIndex}`;
      params.push(funnel_id);
    }

    // Win/Loss summary
    const summary = await query(
      `SELECT 
        status,
        COUNT(*) as count,
        COALESCE(SUM(value), 0) as total_value,
        AVG(value) as avg_value,
        AVG(EXTRACT(EPOCH FROM (${closedAtSql('d')} - created_at)) / 86400) as avg_days
       FROM crm_deals d
       WHERE d.organization_id = $1 AND d.status IN ('won', 'lost') ${dateFilter} ${funnelFilter}
       GROUP BY status`,
      params
    );

    // Loss reasons breakdown
    // Some schemas store the reason as free text (crm_deals.lost_reason).
    const lossReasons = await query(
      `SELECT 
        COALESCE(NULLIF(BTRIM(d.lost_reason), ''), 'Sem motivo') as reason,
        COUNT(d.id) as count,
        COALESCE(SUM(d.value), 0) as lost_value
       FROM crm_deals d
       WHERE d.organization_id = $1 AND d.status = 'lost' ${dateFilter} ${funnelFilter}
       GROUP BY COALESCE(NULLIF(BTRIM(d.lost_reason), ''), 'Sem motivo')
       ORDER BY count DESC`,
      params
    );

    // Win/Loss by owner
    const byOwner = await query(
      `SELECT 
        u.id as user_id,
        u.name as user_name,
        COUNT(*) FILTER (WHERE d.status = 'won') as won_count,
        COUNT(*) FILTER (WHERE d.status = 'lost') as lost_count,
        COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) as won_value,
        ROUND((COUNT(*) FILTER (WHERE d.status = 'won')::decimal / NULLIF(COUNT(*), 0)) * 100, 1) as win_rate
       FROM crm_deals d
       JOIN users u ON u.id = d.owner_id
       WHERE d.organization_id = $1 AND d.status IN ('won', 'lost') ${dateFilter} ${funnelFilter}
       GROUP BY u.id, u.name
       ORDER BY won_count DESC`,
      params
    );

    // Win/Loss by company segment (column can vary by schema; fallback to custom_fields->>'segment')
    let bySegment;
    try {
      bySegment = await query(
        `SELECT 
          COALESCE(c.segment, 'Sem segmento') as segment,
          COUNT(*) FILTER (WHERE d.status = 'won') as won_count,
          COUNT(*) FILTER (WHERE d.status = 'lost') as lost_count,
          COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) as won_value
         FROM crm_deals d
         LEFT JOIN crm_companies c ON c.id = d.company_id
         WHERE d.organization_id = $1 AND d.status IN ('won', 'lost') ${dateFilter} ${funnelFilter}
         GROUP BY c.segment
         ORDER BY won_count DESC`,
        params
      );
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      // crm_companies pode não ter `segment` e também pode não ter `custom_fields`.
      // Nesse caso, agrupa tudo como "Sem segmento" em vez de derrubar o dashboard.
      try {
        bySegment = await query(
          `SELECT
            COALESCE(NULLIF(BTRIM(c.custom_fields->>'segment'), ''), 'Sem segmento') as segment,
            COUNT(*) FILTER (WHERE d.status = 'won') as won_count,
            COUNT(*) FILTER (WHERE d.status = 'lost') as lost_count,
            COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) as won_value
           FROM crm_deals d
           LEFT JOIN crm_companies c ON c.id = d.company_id
           WHERE d.organization_id = $1 AND d.status IN ('won', 'lost') ${dateFilter} ${funnelFilter}
           GROUP BY COALESCE(NULLIF(BTRIM(c.custom_fields->>'segment'), ''), 'Sem segmento')
           ORDER BY won_count DESC`,
          params
        );
      } catch (fallbackError) {
        if (!isMissingSchemaError(fallbackError)) throw fallbackError;
        bySegment = await query(
          `SELECT
            'Sem segmento' as segment,
            COUNT(*) FILTER (WHERE d.status = 'won') as won_count,
            COUNT(*) FILTER (WHERE d.status = 'lost') as lost_count,
            COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'), 0) as won_value
           FROM crm_deals d
           WHERE d.organization_id = $1 AND d.status IN ('won', 'lost') ${dateFilter} ${funnelFilter}
           ORDER BY won_count DESC`,
          params
        );
      }
    }

    // Win/Loss trend by month
    const trend = await query(
      `SELECT 
        DATE_TRUNC('month', ${closedAtSql('d')}) as month,
        COUNT(*) FILTER (WHERE status = 'won') as won_count,
        COUNT(*) FILTER (WHERE status = 'lost') as lost_count,
        COALESCE(SUM(value) FILTER (WHERE status = 'won'), 0) as won_value,
        COALESCE(SUM(value) FILTER (WHERE status = 'lost'), 0) as lost_value
       FROM crm_deals d
       WHERE d.organization_id = $1 AND d.status IN ('won', 'lost') AND ${closedAtSql('d')} IS NOT NULL
         AND ${closedAtSql('d')} >= NOW() - INTERVAL '12 months'
       GROUP BY DATE_TRUNC('month', ${closedAtSql('d')})
       ORDER BY month ASC`,
      [org.organization_id]
    );

    const wonData = summary.rows.find(r => r.status === 'won') || { count: 0, total_value: 0, avg_value: 0, avg_days: 0 };
    const lostData = summary.rows.find(r => r.status === 'lost') || { count: 0, total_value: 0, avg_value: 0, avg_days: 0 };

    res.json({
      summary: {
        won: {
          count: parseInt(wonData.count || 0),
          total_value: parseFloat(wonData.total_value || 0),
          avg_value: parseFloat(wonData.avg_value || 0),
          avg_days: Math.round(parseFloat(wonData.avg_days || 0))
        },
        lost: {
          count: parseInt(lostData.count || 0),
          total_value: parseFloat(lostData.total_value || 0),
          avg_value: parseFloat(lostData.avg_value || 0),
          avg_days: Math.round(parseFloat(lostData.avg_days || 0))
        },
        win_rate: Math.round((parseInt(wonData.count || 0) / Math.max(1, parseInt(wonData.count || 0) + parseInt(lostData.count || 0))) * 100)
      },
      loss_reasons: lossReasons.rows,
      by_owner: byOwner.rows,
      by_segment: bySegment.rows,
      trend: trend.rows
    });
  } catch (error) {
    console.error('Win/Loss analysis error:', error);
    if (isMissingSchemaError(error)) {
      return res.json({
        summary: {
          won: { count: 0, total_value: 0, avg_value: 0, avg_days: 0 },
          lost: { count: 0, total_value: 0, avg_value: 0, avg_days: 0 },
          win_rate: 0,
        },
        loss_reasons: [],
        by_owner: [],
        by_segment: [],
        trend: [],
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// CNPJ lookup via Gleego API
router.get('/cnpj/:cnpj', async (req, res) => {
  try {
    const org = await getUserOrg(req.userId);
    if (!org) return res.status(403).json({ error: 'No organization' });

    const cnpj = req.params.cnpj.replace(/\D/g, '');
    if (cnpj.length !== 14) {
      return res.status(400).json({ error: 'CNPJ deve ter 14 dígitos' });
    }

    // Get token from system_settings
    const tokenResult = await query(`SELECT value FROM system_settings WHERE key = 'cnpj_api_token'`);
    const token = tokenResult.rows[0]?.value;
    if (!token) {
      return res.status(400).json({ error: 'Token da API CNPJ não configurado. Configure em Admin > Integrações.' });
    }

    const response = await fetch(`https://cnpj.gleego.com.br/api/v1/cnpj/${cnpj}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      const errText = await response.text();
      logError('CNPJ lookup failed', { status: response.status, body: errText });
      return res.status(response.status).json({ error: `Erro na consulta: ${response.status}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    logError('CNPJ lookup error', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
