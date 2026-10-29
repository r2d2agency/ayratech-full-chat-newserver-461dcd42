import { useState, useMemo } from 'react';
import { SupervisorLayout } from './SupervisorLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Loader2, MapPin, Clock, User, Search } from 'lucide-react';
import { useSupervisorRoutes, useSupervisorUpdateRoute } from '@/hooks/use-supervisor';
import { useSupervisorTeam } from '@/hooks/use-promotor';
import { toast } from 'sonner';

export default function SupervisorRotas() {
  const { data: team = [] } = useSupervisorTeam();
  const [filterPromoter, setFilterPromoter] = useState('');
  const [filterPdv, setFilterPdv] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [editDate, setEditDate] = useState('');

  const { data: routes = [], isLoading } = useSupervisorRoutes({
    promoter_id: filterPromoter || undefined,
  });

  const updateRoute = useSupervisorUpdateRoute();

  const filtered = useMemo(() => {
    let arr = (routes as any[]) || [];
    if (filterPdv) arr = arr.filter((r: any) => (r.pdv_name || '').toLowerCase().includes(filterPdv.toLowerCase()) || (r.pdv_city || '').toLowerCase().includes(filterPdv.toLowerCase()));
    if (filterStatus) arr = arr.filter((r: any) => r.status === filterStatus);
    return arr;
  }, [routes, filterPdv, filterStatus]);

  const handleSave = async () => {
    if (!editing) return;
    try {
      await updateRoute.mutateAsync({ id: editing.id, visit_date: editDate });
      toast.success('Rota atualizada');
      setEditing(null);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  return (
    <SupervisorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold">Rotas (supervisão)</h1>

        <div className="flex gap-2">
          <Select value={filterPromoter} onValueChange={setFilterPromoter}>
            <SelectTrigger className="flex-1"><SelectValue placeholder="Promotor" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Todos</SelectItem>
              {(team as any[]).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-32"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Todos</SelectItem>
              <SelectItem value="scheduled">Agendada</SelectItem>
              <SelectItem value="in_progress">Em execução</SelectItem>
              <SelectItem value="completed">Concluída</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Filtrar por PDV/cidade" value={filterPdv} onChange={(e) => setFilterPdv(e.target.value)} />
        </div>

        {isLoading && <Loader2 className="h-6 w-6 animate-spin mx-auto" />}

        <div className="space-y-2">
          {filtered.map((r: any) => (
            <Card key={r.id} className="cursor-pointer" onClick={() => { setEditing(r); setEditDate(String(r.visit_date).slice(0, 10)); }}>
              <CardContent className="p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{r.pdv_name || 'PDV'}</span>
                  <span className="text-xs text-muted-foreground">{r.scheduled_time?.slice(0, 5)}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  <MapPin className="h-3 w-3" />{r.pdv_city}
                  <User className="h-3 w-3" />{r.promoter_name}
                  <Clock className="h-3 w-3" />{String(r.visit_date).slice(0, 10)}
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded bg-muted">{r.status}</span>
              </CardContent>
            </Card>
          ))}
          {filtered.length === 0 && !isLoading && <p className="text-sm text-muted-foreground text-center py-8">Nenhuma rota</p>}
        </div>

        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Ajustar rota</DialogTitle></DialogHeader>
            {editing && (
              <div className="space-y-3">
                <div>
                  <Label>Data da visita</Label>
                  <Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </div>
                <Button onClick={handleSave} disabled={updateRoute.isPending} className="w-full">
                  {updateRoute.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Salvar
                </Button>
              </div>
            )}
            <DialogFooter><Button variant="outline" onClick={() => setEditing(null)}>Fechar</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </SupervisorLayout>
  );
}