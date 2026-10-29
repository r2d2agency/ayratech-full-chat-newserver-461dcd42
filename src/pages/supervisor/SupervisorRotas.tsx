import { useState, useMemo } from 'react';
import { SupervisorLayout } from './SupervisorLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Loader2, MapPin, Clock, User, Search, UserPlus, Image, CheckCircle, Store } from 'lucide-react';
import { useSupervisorRoutes, useSupervisorUpdateRoute, useSupervisorAddSupport, useSupervisorRoutePhotos, useSupervisorRouteExecutions } from '@/hooks/use-supervisor';
import { useSupervisorTeam } from '@/hooks/use-promotor';
import { usePDVs } from '@/hooks/use-promotor';
import { toast } from 'sonner';

const STATUS_COLORS: Record<string, string> = {
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

export default function SupervisorRotas() {
  const { data: team = [] } = useSupervisorTeam();
  const { data: pdvs = [] } = usePDVs();
  const supervisorEmployee = (() => {
    try {
      return JSON.parse(localStorage.getItem('supervisor_employee') || '{}');
    } catch {
      return {};
    }
  })();
  const [filterPromoter, setFilterPromoter] = useState('');
  const [filterPdv, setFilterPdv] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [editDate, setEditDate] = useState('');
  const [editPdv, setEditPdv] = useState('');
  const [supportEmployee, setSupportEmployee] = useState('');
  const [showPhotos, setShowPhotos] = useState<any>(null);

  const { data: routes = [], isLoading } = useSupervisorRoutes({
    promoter_id: filterPromoter && filterPromoter !== "all" ? filterPromoter : undefined,
  });

  const updateRoute = useSupervisorUpdateRoute();
  const addSupport = useSupervisorAddSupport();
  const { data: photos = [], isLoading: loadingPhotos } = useSupervisorRoutePhotos(showPhotos?.id);
  const { data: executions = [], isLoading: loadingExecs } = useSupervisorRouteExecutions(showPhotos?.id);

  const filtered = useMemo(() => {
    let arr = (routes as any[]) || [];
    if (filterPdv) arr = arr.filter((r: any) => (r.pdv_name || '').toLowerCase().includes(filterPdv.toLowerCase()) || (r.pdv_city || '').toLowerCase().includes(filterPdv.toLowerCase()));
    if (filterStatus && filterStatus !== 'all') arr = arr.filter((r: any) => r.status === filterStatus);
    return arr;
  }, [routes, filterPdv, filterStatus]);

  const handleSave = async () => {
    if (!editing) return;
    try {
      const payload: any = { id: editing.id, visit_date: editDate };
      if (editPdv) payload.pdv_id = editPdv;
      await updateRoute.mutateAsync(payload);
      toast.success('Rota atualizada');
      setEditing(null);
      setEditPdv('');
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleAddSupport = async () => {
    if (!editing || !supportEmployee) return;
    try {
      await addSupport.mutateAsync({ routeId: editing.id, employee_id: supportEmployee });
      toast.success('Apoio adicionado');
      setSupportEmployee('');
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
              <SelectItem value="all">Todos</SelectItem>
              {(team as any[]).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-32"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
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
            <Card key={r.id} className="cursor-pointer hover:border-primary/40 transition-colors" onClick={() => { setEditing(r); setEditDate(String(r.visit_date).slice(0, 10)); setEditPdv(r.pdv_id || ''); }}>
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
                <span className={`text-[10px] px-2 py-0.5 rounded-full inline-flex ${STATUS_COLORS[r.status] || 'bg-muted text-muted-foreground'}`}>
                  {STATUS_LABELS[r.status] || r.status}
                </span>
              </CardContent>
            </Card>
          ))}
          {filtered.length === 0 && !isLoading && <p className="text-sm text-muted-foreground text-center py-8">Nenhuma rota</p>}
        </div>

        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) { setEditing(null); setSupportEmployee(''); } }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Ajustar rota</DialogTitle></DialogHeader>
            {editing && (
              <div className="space-y-3">
                <div>
                  <Label>Data da visita</Label>
                  <Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </div>
                <div>
                  <Label>PDV</Label>
                  <Select value={editPdv} onValueChange={setEditPdv}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecionar PDV" />
                    </SelectTrigger>
                    <SelectContent>
                      {(pdvs as any[]).map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} {p.city ? `- ${p.city}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleSave} disabled={updateRoute.isPending} className="w-full">
                  {updateRoute.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Salvar alterações
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
                <Button variant="outline" className="w-full" onClick={() => { setShowPhotos(editing); setEditing(null); }}>
                  <Image className="h-4 w-4 mr-2" /> Ver fotos e execução
                </Button>
              </div>
            )}
            <DialogFooter><Button variant="outline" onClick={() => { setEditing(null); setSupportEmployee(''); }}>Fechar</Button></DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!showPhotos} onOpenChange={(o) => { if (!o) setShowPhotos(null); }}>
          <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Execução da rota</DialogTitle>
            </DialogHeader>
            {showPhotos && (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">{showPhotos.pdv_name}</p>
                  <p>{showPhotos.promoter_name} • {String(showPhotos.visit_date).slice(0,10)}</p>
                </div>
                <div>
                  <p className="text-sm font-medium mb-2 flex items-center gap-2"><CheckCircle className="h-4 w-4" /> Check-ins</p>
                  {loadingExecs && <Loader2 className="h-4 w-4 animate-spin" />}
                  {executions.length === 0 && !loadingExecs && <p className="text-xs text-muted-foreground">Sem registros</p>}
                  <div className="space-y-1">
                    {(executions as any[]).map((ex: any) => (
                      <div key={ex.id} className="text-xs p-2 rounded bg-muted/40">
                        <div className="flex justify-between">
                          <span>{ex.action || ex.status || 'Registro'}</span>
                          <span className="text-muted-foreground">{ex.created_at ? new Date(ex.created_at).toLocaleString('pt-BR') : ''}</span>
                        </div>
                        {ex.notes && <p className="text-muted-foreground mt-1">{ex.notes}</p>}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium mb-2 flex items-center gap-2"><Image className="h-4 w-4" /> Fotos</p>
                  {loadingPhotos && <Loader2 className="h-4 w-4 animate-spin" />}
                  {photos.length === 0 && !loadingPhotos && <p className="text-xs text-muted-foreground">Sem fotos</p>}
                  <div className="grid grid-cols-2 gap-2">
                    {(photos as any[]).map((ph: any) => (
                      <a key={ph.id} href={ph.photo_url} target="_blank" rel="noreferrer" className="block">
                        <img src={ph.thumbnail_url || ph.photo_url} alt="" className="w-full h-24 object-cover rounded border" />
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <DialogFooter><Button variant="outline" onClick={() => setShowPhotos(null)}>Fechar</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </SupervisorLayout>
  );
}