import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Clock, Save, Loader2, Calendar } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

interface DaySchedule { enabled: boolean; start: string; end: string; lunch_start: string; lunch_end: string; }
interface WorkSchedule {
  timezone: string; work_days: number[]; work_start: string; work_end: string;
  lunch_start: string; lunch_end: string; punch_tolerance_minutes: number;
  enforce_minimum_lunch_break?: boolean; dayConfig: Record<string, DaySchedule>;
}

const DAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const defaults = (schedule: Partial<WorkSchedule> = {}): WorkSchedule => {
  const days = schedule.work_days || [1, 2, 3, 4, 5];
  const config = schedule.dayConfig || {};
  const dayConfig: Record<string, DaySchedule> = {};
  for (let i = 0; i < 7; i++) {
    const old = config[String(i)] || (config as any)[['dom','seg','ter','qua','qui','sex','sab'][i]];
    dayConfig[String(i)] = old || {
      enabled: days.includes(i), start: schedule.work_start || '08:00', end: schedule.work_end || '18:00',
      lunch_start: schedule.lunch_start || '12:00', lunch_end: schedule.lunch_end || '13:00'
    };
  }
  return { timezone: schedule.timezone || 'America/Sao_Paulo', work_days: days,
    work_start: schedule.work_start || '08:00', work_end: schedule.work_end || '18:00',
    lunch_start: schedule.lunch_start || '12:00', lunch_end: schedule.lunch_end || '13:00',
    punch_tolerance_minutes: schedule.punch_tolerance_minutes ?? 15,
    enforce_minimum_lunch_break: schedule.enforce_minimum_lunch_break !== false, dayConfig };
};

export function WorkSchedulePanel() {
  const [schedule, setSchedule] = useState<WorkSchedule>(defaults());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => { (async () => { try { setSchedule(defaults(await api<Partial<WorkSchedule>>('/api/organizations/work-schedule'))); } catch (e) { console.error(e); } finally { setLoading(false); } })(); }, []);
  const updateDay = (id: number, patch: Partial<DaySchedule>) => setSchedule(s => ({ ...s, dayConfig: { ...s.dayConfig, [id]: { ...s.dayConfig[String(id)], ...patch } } }));
  const handleSave = async () => {
    setSaving(true);
    try {
      const enabled = Object.entries(schedule.dayConfig).filter(([, d]) => d.enabled).map(([id]) => Number(id));
      const first = schedule.dayConfig[String(enabled[0] ?? 1)] || schedule.dayConfig['1'];
      await api('/api/organizations/work-schedule', { method: 'PUT', body: { ...schedule, work_days: enabled, work_start: first.start, work_end: first.end, lunch_start: first.lunch_start, lunch_end: first.lunch_end }, auth: true });
      toast.success('Jornada global salva');
    } catch { toast.error('Erro ao salvar jornada global'); } finally { setSaving(false); }
  };
  if (loading) return <Card><CardContent className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></CardContent></Card>;
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2"><Calendar className="h-5 w-5 text-primary" />Jornada Global de Ponto</CardTitle>
      <CardDescription>Usada por colaboradores sem escala diária ou recorrente. Configure cada dia separadamente.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <div className="rounded-md bg-primary/5 p-3 text-sm text-muted-foreground">A jornada abaixo será aplicada como <strong>JORNADA_GLOBAL</strong>. Dias desativados são considerados folga.</div>
      <div className="space-y-3">{DAYS.map((name, id) => { const day = schedule.dayConfig[String(id)]; return <div key={id} className="rounded-lg border p-3 space-y-3">
        <div className="flex items-center justify-between"><Label className="font-semibold">{name}</Label><div className="flex items-center gap-2 text-sm"><span>{day.enabled ? 'Trabalha' : 'Folga'}</span><Switch checked={day.enabled} onCheckedChange={enabled => updateDay(id, { enabled })} /></div></div>
        {day.enabled && <div className="grid grid-cols-2 md:grid-cols-4 gap-3"><div><Label className="text-xs">Entrada</Label><Input type="time" value={day.start} onChange={e => updateDay(id, { start: e.target.value })} /></div><div><Label className="text-xs">Saída</Label><Input type="time" value={day.end} onChange={e => updateDay(id, { end: e.target.value })} /></div><div><Label className="text-xs">Início almoço</Label><Input type="time" value={day.lunch_start} onChange={e => updateDay(id, { lunch_start: e.target.value })} /></div><div><Label className="text-xs">Fim almoço</Label><Input type="time" value={day.lunch_end} onChange={e => updateDay(id, { lunch_end: e.target.value })} /></div></div>}
      </div>; })}</div>
      <div className="space-y-2"><Label className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />Tolerância para bater ponto (minutos)</Label><Input type="number" min={0} max={120} value={schedule.punch_tolerance_minutes} onChange={e => setSchedule(s => ({ ...s, punch_tolerance_minutes: Number(e.target.value) || 0 }))} /></div>
      <Button onClick={handleSave} disabled={saving} className="w-full">{saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}Salvar Jornada Global</Button>
    </CardContent>
  </Card>;
}
