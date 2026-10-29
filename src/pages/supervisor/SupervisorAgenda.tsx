import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SupervisorLayout } from './SupervisorLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, ChevronLeft, ChevronRight, Users, MapPin, Clock, UserPlus } from 'lucide-react';
import { useSupervisorRoutes, useSupervisorUpdateRoute, useSupervisorAddSupport } from '@/hooks/use-supervisor';
import { useSupervisorTeam } from '@/hooks/use-promotor';
import { toast } from 'sonner';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addMonths, subMonths, eachDayOfInterval, isSameDay, isSameMonth, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-500', confirmed: 'bg-cyan-500', in_progress: 'bg-orange-500',
  completed: 'bg-green-500', not_done: 'bg-red-500', cancelled: 'bg-gray-400',
};

const STATUS_BADGE_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  in_progress: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  completed: 'bg-green-500/10 text-green-700 dark:text-green-400',
  confirmed: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
  not_done: 'bg-red-500/10 text-red-700 dark:text-red-400',
  cancelled: 'bg-gray-400/10 text-gray-600 dark:text-gray-400',
};

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Agendada',
  in_progress: 'Em execução',
  completed: 'Concluída',
  confirmed: 'Confirmada',
  not_done: 'Não realizada',
  cancelled: 'Cancelada',
};

export default function SupervisorAgenda() {
  const { data: team = [], isLoading: loadingTeam } = useSupervisorTeam();
  const supervisorEmployee = (() => {
    try {
      return JSON.parse(localStorage.getItem('supervisor_employee') || '{}');
    } catch {
      return {};
    }
  })();
  const [searchParams] = useSearchParams();
  const [promoterId, setPromoterId] = useState<string>(searchParams.get('promoter') || '');
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [editingRoute, setEditingRoute] = useState<any>(null);
  const [editDate, setEditDate] = useState('');
  const [supportEmployee, setSupportEmployee] = useState('');

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const { data: routes = [], isLoading: loadingRoutes } = useSupervisorRoutes({
    promoter_id: promoterId || undefined,
    date_from: format(monthStart, 'yyyy-MM-dd'),
    date_to: format(monthEnd, 'yyyy-MM-dd'),
  });

  const updateRoute = useSupervisorUpdateRoute();
  const addSupport = useSupervisorAddSupport();

  const routesByDay = useMemo(() => {
    const m: Record<string, any[]> = {};
    (routes as any[]).forEach((r: any) => {
      const d = String(r.visit_date).slice(0, 10);
      (m[d] = m[d] || []).push(r);
    });
    return m;
  }, [routes]);

  const dayRoutes = selectedDay ? (routesByDay[format(selectedDay, 'yyyy-MM-dd')] || []) : [];

  const handleSaveDate = async () => {
    if (!editingRoute || !editDate) return;
    try {
      await updateRoute.mutateAsync({ id: editingRoute.id, visit_date: editDate });
      toast.success('Rota atualizada');
      setEditingRoute(null);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleAddSupport = async () => {
    if (!editingRoute || !supportEmployee) return;
    try {
      await addSupport.mutateAsync({ routeId: editingRoute.id, employee_id: supportEmployee });
      toast.success('Apoio adicionado');
      setSupportEmployee('');
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  if (loadingTeam) {
    return <SupervisorLayout><div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin" /></div></SupervisorLayout>;
  }

  return (
    <SupervisorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2"><Users className="h-5 w-5" /> Agenda</h1>

        <Select value={promoterId} onValueChange={setPromoterId}>
          <SelectTrigger><SelectValue placeholder="Selecione o promotor" /></SelectTrigger>
          <SelectContent>
            {(team as any[]).map((p: any) => (
              <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="icon" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="font-medium">{format(currentMonth, 'MMMM yyyy', { locale: ptBR })}</span>
          <Button variant="ghost" size="icon" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}><ChevronRight className="h-4 w-4" /></Button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
          {['D','S','T','Q','Q','S','S'].map((d, i) => <div key={i}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((d) => {
            const key = format(d, 'yyyy-MM-dd');
            const rs = routesByDay[key] || [];
            const inMonth = isSameMonth(d, currentMonth);
            const isSelected = selectedDay && isSameDay(d, selectedDay);
            return (
              <button
                key={key}
                onClick={() => setSelectedDay(d)}
                className={`aspect-square flex flex-col items-center justify-center rounded-lg text-xs transition-colors ${!inMonth ? 'opacity-30' : ''} ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              >
                <span>{format(d, 'd')}</span>
                <div className="flex gap-0.5 mt-0.5">
                  {rs.slice(0, 3).map((r: any) => (
                    <span key={r.id} className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[r.status] || 'bg-gray-400'}`} title={STATUS_LABELS[r.status] || r.status} />
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        {selectedDay && (
          <div className="space-y-2">
            <h2 className="font-medium text-sm">{format(selectedDay, 'dd/MM/yyyy')}</h2>
            {loadingRoutes && <Loader2 className="h-4 w-4 animate-spin" />}
            {dayRoutes.length === 0 && <p className="text-xs text-muted-foreground">Sem rotas</p>}
            {dayRoutes.map((r: any) => (
              <Card key={r.id} className="cursor-pointer" onClick={() => { setEditingRoute(r); setEditDate(String(r.visit_date).slice(0,10)); }}>
                <CardContent className="p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{r.pdv_name || 'PDV'}</span>
                    <span className="text-xs text-muted-foreground">{r.scheduled_time?.slice(0,5)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <MapPin className="h-3 w-3" />{r.pdv_city}
                    <Clock className="h-3 w-3" />{r.brand_name}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Dialog open={!!editingRoute} onOpenChange={(o) => { if (!o) setEditingRoute(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Ajustar rota</DialogTitle>
            </DialogHeader>
            {editingRoute && (
              <div className="space-y-3">
                <div>
                  <Label>Data da visita</Label>
                  <Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </div>
                <Button onClick={handleSaveDate} disabled={updateRoute.isPending} className="w-full">
                  {updateRoute.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Salvar data
                </Button>
                <div className="border-t pt-3">
                  <Label>Adicionar apoio</Label>
                  <Select value={supportEmployee} onValueChange={setSupportEmployee}>
                    <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {supervisorEmployee?.id && (
                        <SelectItem value={supervisorEmployee.id}>
                          {supervisorEmployee.name || supervisorEmployee.full_name || 'Eu (Supervisor)'}
                        </SelectItem>
                      )}
                      {(team as any[]).map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button onClick={handleAddSupport} disabled={addSupport.isPending || !supportEmployee} className="w-full mt-2" variant="outline">
                    <UserPlus className="h-4 w-4 mr-2" /> Adicionar apoio
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingRoute(null)}>Fechar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </SupervisorLayout>
  );
}