import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSupervisorTeam, useSupervisorTeamPunches } from "@/hooks/use-supervisor";
import { SupervisorLayout } from "./SupervisorLayout";
import { Clock, MapPin, CheckCircle2, AlertTriangle, Loader2, Search } from "lucide-react";
import { format } from "date-fns";

const GEO_STATUS_MAP: Record<string, { label: string; color: string }> = {
  dentro_area: { label: 'Dentro do PDV', color: 'text-green-600' },
  fora_area: { label: 'Fora do PDV', color: 'text-red-600' },
  excecao: { label: 'Exceção', color: 'text-yellow-600' },
  sem_gps: { label: 'Sem GPS', color: 'text-gray-500' },
  sem_pdv: { label: 'Sem PDV', color: 'text-gray-500' },
};

const PUNCH_LABELS: Record<string, string> = {
  entrada: '🟢 Entrada', saida_intervalo: '🟡 Saída Intervalo', retorno_intervalo: '🔵 Retorno', saida: '🔴 Saída', extraordinaria: '⚪ Extra', ajuste: '🔧 Ajuste'
};

// Exibição em América/São Paulo independente do fuso do aparelho
function toSaoPauloDate(d: Date): Date {
  return new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function safeFormatDate(value: any, fmt: string, fallback = '—'): string {
  if (!value) return fallback;
  const d = new Date(String(value).replace(' ', 'T'));
  return d && !Number.isNaN(d.getTime()) ? format(toSaoPauloDate(d), fmt) : fallback;
}

export default function SupervisorPonto() {
  const { data: team = [] } = useSupervisorTeam();
  const [filterEmployee, setFilterEmployee] = useState('');
  const [search, setSearch] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const { data: punches = [], isLoading } = useSupervisorTeamPunches({
    employee_id: filterEmployee && filterEmployee !== 'all' ? filterEmployee : undefined,
    date,
  });

  const filteredTeam = useMemo(
    () => (team as any[]).filter((p: any) => p.full_name?.toLowerCase().includes(search.toLowerCase())),
    [team, search]
  );

  // Agrupa por colaborador -> data
  const grouped = useMemo(() => {
    const byEmp: Record<string, { name: string; dates: Record<string, any[]> }> = {};
    (punches as any[]).forEach((p: any) => {
      const name = p.employee_name || p.employee_id;
      if (!byEmp[p.employee_id]) byEmp[p.employee_id] = { name, dates: {} };
      const ts = p.punched_at || p.offline_local_time || p.created_at;
      const dateStr = safeFormatDate(ts, 'yyyy-MM-dd', '');
      if (!dateStr) return;
      if (!byEmp[p.employee_id].dates[dateStr]) byEmp[p.employee_id].dates[dateStr] = [];
      byEmp[p.employee_id].dates[dateStr].push(p);
    });
    return byEmp;
  }, [punches]);

  const empIds = Object.keys(grouped).sort((a, b) =>
    (grouped[a].name || '').localeCompare(grouped[b].name || '')
  );

  // Colaboradores sem ponto no dia (para alerta rápido)
  const punchedIds = new Set(Object.keys(grouped));
  const missing = (team as any[]).filter((p: any) =>
    (!filterEmployee || filterEmployee === 'all' || p.id === filterEmployee) &&
    p.full_name?.toLowerCase().includes(search.toLowerCase()) &&
    !punchedIds.has(p.id)
  );

  return (
    <SupervisorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2"><Clock className="h-5 w-5" /> Ponto da Equipe</h1>

        <div className="grid grid-cols-2 gap-2">
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="text-sm" />
          <Select value={filterEmployee} onValueChange={setFilterEmployee}>
            <SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {(team as any[]).map((p: any) => (
                <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar promotor..." className="pl-9" />
        </div>

        {isLoading && <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>}

        {empIds.map(empId => (
          <div key={empId} className="space-y-2">
            <h2 className="text-sm font-semibold">{grouped[empId].name}</h2>
            {Object.keys(grouped[empId].dates).sort((a, b) => b.localeCompare(a)).map(d => (
              <Card key={d}>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="text-sm font-medium">{safeFormatDate(d + 'T12:00:00', 'EEEE, dd/MM/yyyy')}</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0 space-y-2">
                  {grouped[empId].dates[d].map((p: any) => (
                    <div key={p.id} className="flex items-center justify-between text-sm p-2 bg-muted/30 rounded-lg">
                      <div className="flex items-center gap-2">
                        <span>{PUNCH_LABELS[p.punch_type] || p.punch_type}</span>
                        <span className="text-muted-foreground">{safeFormatDate(p.punched_at || p.offline_local_time, 'HH:mm:ss')}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {p.is_offline && <Badge variant="outline" className="text-[10px]">Offline</Badge>}
                        {p.pdv_name && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-3 w-3" />{p.pdv_name}
                          </span>
                        )}
                        {p.geo_status && GEO_STATUS_MAP[p.geo_status] && (
                          <span className={`text-xs ${GEO_STATUS_MAP[p.geo_status].color} flex items-center gap-1`} title={GEO_STATUS_MAP[p.geo_status].label}>
                            {p.geo_status === 'dentro_area' ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        ))}

        {!isLoading && empIds.length === 0 && missing.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-8">Nenhum registro encontrado</p>
        )}

        {missing.length > 0 && (
          <Card className="border-yellow-300 dark:border-yellow-700">
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-600" /> Sem ponto em {safeFormatDate(date + 'T12:00:00', 'dd/MM')} ({missing.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 space-y-1">
              {missing.map((p: any) => (
                <p key={p.id} className="text-xs text-muted-foreground">• {p.full_name}</p>
              ))}
            </CardContent>
          </Card>
        )}

        {filteredTeam.length > 0 && search && (
          <p className="text-xs text-muted-foreground text-center">{filteredTeam.length} na equipe · {empIds.length} com ponto</p>
        )}
      </div>
    </SupervisorLayout>
  );
}
