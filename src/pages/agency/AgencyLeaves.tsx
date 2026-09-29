import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAgencyAuth } from '@/contexts/AgencyAuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Plus, CalendarOff, Loader2, UserCheck, X, CheckCircle2, AlertCircle } from 'lucide-react';
import {
  usePromoterLeaves, useAvailableSubstitutes, useCreateLeave, useUpdateLeave, useDeleteLeave,
  LEAVE_REASONS,
} from '@/hooks/use-promoter-leaves';
import { format } from 'date-fns';
import { formatCalendarDate } from '@/lib/date-utils';
import { formatCpf } from '@/lib/br-utils';

const getHeaders = () => {
  const token = localStorage.getItem('agency_auth_token');
  return token ? { Authorization: `Bearer ${token}` } : undefined;
};

const reasonColor: Record<string, string> = {
  doenca: 'destructive', ferias: 'default', falta: 'secondary', desligamento: 'destructive', outro: 'outline',
};

export default function AgencyLeaves() {
  const { user } = useAgencyAuth();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    promoter_id: '', reason: 'doenca', start_date: format(new Date(), 'yyyy-MM-dd'),
    end_date: '', substitute_promoter_id: '', notes: '',
  });

  const { data: leaves = [], isLoading } = usePromoterLeaves({ agency_id: user?.agency_id });
  const { data: promoters = [] } = useQuery<any[]>({
    queryKey: ['agency-promoters'],
    queryFn: () => api('/api/access-control/agency/promoters', { headers: getHeaders() }),
    enabled: !!user,
  });
  const { data: substitutes = [] } = useAvailableSubstitutes(user?.agency_id, form.start_date, form.end_date);

  const create = useCreateLeave();
  const update = useUpdateLeave();
  const del = useDeleteLeave();

  const reset = () => setForm({ promoter_id: '', reason: 'doenca', start_date: format(new Date(), 'yyyy-MM-dd'), end_date: '', substitute_promoter_id: '', notes: '' });

  const handleSave = async () => {
    if (!form.promoter_id || !form.reason || !form.start_date) {
      toast({ title: 'Campos obrigatórios', variant: 'destructive' }); return;
    }
    try {
      const res: any = await create.mutateAsync({
        ...form,
        agency_id: user?.agency_id,
        end_date: form.end_date || null,
        substitute_promoter_id: form.substitute_promoter_id || null,
      } as any);
      toast({
        title: 'Afastamento registrado',
        description: res?.visits_reassigned
          ? `${res.visits_reassigned} visita(s) reatribuída(s) ao substituto.`
          : 'Nenhuma visita pendente para reatribuir.',
      });
      setDialogOpen(false); reset();
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    }
  };

  const closeLeave = (id: string) => {
    update.mutate({ id, status: 'closed', end_date: format(new Date(), 'yyyy-MM-dd') } as any, {
      onSuccess: () => toast({ title: 'Afastamento encerrado' }),
    });
  };

  const fixos = promoters.filter((p: any) => (p.promoter_type || 'fixo') === 'fixo' && p.status === 'active');

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <CalendarOff className="h-6 w-6 text-primary" /> Afastamentos & Substituições
          </h1>
          <p className="text-muted-foreground">Gerencie ausências e designe substitutos automaticamente</p>
        </div>
        <Button onClick={() => { reset(); setDialogOpen(true); }}>
          <Plus className="h-4 w-4 mr-2" /> Registrar Afastamento
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : leaves.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12">
            <CalendarOff className="h-12 w-12 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">Nenhum afastamento registrado</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {leaves.map((l) => (
            <Card key={l.id} className={l.status === 'active' ? 'border-primary/30' : 'opacity-60'}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{l.promoter_name}</CardTitle>
                    <p className="text-xs text-muted-foreground">{formatCpf(l.promoter_cpf || '')}</p>
                  </div>
                  <Badge variant={reasonColor[l.reason] as any}>{LEAVE_REASONS[l.reason]}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Período: </span>
                  {formatCalendarDate(l.start_date, 'dd/MM/yyyy')}
                  {l.end_date ? ` — ${formatCalendarDate(l.end_date, 'dd/MM/yyyy')}` : ' — em aberto'}
                </div>
                {l.substitute_name ? (
                  <div className="flex items-center gap-2 p-2 rounded-md bg-primary/5">
                    <UserCheck className="h-4 w-4 text-primary" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground">Substituto designado</p>
                      <p className="font-medium truncate">{l.substitute_name}</p>
                      <p className="text-xs text-muted-foreground">{l.substitute_type || 'freelance'}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/5 text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    <span className="text-xs">Sem substituto designado</span>
                  </div>
                )}
                {(l.visits_reassigned ?? 0) > 0 && (
                  <Badge variant="outline" className="gap-1">
                    <CheckCircle2 className="h-3 w-3" /> {l.visits_reassigned} visita(s) reatribuída(s)
                  </Badge>
                )}
                {l.notes && <p className="text-xs text-muted-foreground border-l-2 pl-2">{l.notes}</p>}
                <div className="flex gap-2 pt-2">
                  {l.status === 'active' && (
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => closeLeave(l.id)}>
                      <CheckCircle2 className="h-3 w-3 mr-1" /> Encerrar
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="text-destructive" onClick={() => del.mutate(l.id)}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) { setDialogOpen(false); reset(); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Registrar Afastamento</DialogTitle></DialogHeader>
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            <div>
              <Label>Promotor titular (afastado) *</Label>
              <Select value={form.promoter_id} onValueChange={(v) => setForm(f => ({ ...f, promoter_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecione o promotor" /></SelectTrigger>
                <SelectContent>
                  {fixos.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>{p.name} — {formatCpf(p.cpf)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Motivo *</Label>
              <Select value={form.reason} onValueChange={(v) => setForm(f => ({ ...f, reason: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(LEAVE_REASONS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Início *</Label><Input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} /></div>
              <div><Label>Término (opcional)</Label><Input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} /></div>
            </div>
            <div>
              <Label>Substituto (freelance/substituto)</Label>
              <Select value={form.substitute_promoter_id || '__none__'} onValueChange={(v) => setForm(f => ({ ...f, substitute_promoter_id: v === '__none__' ? '' : v }))}>
                <SelectTrigger><SelectValue placeholder="Sem substituto" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sem substituto agora</SelectItem>
                  {substitutes.map((s: any) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.promoter_type}) — {formatCpf(s.cpf || '')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {substitutes.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Nenhum freelance/substituto disponível. Cadastre em "Promotores" com o tipo correspondente.
                </p>
              )}
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} placeholder="Atestado médico, telefone do hospital, etc." />
            </div>
            {form.substitute_promoter_id && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                <p className="font-medium flex items-center gap-2"><UserCheck className="h-4 w-4 text-primary" /> Reatribuição automática</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Todas as visitas pendentes/aprovadas do titular no período serão transferidas para o substituto, e a IA fará nova validação dos documentos dele.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDialogOpen(false); reset(); }}>Cancelar</Button>
            <Button onClick={handleSave} disabled={create.isPending}>
              {create.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
