import { query } from './db.js';

/**
 * Promoter Score Calculator — runs periodically to recalculate scores
 * based on: presence, punctuality, permanence, identity, incidents
 */

async function ensureScoreInfra() {
  await query(`CREATE TABLE IF NOT EXISTS promoter_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agency_promoter_id UUID NOT NULL REFERENCES agency_promoters(id) ON DELETE CASCADE,
    score NUMERIC(5,2) DEFAULT 100.00,
    presence_score NUMERIC(5,2) DEFAULT 100.00,
    punctuality_score NUMERIC(5,2) DEFAULT 100.00,
    permanence_score NUMERIC(5,2) DEFAULT 100.00,
    identity_score NUMERIC(5,2) DEFAULT 100.00,
    incidents_score NUMERIC(5,2) DEFAULT 100.00,
    total_visits INTEGER DEFAULT 0,
    total_incidents INTEGER DEFAULT 0,
    total_blocks INTEGER DEFAULT 0,
    last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, agency_promoter_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS score_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promoter_score_id UUID NOT NULL REFERENCES promoter_scores(id) ON DELETE CASCADE,
    score NUMERIC(5,2) NOT NULL,
    calculated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_promoter_scores_org ON promoter_scores(organization_id, score DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_score_history ON score_history(promoter_score_id, calculated_at DESC)`);
}

