import { useState, useMemo, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  LineChart, Line, PieChart, Pie, Cell 
} from "recharts";
import { 
  LayoutDashboard, Users, Route, Store, Package, Activity, 
  TrendingUp, TrendingDown, Clock, Camera, AlertTriangle, 
  ShoppingCart, Filter, RefreshCw, Calendar, Target,
  ChevronRight, Building2, UserCheck, CheckCircle2, Search, Download, FileSpreadsheet,
  ArrowLeft
} from "lucide-react";
import { 
  useMerchDashboard, 
  useMerchRoutesTimeline, 
  useMerchRankingIssues, 
  useMerchReportStockouts,
  useMerchReportBrand 
} from "@/hooks/use-merch-analytics";
import { useBrands } from "@/hooks/use-merchandising";
import { format, startOfWeek, endOfWeek, subDays, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { BrandRecord } from "@/components/merchandising/BrandRecord";

const CHART_COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

export default function MerchDashboard() {
  const [period, setPeriod] = useState('week');
  const [selectedBrand, setSelectedBrand] = useState<string>('all');
  const [selectedBrandRecord, setSelectedBrandRecord] = useState<{ id: string, name: string } | null>(null);
  const [searchTerm, setSearchBrand] = useState('');
  const { data: brands = [] } = useBrands();
  const { user } = useAuth();
  const navigate = useNavigate();
  
  // Se o usuário está restrito a uma marca, força a seleção dela
  useEffect(() => {
    if (user?.brand_id) {
      setSelectedBrand(user.brand_id);
    }
  }, [user?.brand_id]);

  const brandPermissions = useMemo(() => {
    if (!user?.brand_id) return null;
    return brands.find(b => b.id === user.brand_id);
  }, [user?.brand_id, brands]);
  

  const dateRange = useMemo(() => {
    const today = new Date();
    if (period === 'today') return { from: format(today, 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
    if (period === 'week') return { from: format(startOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
    return { from: format(startOfMonth(today), 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
  }, [period]);

  const filters = useMemo(() => ({
    date_from: dateRange.from,
    date_to: dateRange.to,
    brand_id: selectedBrand === 'all' ? undefined : selectedBrand
  }), [dateRange, selectedBrand]);

  const { data, isLoading, refetch } = useMerchDashboard(filters);
  const { data: timeline = [] } = useMerchRoutesTimeline(filters);
  const { data: ranking = [] } = useMerchRankingIssues(filters);
  const { data: stockouts = [], isLoading: isLoadingStockouts } = useMerchReportStockouts(filters);
  
  // Marcas com atividade no período
  const { data: brandActivity = [] } = useMerchReportBrand({
    date_from: format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd'),
    date_to: format(new Date(), 'yyyy-MM-dd')
  });

  const exportStockoutsCSV = () => {
    if (stockouts.length === 0) {
      alert("Não há dados para exportar no período selecionado.");
      return;
    }

    const headers = ["Data", "PDV", "Cidade", "Promotor", "Marca", "Produto", "SKU", "Qtd Ruptura", "Motivo"];
    const csvContent = [
      headers.join(","),
      ...stockouts.map((s: any) => [
        s.visit_date,
        `"${s.pdv_name}"`,
        `"${s.pdv_city}"`,
        `"${s.promoter_name}"`,
        `"${s.brand_name}"`,
        `"${s.product_name}"`,
        `"${s.product_sku || ''}"`,
        s.qty,
        `"${s.reason || ''}"`
      ].join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `rupturas_${dateRange.from}_a_${dateRange.to}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };


  const kpis = data?.kpis || {};
  const derived = data?.derived || {};

  const periodLabel = period === 'today' ? 'Hoje' : period === 'week' ? 'Esta Semana' : 'Este Mês';

  return (
    <MainLayout>
      <div className="space-y-6">
        {selectedBrandRecord ? (
          <BrandRecord 
            brandId={selectedBrandRecord.id} 
            brandName={selectedBrandRecord.name} 
            onClose={() => setSelectedBrandRecord(null)}
            dateRange={dateRange}
          />
        ) : (
          <>
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold flex items-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">
                  <LayoutDashboard className="h-6 w-6 text-purple-600" />
                  Dashboard Merchandising
                </h1>
                <p className="text-sm text-muted-foreground">Visão consolidada da operação em campo</p>
              </div>
              
              <div className="flex flex-wrap items-center gap-2">
                {!user?.brand_id && (
                  <div className="flex items-center gap-2 mr-2">
                    <Select value={selectedBrand} onValueChange={setSelectedBrand}>
                      <SelectTrigger className="w-[180px] h-9 bg-background">
                        <SelectValue placeholder="Todas as Marcas" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas as Marcas</SelectItem>
                        {brands.map((b: any) => (
                          <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="flex bg-muted rounded-lg p-1">
                  {(['today', 'week', 'month'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPeriod(p)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                        period === p 
                          ? "bg-background text-foreground shadow-sm" 
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p === 'today' ? 'Hoje' : p === 'week' ? 'Semana' : 'Mês'}
                    </button>
                  ))}
                </div>
                <Button variant="outline" size="sm" onClick={exportStockoutsCSV} disabled={isLoadingStockouts} className="h-9 gap-2">
                  <Download className="h-4 w-4" />
                  <span className="hidden sm:inline">Exportar Rupturas</span>
                </Button>
                <Button variant="outline" size="icon" onClick={() => refetch()} disabled={isLoading} className="h-9 w-9">
                  <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>

            {/* Weekly Brands Quick Access */}
            {!user?.brand_id && (
              <Card className="bg-primary/5 border-primary/10 overflow-hidden">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" />
                    Marcas com Execução na Semana
                  </CardTitle>
                  <CardDescription className="text-[10px]">Clique na marca para ver o prontuário completo</CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                    {brandActivity.filter((b: any) => b.total_routes > 0).map((b: any) => (
                      <Button 
                        key={b.brand_id} 
                        variant="outline" 
                        className="h-auto py-2 px-4 flex-shrink-0 bg-background hover:border-primary hover:bg-primary/5 group transition-all"
                        onClick={() => setSelectedBrandRecord({ id: b.brand_id, name: b.brand_name })}
                      >
                        <div className="text-left">
                          <p className="text-xs font-bold group-hover:text-primary">{b.brand_name}</p>
                          <p className="text-[10px] text-muted-foreground">{b.total_routes} rotas / {b.pdvs_served} pdvs</p>
                        </div>
                        <ChevronRight className="h-3 w-3 ml-2 text-muted-foreground group-hover:text-primary" />
                      </Button>
                    ))}
                    {brandActivity.filter((b: any) => b.total_routes > 0).length === 0 && (
                      <p className="text-xs text-muted-foreground py-2 italic">Nenhuma atividade registrada nesta semana.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

        {/* Main Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {(!user?.brand_id || brandPermissions?.show_routes) && (
            <StatCard 
              title="Rotas Agendadas" 
              value={kpis.total_routes || 0} 
              icon={Route} 
              description={`${kpis.completed_routes || 0} concluídas`}
              progress={(kpis.completed_routes / (kpis.total_routes || 1)) * 100}
            />
          )}
          <StatCard 
            title="Promotores Ativos" 
            value={kpis.active_promoters || 0} 
            icon={UserCheck} 
            color="text-green-500"
          />
          <StatCard 
            title="PDVs Atendidos" 
            value={kpis.pdvs_served || 0} 
            icon={Store} 
            color="text-blue-500"
          />
          {!user?.brand_id && (
            <StatCard 
              title="Marcas" 
              value={kpis.brands_served || 0} 
              icon={Building2} 
              color="text-purple-500"
            />
          )}
          {(!user?.brand_id || brandPermissions?.show_stock) && (
            <StatCard 
              title="Execução Produtos" 
              value={`${derived.product_execution_rate || 0}%`} 
              icon={Package} 
              color="text-orange-500"
              description={`${kpis.executed_products || 0} de ${kpis.total_products || 0}`}
            />
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Operational Performance */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                  {(!user?.brand_id || brandPermissions?.show_routes) ? (
                    <>
                      <div>
                        <CardTitle className="text-base">Evolução de Rotas ({periodLabel})</CardTitle>
                        <CardDescription>Previsto vs Realizado por dia</CardDescription>
                      </div>
                      <Activity className="h-4 w-4 text-muted-foreground" />
                    </>
                  ) : (
                    <div>
                      <CardTitle className="text-base">Atividade ({periodLabel})</CardTitle>
                      <CardDescription>Resumo de presença</CardDescription>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={timeline} onClick={() => navigate('/merch/relatorios?tab=pdv')}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--muted))" />
                      <XAxis 
                        dataKey="date" 
                        fontSize={11} 
                        tickLine={false} 
                        axisLine={false}
                        tickFormatter={(val) => {
                          try {
                            return format(new Date(val), 'dd/MM', { locale: ptBR });
                          } catch {
                            return val;
                          }
                        }}
                      />
                      <YAxis fontSize={11} tickLine={false} axisLine={false} />
                      <Tooltip 
                        cursor={{ fill: 'hsl(var(--muted)/0.4)' }}
                        contentStyle={{ borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                      />
                      {(!user?.brand_id || brandPermissions?.show_routes) && (
                        <Bar dataKey="scheduled" name="Previsto" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} fillOpacity={0.4} />
                      )}
                      <Bar dataKey="completed" name="Realizado" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="partial" name="Em Andamento" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

          {/* Operational Score */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Score Operacional</CardTitle>
              <CardDescription>Qualidade da execução geral</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center pt-2">
              <div className="relative w-40 h-40 flex items-center justify-center">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                  <circle
                    cx="50" cy="50" r="45"
                    fill="none"
                    stroke="hsl(var(--muted))"
                    strokeWidth="8"
                    className="opacity-20"
                  />
                  <circle
                    cx="50" cy="50" r="45"
                    fill="none"
                    stroke="hsl(var(--primary))"
                    strokeWidth="8"
                    strokeDasharray={282.7}
                    strokeDashoffset={282.7 - (282.7 * (derived.operational_score || 0)) / 100}
                    strokeLinecap="round"
                    className="transition-all duration-1000 ease-out"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-4xl font-bold">{derived.operational_score || 0}</span>
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider">Pontos</span>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4 w-full mt-8">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Cobertura</span>
                    <span className="font-medium">{derived.completion_rate || 0}%</span>
                  </div>
                  <Progress value={derived.completion_rate || 0} className="h-1" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Execução</span>
                    <span className="font-medium">{derived.product_execution_rate || 0}%</span>
                  </div>
                  <Progress value={derived.product_execution_rate || 0} className="h-1" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Field Health */}
          {(!user?.brand_id || brandPermissions?.show_photos) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  Saúde do Campo
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <HealthItem 
                  label="Tempo Médio / Visita" 
                  value={`${derived.avg_visit_duration_min || 0} min`} 
                  icon={Clock}
                />
                <HealthItem 
                  label="Fotos Capturadas" 
                  value={kpis.photos_captured || 0} 
                  icon={Camera}
                  subValue={`Média ${derived.avg_photos_per_route || 0} / rota`}
                />
                {!user?.brand_id && (
                  <HealthItem 
                    label="Pesquisas de Preço" 
                    value={kpis.price_research_completed || 0} 
                    icon={Target}
                    subValue={`${kpis.price_research_pending || 0} pendentes`}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {/* Critical Alerts */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Alertas Críticos
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Link to="/merch/execucao?tab=damages" className="block p-3 rounded-lg bg-destructive/5 border border-destructive/10 hover:bg-destructive/10 transition-colors">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-destructive">Avarias Registradas</span>
                  <Badge variant="destructive" className="text-xs">{kpis.damages_registered || 0}</Badge>
                </div>
                <p className="text-[10px] text-muted-foreground leading-tight">Produtos danificados ou impróprios para venda identificados no campo.</p>
              </Link>
              
              <Link to="/merch/execucao?tab=returns" className="block p-3 rounded-lg bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-900/30 hover:bg-orange-100 transition-colors">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-orange-700 dark:text-orange-400">Rupturas de Estoque</span>
                  <Badge variant="outline" className="text-xs bg-orange-100 text-orange-700 border-orange-200">{kpis.stockouts_registered || 0}</Badge>
                </div>
                <p className="text-[10px] text-muted-foreground leading-tight">Falta de produtos na gôndola ou no depósito detectada pelos promotores.</p>
              </Link>

              <div className="pt-2 border-t mt-auto">
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="w-full text-xs gap-2" 
                  onClick={exportStockoutsCSV}
                  disabled={isLoadingStockouts || stockouts.length === 0}
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-green-600" />
                  Baixar Lista de Rupturas ({stockouts.length})
                </Button>
              </div>

            </CardContent>
          </Card>

          {/* Ranking Issues */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Store className="h-4 w-4 text-primary" />
                Top PDVs Críticos
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {ranking.slice(0, 5).map((r: any, i: number) => (
                  <div key={r.pdv_id} className="flex items-center justify-between group cursor-pointer hover:bg-muted/50 rounded p-1" onClick={() => navigate(`/merch/relatorios?tab=pdv&pdv_id=${r.pdv_id}`)}>
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="h-6 w-6 rounded bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                        {i + 1}
                      </div>
                      <span className="text-xs font-medium truncate max-w-[150px]">{r.pdv_name}</span>
                    </div>
                    <div className="flex gap-1">
                      <Badge variant="outline" className="text-[10px] h-5 px-1 bg-red-50 text-red-700 border-red-100">
                        {r.damages} av
                      </Badge>
                      <Badge variant="outline" className="text-[10px] h-5 px-1 bg-orange-50 text-orange-700 border-orange-100">
                        {r.stockouts} rup
                      </Badge>
                    </div>
                  </div>
                ))}
                {ranking.length === 0 && (
                  <div className="py-8 text-center text-muted-foreground">
                    <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-20" />
                    <p className="text-xs">Nenhum problema reportado</p>
                  </div>
                )}
              </div>
              <Button variant="ghost" size="sm" className="w-full mt-4 text-[11px] text-primary" asChild>
                <Link to="/merch/relatorios?tab=pdv">Ver relatório completo <ChevronRight className="ml-1 h-3 w-3" /></Link>
              </Button>
            </CardContent>
          </Card>
        </div>
          </>
        )}
      </div>
    </MainLayout>
  );
}

function StatCard({ title, value, icon: Icon, description, progress, color }: any) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{title}</p>
            <div className="flex items-baseline gap-1">
              <h3 className="text-2xl font-bold">{value}</h3>
            </div>
          </div>
          <div className={cn("p-2 rounded-lg bg-muted/50", color)}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
        {(description || progress !== undefined) && (
          <div className="mt-3">
            {progress !== undefined && <Progress value={progress} className="h-1 mb-1.5" />}
            {description && <p className="text-[10px] text-muted-foreground font-medium">{description}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HealthItem({ label, value, icon: Icon, subValue }: any) {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl border border-border/50 hover:border-primary/20 transition-all">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-primary/5 flex items-center justify-center">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground font-medium">{label}</p>
          {subValue && <p className="text-[10px] text-muted-foreground opacity-70">{subValue}</p>}
        </div>
      </div>
      <span className="text-sm font-bold">{value}</span>
    </div>
  );
}
