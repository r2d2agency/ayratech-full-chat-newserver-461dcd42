-- PDV Visits: permanence tracking (check-in once, checkout once per PDV per
-- day PER SLOT).
--
-- Um promotor pode ter duas rotas no MESMO PDV no mesmo dia (07:00 e 13:00).
-- Cada horário é um "slot" com check-in e checkout próprios, então a
-- unicidade passa a ser (promoter, pdv, date, slot_time).
CREATE TABLE IF NOT EXISTS pdv_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  promoter_id UUID NOT NULL REFERENCES employees(id),
  pdv_id UUID NOT NULL REFERENCES pdvs(id),
  visit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  slot_time TIME NOT NULL DEFAULT '00:00',
  checkin_at TIMESTAMPTZ,
  checkin_latitude DOUBLE PRECISION,
  checkin_longitude DOUBLE PRECISION,
  checkin_photo_url TEXT,
  checkin_device TEXT,
  checkout_at TIMESTAMPTZ,
  checkout_latitude DOUBLE PRECISION,
  checkout_longitude DOUBLE PRECISION,
  checkout_photo_url TEXT,
  status VARCHAR(20) DEFAULT 'active', -- active, completed
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(promoter_id, pdv_id, visit_date, slot_time)
);

-- Link routes to PDV visits
CREATE TABLE IF NOT EXISTS pdv_visit_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES pdv_visits(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES merch_routes(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(visit_id, route_id)
);

-- Timeline events for audit
CREATE TABLE IF NOT EXISTS pdv_visit_timeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES pdv_visits(id) ON DELETE CASCADE,
  route_id UUID REFERENCES merch_routes(id),
  event_type VARCHAR(50) NOT NULL, -- pdv_checkin, route_started, route_completed, pdv_checkout, photo_taken
  event_data JSONB DEFAULT '{}',
  performed_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Timezone settings per org
CREATE TABLE IF NOT EXISTS timezone_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE,
  timezone VARCHAR(50) NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Server time audit
CREATE TABLE IF NOT EXISTS server_time_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  action VARCHAR(100),
  server_time TIMESTAMPTZ DEFAULT NOW(),
  timezone_used VARCHAR(50) DEFAULT 'America/Sao_Paulo',
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
