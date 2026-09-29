import { useMemo } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useRhIndicators } from "@/hooks/use-rh-extended";
import {
  Users, TrendingDown, TrendingUp, AlertTriangle, Stethoscope, Shield,
  GraduationCap, ClipboardCheck, DollarSign, Cake, Clock, CalendarClock
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, BarChart, Bar, CartesianGrid } from "recharts";

const fmtDate = (v: any) => {
  if (!v) return "—";
  try {
    const parsed = parseISO(String(v).slice(0, 10) + 'T12:00:00');
    return Number.isNaN(parsed.getTime()) ? "—" : format(parsed, 'dd/MM/yyyy', { locale: ptBR });
  } catch { return "—"; }
};

function StatCard({ title, value, icon: Icon, tone = "default", subtitle }: any) {
  const tones: Record<string, string> = {
    default: "text-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
    info: "text-blue-600 dark:text-blue-400",
  };
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">{title}</span>
          <Icon className={`h-4 w-4 ${tones[tone]}`} />
        </div>
        <div className={`text-2xl font-semibold ${tones[tone]}`}>{value}</div>
        {subtitle && <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}

export default function RHIndicadores() {
  const { data, isLoading } = useRhIndicators();

  const turnoverData = useMemo(() => {
    const s = data?.turnover_series || [];
    return s.map((r: any) => {
      const hc = Number(r.headcount) || 0;
      const term = Number(r.terminations) || 0;
      const rate = hc > 0 ? (term / hc) * 100 : 0;
      return {
        month: fmtDate(r.month_start) === '—' ? '—' : format(parseISO(`${String(r.month_start).slice(0, 10)}T12:00:00`), "MMM/yy", { locale: ptBR }),
        rate: Number(rate.toFixed(2)),
        admissions: Number(r.admissions) || 0,
        terminations: term,
      };
    });
  }, [data]);

  const currentTurnover = turnoverData.length ? turnoverData[turnoverData.length - 1].rate : 0;
  const prevTurnover = turnoverData.length > 1 ? turnoverData[turnoverData.length - 2].rate : 0;
  const trending = currentTurnover >= prevTurnover;

  const hc = data?.headcount || {};
  const exams = data?.exams || {};
  const epis = data?.epis || {};
  const trainings = data?.trainings || {};
  const abs = data?.absenteeism || {};
  const absRate = abs.total_records > 0 ? ((abs.absent_days / abs.total_records) * 100).toFixed(1) : "0.0";
  const payrollCurrent = (data?.payroll || []).find((p: any) => p.reference_month === new Date().toISOString().slice(0,7))?.total || 0;
  const payrollPrev = (data?.payroll || []).find((p: any) => p.reference_month !== new Date().toISOString().slice(0,7))?.total || 0;

  const warnCounts = useMemo(() => {
    const arr = data?.warnings_90d_by_type || [];
    return arr.map((r: any) => ({ type: r.warning_type, count: Number(r.count) }));
  }, [data]);

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Indicadores de RH</h1>
            <p className="text-sm text-muted-foreground">Visão executiva da operação de pessoas</p>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        ) : (
          <>
            {/* Headcount + KPIs principais */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <StatCard title="Ativos" value={hc.active || 0} icon={Users} tone="success" subtitle={`Total ${hc.total || 0}`} />
              <StatCard title="Afastados" value={hc.on_leave || 0} icon={AlertTriangle} tone="warning" />
              <StatCard title="Férias" value={hc.on_vacation || 0} icon={CalendarClock} tone="info" />
              <StatCard title="Turnover mês" value={`${currentTurnover.toFixed(1)}%`} icon={trending ? TrendingUp : TrendingDown} tone={trending ? "danger" : "success"} subtitle={`Anterior ${prevTurnover.toFixed(1)}%`} />
              <StatCard title="Tempo médio casa" value={`${(data?.avg_tenure_years || 0).toFixed(1)}a`} icon={Clock} />
              <StatCard title="Absenteísmo mês" value={`${absRate}%`} icon={AlertTriangle} tone={Number(absRate) > 5 ? "danger" : "default"} />
            </div>

            {/* Alertas críticos */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard title="ASOs vencidos" value={exams.expired || 0} icon={Stethoscope} tone="danger" />
              <StatCard title="ASOs vencendo 30d" value={exams.expiring_30 || 0} icon={Stethoscope} tone="warning" />
              <StatCard title="EPIs vencidos" value={epis.expired || 0} icon={Shield} tone="danger" />
              <StatCard title="EPIs vencendo 30d" value={epis.expiring_30 || 0} icon={Shield} tone="warning" />
              <StatCard title="EPIs entregues mês" value={epis.delivered_month || 0} icon={Shield} tone="info" />
              <StatCard title="CA de EPI vencendo" value={epis.ca_expiring || 0} icon={AlertTriangle} tone="warning" />
              <StatCard title="Treinamentos vencidos" value={trainings.expired || 0} icon={GraduationCap} tone="danger" />
              <StatCard title="Treinamentos vencendo 60d" value={trainings.expiring_60 || 0} icon={GraduationCap} tone="warning" />
            </div>

            {/* Turnover chart */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Turnover — últimos 12 meses</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={turnoverData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="month" fontSize={12} />
                    <YAxis fontSize={12} />
                    <Tooltip formatter={(v: any, k: any) => k === 'rate' ? `${v}%` : v} />
                    <Line type="monotone" dataKey="rate" name="Turnover %" stroke="hsl(var(--primary))" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Admissões vs desligamentos */}
              <Card>
                <CardHeader><CardTitle className="text-base">Admissões x Desligamentos</CardTitle></CardHeader>
                <CardContent className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={turnoverData}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="month" fontSize={12} />
                      <YAxis fontSize={12} />
                      <Tooltip />
                      <Bar dataKey="admissions" name="Admissões" fill="hsl(var(--primary))" />
                      <Bar dataKey="terminations" name="Desligamentos" fill="hsl(var(--destructive))" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Contratos de experiência */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><ClipboardCheck className="h-4 w-4" />Contratos de experiência</CardTitle></CardHeader>
                <CardContent>
                  {(data?.experience_alerts || []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">Sem contratos de experiência ativos.</p>
                  ) : (
                    <div className="space-y-2 max-h-56 overflow-y-auto">
                      {(data?.experience_alerts || []).map((e: any) => (
                        <div key={e.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                          <div>
                            <div className="text-sm font-medium">{e.full_name}</div>
                            <div className="text-xs text-muted-foreground">{e.position} · admissão {fmtDate(e.admission_date)}</div>
                          </div>
                          <div className="text-right">
                            <Badge variant={e.bucket?.includes('15d') ? 'destructive' : 'secondary'}>
                              {e.bucket === 'primeiro_15d' && '1º venc. em ≤15d'}
                              {e.bucket === 'segundo_15d' && '2º venc. em ≤15d'}
                              {e.bucket === 'segundo_45d' && 'Venc. em ≤45d'}
                              {e.bucket === 'outros' && 'Em curso'}
                            </Badge>
                            <div className="text-xs text-muted-foreground mt-1">Fim: {fmtDate(e.second_end)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Documentos pendentes de admissões recentes */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><ClipboardCheck className="h-4 w-4" />Documentos pendentes (admissões dos últimos 30 dias)</CardTitle></CardHeader>
                <CardContent>
                  {(data?.pending_admission_docs || []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">Todos os documentos obrigatórios foram anexados. ✓</p>
                  ) : (
                    <div className="space-y-2 max-h-56 overflow-y-auto">
                      {(data?.pending_admission_docs || []).map((p: any) => (
                        <div key={p.id} className="flex items-start justify-between border-b pb-2 last:border-0 gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{p.full_name}</div>
                            <div className="text-xs text-muted-foreground">Admitido em {fmtDate(p.admission_date)}</div>
                            <div className="text-xs text-destructive mt-1">Faltam: {(p.missing || []).join(', ')}</div>
                          </div>
                          <Badge variant="destructive">{(p.missing || []).length}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Próximos ASOs */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Stethoscope className="h-4 w-4" />ASOs vencendo</CardTitle></CardHeader>
                <CardContent className="max-h-56 overflow-y-auto space-y-2">
                  {(exams.upcoming || []).length === 0 ? <p className="text-sm text-muted-foreground">Nenhum.</p> :
                    (exams.upcoming || []).map((r: any) => (
                      <div key={r.id} className="flex justify-between text-sm border-b pb-1 last:border-0">
                        <span>{r.full_name}</span>
                        <Badge variant={new Date(r.expiry_date) < new Date() ? 'destructive' : 'secondary'}>{fmtDate(r.expiry_date)}</Badge>
                      </div>
                    ))
                  }
                </CardContent>
              </Card>

              {/* Próximos EPIs */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4" />EPIs a substituir</CardTitle></CardHeader>
                <CardContent className="max-h-56 overflow-y-auto space-y-2">
                  {(epis.upcoming || []).length === 0 ? <p className="text-sm text-muted-foreground">Nenhum.</p> :
                    (epis.upcoming || []).map((r: any) => (
                      <div key={r.id} className="flex justify-between text-sm border-b pb-1 last:border-0">
                        <span>{r.full_name} · <span className="text-muted-foreground">{r.epi_name}</span></span>
                        <Badge variant={new Date(r.expected_replacement) < new Date() ? 'destructive' : 'secondary'}>{fmtDate(r.expected_replacement)}</Badge>
                      </div>
                    ))
                  }
                </CardContent>
              </Card>

              {/* Advertências 90d */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4" />Advertências 90d</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex gap-2 flex-wrap mb-3">
                    {warnCounts.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma.</p> :
                      warnCounts.map((w) => (
                        <Badge key={w.type} variant="outline" className="capitalize">{w.type}: {w.count}</Badge>
                      ))}
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {(data?.warnings_recent || []).map((w: any) => (
                      <div key={w.id} className="text-xs border-b pb-1 last:border-0">
                        <div className="font-medium">{w.full_name}</div>
                        <div className="text-muted-foreground">{fmtDate(w.warning_date)} · {w.warning_type} · {w.reason}</div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Folha */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><DollarSign className="h-4 w-4" />Folha</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-muted-foreground">Mês atual</div>
                      <div className="text-xl font-semibold">R$ {Number(payrollCurrent).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Mês anterior</div>
                      <div className="text-xl font-semibold">R$ {Number(payrollPrev).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Aniversariantes */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Cake className="h-4 w-4" />Aniversariantes do mês</CardTitle></CardHeader>
                <CardContent className="max-h-40 overflow-y-auto space-y-1">
                  {(data?.birthdays || []).length === 0 ? <p className="text-sm text-muted-foreground">Nenhum este mês.</p> :
                    (data?.birthdays || []).map((b: any) => (
                      <div key={b.id} className="flex justify-between text-sm">
                        <span>{b.full_name} <span className="text-muted-foreground text-xs">{b.position}</span></span>
                        <span className="text-muted-foreground text-xs">{format(parseISO(String(b.birth_date).slice(0,10) + 'T12:00:00'), 'dd/MM')}</span>
                      </div>
                    ))}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </MainLayout>
  );
}
