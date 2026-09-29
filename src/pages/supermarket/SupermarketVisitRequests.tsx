import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CalendarDays, Check, X, Loader2, CheckCheck, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { formatCalendarDate } from '@/lib/date-utils';
import { usePromoterValidations } from '@/hooks/use-promoter-validations';
import { ValidationBadge, ValidationDetailDialog } from '@/components/access-control/ValidationDetailDialog';

const WEEKDAY_LABELS = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

const getHeaders = () => {
  const t = localStorage.getItem('supermarket_auth_token');
  return t ? { Authorization: `Bearer ${t}` } : undefined;
};

export default function SupermarketVisitRequests() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = getHeaders();
  const [tab, setTab] = useState('pending');
  const [selected, setSelected] = useState<string[]>([]);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [validationDialogOpen, setValidationDialogOpen] = useState(false);
  const [selectedValidationId, setSelectedValidationId] = useState<string | undefined>();

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['sm-visit-requests', tab === 'all' ? undefined : tab],
    queryFn: () => api<any[]>(
      `/api/access-control/supermarket/visit-requests${tab !== 'all' ? `?status=${tab}` : ''}`,
      { headers }
    ),
  });

  const { data: validations = [] } = usePromoterValidations();
  const latestByPromoter = new Map<string, any>();
  for (const v of validations) {
    const key = v.agency_promoter_id;
    const cur = latestByPromoter.get(key);
    if (!cur || new Date(v.created_at) > new Date(cur.created_at)) latestByPromoter.set(key, v);
  }
  const openValidation = (promoterId?: string) => {
    if (!promoterId) return;
    const v = latestByPromoter.get(promoterId);
    if (!v) { toast({ title: 'Sem análise', description: 'Nenhuma validação IA disponível para este promotor.' }); return; }
    setSelectedValidationId(v.id);
    setValidationDialogOpen(true);
  };

  const reviewMutation = useMutation({
    mutationFn: (data: { ids: string[]; action: string; rejection_reason?: string }) =>
      api('/api/access-control/supermarket/visit-requests/review', { method: 'POST', body: data, headers }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sm-visit-requests'] });
      setSelected([]);
      toast({ title: vars.action === 'approved' ? 'Solicitações aprovadas!' : 'Solicitações recusadas' });
    },
    onError: (err: any) => toast({ title: 'Erro', description: err?.message, variant: 'destructive' }),
  });

  const toggleSelect = (id: string) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const selectAll = () => {
    const pending = requests.filter((r: any) => r.status === 'pending');
    if (selected.length === pending.length) setSelected([]);
    else setSelected(pending.map((r: any) => r.id));
  };

  const handleApprove = () => {
    if (!selected.length) return;
    reviewMutation.mutate({ ids: selected, action: 'approved' });
  };

  const handleReject = () => {
    if (!selected.length) return;
    reviewMutation.mutate({ ids: selected, action: 'rejected', rejection_reason: rejectReason });
    setRejectDialogOpen(false);
    setRejectReason('');
  };

  const pendingRequests = requests.filter((r: any) => r.status === 'pending');

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Solicitações de Visita</h1>
        <p className="text-muted-foreground">Aprove ou recuse solicitações de visita das agências</p>
      </div>

      {/* Bulk actions bar */}
      {selected.length > 0 && (
        <div className="flex items-center gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
          <Badge variant="outline">{selected.length} selecionada(s)</Badge>
          <div className="flex-1" />
          <Button size="sm" variant="default" onClick={handleApprove} disabled={reviewMutation.isPending} className="gap-1">
            <CheckCheck className="h-4 w-4" /> Aprovar Selecionadas
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setRejectDialogOpen(true)} disabled={reviewMutation.isPending} className="gap-1">
            <X className="h-4 w-4" /> Recusar Selecionadas
          </Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={v => { setTab(v); setSelected([]); }}>
        <TabsList>
          <TabsTrigger value="pending" className="gap-1">
            Pendentes {pendingRequests.length > 0 && <Badge variant="secondary" className="text-xs ml-1">{pendingRequests.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="approved">Aprovadas</TabsTrigger>
          <TabsTrigger value="rejected">Recusadas</TabsTrigger>
          <TabsTrigger value="all">Todas</TabsTrigger>
        </TabsList>

        <TabsContent value={tab}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5" /> Solicitações
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
              ) : requests.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">Nenhuma solicitação {tab !== 'all' ? 'nesta categoria' : ''}</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {tab === 'pending' && (
                          <TableHead className="w-10">
                            <Checkbox
                              checked={selected.length > 0 && selected.length === pendingRequests.length}
                              onCheckedChange={selectAll}
                            />
                          </TableHead>
                        )}
                        <TableHead>Agência</TableHead>
                        <TableHead>Promotor</TableHead>
                        <TableHead>Marca</TableHead>
                        <TableHead>Período</TableHead>
                        <TableHead>Dias</TableHead>
                        <TableHead>Horário</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Validação IA</TableHead>
                        {tab === 'pending' && <TableHead className="w-[120px]">Ações</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {requests.map((r: any) => {
                        const isPending = r.status === 'pending';
                        return (
                          <TableRow key={r.id} className={selected.includes(r.id) ? 'bg-primary/5' : ''}>
                            {tab === 'pending' && (
                              <TableCell>
                                {isPending && <Checkbox checked={selected.includes(r.id)} onCheckedChange={() => toggleSelect(r.id)} />}
                              </TableCell>
                            )}
                            <TableCell className="font-medium">{r.agency_name}</TableCell>
                            <TableCell>{r.promoter_name || '—'}</TableCell>
                            <TableCell>{r.brand_name || '—'}</TableCell>
                            <TableCell className="text-sm whitespace-nowrap">
                              {r.period_start && formatCalendarDate(r.period_start, 'dd/MM/yy')} — {r.period_end && formatCalendarDate(r.period_end, 'dd/MM/yy')}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-0.5 flex-wrap">
                                {(r.weekdays || []).map((d: number) => (
                                  <Badge key={d} variant="outline" className="text-[10px] px-1">{WEEKDAY_LABELS[d]}</Badge>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm whitespace-nowrap">{r.start_time?.slice(0,5)} - {r.end_time?.slice(0,5)}</TableCell>
                            <TableCell>
                              <Badge variant={r.status === 'approved' ? 'default' : r.status === 'rejected' ? 'destructive' : 'outline'}>
                                {r.status === 'approved' ? 'Aprovado' : r.status === 'rejected' ? 'Recusado' : 'Pendente'}
                              </Badge>
                              {r.rejection_reason && <p className="text-xs text-destructive mt-1">{r.rejection_reason}</p>}
                            </TableCell>
                            <TableCell>
                              {(() => {
                                const v = r.promoter_id ? latestByPromoter.get(r.promoter_id) : null;
                                if (!v) return <span className="text-xs text-muted-foreground">—</span>;
                                return (
                                  <button onClick={() => openValidation(r.promoter_id)} className="flex items-center gap-1 hover:opacity-80">
                                    <ValidationBadge status={v.status} />
                                    <span className="text-xs text-muted-foreground">{Number(v.score).toFixed(0)}</span>
                                  </button>
                                );
                              })()}
                            </TableCell>
                            {tab === 'pending' && (
                              <TableCell>
                                {isPending && (
                                  <div className="flex gap-1">
                                    <Button size="icon" variant="ghost" title="Aprovar"
                                      onClick={() => reviewMutation.mutate({ ids: [r.id], action: 'approved' })}>
                                      <Check className="h-4 w-4 text-primary" />
                                    </Button>
                                    <Button size="icon" variant="ghost" title="Recusar"
                                      onClick={() => { setSelected([r.id]); setRejectDialogOpen(true); }}>
                                      <X className="h-4 w-4 text-destructive" />
                                    </Button>
                                  </div>
                                )}
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Reject reason dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Recusar Solicitação</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Você está recusando {selected.length} solicitação(ões). Deseja informar o motivo?
            </p>
            <div>
              <Label>Motivo (opcional)</Label>
              <Textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Ex: Lotação máxima atingida neste período" rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectDialogOpen(false); setRejectReason(''); }}>Cancelar</Button>
            <Button variant="destructive" onClick={handleReject} disabled={reviewMutation.isPending}>
              {reviewMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Confirmar Recusa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ValidationDetailDialog
        validationId={selectedValidationId}
        open={validationDialogOpen}
        onOpenChange={setValidationDialogOpen}
      />
    </div>
  );
}
