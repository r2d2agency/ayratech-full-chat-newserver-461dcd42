import { query } from '../db.js';
import { logWarn } from '../logger.js';

export const PUNCH_ON_CHECKIN_SETTING_KEY = 'punch_on_checkin_config';
export const PUNCH_ON_CHECKIN_DEFAULTS = { enabled: false };

export async function readPunchOnCheckinConfig(orgId) {
  if (!orgId) return { ...PUNCH_ON_CHECKIN_DEFAULTS };
  try {
    const result = await query(
      `SELECT config FROM organization_settings WHERE organization_id = $1 AND setting_key = $2`,
      [orgId, PUNCH_ON_CHECKIN_SETTING_KEY]
    );
    const config = result.rows[0]?.config || {};
    return { enabled: config.enabled === true };
  } catch (e) {
    logWarn('merch.punch_on_checkin_config.read_failed', { error: e?.message });
    return { ...PUNCH_ON_CHECKIN_DEFAULTS };
  }
}
