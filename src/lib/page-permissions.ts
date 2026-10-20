// All available pages that can be controlled via permission templates
//
// `restricted: 'rh'` marks pages that only admins and users belonging to RH
// may see/assign. They are hidden from the picker for everyone else and the
// backend refuses to save a template containing them.
export const PAGE_PERMISSIONS = [
  // Atendimento
  { key: 'chat', label: 'Chat', section: 'Atendimento', icon: 'MessagesSquare' },
  { key: 'secretaria_ia', label: 'Secretária IA', section: 'Atendimento', icon: 'Bot' },
  { key: 'agentes_ia', label: 'Agentes IA', section: 'Atendimento', icon: 'Sparkles' },
  { key: 'ia_assistentes', label: 'IA Assistentes', section: 'Atendimento', icon: 'Bot' },
  { key: 'chatbots', label: 'Chatbots', section: 'Atendimento', icon: 'Bot' },
  { key: 'fluxos', label: 'Fluxos', section: 'Atendimento', icon: 'GitBranch' },
  { key: 'departamentos', label: 'Departamentos', section: 'Atendimento', icon: 'Building2' },
  { key: 'agendamentos', label: 'Agendamentos', section: 'Atendimento', icon: 'Bell' },
  { key: 'respostas_rapidas', label: 'Respostas Rápidas', section: 'Atendimento', icon: 'MessageSquare' },
  { key: 'tags', label: 'Tags', section: 'Atendimento', icon: 'Receipt' },
  { key: 'contatos', label: 'Contatos', section: 'Atendimento', icon: 'Users' },

  // CRM
  { key: 'crm_negociacoes', label: 'Negociações', section: 'CRM', icon: 'Kanban' },
  { key: 'crm_prospects', label: 'Prospects', section: 'CRM', icon: 'UserPlus' },
  { key: 'crm_empresas', label: 'Empresas', section: 'CRM', icon: 'Building2' },
  { key: 'projetos', label: 'Projetos', section: 'CRM', icon: 'FolderKanban' },
  { key: 'mapa', label: 'Mapa', section: 'CRM', icon: 'Map' },
  { key: 'crm_agenda', label: 'Agenda', section: 'CRM', icon: 'CalendarDays' },
  { key: 'crm_tarefas', label: 'Tarefas', section: 'CRM', icon: 'ClipboardList' },
  { key: 'crm_relatorios', label: 'Relatórios', section: 'CRM', icon: 'BarChart3' },
  { key: 'revenue_intelligence', label: 'Revenue Intel', section: 'CRM', icon: 'Brain' },
  { key: 'modulo_fantasma', label: 'Módulo Fantasma', section: 'CRM', icon: 'Ghost' },
  { key: 'crm_configuracoes', label: 'Configurações CRM', section: 'CRM', icon: 'Settings' },

  // Disparos
  { key: 'listas', label: 'Listas', section: 'Disparos', icon: 'Users' },
  { key: 'mensagens', label: 'Mensagens', section: 'Disparos', icon: 'MessageSquare' },
  { key: 'campanhas', label: 'Campanhas', section: 'Disparos', icon: 'Send' },
  { key: 'sequencias', label: 'Sequências', section: 'Disparos', icon: 'RefreshCw' },
  { key: 'fluxos_externos', label: 'Fluxos Externos', section: 'Disparos', icon: 'FileText' },
  { key: 'webhooks', label: 'Webhooks', section: 'Disparos', icon: 'Webhook' },
  { key: 'api_docs', label: 'API Integração', section: 'Disparos', icon: 'Code' },
  { key: 'ctwa_analytics', label: 'CTWA Analytics', section: 'Disparos', icon: 'MousePointerClick' },
  { key: 'lead_gleego', label: 'Lead Gleego', section: 'Disparos', icon: 'BarChart4' },

  // Minha Conta
  { key: 'ajustes', label: 'Ajustes', section: 'Minha Conta', icon: 'Settings' },
  { key: 'meta_templates', label: 'Templates Meta', section: 'Minha Conta', icon: 'FileText' },
  { key: 'assinaturas', label: 'Assinaturas', section: 'Minha Conta', icon: 'FileSignature' },

  // Administração
  { key: 'cobranca', label: 'Cobrança', section: 'Administração', icon: 'Receipt' },
  { key: 'conexoes', label: 'Conexões', section: 'Administração', icon: 'Plug' },
  { key: 'organizacoes', label: 'Organizações', section: 'Administração', icon: 'Building2' },
  { key: 'controle_acesso', label: 'Painel de Controle de Acesso', section: 'Administração', icon: 'ShieldCheck' },
  { key: 'modelo_contrato', label: 'Modelos de Contrato', section: 'Administração', icon: 'FileText' },

  // Merchandising
  { key: 'merch_dashboard', label: 'Dashboard Merch', section: 'Merchandising', icon: 'LayoutDashboard' },
  { key: 'merch_marcas', label: 'Marcas', section: 'Merchandising', icon: 'Building2' },
  { key: 'merch_redes', label: 'Redes', section: 'Merchandising', icon: 'LayoutGrid' },
  { key: 'merch_categorias', label: 'Categorias', section: 'Merchandising', icon: 'Tags' },
  { key: 'merch_produtos', label: 'Produtos', section: 'Merchandising', icon: 'Boxes' },
  { key: 'merch_mix', label: 'Mix por PDV', section: 'Merchandising', icon: 'Store' },
  { key: 'merch_equipe', label: 'Equipe', section: 'Merchandising', icon: 'Users' },
  { key: 'merch_rotas', label: 'Rotas & Agenda', section: 'Merchandising', icon: 'MapPin' },
  { key: 'merch_checklists', label: 'Checklists', section: 'Merchandising', icon: 'ClipboardList' },
  { key: 'live_maps', label: 'Live Maps', section: 'Merchandising', icon: 'Radio' },
  { key: 'merch_execucao', label: 'Execução Campo', section: 'Merchandising', icon: 'Radio' },
  { key: 'merch_book_fotos', label: 'Book de Fotos', section: 'Merchandising', icon: 'Camera' },
  { key: 'merch_auditoria', label: 'Auditoria', section: 'Merchandising', icon: 'Shield' },
  { key: 'merch_perdas', label: 'Perdas (Conferência)', section: 'Merchandising', icon: 'AlertTriangle' },
  { key: 'merch_contagem_estoque', label: 'Contagem Estoque', section: 'Merchandising', icon: 'Boxes' },
  { key: 'merch_contagem_dashboard', label: 'Dashboard Contagem', section: 'Merchandising', icon: 'BarChart3' },
  { key: 'merch_pesquisa_precos', label: 'Pesquisa de Preços', section: 'Merchandising', icon: 'DollarSign' },
  { key: 'merch_pesquisa_dashboard', label: 'Dashboard Preços', section: 'Merchandising', icon: 'BarChart3' },
  { key: 'merch_contratos', label: 'Contratos', section: 'Merchandising', icon: 'FileText' },
  { key: 'merch_relatorios', label: 'Relatórios', section: 'Merchandising', icon: 'BarChart3' },

  // RH (only admins and users belonging to RH may assign these)
  { key: 'rh_dashboard', label: 'Dashboard RH', section: 'RH', icon: 'LayoutDashboard', restricted: 'rh' },
  { key: 'rh_indicadores', label: 'Indicadores RH', section: 'RH', icon: 'TrendingUp', restricted: 'rh' },
  { key: 'rh_colaboradores', label: 'Colaboradores', section: 'RH', icon: 'UserPlus', restricted: 'rh' },
  { key: 'rh_admissao', label: 'Admissão', section: 'RH', icon: 'UserPlus', restricted: 'rh' },
  { key: 'rh_cargos', label: 'Cargos', section: 'RH', icon: 'Briefcase', restricted: 'rh' },
  { key: 'rh_esocial', label: 'eSocial', section: 'RH', icon: 'FileCode2', restricted: 'rh' },
  { key: 'rh_escalas', label: 'Escalas', section: 'RH', icon: 'CalendarDays', restricted: 'rh' },
  { key: 'rh_afd', label: 'Totem & AFD', section: 'RH', icon: 'Monitor', restricted: 'rh' },
  { key: 'rh_ponto', label: 'Ponto', section: 'RH', icon: 'Clock', restricted: 'rh' },
  { key: 'rh_ponto_monitor', label: 'Monitor de Ponto', section: 'RH', icon: 'Clock', restricted: 'rh' },
  { key: 'rh_holerite', label: 'Holerite', section: 'RH', icon: 'DollarSign', restricted: 'rh' },
  { key: 'rh_documentos', label: 'Documentos RH', section: 'RH', icon: 'FileText', restricted: 'rh' },
  { key: 'rh_exames', label: 'Exames Ocupacionais', section: 'RH', icon: 'Stethoscope', restricted: 'rh' },
  { key: 'rh_epis', label: 'EPIs', section: 'RH', icon: 'HardHat', restricted: 'rh' },
  { key: 'rh_advertencias', label: 'Advertências', section: 'RH', icon: 'AlertTriangle', restricted: 'rh' },
  { key: 'rh_treinamentos', label: 'Treinamentos', section: 'RH', icon: 'GraduationCap', restricted: 'rh' },
  { key: 'rh_feriados', label: 'Feriados', section: 'RH', icon: 'CalendarDays', restricted: 'rh' },
  { key: 'rh_mapa', label: 'Mapa Operacional', section: 'RH', icon: 'MapPin', restricted: 'rh' },
  { key: 'rh_acessos', label: 'Acessos App', section: 'RH', icon: 'Shield', restricted: 'rh' },
  { key: 'rh_biometria', label: 'Biometria Facial', section: 'RH', icon: 'ScanFace', restricted: 'rh' },
  { key: 'rh_rastreamento', label: 'Rastreamento', section: 'RH', icon: 'Navigation', restricted: 'rh' },
  { key: 'rh_ajuda', label: 'Ajuda & Manuais', section: 'RH', icon: 'HelpCircle', restricted: 'rh' },
  { key: 'rh_configuracoes', label: 'Configurações RH', section: 'RH', icon: 'Settings', restricted: 'rh' },
  { key: 'rh_logs', label: 'Logs & Erros', section: 'RH', icon: 'Code', restricted: 'rh' },
  { key: 'rh_changelog', label: 'Atualizações', section: 'RH', icon: 'Sparkles', restricted: 'rh' },
  { key: 'rh_pdvs', label: 'PDVs & Sedes', section: 'RH', icon: 'MapPin', restricted: 'rh' },
] as const;