export async function executeScoreCalculation() {
  console.log('⭐ [CRON] Starting promoter score calculation...');
  let calculated = 0;

  try {
    await ensureScoreInfra();

    // Get all active promoters with their orgs
    // O organizacao do promotor de agencia vem da agencia (agency_promoters -> agencies -> organizations),
    // por isso o join: agency_promoters nao tem organization_id proprio.
    const promoters = await query(`
      SELECT ap.id as promoter_id, ag.organization_id
      FROM agency_promoters ap
      JOIN agencies ag ON ag.id = ap.agency_id
      WHERE ap.status = 'active'
    `);

    if (!promoters.rows.length) {
      console.log('⭐ [CRON] No active promoters found');
      return { calculated: 0 };
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysStr = thirtyDaysAgo.toISOString().split('T')[0];

    for (const p of promoters.rows) {
      try {
        // === 1. PRESENCE SCORE (based on scheduled vs actual visits in last 30 days) ===
        let presenceScore = 100;
        const snapshots = await query(
          `SELECT COUNT(*) as total FROM promoter_activity_snapshots
           WHERE agency_promoter_id = $1 AND visit_date >= $2`,
          [p.promoter_id, thirtyDaysStr]
        );
        const totalVisits = parseInt(snapshots.rows[0]?.total || '0');
        // Simple heuristic: expect at least 20 visits in 30 days for full score
        if (totalVisits < 20) {
          presenceScore = Math.max(0, Math.min(100, (totalVisits / 20) * 100));
        }

        // === 2. PUNCTUALITY SCORE (late arrivals from snapshots) ===
        let punctualityScore = 100;
        const lateEntries = await query(
          `SELECT COUNT(*) as late FROM promoter_activity_snapshots
           WHERE agency_promoter_id = $1 AND visit_date >= $2
           AND status = 'active' AND entry_at IS NOT NULL
           AND EXTRACT(HOUR FROM entry_at) >= 10`,
          [p.promoter_id, thirtyDaysStr]
        );
        const lateCount = parseInt(lateEntries.rows[0]?.late || '0');
        if (totalVisits > 0) {
          const lateRatio = lateCount / totalVisits;
          punctualityScore = Math.max(0, 100 - (lateRatio * 100));
        }

        // === 3. PERMANENCE SCORE (average time in store) ===
        let permanenceScore = 100;
        const permanenceData = await query(
          `SELECT AVG(EXTRACT(EPOCH FROM (exit_at - entry_at)) / 3600) as avg_hours
           FROM promoter_activity_snapshots
           WHERE agency_promoter_id = $1 AND visit_date >= $2
           AND entry_at IS NOT NULL AND exit_at IS NOT NULL`,
          [p.promoter_id, thirtyDaysStr]
        );
        const avgHours = parseFloat(permanenceData.rows[0]?.avg_hours || '0');
        // Expect at least 4 hours per visit for full score
        if (avgHours > 0 && avgHours < 4) {
          permanenceScore = Math.max(0, (avgHours / 4) * 100);
        }

        // === 4. IDENTITY SCORE (facial/selfie verification success rate) ===
        let identityScore = 100;
        try {
          const verifications = await query(
            `SELECT result, COUNT(*) as cnt FROM face_verification_logs
             WHERE agency_promoter_id = $1 AND created_at >= $2
             GROUP BY result`,
            [p.promoter_id, thirtyDaysStr]
          );
          let totalVerif = 0, approvedVerif = 0;
          for (const v of verifications.rows) {
            totalVerif += parseInt(v.cnt);
            if (v.result === 'approved') approvedVerif += parseInt(v.cnt);
          }
          if (totalVerif > 0) {
            identityScore = (approvedVerif / totalVerif) * 100;
          }
        } catch { /* table may not exist yet */ }

        // === 5. INCIDENTS SCORE (based on open/recent incidents) ===
        let incidentsScore = 100;
        try {
          const incidents = await query(
            `SELECT severity, COUNT(*) as cnt FROM incidents
             WHERE agency_promoter_id = $1 AND created_at >= $2
             GROUP BY severity`,
            [p.promoter_id, thirtyDaysStr]
          );
          let penalty = 0;
          for (const inc of incidents.rows) {
            const cnt = parseInt(inc.cnt);
            if (inc.severity === 'high') penalty += cnt * 15;
            else if (inc.severity === 'medium') penalty += cnt * 8;
            else penalty += cnt * 3;
          }
          incidentsScore = Math.max(0, 100 - penalty);
        } catch { /* table may not exist yet */ }

        // Count totals
        let totalIncidents = 0;
        try {
          const incCount = await query(
            `SELECT COUNT(*) as cnt FROM incidents WHERE agency_promoter_id = $1`,
            [p.promoter_id]
          );
          totalIncidents = parseInt(incCount.rows[0]?.cnt || '0');
        } catch { /* */ }

        let totalBlocks = 0;
        try {
          const blockCount = await query(
            `SELECT COUNT(*) as cnt FROM face_verification_logs
             WHERE agency_promoter_id = $1 AND result = 'rejected'`,
            [p.promoter_id]
          );
          totalBlocks = parseInt(blockCount.rows[0]?.cnt || '0');
        } catch { /* */ }

        // === FINAL SCORE (weighted average) ===
        const finalScore = Math.round(
          (presenceScore * 0.25 +
           punctualityScore * 0.20 +
           permanenceScore * 0.20 +
           identityScore * 0.15 +
           incidentsScore * 0.20) * 100
        ) / 100;

        // Upsert score
        const upsert = await query(
          `INSERT INTO promoter_scores
           (organization_id, agency_promoter_id, score, presence_score, punctuality_score, permanence_score, identity_score, incidents_score, total_visits, total_incidents, total_blocks, last_calculated_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
           ON CONFLICT (organization_id, agency_promoter_id) DO UPDATE SET
             score = EXCLUDED.score,
             presence_score = EXCLUDED.presence_score,
             punctuality_score = EXCLUDED.punctuality_score,
             permanence_score = EXCLUDED.permanence_score,
             identity_score = EXCLUDED.identity_score,
             incidents_score = EXCLUDED.incidents_score,
             total_visits = EXCLUDED.total_visits,
             total_incidents = EXCLUDED.total_incidents,
             total_blocks = EXCLUDED.total_blocks,
             last_calculated_at = NOW(),
             updated_at = NOW()
           RETURNING id`,
          [
            p.organization_id, p.promoter_id,
            finalScore, presenceScore, punctualityScore, permanenceScore, identityScore, incidentsScore,
            totalVisits, totalIncidents, totalBlocks,
          ]
        );

        // Save history point
        if (upsert.rows[0]) {
          await query(
            `INSERT INTO score_history (promoter_score_id, score) VALUES ($1, $2)`,
            [upsert.rows[0].id, finalScore]
          );
        }

        calculated++;
      } catch (err) {
        console.error(`⭐ [CRON] Error calculating score for promoter ${p.promoter_id}:`, err.message);
      }
    }

    console.log(`⭐ [CRON] Score calculation complete: ${calculated} promoters updated`);
    return { calculated };
  } catch (err) {
    console.error('⭐ [CRON] Score calculation error:', err);
    throw err;
  }
}
