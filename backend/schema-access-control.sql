-- =====================================================
-- FASE 5: Módulo de Controle de Acesso para Supermercados
-- =====================================================

-- Redes de supermercados
CREATE TABLE IF NOT EXISTS supermarket_networks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  cnpj VARCHAR(20),
  contact_name VARCHAR(255),
  contact_phone VARCHAR(30),
  contact_email VARCHAR(255),
  notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unidades de supermercado (PDVs do supermercado - podem pertencer a uma rede)
CREATE TABLE IF NOT EXISTS supermarket_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  network_id UUID REFERENCES supermarket_networks(id) ON DELETE SET NULL,
  pdv_id UUID REFERENCES pdvs(id) ON DELETE SET NULL, -- vínculo com PDV existente do Ayratech
  name VARCHAR(255) NOT NULL,
  cnpj VARCHAR(20),
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(2),
  zip_code VARCHAR(10),
  neighborhood VARCHAR(100),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  radius_meters INTEGER DEFAULT 200,
  -- Perimeter drawn on the map, same shape as pdvs.geofence_polygon: an array
  -- of {lat, lng} points. Either the polygon or the radius accepts a check-in.
  geofence_polygon JSONB,
  opening_time TIME DEFAULT '06:00',
  closing_time TIME DEFAULT '22:00',
  operating_days JSONB DEFAULT '[1,2,3,4,5,6]', -- 0=dom..6=sab
  access_rules JSONB DEFAULT '{}', -- regras globais do PDV
  operational_requirements TEXT, -- exigências operacionais
  totem_enabled BOOLEAN DEFAULT false,
  totem_token VARCHAR(255), -- token único para autenticação do totem
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agências terceiras
CREATE TABLE IF NOT EXISTS agencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  cnpj VARCHAR(20),
  responsible_name VARCHAR(255),
  responsible_phone VARCHAR(30),
  responsible_email VARCHAR(255),
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(2),
  plan_name VARCHAR(100),
  max_promoters INTEGER DEFAULT 10,
  price_per_promoter NUMERIC(10,2) DEFAULT 0,
  billing_status VARCHAR(20) DEFAULT 'active', -- active, overdue, blocked
  auto_block_on_overdue BOOLEAN DEFAULT false,
  status VARCHAR(20) DEFAULT 'active', -- active, inactive, blocked
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Login separado para agências
CREATE TABLE IF NOT EXISTS agency_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(30) DEFAULT 'admin', -- admin, viewer
  last_login TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(email)
);

-- Promotores vinculados a agências
CREATE TABLE IF NOT EXISTS agency_promoters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL, -- promotor interno (já existe)
  -- dados para promotor externo (sem employee_id)
  name VARCHAR(255) NOT NULL,
  cpf VARCHAR(14) NOT NULL,
  phone VARCHAR(30),
  photo_url TEXT,
  document_url TEXT,
  status VARCHAR(20) DEFAULT 'active', -- active, inactive, blocked
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agency_id, cpf)
);

CREATE INDEX IF NOT EXISTS idx_agency_promoters_cpf ON agency_promoters(cpf);

-- Regras de acesso: quais PDVs, dias, horários e marcas o promotor pode acessar
CREATE TABLE IF NOT EXISTS pdv_access_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agency_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE, -- para promotores internos diretos
  supermarket_unit_id UUID NOT NULL REFERENCES supermarket_units(id) ON DELETE CASCADE,
  allowed_weekdays JSONB DEFAULT '[1,2,3,4,5]', -- 0=dom..6=sab
  start_time TIME DEFAULT '08:00',
  end_time TIME DEFAULT '18:00',
  max_duration_minutes INTEGER, -- limite de permanência
  require_active_route BOOLEAN DEFAULT false,
  require_prior_approval BOOLEAN DEFAULT false,
  approval_status VARCHAR(20) DEFAULT 'approved', -- pending, approved, rejected
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_promoter CHECK (agency_promoter_id IS NOT NULL OR employee_id IS NOT NULL)
);