export type PageKey = typeof PAGE_PERMISSIONS[number]['key'];

// Keys reserved to admins and users belonging to RH
export const RH_PERMISSION_KEYS = PAGE_PERMISSIONS
  .filter(p => (p as any).restricted === 'rh')
  .map(p => p.key);

// Every known page key — used to normalise stored templates
export const ALL_PERMISSION_KEYS = PAGE_PERMISSIONS.map(p => p.key);

// True when the given permission key is restricted to RH
export function isRestrictedKey(key: string): boolean {
  return RH_PERMISSION_KEYS.includes(key as any);
}

// Get all unique sections
export const PAGE_SECTIONS = [...new Set(PAGE_PERMISSIONS.map(p => p.section))];

// Create a "full access" permissions object
export function createFullPermissions(includeRestricted = true): Record<string, boolean> {
  const perms: Record<string, boolean> = {};
  PAGE_PERMISSIONS.forEach(p => {
    if (!includeRestricted && (p as any).restricted === 'rh') return;
    perms[p.key] = true;
  });
  return perms;
}

// Create an empty permissions object
export function createEmptyPermissions(): Record<string, boolean> {
  const perms: Record<string, boolean> = {};
  PAGE_PERMISSIONS.forEach(p => { perms[p.key] = false; });
  return perms;
}

