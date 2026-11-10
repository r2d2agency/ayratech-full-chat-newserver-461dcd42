import { useState, useMemo, useEffect } from "react";
import { resolveMediaUrl } from "@/lib/media";
import { getBase64ImageFromURL } from "@/lib/pdf-utils";
import { useAuth } from "@/contexts/AuthContext";


import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useBrands } from "@/hooks/use-merchandising";
import { useEmployees } from "@/hooks/use-rh";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  useMerchDashboard, useMerchReportPDV, useMerchReportBrand,
  useMerchReportPromoter, useMerchReportProduct, useMerchReportCategory,
  useMerchRoutesTimeline, useMerchRankingIssues, useMerchAnalytical,
  useMerchInactivityReport, useMerchInactivityConfig,
} from "@/hooks/use-merch-analytics";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell,
} from "recharts";
import {
  BarChart3, Store, Building2, Package, User, Layers, Route, AlertTriangle,
  TrendingUp, TrendingDown, Camera, DollarSign, ShoppingCart, Clock, Target,
  Download, FileSpreadsheet, Sparkles, Filter, Calendar, FileText, CheckCircle2, XCircle, CalendarClock,
  Settings, TimerReset,
} from "lucide-react";
import { AiAnalysisChat } from "@/components/merch/AiAnalysisChat";
import { format, subDays, startOfWeek, startOfMonth } from "date-fns";

const PERIOD_PRESETS = [
  { value: 'today', label: 'Hoje' },
  { value: 'yesterday', label: 'Ontem' },
  { value: 'week', label: 'Esta semana' },
  { value: 'month', label: 'Este mês' },
  { value: 'custom', label: 'Personalizado' },
];

const ALL_VALUE = "__all__";
const CHART_COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

