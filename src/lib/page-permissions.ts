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
  { key: 'ctwa_analytics', label: 'CTWA Analytics', section: 'Disparos', icon: 'MousePointerClick' },
  { key: 'lead_gleego', label: 'Lead Gleego', section: 'Disparos', icon: 'BarChart4' },
  
  // Minha Conta
  { key: 'ajustes', label: 'Ajustes', section: 'Minha Conta', icon: 'Settings' },
  { key: 'merch_contagem_estoque', label: 'Contagem Estoque', section: 'Merchandising', icon: 'Boxes' },
  { key: 'meta_templates', label: 'Templates Meta', section: 'Minha Conta', icon: 'FileText' },
  { key: 'assinaturas', label: 'Assinaturas', section: 'Minha Conta', icon: 'FileSignature' },
  
  // Administração
  { key: 'cobranca', label: 'Cobrança', section: 'Administração', icon: 'Receipt' },
  { key: 'conexoes', label: 'Conexões', section: 'Administração', icon: 'Plug' },
  { key: 'organizacoes', label: 'Organizações', section: 'Administração', icon: 'Building2' },

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
