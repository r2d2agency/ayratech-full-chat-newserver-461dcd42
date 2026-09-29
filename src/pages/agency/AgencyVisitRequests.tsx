import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, CalendarDays, Loader2, Clock, MapPin } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { formatCalendarDate } from '@/lib/date-utils';
import { useAgencyAuth } from '@/contexts/AgencyAuthContext';

const WEEKDAY_LABELS = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

const getHeaders = () => {
  const t = localStorage.getItem('agency_auth_token');
  return t ? { Authorization: `Bearer ${t}` } : undefined;
};

const statusMap: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending: { label: 'Pendente', variant: 'outline' },
  approved: { label: 'Aprovado', variant: 'default' },
  rejected: { label: 'Recusado', variant: 'destructive' },
};

export default function AgencyVisitRequests() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user, isLoading: isAuthLoading } = useAgencyAuth();
  const headers = getHeaders();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    supermarket_unit_id: '',
    promoter_id: '',
    promoter_name: '',
    brand_id: '',
    brand_name: '',
    period_start: '',
    period_end: '',
    weekdays: [1, 2, 3, 4, 5] as number[],
    start_time: '08:00',
    end_time: '18:00',
    notes: '',
  });

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['agency-visit-requests'],
    queryFn: () => api<any[]>('/api/access-control/agency/visit-requests', { headers }),
    enabled: !!user && !!headers && !isAuthLoading,
  });

  const { data: allowedUnits = [] } = useQuery({
    queryKey: ['agency-allowed-units'],
    queryFn: () => api<any[]>('/api/access-control/agency/allowed-units', { headers }),
    enabled: !!user && !!headers && !isAuthLoading,
  });

  const { data: promoters = [] } = useQuery({
    queryKey: ['agency-promoters-list'],
    queryFn: () => api<any[]>('/api/access-control/agency/promoters', { headers }),
    enabled: !!user && !!headers && !isAuthLoading,
  });

  const { data: agencyBrands = [] } = useQuery({
    queryKey: ['agency-brands'],
    queryFn: () => api<any[]>('/api/access-control/agency/brands', { headers }),
    enabled: !!user && !!headers && !isAuthLoading,
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => api('/api/access-control/agency/visit-requests', { method: 'POST', body: data, headers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agency-visit-requests'] });
      toast({ title: 'Solicitação enviada!' });
      setDialogOpen(false);
    },
    onError: (err: any) => toast({ title: 'Erro', description: err?.message, variant: 'destructive' }),
  });

  const toggleWeekday = (day: number) => {
    setForm(f => ({
      ...f,
      weekdays: f.weekdays.includes(day) ? f.weekdays.filter(d => d !== day) : [...f.weekdays, day].sort(),
    }));
  };

  const openNew = () => {
    setForm({
      supermarket_unit_id: '', promoter_id: '', promoter_name: '', brand_id: '', brand_name: '',
      period_start: '', period_end: '', weekdays: [1, 2, 3, 4, 5], start_time: '08:00', end_time: '18:00', notes: '',
    });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.supermarket_unit_id || !form.period_start || !form.period_end) {
      toast({ title: 'Campos obrigatórios', description: 'Selecione o PDV e o período.', variant: 'destructive' });
      return;
    }
    const selectedPromoter = promoters.find((p: any) => p.id === form.promoter_id);
    const selectedBrand = agencyBrands.find((b: any) => b.id === form.brand_id);
    createMutation.mutate({
      ...form,
      promoter_name: selectedPromoter?.name || form.promoter_name || null,
      brand_name: selectedBrand?.name || form.brand_name || null,
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Solicitações de Visita</h1>
          <p className="text-muted-foreground">Solicite autorização de visita aos PDVs</p>
        </div>
        <Button onClick={openNew} className="gap-2"><Plus className="h-4 w-4" /> Nova Solicitação</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CalendarDays className="h-5 w-5" /> Minhas Solicitações</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : requests.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">Nenhuma solicitação enviada</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PDV</TableHead>
                    <TableHead>Promotor</TableHead>
                    <TableHead>Marca</TableHead>
                    <TableHead>Período</TableHead>
                    <TableHead>Dias</TableHead>
                    <TableHead>Horário</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Horário</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((r: any) => {
                    const s = statusMap[r.status] || statusMap.pending;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.unit_name}</TableCell>
                        <TableCell>{r.promoter_name || '—'}</TableCell>
                        <TableCell><Badge variant="outline">{r.brand_name || '—'}</Badge></TableCell>
                        <TableCell className="text-sm">
                          {r.period_start && formatCalendarDate(r.period_start, 'dd/MM/yyyy')} — {r.period_end && formatCalendarDate(r.period_end, 'dd/MM/yyyy')}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {(r.weekdays || []).map((d: number) => (
                              <Badge key={d} variant="outline" className="text-xs px-1">{WEEKDAY_LABELS[d]}</Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{r.start_time?.slice(0,5)} - {r.end_time?.slice(0,5)}</TableCell>
                        <TableCell>
                          <Badge variant={s.variant}>{s.label}</Badge>
                          {r.rejection_reason && <p className="text-xs text-destructive mt-1">{r.rejection_reason}</p>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Nova Solicitação de Visita</DialogTitle></DialogHeader>
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            <div>
              <Label>PDV / Unidade *</Label>
              <Select value={form.supermarket_unit_id} onValueChange={v => setForm(f => ({ ...f, supermarket_unit_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecione o PDV" /></SelectTrigger>
                <SelectContent>
                  {allowedUnits.map((u: any) => (
                    <SelectItem key={u.id} value={u.id}>
                      <span className="flex items-center gap-2">
                        <MapPin className="h-3 w-3" /> {u.name} {u.city ? `— ${u.city}/${u.state}` : ''}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Promotor</Label>
              <Select value={form.promoter_id} onValueChange={v => setForm(f => ({ ...f, promoter_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecione o promotor (opcional)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Todos os promotores</SelectItem>
                  {promoters.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name} — {p.cpf}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Marca</Label>
              <Select value={form.brand_id} onValueChange={v => {
                const brand = agencyBrands.find((b: any) => b.id === v);
                setForm(f => ({ ...f, brand_id: v, brand_name: brand?.name || '' }));
              }}>
                <SelectTrigger><SelectValue placeholder="Selecione a marca" /></SelectTrigger>
                <SelectContent>
                  {agencyBrands.map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Início do Período *</Label><Input type="date" value={form.period_start} onChange={e => setForm(f => ({ ...f, period_start: e.target.value }))} /></div>
              <div><Label>Fim do Período *</Label><Input type="date" value={form.period_end} onChange={e => setForm(f => ({ ...f, period_end: e.target.value }))} /></div>
            </div>
            <div>
              <Label>Dias da Semana</Label>
              <div className="flex gap-2 mt-1">
                {[1, 2, 3, 4, 5, 6, 7].map(d => (
                  <label key={d} className="flex flex-col items-center gap-1 cursor-pointer">
                    <Checkbox checked={form.weekdays.includes(d)} onCheckedChange={() => toggleWeekday(d)} />
                    <span className="text-xs">{WEEKDAY_LABELS[d]}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Entrada</Label><Input type="time" value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} /></div>
              <div><Label>Saída</Label><Input type="time" value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} /></div>
            </div>
            <div><Label>Observações</Label><Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Informações adicionais..." rows={3} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Enviar Solicitação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