function getDateRange(preset: string): { from: string; to: string } {
  const today = new Date();
  switch (preset) {
    case 'today': return { from: format(today, 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
    case 'yesterday': { const y = subDays(today, 1); return { from: format(y, 'yyyy-MM-dd'), to: format(y, 'yyyy-MM-dd') }; }
    case 'week': return { from: format(startOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
    case 'month': return { from: format(startOfMonth(today), 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
    default: return { from: format(subDays(today, 30), 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
  }
}

// Busca os dados da aba atual usando os filtros
async function fetchTabData(tab: string, filters: any): Promise<any[]> {
  const qs = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v) qs.append(k, String(v)); });
  const endpointMap: Record<string, string> = {
    dashboard: `/api/merch-analytics/dashboard?${qs}`,
    pdv: `/api/merch-analytics/report/pdv?${qs}`,
    marca: `/api/merch-analytics/report/brand?${qs}`,
    promotor: `/api/merch-analytics/report/promoter?${qs}`,
    produto: `/api/merch-analytics/report/product?${qs}`,
    categoria: `/api/merch-analytics/report/category?${qs}`,
    avarias: `/api/merch-analytics/report/stockouts?${qs}`,
    inatividade: `/api/merch-analytics/inactivity/report?${qs}`,
    analitico: `/api/merch-analytics/analytical?${qs}`,
  };
  const url = endpointMap[tab] || endpointMap.pdv;
  const raw = await api<any>(url);
  return Array.isArray(raw) ? raw : (raw?.rows || raw?.data || []);
}

function tabLabel(tab: string): string {
  const map: Record<string, string> = {
    dashboard: 'Dashboard', pdv: 'PDVs', marca: 'Marcas', promotor: 'Promotores',
    produto: 'Produtos', categoria: 'Categorias', avarias: 'Rupturas/Avarias', inatividade: 'Inatividade', analitico: 'Analítico',
  };
  return map[tab] || tab;
}

// Rótulos e ordem das colunas por aba (para exportações "certinhas")
const COLUMN_LABELS: Record<string, Record<string, string>> = {
  pdv: {
    pdv_name: 'PDV', network_name: 'Rede', city: 'Cidade', state: 'UF',
    total_routes: 'Rotas', completed_routes: 'Rotas Concluídas', pending_routes: 'Rotas Pendentes',
    brands_served: 'Marcas Atendidas', total_products: 'Produtos', executed_products: 'Produtos Executados',
    damages: 'Avarias', stockouts: 'Rupturas', photos: 'Fotos', avg_visit_min: 'Duração Média (min)',
  },
  marca: {
    brand_name: 'Marca', total_routes: 'Rotas', completed_routes: 'Rotas Concluídas',
    pdvs_served: 'PDVs Atendidos', total_products: 'Produtos', executed_products: 'Produtos Executados',
    damages: 'Avarias', stockouts: 'Rupturas', photos: 'Fotos',
  },
  promotor: {
    promoter_name: 'Promotor', total_routes: 'Rotas', completed_routes: 'Rotas Concluídas',
    pending_routes: 'Rotas Pendentes', brands_served: 'Marcas', pdvs_visited: 'PDVs Visitados',
    avg_visit_min: 'Duração Média (min)', score: 'Score (%)',
    photos: 'Fotos', damages: 'Avarias', stockouts: 'Rupturas',
  },
  produto: {
    brand_name: 'Marca', pdv_name: 'PDV', product_name: 'Produto', sku: 'SKU', promoters: 'Promotores', promoters_count: 'Qtd. Promotores',
    pdvs: 'PDVs', routes: 'Rotas', executed: 'Executados',
    stock_store: 'Estoque Loja', stock_stock: 'Estoque Depósito',
    damages: 'Avarias', stockouts: 'Rupturas', expiries: 'Validade (registros)',
    next_expiry_date: 'Validade + Próxima', next_expiry_qty_store: 'Qtd. Frente',
    next_expiry_qty_stock: 'Qtd. Estoque', next_expiry_total: 'Total na Validade',
  },
  categoria: {
    category_name: 'Categoria', total_products: 'Produtos', total_executions: 'Execuções',
    executed: 'Executados', damages: 'Avarias', stockouts: 'Rupturas',
    total_stock: 'Estoque Total', expiries: 'Validade (registros)',
  },
  avarias: {
    visit_date: 'Data', pdv_name: 'PDV', brand_name: 'Marca', promoter_name: 'Promotor',
    product_name: 'Produto', sku: 'SKU', type: 'Tipo', qty_store: 'Qtd. Loja',
    qty_stock: 'Qtd. Depósito', total: 'Total', reason: 'Motivo',
  },
  inatividade: {
    visit_date: 'Data', promoter_name: 'Promotor', pdv_name: 'PDV', brand_name: 'Marca',
    checkin_at: 'Check-in', last_photo_at: 'Última Foto', inactivity_minutes: 'Min. Inativo',
    minutes_since_checkin: 'Min. Desde Check-in', has_photo_after_checkin: 'Tem Foto', severity: 'Severidade',
    is_alert: 'Em Alerta',
  },
};

// Rótulos genéricos (usados em abas sem mapa próprio e para colunas extras)
const GENERIC_LABELS: Record<string, string> = {
  visit_date: 'Data', date: 'Data', day: 'Dia', created_at: 'Criado em', updated_at: 'Atualizado em',
  pdv_name: 'PDV', network_name: 'Rede', brand_name: 'Marca', promoter_name: 'Promotor',
  product_name: 'Produto', category_name: 'Categoria', sku: 'SKU', status: 'Situação', type: 'Tipo',
  reason: 'Motivo', notes: 'Observações', city: 'Cidade', state: 'UF',
  total: 'Total', qty: 'Quantidade', quantity: 'Quantidade', qty_store: 'Qtd. Loja', qty_stock: 'Qtd. Depósito',
  routes: 'Rotas', total_routes: 'Rotas', completed_routes: 'Rotas Concluídas', pending_routes: 'Rotas Pendentes',
  partial_routes: 'Rotas Parciais', products: 'Produtos', total_products: 'Produtos',
  executed: 'Executados', executed_products: 'Produtos Executados', damages: 'Avarias', stockouts: 'Rupturas',
  expiries: 'Validade (registros)', photos: 'Fotos', pdvs: 'PDVs', pdvs_served: 'PDVs Atendidos',
  pdvs_visited: 'PDVs Visitados', brands: 'Marcas', brands_served: 'Marcas Atendidas',
  promoters: 'Promotores', promoters_count: 'Qtd. Promotores', active_promoters: 'Promotores Ativos',
  score: 'Score (%)', operational_score: 'Score Operacional', avg_visit_min: 'Duração Média (min)',
  avg_visit_duration_min: 'Duração Média (min)', stock_store: 'Estoque Loja', stock_stock: 'Estoque Depósito',
  total_stock: 'Estoque Total', total_executions: 'Execuções', completed: 'Concluídos', pending: 'Pendentes',
};

const STATUS_LABELS: Record<string, string> = {
  completed: 'Concluída', pending: 'Pendente', scheduled: 'Agendada', confirmed: 'Confirmada',
  partial: 'Parcial', cancelled: 'Cancelada', canceled: 'Cancelada', in_progress: 'Em andamento',
  damage: 'Avaria', rupture: 'Ruptura', stockout: 'Ruptura', expiry: 'Validade',
  true: 'Sim', false: 'Não',
};

const HIDDEN_KEYS = /(_id$|^id$|photo_url|image_url|_url$|metadata)/i;

// Converte snake_case desconhecido em rótulo legível
function humanizeKey(key: string): string {
  return GENERIC_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildExportRows(tab: string, rows: any[], only?: string[]): { headers: string[]; keys: string[]; data: any[][] } {
  const labels = COLUMN_LABELS[tab] || {};
  const present = new Set<string>();
  rows.forEach(r => Object.keys(r || {}).forEach(k => present.add(k)));
  const ordered = Object.keys(labels).filter(k => present.has(k));
  const extras = [...present].filter(k => !labels[k] && !HIDDEN_KEYS.test(k));
  let keys = ordered.length ? [...ordered, ...extras] : [...present].filter(k => !HIDDEN_KEYS.test(k));
  if (only && only.length) keys = keys.filter(k => only.includes(k));
  const headers = keys.map(k => labels[k] || humanizeKey(k));
  const fmt = (k: string, v: any) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
    if (typeof v === 'string') {
      // Datas (ISO ou timestamp) no padrão brasileiro
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T12:00:00').toLocaleDateString('pt-BR');
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const st = STATUS_LABELS[v.toLowerCase()];
      if (st && /status|type|situa|tipo/i.test(k)) return st;
    }
    const n = typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v;
    if (typeof n === 'number') return Number.isInteger(n) ? n : Number(n.toFixed(2));
    return String(v);
  };
  const data = rows.map(r => keys.map(k => fmt(k, r[k])));
  return { headers, keys, data };
}

// Exporta Excel (.xlsx) da aba atual com colunas formatadas
async function exportCurrentTabExcel(tab: string, filters: any, preRows?: any[], only?: string[]) {
  try {
    const rows = preRows ?? await fetchTabData(tab, filters);
    if (!rows.length) { alert("Sem dados para exportar neste período/aba."); return; }
    const XLSX = await import('xlsx');
    const { headers, data } = buildExportRows(tab, rows, only);
    const aoa = [
      [`Relatório - ${tabLabel(tab)}`],
      [`Período: ${filters.date_from ? new Date(filters.date_from + 'T12:00:00').toLocaleDateString('pt-BR') : '-'} a ${filters.date_to ? new Date(filters.date_to + 'T12:00:00').toLocaleDateString('pt-BR') : '-'}`],
      [],
      headers,
      ...data,
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    (ws as any)['!cols'] = headers.map((h, i) => ({
      wch: Math.min(45, Math.max(12, h.length + 2, ...data.map(r => String(r[i] ?? '').length + 2))),
    }));
    (ws as any)['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + data.length, c: headers.length - 1 } }) };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tabLabel(tab).slice(0, 30));
    XLSX.writeFile(wb, `relatorio_${tab}_${filters.date_from || ''}_${filters.date_to || ''}.xlsx`);
  } catch (e: any) {
    alert("Erro ao exportar Excel: " + (e?.message || e));
  }
}

// Exporta CSV da aba atual
async function exportCurrentTabCSV(tab: string, filters: any, preRows?: any[], only?: string[]) {
  try {
    const rows = preRows ?? await fetchTabData(tab, filters);
    if (!rows.length) { alert("Sem dados para exportar neste período/aba."); return; }
    const { headers, data } = buildExportRows(tab, rows, only);
    const escape = (v: any) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.map(escape).join(";"), ...data.map(r => r.map(escape).join(";"))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `relatorio_${tab}_${filters.date_from || ''}_${filters.date_to || ''}.csv`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  } catch (e: any) {
    alert("Erro ao exportar CSV: " + (e?.message || e));
  }
}

// Exporta PDF da aba atual
async function exportCurrentTabPDF(tab: string, filters: any, preRows?: any[], only?: string[], userContext?: any) {
  try {
    const rows = preRows ?? await fetchTabData(tab, filters);
    if (!rows.length) { alert("Sem dados para exportar neste período/aba."); return; }
    const [{ default: jsPDF }, autoTableMod] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const autoTable = (autoTableMod as any).default || (autoTableMod as any);
    const doc = new jsPDF('l', 'mm', 'a4');
    const pageWidth = doc.internal.pageSize.getWidth();

    // Header Background
    doc.setFillColor(30, 30, 46);
    doc.rect(0, 0, pageWidth, 40, 'F');

    // Logo Placeholder
    if (userContext?.organization_id) {
      try {
        const orgRes = await api<{ logo_url: string }>(`/api/organizations/${userContext.organization_id}`);
        if (orgRes.logo_url) {
          const agencyLogo = await getBase64ImageFromURL(orgRes.logo_url);
          doc.addImage(agencyLogo, 'PNG', 12, 5, 20, 20);
        }
      } catch (e) {
        console.error("PDF logo error", e);
      }
    }

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text(`Relatório - ${tabLabel(tab)}`, 40, 15);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const brDate = (d?: string) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('pt-BR') : '-');
    const periodStr = `Período: ${brDate(filters.date_from)} a ${brDate(filters.date_to)} • Gerado em ${new Date().toLocaleString('pt-BR')}`;
    doc.text(periodStr, 40, 22);



    // Table
    const { headers, data } = buildExportRows(tab, rows, only);
    const body = data.map(r => r.map(v => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
      return String(v);
    }));

    autoTable(doc, {
      startY: 45,

      head: [headers],
      body,
      styles: { fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
      headStyles: { fillColor: [30, 30, 46], textColor: 255, fontStyle: 'bold', fontSize: 7 },
      alternateRowStyles: { fillColor: [245, 245, 250] },
      margin: { left: 8, right: 8 },
    });

    // Footer
    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(150, 150, 150);
      if (userContext?.organization_footer) {
        doc.text(userContext.organization_footer, pageWidth / 2, doc.internal.pageSize.getHeight() - 10, { align: 'center' });
      }
      doc.text(`Ayratech • Sistema de Gestão v1.0.0 • Página ${i}/${pageCount}`,
        pageWidth / 2, doc.internal.pageSize.getHeight() - 5, { align: 'center' });


    }
    doc.save(`relatorio_${tab}_${filters.date_from || ''}_${filters.date_to || ''}.pdf`);
  } catch (e: any) {
    alert("Erro ao exportar PDF: " + (e?.message || e));
  }
}

// ===== Diálogo de exportação com personalização de colunas =====
function ExportDialog({ open, onOpenChange, tab, filters }: { open: boolean; onOpenChange: (v: boolean) => void; tab: string; filters: any }) {
  const { user } = useAuth();

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [columns, setColumns] = useState<{ key: string; label: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchTabData(tab, filters)
      .then(data => {
        const { headers, keys } = buildExportRows(tab, data);
        const cols = keys.map((k, i) => ({ key: k, label: headers[i] }));
        setRows(data);
        setColumns(cols);
        setSelected(cols.map(c => c.key));
      })
      .catch(() => { setRows([]); setColumns([]); setSelected([]); })
      .finally(() => setLoading(false));
  }, [open, tab, filters]);

  const toggle = (key: string) =>
    setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

  const run = async (fn: (t: string, f: any, r?: any[], only?: string[], u?: any) => Promise<void>) => {
    await fn(tab, filters, rows, selected, user);
    onOpenChange(false);
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Exportar — {tabLabel(tab)}</DialogTitle>
          <DialogDescription>
            Escolha as informações que devem aparecer no arquivo exportado.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Carregando colunas...</p>
        ) : columns.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Sem dados para exportar neste período/aba.</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs">
              <Button variant="ghost" size="sm" onClick={() => setSelected(columns.map(c => c.key))}>Marcar todas</Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected([])}>Desmarcar todas</Button>
              <span className="text-muted-foreground ml-auto">{selected.length}/{columns.length} colunas · {rows.length} linhas</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[45vh] overflow-y-auto border rounded-md p-3">
              {columns.map(c => (
                <label key={c.key} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={selected.includes(c.key)} onCheckedChange={() => toggle(c.key)} />
                  <span className="truncate" title={c.label}>{c.label}</span>
                </label>
              ))}
            </div>
          </>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="outline" disabled={!selected.length} onClick={() => run(exportCurrentTabCSV as any)}>
            <Download className="h-4 w-4 mr-1" />CSV
          </Button>
          <Button variant="outline" disabled={!selected.length} onClick={() => run(exportCurrentTabPDF as any)}>
            <FileText className="h-4 w-4 mr-1" />PDF
          </Button>
          <Button disabled={!selected.length} onClick={() => run(exportCurrentTabExcel as any)}>
            <FileSpreadsheet className="h-4 w-4 mr-1" />Excel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function MerchRelatorios() {
  const [tab, setTab] = useState('dashboard');
  const [aiOpen, setAiOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [period, setPeriod] = useState('month');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [pdvFilter, setPdvFilter] = useState('');
  const [promoterFilter, setPromoterFilter] = useState('');
  const [groupPdv, setGroupPdv] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [configForm, setConfigForm] = useState({ enabled: true, threshold_minutes: 20 });

  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: brands = [] } = useBrands();
  const { data: employees = [] } = useEmployees();
  const { data: pdvs = [] } = useQuery({ queryKey: ['rh-pdvs-list'], queryFn: () => api<any[]>('/api/promotor/rh/pdvs') });
  const { data: inactivityConfig } = useMerchInactivityConfig();

  const dateRange = useMemo(() => {
    if (period === 'custom' && dateFrom && dateTo) return { from: dateFrom, to: dateTo };
    return getDateRange(period);
  }, [period, dateFrom, dateTo]);

  const filters = useMemo(() => ({
    date_from: dateRange.from,
    date_to: dateRange.to,
    brand_id: (user?.brand_id || brandFilter) || undefined,
    pdv_id: pdvFilter || undefined,
    promoter_id: promoterFilter || undefined,
    group_pdv: tab === 'produto' && groupPdv ? '1' : undefined,
  }), [dateRange, brandFilter, pdvFilter, promoterFilter, tab, groupPdv]);

  useEffect(() => {
    if (inactivityConfig) {
      setConfigForm({
        enabled: inactivityConfig.enabled !== false,
        threshold_minutes: Number(inactivityConfig.threshold_minutes || 20),
      });
    }
  }, [inactivityConfig]);

  async function saveInactivityConfig() {
    try {
      const payload = {
        enabled: configForm.enabled,
        threshold_minutes: Math.max(1, Number(configForm.threshold_minutes) || 20),
      };
      await api('/api/merch-analytics/inactivity/config', { method: 'PUT', body: payload });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['merch-analytics-inactivity-config'] }),
        qc.invalidateQueries({ queryKey: ['merch-analytics-inactivity-report'] }),
      ]);
      toast({ title: 'Configuração de inatividade salva' });
      setConfigOpen(false);
    } catch (error: any) {
      toast({
        title: 'Erro ao salvar configuração',
        description: error?.message || 'Não foi possível salvar o timer de inatividade.',
        variant: 'destructive',
      });
    }
  }

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-primary" />
            {user?.brand_id ? `Bem-vindo, ${brands.find(b => b.id === user.brand_id)?.name || 'Marca'}` : 'Relatórios Inteligentes'}
          </h1>
          {!user?.brand_id && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
              <Settings className="h-4 w-4 mr-1" />Configurar Inatividade
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.location.href = '/merch/relatorios/programacao'}>
              <Calendar className="h-4 w-4 mr-1" />Programar envios / Personalizar PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
              <Download className="h-4 w-4 mr-1" />Exportar (personalizar colunas)
            </Button>
            <Button size="sm" className="bg-gradient-to-r from-primary to-primary/80" onClick={() => setAiOpen(true)}>
              <Sparkles className="h-4 w-4 mr-1" />Análise IA
            </Button>
          </div>
          )}
        </div>

        {/* Filters Bar */}
        <Card className="p-3">
          <div className="flex gap-3 flex-wrap items-end">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Período</label>
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>{PERIOD_PRESETS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {period === 'custom' && (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">De</label>
                  <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Até</label>
                  <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36" />
                </div>
              </>
            )}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Marca</label>
              <SearchableSelect
                options={brands.map((b: any) => ({ value: b.id, label: b.name }))}
                value={brandFilter || ALL_VALUE}
                onChange={v => setBrandFilter(v === ALL_VALUE ? '' : v)}
                allLabel="Todas"
                allValue={ALL_VALUE}
                placeholder="Todas"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">PDV</label>
              <SearchableSelect
                options={pdvs.map((p: any) => ({ value: p.id, label: p.name }))}
                value={pdvFilter || ALL_VALUE}
                onChange={v => setPdvFilter(v === ALL_VALUE ? '' : v)}
                allLabel="Todos"
                allValue={ALL_VALUE}
                placeholder="Todos"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Promotor</label>
              <SearchableSelect
                options={employees.filter((e: any) => e.active !== false).map((e: any) => ({ value: e.id, label: e.full_name }))}
                value={promoterFilter || ALL_VALUE}
                onChange={v => setPromoterFilter(v === ALL_VALUE ? '' : v)}
                allLabel="Todos"
                allValue={ALL_VALUE}
                placeholder="Todos"
              />
            </div>
          </div>
        </Card>

        {/* Tabs */}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap h-auto gap-1">
            <TabsTrigger value="dashboard"><Target className="h-4 w-4 mr-1" />Dashboard</TabsTrigger>
            <TabsTrigger value="analitico"><FileText className="h-4 w-4 mr-1" />Analítico</TabsTrigger>
            <TabsTrigger value="pdv"><Store className="h-4 w-4 mr-1" />PDV</TabsTrigger>
            <TabsTrigger value="marca"><Building2 className="h-4 w-4 mr-1" />Marca</TabsTrigger>
            <TabsTrigger value="promotor"><User className="h-4 w-4 mr-1" />Promotor</TabsTrigger>
            <TabsTrigger value="produto"><Package className="h-4 w-4 mr-1" />Produto</TabsTrigger>
            <TabsTrigger value="categoria"><Layers className="h-4 w-4 mr-1" />Categoria</TabsTrigger>
            <TabsTrigger value="inatividade"><TimerReset className="h-4 w-4 mr-1" />Inatividade</TabsTrigger>
            <TabsTrigger value="avarias"><AlertTriangle className="h-4 w-4 mr-1" />Avarias/Rupturas</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard"><DashboardTab filters={filters} /></TabsContent>
          <TabsContent value="analitico"><AnaliticoTab filters={filters} /></TabsContent>
          <TabsContent value="pdv"><PDVTab filters={filters} /></TabsContent>
          <TabsContent value="marca"><MarcaTab filters={filters} /></TabsContent>
          <TabsContent value="promotor"><PromotorTab filters={filters} /></TabsContent>
          <TabsContent value="produto">
            <ProdutoTab filters={filters} groupPdv={groupPdv} onGroupPdvChange={setGroupPdv} />
          </TabsContent>
          <TabsContent value="categoria"><CategoriaTab filters={filters} /></TabsContent>
          <TabsContent value="inatividade"><InatividadeTab filters={filters} onOpenConfig={() => setConfigOpen(true)} /></TabsContent>
          <TabsContent value="avarias"><AvariasTab filters={filters} /></TabsContent>
        </Tabs>
      </div>
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Configuração de Inatividade</DialogTitle>
            <DialogDescription>
              Define em quantos minutos sem foto após o check-in a rota entra em alerta.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Alertas ativos</p>
                <p className="text-xs text-muted-foreground">Desative se quiser acompanhar sem gerar alerta operacional.</p>
              </div>
              <Switch
                checked={configForm.enabled}
                onCheckedChange={(value) => setConfigForm((prev) => ({ ...prev, enabled: value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Minutos para considerar inatividade</Label>
              <Input
                type="number"
                min={1}
                max={720}
                value={configForm.threshold_minutes}
                onChange={(e) => setConfigForm((prev) => ({ ...prev, threshold_minutes: Number(e.target.value) || 1 }))}
              />
              <p className="text-xs text-muted-foreground">
                Exemplo: `20` significa que, após 20 minutos sem nova foto, a rota entra em alerta.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigOpen(false)}>Cancelar</Button>
            <Button onClick={saveInactivityConfig}>Salvar configuração</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} tab={tab} filters={filters} />
      <AiAnalysisChat open={aiOpen} onOpenChange={setAiOpen} filters={filters} />
    </MainLayout>
  );
}

// ===== KPI Card =====
function KPICard({ title, value, icon: Icon, subtitle, trend, color = 'primary' }: {
  title: string; value: string | number; icon: any; subtitle?: string; trend?: number; color?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          <div className={`p-2 rounded-lg bg-${color}/10`}>
            <Icon className={`h-5 w-5 text-${color}`} />
          </div>
        </div>
        {trend !== undefined && (
          <div className={`flex items-center gap-1 mt-2 text-xs ${trend >= 0 ? 'text-green-600' : 'text-red-500'}`}>
            {trend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            <span>{trend >= 0 ? '+' : ''}{trend}% vs anterior</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ===== Score Ring =====
function ScoreRing({ score, label }: { score: number; label: string }) {
  const color = score >= 80 ? 'text-green-500' : score >= 60 ? 'text-yellow-500' : 'text-red-500';
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-20 h-20">
        <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" fill="none" stroke="currentColor" strokeWidth="6" className="text-muted/30" />
          <circle cx="40" cy="40" r="34" fill="none" stroke="currentColor" strokeWidth="6"
            className={color} strokeDasharray={`${(score / 100) * 213.6} 213.6`} strokeLinecap="round" />
        </svg>
        <span className={`absolute inset-0 flex items-center justify-center text-lg font-bold ${color}`}>{score}</span>
      </div>
      <span className="text-xs text-muted-foreground text-center">{label}</span>
    </div>
  );
}

// ===== Dashboard Tab =====
function DashboardTab({ filters }: { filters: any }) {
  const { data, isLoading } = useMerchDashboard(filters);
  const { data: timeline = [] } = useMerchRoutesTimeline(filters);
  const { data: ranking = [] } = useMerchRankingIssues(filters);

  const k = data?.kpis || {};
  const d = data?.derived || {};

  return (
    <div className="space-y-4">
      {/* Primary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <KPICard title="Rotas Totais" value={k.total_routes || 0} icon={Route} subtitle={`${k.completed_routes || 0} concluídas`} />
        <KPICard title="Produtos Auditados" value={k.executed_products || 0} icon={Package} subtitle={`de ${k.total_products || 0} no total`} />
        <KPICard title="Marcas Atendidas" value={k.brands_served || 0} icon={Building2} />
        <KPICard title="PDVs Atendidos" value={k.pdvs_served || 0} icon={Store} />
        <KPICard title="Promotores Ativos" value={k.active_promoters || 0} icon={User} />
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KPICard title="Fotos" value={k.photos_captured || 0} icon={Camera} />
        <KPICard title="Avarias" value={k.damages_registered || 0} icon={AlertTriangle} color="destructive" />
        <KPICard title="Rupturas" value={k.stockouts_registered || 0} icon={ShoppingCart} color="destructive" />
        <KPICard title="Pesq. Preço Concluídas" value={k.price_research_completed || 0} icon={DollarSign} />
        <KPICard title="Contagens Estoque" value={k.stock_counts || 0} icon={Package} />
        <KPICard title="Contagens Validade" value={k.expiry_counts || 0} icon={Clock} />
      </div>

      {/* Scores & Derived */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Score Operacional</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center justify-center gap-6">
              <ScoreRing score={d.operational_score || 0} label="Geral" />
              <ScoreRing score={d.completion_rate || 0} label="Rotas" />
              <ScoreRing score={d.product_execution_rate || 0} label="Produtos" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Taxas</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span>Conclusão de Rota</span><span className="font-semibold">{d.completion_rate || 0}%</span>
              </div>
              <Progress value={d.completion_rate || 0} className="h-2" />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span>Execução de Produtos</span><span className="font-semibold">{d.product_execution_rate || 0}%</span>
              </div>
              <Progress value={d.product_execution_rate || 0} className="h-2" />
            </div>
            <div className="flex justify-between text-xs pt-1">
              <span>Média tempo/visita</span><span className="font-semibold">{d.avg_visit_duration_min || 0} min</span>
            </div>
            <div className="flex justify-between text-xs">
              <span>Média fotos/rota</span><span className="font-semibold">{d.avg_photos_per_route || 0}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Top PDVs com Problemas</CardTitle></CardHeader>
          <CardContent className="space-y-2 max-h-48 overflow-y-auto">
            {ranking.map((r: any, i: number) => (
              <div key={r.pdv_id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground w-4">{i + 1}</span>
                  <span className="truncate max-w-[140px]">{r.pdv_name}</span>
                </div>
                <div className="flex gap-2">
                  <Badge variant="outline" className="text-[10px]">{r.damages} avarias</Badge>
                  <Badge variant="outline" className="text-[10px]">{r.stockouts} rupturas</Badge>
                </div>
              </div>
            ))}
            {ranking.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">Sem dados</p>}
          </CardContent>
        </Card>
      </div>

      {/* Route Timeline Chart */}
      {timeline.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Evolução de Rotas</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={timeline}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="completed" name="Concluídas" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                <Bar dataKey="partial" name="Parciais" fill="hsl(var(--chart-2))" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ===== PDV Tab =====
function PDVTab({ filters }: { filters: any }) {
  const { data: rows = [] } = useMerchReportPDV(filters);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PDV</TableHead>
                <TableHead>Cidade</TableHead>
                <TableHead>Rede</TableHead>
                <TableHead className="text-center">Visitas</TableHead>
                <TableHead className="text-center">Marcas</TableHead>
                <TableHead className="text-center">Promotores</TableHead>
                <TableHead className="text-center">Produtos</TableHead>
                <TableHead className="text-center">Avarias</TableHead>
                <TableHead className="text-center">Rupturas</TableHead>
                <TableHead className="text-center">Tempo Médio</TableHead>
                <TableHead className="text-center">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r: any) => (
                <TableRow key={r.pdv_id}>
                  <TableCell className="font-medium">{r.pdv_name}</TableCell>
                  <TableCell className="text-sm">{r.city || '-'}</TableCell>
                  <TableCell className="text-sm">{r.network || '-'}</TableCell>
                  <TableCell className="text-center">{r.total_visits}</TableCell>
                  <TableCell className="text-center">{r.brands_served}</TableCell>
                  <TableCell className="text-center">{r.promoters}</TableCell>
                  <TableCell className="text-center">{r.executed_products}/{r.total_products}</TableCell>
                  <TableCell className="text-center">{r.damages > 0 ? <Badge variant="destructive">{r.damages}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center">{r.stockouts > 0 ? <Badge variant="destructive">{r.stockouts}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center text-sm">{Math.round(r.avg_duration_min || 0)} min</TableCell>
                  <TableCell className="text-center">
                    <Badge variant={r.score >= 80 ? 'default' : r.score >= 60 ? 'secondary' : 'destructive'}>{r.score}%</Badge>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && <TableRow><TableCell colSpan={11} className="text-center py-8 text-muted-foreground">Sem dados para o período selecionado</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Marca Tab =====
function MarcaTab({ filters }: { filters: any }) {
  const { data: rows = [] } = useMerchReportBrand(filters);
  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        {rows.map((r: any) => (
          <Card key={r.brand_id}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-lg">{r.brand_name}</h3>
                  <div className="flex gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
                    <span><Store className="h-3 w-3 inline mr-1" />{r.pdvs_served} PDVs</span>
                    <span><User className="h-3 w-3 inline mr-1" />{r.promoters} promotores</span>
                    <span><Route className="h-3 w-3 inline mr-1" />{r.completed}/{r.total_routes} rotas</span>
                    <span><Package className="h-3 w-3 inline mr-1" />{r.executed_products}/{r.total_products} produtos</span>
                    {r.damages > 0 && <span className="text-destructive"><AlertTriangle className="h-3 w-3 inline mr-1" />{r.damages} avarias</span>}
                    {r.stockouts > 0 && <span className="text-destructive"><ShoppingCart className="h-3 w-3 inline mr-1" />{r.stockouts} rupturas</span>}
                  </div>
                </div>
                <Badge variant={r.score >= 80 ? 'default' : r.score >= 60 ? 'secondary' : 'destructive'} className="text-lg px-3 py-1">
                  {r.score}%
                </Badge>
              </div>
              <Progress value={r.score} className="mt-3 h-2" />
            </CardContent>
          </Card>
        ))}
        {rows.length === 0 && <Card><CardContent className="py-12 text-center text-muted-foreground">Sem dados</CardContent></Card>}
      </div>
    </div>
  );
}

// ===== Promotor Tab =====
function PromotorTab({ filters }: { filters: any }) {
  const { data: rows = [] } = useMerchReportPromoter(filters);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Promotor</TableHead>
                <TableHead className="text-center">Rotas</TableHead>
                <TableHead className="text-center">Concluídas</TableHead>
                <TableHead className="text-center">Pendentes</TableHead>
                <TableHead className="text-center">Marcas</TableHead>
                <TableHead className="text-center">PDVs</TableHead>
                <TableHead className="text-center">Produtos</TableHead>
                <TableHead className="text-center">Fotos</TableHead>
                <TableHead className="text-center">Avarias</TableHead>
                <TableHead className="text-center">Rupturas</TableHead>
                <TableHead className="text-center">Tempo Médio</TableHead>
                <TableHead className="text-center" title="Score = (rotas concluídas ÷ total de rotas) x 100, no período filtrado">Score ⓘ</TableHead>

              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r: any) => (
                <TableRow key={r.promoter_id}>
                  <TableCell className="font-medium">{r.promoter_name}</TableCell>
                  <TableCell className="text-center">{r.total_routes}</TableCell>
                  <TableCell className="text-center">{r.completed_routes}</TableCell>
                  <TableCell className="text-center">{r.pending_routes}</TableCell>
                  <TableCell className="text-center">{r.brands_served}</TableCell>
                  <TableCell className="text-center">{r.pdvs_visited}</TableCell>
                  <TableCell className="text-center">{r.products_executed}</TableCell>
                  <TableCell className="text-center">{r.photos}</TableCell>
                  <TableCell className="text-center">{r.damages > 0 ? <Badge variant="destructive">{r.damages}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center">{r.stockouts > 0 ? <Badge variant="destructive">{r.stockouts}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center text-sm">{Math.round(parseFloat(r.avg_visit_min) || 0)} min</TableCell>
                  <TableCell className="text-center">
                    <Badge variant={r.score >= 80 ? 'default' : r.score >= 60 ? 'secondary' : 'destructive'}>{r.score}%</Badge>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && <TableRow><TableCell colSpan={12} className="text-center py-8 text-muted-foreground">Sem dados</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Produto Tab =====
function ProdutoTab({ filters, groupPdv, onGroupPdvChange }: { filters: any; groupPdv: boolean; onGroupPdvChange: (v: boolean) => void }) {
  const { data: rows = [] } = useMerchReportProduct(filters);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Switch id="group-pdv" checked={groupPdv} onCheckedChange={onGroupPdvChange} />
        <Label htmlFor="group-pdv" className="text-sm">Separar listagem por PDV</Label>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Marca</TableHead>
                {groupPdv && <TableHead>PDV</TableHead>}
                <TableHead>Produto</TableHead>
                <TableHead>Promotores</TableHead>
                <TableHead className="text-center">PDVs</TableHead>
                <TableHead className="text-center">Rotas</TableHead>
                <TableHead className="text-center">Executados</TableHead>
                <TableHead className="text-center">Estoque Loja</TableHead>
                <TableHead className="text-center">Estoque Depósito</TableHead>
                <TableHead className="text-center">Avarias</TableHead>
                <TableHead className="text-center">Rupturas</TableHead>
                <TableHead className="text-center">Validade (registros)</TableHead>
                <TableHead className="text-center">Validade + Próxima</TableHead>
                <TableHead className="text-center">Qtd. Frente</TableHead>
                <TableHead className="text-center">Qtd. Estoque</TableHead>
                <TableHead className="text-center">Total na Validade</TableHead>

              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r: any) => (
                <TableRow key={`${r.product_id}-${r.pdv_id || ''}`}>
                  <TableCell className="text-sm">{r.brand_name || '—'}</TableCell>
                  {groupPdv && <TableCell className="text-sm">{r.pdv_name || '—'}</TableCell>}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {resolveMediaUrl(r.photo_url) ? <img src={resolveMediaUrl(r.photo_url)!} alt="" className="h-8 w-8 rounded object-cover" /> : <Package className="h-5 w-5 text-muted-foreground" />}
                      <div>
                        <p className="font-medium text-sm">{r.product_name}</p>
                        {r.sku && <p className="text-xs text-muted-foreground">SKU: {r.sku}</p>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[220px]">
                    {r.promoters
                      ? <span className="text-xs" title={r.promoters}>
                          {r.promoters}
                          {parseInt(r.promoters_count) > 1 && <span className="text-muted-foreground"> ({r.promoters_count})</span>}
                        </span>
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-center">{r.pdvs}</TableCell>
                  <TableCell className="text-center">{r.routes}</TableCell>
                  <TableCell className="text-center">{r.executed}</TableCell>
                  <TableCell className="text-center">{r.stock_store}</TableCell>
                  <TableCell className="text-center">{r.stock_stock}</TableCell>
                  <TableCell className="text-center">{parseInt(r.damages) > 0 ? <Badge variant="destructive">{r.damages}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center">{parseInt(r.stockouts) > 0 ? <Badge variant="destructive">{r.stockouts}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center">{parseInt(r.expiries) > 0 ? <Badge variant="secondary">{r.expiries}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center">
                    {r.next_expiry_date
                      ? <Badge variant={new Date(r.next_expiry_date).getTime() - Date.now() < 30 * 86400000 ? 'destructive' : 'secondary'}>
                          {new Date(r.next_expiry_date).toLocaleDateString('pt-BR')}
                        </Badge>
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-center">{r.next_expiry_qty_store ?? 0}</TableCell>
                  <TableCell className="text-center">{r.next_expiry_qty_stock ?? 0}</TableCell>
                  <TableCell className="text-center font-medium">{r.next_expiry_total ?? 0}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && <TableRow><TableCell colSpan={groupPdv ? 16 : 15} className="text-center py-8 text-muted-foreground">Sem dados</TableCell></TableRow>}

            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Categoria Tab =====
function CategoriaTab({ filters }: { filters: any }) {
  const { data: rows = [] } = useMerchReportCategory(filters);

  const chartData = rows.slice(0, 10).map((r: any) => ({
    name: r.category_name || 'Sem categoria',
    executions: parseInt(r.executed) || 0,
    damages: parseInt(r.damages) || 0,
    stockouts: parseInt(r.stockouts) || 0,
  }));

  return (
    <div className="space-y-4">
      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Execuções por Categoria</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="executions" name="Executados" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                <Bar dataKey="damages" name="Avarias" fill="hsl(var(--destructive))" radius={[2, 2, 0, 0]} />
                <Bar dataKey="stockouts" name="Rupturas" fill="hsl(var(--chart-4))" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Categoria</TableHead>
                <TableHead className="text-center">Produtos</TableHead>
                <TableHead className="text-center">Execuções</TableHead>
                <TableHead className="text-center">Concluídos</TableHead>
                <TableHead className="text-center">Estoque Total</TableHead>
                <TableHead className="text-center">Avarias</TableHead>
                <TableHead className="text-center">Rupturas</TableHead>
                <TableHead className="text-center">Validade</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r: any) => (
                <TableRow key={r.category_id || 'none'}>
                  <TableCell className="font-medium">{r.category_name || 'Sem categoria'}</TableCell>
                  <TableCell className="text-center">{r.total_products}</TableCell>
                  <TableCell className="text-center">{r.total_executions}</TableCell>
                  <TableCell className="text-center">{r.executed}</TableCell>
                  <TableCell className="text-center">{r.total_stock}</TableCell>
                  <TableCell className="text-center">{parseInt(r.damages) > 0 ? <Badge variant="destructive">{r.damages}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center">{parseInt(r.stockouts) > 0 ? <Badge variant="destructive">{r.stockouts}</Badge> : '0'}</TableCell>
                  <TableCell className="text-center">{parseInt(r.expiries) > 0 ? <Badge variant="secondary">{r.expiries}</Badge> : '0'}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Sem dados</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Inatividade Tab =====
function InatividadeTab({ filters, onOpenConfig }: { filters: any; onOpenConfig: () => void }) {
  const { data, isLoading } = useMerchInactivityReport(filters);
  const summary = data?.summary || {};
  const rows = data?.rows || [];
  const config = data?.config || { enabled: true, threshold_minutes: 20 };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <KPICard
          title="Rotas Monitoradas"
          value={summary.monitored_routes || 0}
          icon={Route}
          subtitle="Check-in aberto no momento"
        />
        <KPICard
          title="Rotas em Alerta"
          value={summary.alert_routes || 0}
          icon={AlertTriangle}
          subtitle={config.enabled ? "Acima do limite configurado" : "Alertas desativados"}
          color="destructive"
        />
        <KPICard
          title="Timer Configurado"
          value={`${summary.threshold_minutes || config.threshold_minutes || 20} min`}
          icon={TimerReset}
          subtitle="Tempo sem foto para alertar"
        />
        <KPICard
          title="Maior Inatividade"
          value={`${summary.max_inactivity_minutes || 0} min`}
          icon={Clock}
          subtitle={`Média atual ${summary.avg_inactivity_minutes || 0} min`}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Relatório de Inatividade em Campo</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Após o check-in, o sistema mede o tempo desde a última foto registrada na rota.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={config.enabled ? "default" : "secondary"}>
                {config.enabled ? "Monitoramento ativo" : "Alertas desativados"}
              </Badge>
              <Button variant="outline" size="sm" onClick={onOpenConfig}>
                <Settings className="h-4 w-4 mr-1" />Configurar Timer
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Promotor</TableHead>
                <TableHead>PDV</TableHead>
                <TableHead>Marca</TableHead>
                <TableHead className="text-center">Check-in</TableHead>
                <TableHead className="text-center">Última Foto</TableHead>
                <TableHead className="text-center">Inatividade</TableHead>
                <TableHead className="text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row: any) => {
                const statusLabel = !config.enabled
                  ? 'Monitorando'
                  : row.is_alert
                    ? (row.severity === 'critical' ? 'Crítico' : 'Em alerta')
                    : 'Dentro do limite';
                const badgeVariant = !config.enabled
                  ? 'secondary'
                  : row.is_alert
                    ? 'destructive'
                    : 'outline';

                return (
                  <TableRow key={row.route_id}>
                    <TableCell className="font-medium">{row.promoter_name || 'Sem promotor'}</TableCell>
                    <TableCell>
                      <div>
                        <div>{row.pdv_name || 'Sem PDV'}</div>
                        {(row.pdv_city || row.pdv_state) && (
                          <div className="text-xs text-muted-foreground">{[row.pdv_city, row.pdv_state].filter(Boolean).join(' / ')}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{row.brand_name || 'Sem marca'}</TableCell>
                    <TableCell className="text-center">
                      {row.checkin_at ? new Date(row.checkin_at).toLocaleString('pt-BR') : '—'}
                    </TableCell>
                    <TableCell className="text-center">
                      {row.last_photo_at ? new Date(row.last_photo_at).toLocaleString('pt-BR') : (
                        <span className="text-muted-foreground">Sem foto</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center font-semibold">{row.inactivity_minutes || 0} min</TableCell>
                    <TableCell className="text-center">
                      <Badge variant={badgeVariant as any}>{statusLabel}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Nenhuma rota com check-in aberto encontrada para os filtros selecionados.
                  </TableCell>
                </TableRow>
              )}
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Carregando relatório de inatividade...
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Avarias/Rupturas Tab =====
function AvariasTab({ filters }: { filters: any }) {
  const { data: ranking = [] } = useMerchRankingIssues(filters);
  const { data: products = [] } = useMerchReportProduct(filters);

  const productsWithIssues = products.filter((p: any) => parseInt(p.damages) > 0 || parseInt(p.stockouts) > 0)
    .sort((a: any, b: any) => (parseInt(b.damages) + parseInt(b.stockouts)) - (parseInt(a.damages) + parseInt(a.stockouts)));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Store className="h-4 w-4" />PDVs com Mais Problemas</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {ranking.slice(0, 10).map((r: any, i: number) => (
                <div key={r.pdv_id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground w-5">{i + 1}.</span>
                    <span className="text-sm truncate max-w-[180px]">{r.pdv_name}</span>
                  </div>
                  <div className="flex gap-1">
                    <Badge variant="destructive" className="text-[10px]">{r.damages} avarias</Badge>
                    <Badge variant="outline" className="text-[10px]">{r.stockouts} rupturas</Badge>
                  </div>
                </div>
              ))}
              {ranking.length === 0 && <p className="text-center text-sm text-muted-foreground py-4">Sem ocorrências</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Package className="h-4 w-4" />Produtos com Mais Problemas</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {productsWithIssues.slice(0, 10).map((r: any, i: number) => (
                <div key={r.product_id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground w-5">{i + 1}.</span>
                    <span className="text-sm truncate max-w-[180px]">{r.product_name}</span>
                  </div>
                  <div className="flex gap-1">
                    {parseInt(r.damages) > 0 && <Badge variant="destructive" className="text-[10px]">{r.damages} avarias</Badge>}
                    {parseInt(r.stockouts) > 0 && <Badge variant="outline" className="text-[10px]">{r.stockouts} rupturas</Badge>}
                  </div>
                </div>
              ))}
              {productsWithIssues.length === 0 && <p className="text-center text-sm text-muted-foreground py-4">Sem ocorrências</p>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ===== Analítico Tab (versão analítica – mesmo conteúdo do PDF) =====
function parseVisitDate(v: any): Date | null {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}
function statusMeta(status: string, visit_date: string) {
  const today = new Date(); today.setHours(0,0,0,0);
  const vd = parseVisitDate(visit_date);
  const isFuture = vd && vd.getTime() > today.getTime();
  const isToday = vd && vd.getTime() === today.getTime();
  const wkEnd = new Date(today); wkEnd.setDate(wkEnd.getDate() + 7);
  const inWeek = vd && vd.getTime() >= today.getTime() && vd.getTime() <= wkEnd.getTime();
  if (status === 'completed') return { label: 'Realizado', className: 'bg-green-100 text-green-800 border-green-300', variant: 'default' as const };
  if (status === 'in_progress') return { label: 'Em andamento', className: 'bg-yellow-100 text-yellow-800 border-yellow-300', variant: 'secondary' as const };
  if (['cancelled', 'justified', 'no_show', 'skipped'].includes(status)) return { label: 'Não realizado', className: 'bg-red-100 text-red-800 border-red-300', variant: 'destructive' as const };
  if (isFuture || isToday || inWeek) return { label: 'Agendado', className: 'bg-blue-50 text-blue-800 border-blue-300', variant: 'outline' as const };
  return { label: 'Pendente', className: 'bg-muted text-muted-foreground border', variant: 'outline' as const };
}

function AnaliticoTab({ filters }: { filters: any }) {
  const { data, isLoading } = useMerchAnalytical(filters);
  const summary = data?.summary || {};
  const rows = data?.rows || [];

  // Group by PDV
  const groups = useMemo(() => {
    const map = new Map<string, { pdv_name: string; pdv_city: string; pdv_state: string; items: any[] }>();
    for (const r of rows) {
      const key = r.pdv_id || r.pdv_name || '—';
      if (!map.has(key)) map.set(key, { pdv_name: r.pdv_name || 'Sem PDV', pdv_city: r.pdv_city, pdv_state: r.pdv_state, items: [] });
      map.get(key)!.items.push(r);
    }
    return Array.from(map.entries()).map(([k, v]) => ({ key: k, ...v }));
  }, [rows]);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPICard title="Agendadas" value={summary.scheduled || 0} icon={Route} />
        <KPICard title="Concluídas" value={summary.completed || 0} icon={CheckCircle2} />
        <KPICard title="Em andamento" value={summary.in_progress || 0} icon={Clock} />
        <KPICard title="Não realizadas" value={summary.not_done || 0} icon={XCircle} />
        <KPICard title="% Conclusão" value={`${summary.completion_pct || 0}%`} icon={Target} subtitle={`Agendadas p/ semana: ${summary.upcoming || 0}`} />
      </div>

      {/* Legend */}
      <Card className="p-3">
        <div className="flex flex-wrap gap-3 text-xs">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-green-500" /> Realizado</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-yellow-400" /> Parcial / Em andamento</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-blue-400" /> Agendado</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-500" /> Não realizado</span>
        </div>
      </Card>

      {isLoading && <Card><CardContent className="py-10 text-center text-muted-foreground">Carregando…</CardContent></Card>}
      {!isLoading && groups.length === 0 && (
        <Card><CardContent className="py-10 text-center text-muted-foreground">Sem rotas para o período/filtros selecionados</CardContent></Card>
      )}

      {/* Grouped by PDV */}
      <div className="space-y-3">
        {groups.map((g) => {
          const total = g.items.length;
          const done = g.items.filter((i) => i.status === 'completed').length;
          const upcoming = g.items.filter((i) => {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const vd = parseVisitDate(i.visit_date);
            return vd && vd.getTime() >= today.getTime() && !['completed', 'cancelled', 'justified', 'no_show', 'skipped'].includes(i.status);
          }).length;
          return (
            <Card key={g.key} className="overflow-hidden">
              <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <Store className="h-4 w-4 text-blue-700" />
                  <span className="font-semibold">{g.pdv_name}</span>
                  {(g.pdv_city || g.pdv_state) && (
                    <span className="text-xs text-muted-foreground">{[g.pdv_city, g.pdv_state].filter(Boolean).join('/')}</span>
                  )}
                </div>
                <div className="flex gap-2 text-xs">
                  <Badge variant="outline">{total} rotas</Badge>
                  <Badge className="bg-green-100 text-green-800 border-green-300">{done} realizadas</Badge>
                  {upcoming > 0 && <Badge className="bg-blue-100 text-blue-800 border-blue-300"><CalendarClock className="h-3 w-3 mr-1" />{upcoming} agendadas</Badge>}
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Marca</TableHead>
                    <TableHead>Promotor</TableHead>
                    <TableHead className="text-center">Itens</TableHead>
                    <TableHead className="text-center">Progresso</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.items.map((i: any) => {
                    const meta = statusMeta(i.status, i.visit_date);
                    const _vd = parseVisitDate(i.visit_date);
                    const dateStr = _vd ? _vd.toLocaleDateString('pt-BR') : '-';
                    return (
                      <TableRow key={i.id}>
                        <TableCell className="text-sm">{dateStr}</TableCell>
                        <TableCell className="text-sm">{i.brand_name || '-'}</TableCell>
                        <TableCell className="text-sm">{i.promoter_name || '-'}</TableCell>
                        <TableCell className="text-center text-sm">{i.items_executed}/{i.items_scheduled}</TableCell>
                        <TableCell className="text-center">
                          <div className="flex items-center gap-2">
                            <Progress value={Number(i.progress_pct) || 0} className="h-2 flex-1" />
                            <span className="text-xs w-8 text-right">{Math.round(Number(i.progress_pct) || 0)}%</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs border ${meta.className}`}>{meta.label}</span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