-- Permissões de marcas por promotor por PDV
CREATE TABLE IF NOT EXISTS promoter_brand_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_rule_id UUID NOT NULL REFERENCES pdv_access_rules(id) ON DELETE CASCADE,
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(access_rule_id, brand_id)
);

-- Logs de entrada (check-in)
CREATE TABLE IF NOT EXISTS pdv_entry_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supermarket_unit_id UUID NOT NULL REFERENCES supermarket_units(id) ON DELETE CASCADE,
  agency_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE SET NULL,
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  cpf VARCHAR(14) NOT NULL,
  entry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exit_at TIMESTAMPTZ,
  duration_minutes INTEGER, -- calculado no checkout
  status VARCHAR(20) NOT NULL DEFAULT 'authorized', -- authorized, blocked
  block_reason VARCHAR(100), -- fora_horario, sem_autorizacao, pdv_nao_permitido, cadastro_inexistente, agencia_bloqueada
  origin VARCHAR(20) DEFAULT 'totem', -- totem, manual, sistema
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  device_info TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pdv_entry_logs_cpf ON pdv_entry_logs(cpf);
CREATE INDEX IF NOT EXISTS idx_pdv_entry_logs_unit ON pdv_entry_logs(supermarket_unit_id, entry_at);
CREATE INDEX IF NOT EXISTS idx_pdv_entry_logs_date ON pdv_entry_logs(organization_id, entry_at);

-- Log de auditoria completo
CREATE TABLE IF NOT EXISTS access_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL, -- entry_authorized, entry_blocked, exit_registered, rule_created, rule_updated, rule_deleted, permission_changed
  entity_type VARCHAR(50), -- agency, promoter, unit, rule
  entity_id UUID,
  supermarket_unit_id UUID REFERENCES supermarket_units(id) ON DELETE SET NULL,
  agency_id UUID REFERENCES agencies(id) ON DELETE SET NULL,
  agency_promoter_id UUID REFERENCES agency_promoters(id) ON DELETE SET NULL,
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  performed_by UUID, -- user que executou
  performed_by_type VARCHAR(20) DEFAULT 'system', -- system, admin, agency, totem
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_audit_org ON access_audit_logs(organization_id, created_at);

-- Login separado para supermercados (perfil PDV)
CREATE TABLE IF NOT EXISTS supermarket_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supermarket_unit_id UUID NOT NULL REFERENCES supermarket_units(id) ON DELETE CASCADE,
  network_id UUID REFERENCES supermarket_networks(id) ON DELETE SET NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(30) DEFAULT 'manager', -- manager, viewer
  can_view_all_network BOOLEAN DEFAULT false, -- se pode ver todas as unidades da rede
  last_login TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(email)
);

-- Sessões do totem (tokens temporários)
CREATE TABLE IF NOT EXISTS totem_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supermarket_unit_id UUID NOT NULL REFERENCES supermarket_units(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  device_info TEXT,
  ip_address VARCHAR(45),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Marcas ativas no dia por unidade (cache/materialização)
CREATE TABLE IF NOT EXISTS daily_brand_presence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supermarket_unit_id UUID NOT NULL REFERENCES supermarket_units(id) ON DELETE CASCADE,
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  presence_date DATE NOT NULL DEFAULT CURRENT_DATE,
  agency_id UUID REFERENCES agencies(id) ON DELETE SET NULL,
  promoter_count INTEGER DEFAULT 0,
  first_entry TIMESTAMPTZ,
  last_exit TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(supermarket_unit_id, brand_id, presence_date)
);

-- PDVs permitidos por agência (pré-autorização)
CREATE TABLE IF NOT EXISTS agency_allowed_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  supermarket_unit_id UUID NOT NULL REFERENCES supermarket_units(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agency_id, supermarket_unit_id)
);
