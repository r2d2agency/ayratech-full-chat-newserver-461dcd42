// Configuração da janela de horário do check-in (por organização).
//
// A regra "o check-in só abre a partir do horário da rota" é uma política do
// cliente, não uma imposição do sistema: quem tem muitas rotas sem horário
// precisa poder desligá-la sem mexer em cada rota.
//
// A configuração fica em organization_settings (organization_id + setting_key
// + config JSONB), no mesmo formato do photo-quality-config.

import { query } from '../db.js';
import { logWarn } from '../logger.js';

export const CHECKIN_WINDOW_SETTING_KEY = 'checkin_window_config';
export const CHECKIN_WINDOW_DEFAULTS = { enabled: true, tolerance_minutes: 15 };

/**
 * Lê a configuração da janela de check-in da organização.
 * Nunca lança: em caso de erro devolve o padrão (regra ligada, 15 min).
 */
export async function readCheckinWindowConfig(orgId) {
  if (!orgId) return { ...CHECKIN_WINDOW_DEFAULTS };
  try {
    const result = await query(
      `SELECT config FROM organization_settings WHERE organization_id = $1 AND setting_key = $2`,
      [orgId, CHECKIN_WINDOW_SETTING_KEY]
    );
    const config = result.rows[0]?.config || {};
    return {
      enabled: config.enabled !== false,
      tolerance_minutes: Number.isFinite(Number(config.tolerance_minutes))
        ? Number(config.tolerance_minutes)
        : CHECKIN_WINDOW_DEFAULTS.tolerance_minutes,
    };
  } catch (e) {
    logWarn('merch.checkin_window_config.read_failed', { error: e?.message });
    return { ...CHECKIN_WINDOW_DEFAULTS };
  }
}
