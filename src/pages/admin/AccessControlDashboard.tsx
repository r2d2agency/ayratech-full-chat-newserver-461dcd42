import { useDashboardOperational, useDashboardValidations, useDashboardPromoters, useDashboardFinancial } from '@/hooks/use-access-dashboard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Activity, Users, ShieldCheck, DollarSign, Loader2, CalendarOff, MapPin, AlertTriangle, TrendingUp, Building2 } from 'lucide-react';
import { format } from 'date-fns';
import { formatCalendarDate } from '@/lib/date-utils';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, PieChart, Pie, Cell, Legend } from 'recharts';
import { Link } from 'react-router-dom';

const KPI = ({ label, value, icon: Icon, accent }: any) => (
  <Card>
    <CardContent className="p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${accent || 'bg-primary/10 text-primary'}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold">{value ?? '—'}</p>
      </div>
    </CardContent>
  </Card>
);

const COLORS = ['hsl(var(--primary))', 'hsl(var(--accent))', 'hsl(var(--destructive))', 'hsl(var(--muted-foreground))'];

export default function AccessControlDashboard() {
  const op = useDashboardOperational();
  const val = useDashboardValidations();
  const prom = useDashboardPromoters();
  const fin = useDashboardFinancial();

  const loading = op.isLoading && val.isLoading && prom.isLoading && fin.isLoading;
  if (loading) return <div className="p-8 flex justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  const promoterTypeData = prom.data ? [
    { name: 'Fixo', value: prom.data.fixo || 0 },
    { name: 'Freelance', value: prom.data.freelance || 0 },
    { name: 'Substituto', value: prom.data.substituto || 0 },
  ] : [];

  const validationStatusData = val.data ? [
    { name: 'Aprovados', value: val.data.approved || 0 },
    { name: 'Pendentes', value: val.data.pending || 0 },
    { name: 'Divergentes', value: val.data.divergent || 0 },
    { name: 'Rejeitados', value: val.data.rejected || 0 },
  ] : [];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Activity className="h-6 w-6 text-primary" /> Dashboard de Acompanhamento
        </h1>
        <p className="text-muted-foreground">Visão consolidada de operação, validações, promotores e finanças</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label="Visitas hoje" value={op.data?.visits_today} icon={Activity} />
        <KPI label="No PDV agora" value={op.data?.in_pdv} icon={MapPin} accent="bg-green-500/10 text-green-600" />
        <KPI label="Afastamentos ativos" value={op.data?.active_leaves?.length || 0} icon={CalendarOff} accent="bg-orange-500/10 text-orange-600" />
        <KPI label="Validações pendentes" value={val.data?.pending} icon={ShieldCheck} accent="bg-blue-500/10 text-blue-600" />
      </div>

      <Tabs defaultValue="operational" className="space-y-4">
        <TabsList>
          <TabsTrigger value="operational"><Activity className="h-4 w-4 mr-2" /> Operacional</TabsTrigger>
          <TabsTrigger value="validations"><ShieldCheck className="h-4 w-4 mr-2" /> Validações IA</TabsTrigger>
          <TabsTrigger value="promoters"><Users className="h-4 w-4 mr-2" /> Promotores</TabsTrigger>
          <TabsTrigger value="financial"><DollarSign className="h-4 w-4 mr-2" /> Financeiro</TabsTrigger>
        </TabsList>

        {/* OPERATIONAL */}
        <TabsContent value="operational" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-center">
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Aprovadas hoje</p><p className="text-xl font-bold text-green-600">{op.data?.approved || 0}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Pendentes hoje</p><p className="text-xl font-bold text-orange-600">{op.data?.pending || 0}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Rejeitadas hoje</p><p className="text-xl font-bold text-destructive">{op.data?.rejected || 0}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Substituições pendentes</p><p className="text-xl font-bold text-orange-600">{op.data?.pending_substitution || 0}</p></CardContent></Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><CalendarOff className="h-4 w-4" /> Afastamentos ativos</CardTitle></CardHeader>
            <CardContent>
              {!op.data?.active_leaves?.length ? (
                <p className="text-sm text-muted-foreground text-center py-6">Nenhum afastamento ativo</p>
              ) : (
                <div className="space-y-2">
                  {op.data.active_leaves.slice(0, 10).map((l: any) => (
                    <div key={l.id} className="flex items-center justify-between p-2 rounded-md bg-muted/30">
                      <div>
                        <p className="font-medium text-sm">{l.promoter_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {l.reason} • desde {formatCalendarDate(l.start_date, 'dd/MM/yy')}
                        </p>
                      </div>
                      {l.substitute_name ? (
                        <Badge variant="default" className="text-xs">→ {l.substitute_name}</Badge>
                      ) : (
                        <Badge variant="destructive" className="text-xs"><AlertTriangle className="h-3 w-3 mr-1" /> Sem substituto</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* VALIDATIONS */}
        <TabsContent value="validations" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card>
              <CardHeader><CardTitle className="text-base">Status (últimos 30d)</CardTitle></CardHeader>
              <CardContent style={{ height: 240 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={validationStatusData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80}>
                      {validationStatusData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Legend />
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card className="md:col-span-2">
              <CardHeader><CardTitle className="text-base">Score médio: <span className="text-primary">{val.data?.avg_score ?? '—'}</span></CardTitle></CardHeader>
              <CardContent>
                {!val.data?.recent?.length ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Nenhuma validação recente</p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {val.data.recent.map((v: any) => (
                      <div key={v.id} className="flex items-center justify-between p-2 rounded-md bg-muted/30 text-sm">
                        <div>
                          <p className="font-medium">{v.promoter_name}</p>
                          <p className="text-xs text-muted-foreground">{v.rede_name || '—'} • {format(new Date(v.created_at), 'dd/MM HH:mm')}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{v.score ?? 0}</Badge>
                          <Badge variant={v.status === 'approved' ? 'default' : v.status === 'rejected' ? 'destructive' : 'secondary'}>{v.status}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* PROMOTERS */}
        <TabsContent value="promoters" className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KPI label="Total" value={prom.data?.total} icon={Users} />
            <KPI label="Ativos" value={prom.data?.active} icon={TrendingUp} accent="bg-green-500/10 text-green-600" />
            <KPI label="Disponíveis" value={prom.data?.available} icon={Activity} accent="bg-blue-500/10 text-blue-600" />
            <KPI label="Bloqueados" value={prom.data?.blocked} icon={AlertTriangle} accent="bg-destructive/10 text-destructive" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Distribuição por tipo</CardTitle></CardHeader>
              <CardContent style={{ height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={promoterTypeData}>
                    <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <Tooltip />
                    <Bar dataKey="value" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Building2 className="h-4 w-4" /> Por agência</CardTitle></CardHeader>
              <CardContent>
                {!prom.data?.by_agency?.length ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Sem dados</p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {prom.data.by_agency.map((a: any) => (
                      <div key={a.id} className="flex items-center justify-between p-2 rounded-md bg-muted/30 text-sm">
                        <p className="font-medium truncate">{a.agency_name}</p>
                        <div className="flex gap-1">
                          <Badge variant="outline" className="text-xs">{a.active}/{a.total}</Badge>
                          {a.freelance > 0 && <Badge variant="secondary" className="text-xs">{a.freelance} free</Badge>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* FINANCIAL */}
        <TabsContent value="financial" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <KPI label="Freelancers ativados no mês" value={fin.data?.freelancers_this_month?.count} icon={Users} accent="bg-blue-500/10 text-blue-600" />
            <KPI label="Custo estimado (mês)" value={`R$ ${Number(fin.data?.freelancers_this_month?.estimated_cost || 0).toFixed(2)}`} icon={DollarSign} accent="bg-green-500/10 text-green-600" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Contratos vencendo (30 dias)</CardTitle></CardHeader>
              <CardContent>
                {!fin.data?.contracts_expiring?.length ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Nenhum contrato vencendo</p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {fin.data.contracts_expiring.map((c: any) => (
                      <div key={c.id} className="flex items-center justify-between p-2 rounded-md bg-muted/30 text-sm">
                        <p className="font-medium">{c.name}</p>
                        <Badge variant="outline">{formatCalendarDate(c.contract_end_date, 'dd/MM/yyyy')}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Custo de freelancers por PDV</CardTitle></CardHeader>
              <CardContent>
                {!fin.data?.cost_by_pdv?.length ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Sem dados</p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {fin.data.cost_by_pdv.map((p: any) => (
                      <div key={p.id} className="flex items-center justify-between p-2 rounded-md bg-muted/30 text-sm">
                        <div>
                          <p className="font-medium">{p.pdv_name || '—'}</p>
                          <p className="text-xs text-muted-foreground">{p.visits} visita(s)</p>
                        </div>
                        <Badge>R$ {Number(p.estimated_cost).toFixed(2)}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <div className="text-xs text-muted-foreground text-center pt-4">
        <Link to="/admin/access-control" className="hover:underline">→ Voltar para Controle de Acesso</Link>
      </div>
    </div>
  );
}
