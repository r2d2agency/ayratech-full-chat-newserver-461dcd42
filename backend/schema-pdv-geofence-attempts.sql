-- Geofence check-in attempts: every time a promoter tries to check in at a PDV,
-- whether it is accepted or refused.
--
-- pdv_visits only records a visit that actually happened, so it cannot answer
-- "the promoter says he was there but the check-in failed" -- the refusal left
-- no row anywhere. This table records the attempt itself: where they were, when,
-- what the geofence said and why it refused.
--
-- The row is written for BOTH outcomes on purpose. An accepted check-in leaves
-- a trail to audit later; a refused one explains a support call.
CREATE TABLE IF NOT EXISTS pdv_geofence_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  promoter_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pdv_id UUID REFERENCES pdvs(id) ON DELETE SET NULL,
  attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy_meters DOUBLE PRECISION,
  accepted BOOLEAN NOT NULL DEFAULT false,
  -- Which rule decided: polygon, radius, or both. Null when there was no PDV.
  matched_by VARCHAR(20),
  -- polygon | radius | none -- what the geofence actually evaluated.
  mode VARCHAR(20),
  distance_meters DOUBLE PRECISION,
  radius_meters DOUBLE PRECISION,
  polygon_vertices INTEGER,
  reason_code VARCHAR(40),
  reason TEXT,
  -- 'checkin' | 'checkout' | 'punch'. Checkouts and punches are logged too so a
  -- refused punch is auditable with the same detail as a refused check-in.
  action VARCHAR(20) NOT NULL DEFAULT 'checkin',
  -- What the promoter typed when asking for an exception punch. The refusal
  -- overrides this field, so keep it separate.
  justification TEXT,
  device_info TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pdv_geofence_attempts_promoter_date
  ON pdv_geofence_attempts(promoter_id, attempt_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdv_geofence_attempts_org_date
  ON pdv_geofence_attempts(organization_id, attempt_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdv_geofence_attempts_pdv
  ON pdv_geofence_attempts(pdv_id, attempt_at DESC);
-- The refused ones are what an operator actually searches for.
CREATE INDEX IF NOT EXISTS idx_pdv_geofence_attempts_refused
  ON pdv_geofence_attempts(organization_id, accepted, attempt_at DESC);