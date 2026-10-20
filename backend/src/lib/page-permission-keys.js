// Catálogo de chaves de permissão de página.
// Espelha src/lib/page-permissions.ts (frontend).
// Mantido aqui para que o backend normalize os templates com a mesma lista.

export const RH_PERMISSION_KEYS = [
  'rh_dashboard', 'rh_indicadores', 'rh_colaboradores', 'rh_admissao', 'rh_cargos',
  'rh_esocial', 'rh_escalas', 'rh_afd', 'rh_ponto', 'rh_ponto_monitor', 'rh_holerite',
  'rh_documentos', 'rh_exames', 'rh_epis', 'rh_advertencias', 'rh_treinamentos',
  'rh_feriados', 'rh_mapa', 'rh_acessos', 'rh_biometria', 'rh_rastreamento',
  'rh_ajuda', 'rh_configuracoes', 'rh_logs', 'rh_changelog', 'rh_pdvs',
];

export const ALL_PERMISSION_KEYS = [
  'chat', 'secretaria_ia', 'agentes_ia', 'ia_assistentes', 'chatbots', 'fluxos',
  'departamentos', 'agendamentos', 'respostas_rapidas', 'tags', 'contatos',
  'crm_negociacoes', 'crm_prospects', 'crm_empresas', 'projetos', 'mapa',
  'crm_agenda', 'crm_tarefas', 'crm_relatorios', 'revenue_intelligence',
  'modulo_fantasma', 'crm_configuracoes',
  'listas', 'mensagens', 'campanhas', 'sequencias', 'fluxos_externos', 'webhooks',
  'api_docs', 'ctwa_analytics', 'lead_gleego',
  'ajustes', 'meta_templates', 'assinaturas',
  'cobranca', 'conexoes', 'organizacoes', 'controle_acesso', 'modelo_contrato',
  'merch_dashboard', 'merch_marcas', 'merch_redes', 'merch_categorias',
  'merch_produtos', 'merch_mix', 'merch_equipe', 'merch_rotas', 'merch_checklists',
  'live_maps', 'merch_execucao', 'merch_book_fotos', 'merch_auditoria',
  'merch_perdas', 'merch_contagem_estoque', 'merch_contagem_dashboard',
  'merch_pesquisa_precos', 'merch_pesquisa_dashboard', 'merch_contratos',
  'merch_relatorios',
  ...RH_PERMISSION_KEYS,
];

/**
 * Normaliza um objeto de permissões: toda chave conhecida fica presente com
 * booleano explícito. Assim "desmarcar tudo" significa "tudo negado",
 * e chaves ausentes nunca vazam como-permitidas.
 */
export function normalizePermissions(permissions) {
  const source = (permissions && typeof permissions === 'object') ? permissions : {};
  const normalized = {};
  for (const key of ALL_PERMISSION_KEYS) {
    normalized[key] = source[key] === true;
  }
  // preserva chaves legadas desconhecidas
  for (const key of Object.keys(source)) {
    if (!(key in normalized)) normalized[key] = source[key] === true;
  }
  return normalized;
}
