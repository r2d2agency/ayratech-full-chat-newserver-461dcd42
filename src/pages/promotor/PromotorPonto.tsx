import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePromotorPunches } from "@/hooks/use-promotor";
import { PromotorLayout } from "./PromotorLayout";
import { Clock, MapPin, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { format, subDays } from "date-fns";

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

// date-fns formata usando o fuso horário do próprio navegador/aparelho —
// se o dispositivo estiver com fuso diferente (ou mal configurado), a data
// e hora do ponto podem aparecer erradas, sobretudo perto da meia-noite.
// Convertendo explicitamente para América/São Paulo antes de formatar, a
// exibição fica correta independente do fuso do aparelho.
function toSaoPauloDate(d: Date): Date {
  return new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function safeFormatDate(value: any, fmt: string, fallback = '—'): string {
  if (!value) return fallback;
  const d = new Date(String(value).replace(' ', 'T'));
  return d && !Number.isNaN(d.getTime()) ? format(toSaoPauloDate(d), fmt) : fallback;
}

export default function PromotorPonto() {
  const startDate = subDays(new Date(), 30).toISOString().slice(0, 10);
  const { data: punches, isLoading } = usePromotorPunches({ start_date: startDate });

  // Group by date
  const grouped = (punches || []).reduce((acc: Record<string, any[]>, p: any) => {
    const ts = p.punched_at || p.offline_local_time || p.created_at;
    const dateStr = safeFormatDate(ts, 'yyyy-MM-dd', '');
    if (!dateStr) return acc;
    if (!acc[dateStr]) acc[dateStr] = [];
    acc[dateStr].push(p);
    return acc;
  }, {});
  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  return (
    <PromotorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2"><Clock className="h-5 w-5" /> Meu Ponto</h1>
        <p className="text-sm text-muted-foreground">Últimos 30 dias</p>

        {isLoading && <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>}

        {dates.length === 0 && !isLoading && (
          <p className="text-center text-sm text-muted-foreground py-8">Nenhum registro encontrado</p>
        )}

        {dates.map(date => (
          <Card key={date}>
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-sm font-medium">{safeFormatDate(date + 'T12:00:00', 'EEEE, dd/MM/yyyy')}</CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 space-y-2">
              {grouped[date].map((p: any) => (
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
                    {p.geo_status && (
                      <span className={`text-xs ${GEO_STATUS_MAP[p.geo_status]?.color || ''}`}>
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
    </PromotorLayout>
  );
}