// Normalise a stored template: every known key must be present with an
// explicit boolean, so "desmarcar tudo" really means "everything false".
export function normalizePermissions(permissions: unknown): Record<string, boolean> {
  const source = (permissions && typeof permissions === 'object' ? permissions : {}) as Record<string, unknown>;
  const perms: Record<string, boolean> = {};
  ALL_PERMISSION_KEYS.forEach(key => {
    perms[key] = source[key] === true;
  });
  // keep unknown keys (e.g. legacy pages) as they were
  Object.keys(source).forEach(key => {
    if (!(key in perms)) perms[key] = source[key] === true;
  });
  return perms;
}

// Maps a route to the permission key that guards it. Used to block direct
// URL access to pages the user's template does not grant.
export const ROUTE_PERMISSION_KEYS: Record<string, string> = {
  '/chat': 'chat',
  '/secretaria-grupos': 'secretaria_ia',
  '/agentes-ia': 'agentes_ia',
  '/agentes-ia-cliente': 'ia_assistentes',
  '/chatbots': 'chatbots',
  '/fluxos': 'fluxos',
  '/departamentos': 'departamentos',
  '/agendamentos': 'agendamentos',
  '/respostas-rapidas': 'respostas_rapidas',
  '/tags': 'tags',
  '/contatos-chat': 'contatos',
  '/crm/negociacoes': 'crm_negociacoes',
  '/crm/prospects': 'crm_prospects',
  '/crm/empresas': 'crm_empresas',
  '/projetos': 'projetos',
  '/mapa': 'mapa',
  '/crm/agenda': 'crm_agenda',
  '/tarefas': 'crm_tarefas',
  '/crm/tarefas': 'crm_tarefas',
  '/crm/relatorios': 'crm_relatorios',
  '/revenue-intelligence': 'revenue_intelligence',
  '/modulo-fantasma': 'modulo_fantasma',
  '/crm/configuracoes': 'crm_configuracoes',
  '/rh/dashboard': 'rh_dashboard',
  '/rh/indicadores': 'rh_indicadores',
  '/rh/colaboradores': 'rh_colaboradores',
  '/rh/admissao': 'rh_admissao',
  '/rh/cargos': 'rh_cargos',
  '/rh/esocial': 'rh_esocial',
  '/rh/escalas': 'rh_escalas',
  '/rh/afd': 'rh_afd',
  '/rh/ponto': 'rh_ponto',
  '/rh/ponto-monitor': 'rh_ponto_monitor',
  '/rh/holerite': 'rh_holerite',
  '/rh/documentos': 'rh_documentos',
  '/rh/exames': 'rh_exames',
  '/rh/epis': 'rh_epis',
  '/rh/advertencias': 'rh_advertencias',
  '/rh/treinamentos': 'rh_treinamentos',
  '/rh/feriados': 'rh_feriados',
  '/rh/mapa': 'rh_mapa',
  '/rh/acessos': 'rh_acessos',
  '/rh/biometria': 'rh_biometria',
  '/rh/rastreamento': 'rh_rastreamento',
  '/rh/ajuda': 'rh_ajuda',
  '/rh/configuracoes': 'rh_configuracoes',
  '/rh/logs': 'rh_logs',
  '/rh/changelog': 'rh_changelog',
  '/rh/pdvs': 'rh_pdvs',
  '/rh/demissao': 'rh_colaboradores',
  '/rh/totem': 'rh_afd',
  '/merch/dashboard': 'merch_dashboard',
  '/merch/marcas': 'merch_marcas',
  '/merch/redes': 'merch_redes',
  '/merch/categorias': 'merch_categorias',
  '/merch/produtos': 'merch_produtos',
  '/merch/mix': 'merch_mix',
  '/merch/equipe': 'merch_equipe',
  '/merch/rotas': 'merch_rotas',
  '/merch/checklists': 'merch_checklists',
  '/live-maps': 'live_maps',
  '/merch/execucao': 'merch_execucao',
  '/merch/book-fotos': 'merch_book_fotos',
  '/merch/auditoria': 'merch_auditoria',
  '/merch/perdas': 'merch_perdas',
  '/merch/contagem-estoque': 'merch_contagem_estoque',
  '/merch/contagem-dashboard': 'merch_contagem_dashboard',
  '/merch/pesquisa-precos': 'merch_pesquisa_precos',
  '/merch/pesquisa-dashboard': 'merch_pesquisa_dashboard',
  '/merch/contratos': 'merch_contratos',
  '/merch/relatorios': 'merch_relatorios',
  '/merch/relatorios/programacao': 'merch_relatorios',
  '/controle-acesso': 'controle_acesso',
  '/modelo-contrato': 'modelo_contrato',
  '/contatos': 'listas',
  '/mensagens': 'mensagens',
  '/campanhas': 'campanhas',
  '/sequencias': 'sequencias',
  '/fluxos-externos': 'fluxos_externos',
  '/lead-webhooks': 'webhooks',
  '/api-docs': 'api_docs',
  '/ctwa-analytics': 'ctwa_analytics',
  '/lead-gleego': 'lead_gleego',
  '/conexao': 'conexoes',
  '/meta-templates': 'meta_templates',
  '/assinaturas': 'assinaturas',
  '/configuracoes': 'ajustes',
  '/cobranca': 'cobranca',
  '/organizacoes': 'organizacoes',
};

// Resolve the permission key guarding a given pathname (handles nested/dynamic paths)
export function permissionKeyForPath(pathname: string): string | null {
  if (ROUTE_PERMISSION_KEYS[pathname]) return ROUTE_PERMISSION_KEYS[pathname];
  // dynamic segments: /rh/demissao/:employeeId
  const segments = pathname.split('/').filter(Boolean);
  for (let i = segments.length; i > 0; i--) {
    const candidate = '/' + segments.slice(0, i).join('/');
    if (ROUTE_PERMISSION_KEYS[candidate]) return ROUTE_PERMISSION_KEYS[candidate];
  }
  return null;
}
