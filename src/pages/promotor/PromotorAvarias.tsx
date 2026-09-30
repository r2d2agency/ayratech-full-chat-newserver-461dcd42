import { useState, useMemo } from "react";
import { PromotorLayout } from "./PromotorLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePromotorDamages, usePromotorRequestReturn, usePromotorUploadInvoice } from "@/hooks/use-promotor-routes";
import { CameraCapture } from "@/components/promotor/CameraCapture";
import { useOfflineSync } from "@/hooks/use-offline-sync";
import { toast } from "sonner";
import { AlertTriangle, Trash2, Upload, Send, Image as ImageIcon } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  registered: 'Registrada', awaiting_invoice: 'Aguardando Nota', invoice_sent: 'Nota Enviada',
  in_review: 'Em Conferência', completed: 'Aprovada', rejected: 'Reprovada', cancelled: 'Cancelada',
};
const STATUS_COLORS: Record<string, string> = {
  registered: 'bg-yellow-500/20 text-yellow-700', awaiting_invoice: 'bg-orange-500/20 text-orange-700',
  invoice_sent: 'bg-blue-500/20 text-blue-700', in_review: 'bg-purple-500/20 text-purple-700',
  completed: 'bg-green-500/20 text-green-700', rejected: 'bg-red-500/20 text-red-700',
  cancelled: 'bg-muted text-muted-foreground',
};

function KindBadge({ kind }: { kind?: string }) {
  if (kind === 'discard') {
    return <Badge className="bg-red-500/15 text-red-700 border-red-500/30"><Trash2 className="h-3 w-3 mr-1" />Descarte</Badge>;
  }
  return <Badge className="bg-orange-500/15 text-orange-700 border-orange-500/30"><AlertTriangle className="h-3 w-3 mr-1" />Avaria</Badge>;
}

export default function PromotorAvarias() {
  const { data: damages = [] } = usePromotorDamages();
  const requestReturn = usePromotorRequestReturn();
  const uploadInvoice = usePromotorUploadInvoice();
  const { isOnline, queueApiCall } = useOfflineSync();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState<any>({});
  const [invoiceContext, setInvoiceContext] = useState<{ request_id?: string; total_registered?: number }>({});

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const handleRequestReturn = () => {
    const selected = damages.filter((d: any) => selectedIds.has(d.id));
    if (!selected.length) return;
    const pdv_id = selected[0].pdv_id;
    const brand_id = selected[0].brand_id;
    // ensure same pdv+brand
    if (selected.some((s: any) => s.pdv_id !== pdv_id || s.brand_id !== brand_id)) {
      toast.error('Selecione apenas itens do mesmo PDV e marca');
      return;
    }
    requestReturn.mutate({ damage_ids: Array.from(selectedIds), pdv_id, brand_id }, {
      onSuccess: () => {
        toast.success('Solicitação de nota enviada ao PDV');
        setSelectedIds(new Set());
        setShowReturnDialog(false);
      },
    });
  };

  const grouped = useMemo(() => {
    const groups: Record<string, any[]> = { registered: [], awaiting: [], review: [], other: [] };
    damages.forEach((d: any) => {
      if (d.status === 'registered') groups.registered.push(d);
      else if (d.status === 'awaiting_invoice') groups.awaiting.push(d);
      else if (d.status === 'in_review' || d.status === 'invoice_sent') groups.review.push(d);
      else groups.other.push(d);
    });
    return groups;
  }, [damages]);

  // group awaiting by request to allow single invoice per group
  const awaitingByRequest = useMemo(() => {
    const map = new Map<string, { items: any[]; pdv_name: string; brand_name: string; total: number }>();
    grouped.awaiting.forEach((d: any) => {
      const key = `${d.pdv_id}|${d.brand_id}`;
      const g = map.get(key) || { items: [], pdv_name: d.pdv_name, brand_name: d.brand_name, total: 0 };
      g.items.push(d);
      g.total += (Number(d.qty_store) || 0) + (Number(d.qty_stock) || 0);
      map.set(key, g);
    });
    return Array.from(map.entries());
  }, [grouped.awaiting]);

  const openInvoiceFor = async (group: any) => {
    // need request_id — fetch from any damage's most recent request via API? Simpler: include in payload
    // request_id is unknown client-side here; the backend update endpoint accepts request_id.
    // We expose it through damage row if backend returns it; fallback: ask user.
    const request_id = group.items[0].request_id || group.items[0].current_request_id;
    setInvoiceContext({ request_id, total_registered: group.total });
    setInvoiceForm({ request_id, invoice_total_qty: group.total, invoice_photo_url: '' });
    setShowInvoiceDialog(true);
  };

  const divergence = Math.max(0, (parseInt(invoiceForm.invoice_total_qty || 0, 10) || 0) - (invoiceContext.total_registered || 0));

  return (
    <PromotorLayout>
      <div className="max-w-lg mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-orange-500" /> Perdas
          </h2>
          {selectedIds.size > 0 && (
            <Button size="sm" onClick={() => setShowReturnDialog(true)}>
              <Send className="h-4 w-4 mr-1" /> Solicitar Nota ({selectedIds.size})
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Avarias (produto danificado) e Descartes (vencido/estufado) entram aqui. Agrupe por PDV+Marca e solicite a nota.</p>

        {/* Registered (selectable) */}
        {grouped.registered.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-yellow-700 mb-2">Registradas</h3>
            {grouped.registered.map((d: any) => (
              <Card key={d.id} className="mb-2">
                <CardContent className="p-3 flex items-start gap-3">
                  <Checkbox checked={selectedIds.has(d.id)} onCheckedChange={() => toggleSelect(d.id)} className="mt-1" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm truncate">{d.product_name}</span>
                      <KindBadge kind={d.kind} />
                    </div>
                    <div className="text-xs text-muted-foreground">{d.pdv_name} • {d.brand_name}</div>
                    <div className="text-xs mt-0.5">Loja: {d.qty_store} | Estoque: {d.qty_stock} | <strong>Total: {(Number(d.qty_store)||0)+(Number(d.qty_stock)||0)}</strong></div>
                    {d.reason && <div className="text-xs text-muted-foreground mt-0.5">{d.reason}</div>}
                  </div>
                  <Badge className={STATUS_COLORS[d.status]}>{STATUS_LABELS[d.status]}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Awaiting Invoice grouped */}
        {awaitingByRequest.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-orange-700 mb-2">Aguardando Nota do PDV</h3>
            {awaitingByRequest.map(([key, g]) => (
              <Card key={key} className="mb-2 border-orange-500/30">
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="font-semibold text-sm">{g.pdv_name}</div>
                      <div className="text-xs text-muted-foreground">{g.brand_name} • {g.items.length} item(s) • Total: <strong>{g.total}</strong></div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => openInvoiceFor(g)}>
                      <Upload className="h-3 w-3 mr-1" /> Enviar Nota
                    </Button>
                  </div>
                  <div className="space-y-1">
                    {g.items.map((it: any) => (
                      <div key={it.id} className="text-xs flex items-center gap-2">
                        <KindBadge kind={it.kind} />
                        <span className="flex-1 truncate">{it.product_name}</span>
                        <span className="text-muted-foreground">{(Number(it.qty_store)||0)+(Number(it.qty_stock)||0)}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Review and history */}
        {(grouped.review.length > 0 || grouped.other.length > 0) && (
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2">Histórico</h3>
            {[...grouped.review, ...grouped.other].map((d: any) => (
              <Card key={d.id} className="mb-2">
                <CardContent className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm truncate">{d.product_name}</span>
                      <KindBadge kind={d.kind} />
                    </div>
                    <div className="text-xs text-muted-foreground">{d.pdv_name} • Qtd: {(Number(d.qty_store)||0)+(Number(d.qty_stock)||0)}</div>
                  </div>
                  <Badge className={STATUS_COLORS[d.status]}>{STATUS_LABELS[d.status]}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {damages.length === 0 && (
          <div className="text-center py-12">
            <AlertTriangle className="h-12 w-12 mx-auto text-muted-foreground/20 mb-3" />
            <p className="text-sm text-muted-foreground">Nenhuma perda registrada</p>
          </div>
        )}

        {/* Return Request Dialog */}
        <Dialog open={showReturnDialog} onOpenChange={setShowReturnDialog}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Solicitar Nota ao PDV</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">{selectedIds.size} item(ns) serão agrupados na solicitação. O PDV emite a nota de devolução e você envia depois.</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowReturnDialog(false)}>Cancelar</Button>
              <Button onClick={handleRequestReturn} disabled={requestReturn.isPending}>Confirmar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Upload Invoice Dialog */}
        <Dialog open={showInvoiceDialog} onOpenChange={setShowInvoiceDialog}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Enviar Nota de Devolução</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label className="text-xs">Nº da Nota</Label><Input placeholder="Número" onChange={e => setInvoiceForm({ ...invoiceForm, invoice_number: e.target.value })} /></div>
              <div><Label className="text-xs">Data da Nota</Label><Input type="date" onChange={e => setInvoiceForm({ ...invoiceForm, invoice_date: e.target.value })} /></div>
              <div><Label className="text-xs">Emitente</Label><Input placeholder="Nome do emitente" onChange={e => setInvoiceForm({ ...invoiceForm, issuer_name: e.target.value })} /></div>
              <div>
                <Label className="text-xs">Total descartado na nota</Label>
                <Input
                  type="number" min={0}
                  value={invoiceForm.invoice_total_qty ?? ''}
                  onChange={e => setInvoiceForm({ ...invoiceForm, invoice_total_qty: e.target.value })}
                />
                <p className="text-[10px] text-muted-foreground mt-1">Você registrou {invoiceContext.total_registered ?? 0}. Se a NF tiver mais, a diferença será registrada como "Descarte pelo PDV".</p>
                {divergence > 0 && (
                  <div className="text-xs mt-1 p-2 rounded bg-red-500/10 text-red-700">
                    Divergência: <strong>{divergence}</strong> serão lançados como Descarte PDV
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Foto da nota de troca <span className="text-destructive">*</span></Label>
                <CameraCapture
                  buttonLabel="Fotografar nota"
                  onCapture={(url) => setInvoiceForm((prev: any) => ({ ...prev, invoice_photo_url: url }))}
                />
                {invoiceForm.invoice_photo_url && <div className="flex items-center gap-2 text-xs text-green-700"><ImageIcon className="h-4 w-4" /> Foto da nota anexada</div>}
              </div>
              <div><Label className="text-xs">Observação (opcional)</Label><Textarea rows={2} onChange={e => setInvoiceForm({ ...invoiceForm, observation: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowInvoiceDialog(false)}>Cancelar</Button>
              <Button
                disabled={!invoiceForm.request_id || !invoiceForm.invoice_photo_url || uploadInvoice.isPending}
                onClick={async () => {
                  if (!invoiceForm.invoice_photo_url) {
                    toast.error('Adicione uma foto da nota para enviar.');
                    return;
                  }
                  if (!isOnline) {
                    await queueApiCall({
                      url: '/api/merch/promotor/return-invoices',
                      method: 'POST',
                      body: invoiceForm,
                      headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token') || ''}` },
                      dependsOnUploadId: invoiceForm.invoice_photo_url.startsWith('local-file://') ? invoiceForm.invoice_photo_url.replace('local-file://', '') : undefined,
                    });
                    toast.success('Nota salva offline e será enviada quando houver conexão.');
                    setShowInvoiceDialog(false);
                    return;
                  }
                  uploadInvoice.mutate(invoiceForm, {
                    onSuccess: () => { toast.success('Nota enviada para conferência'); setShowInvoiceDialog(false); },
                    onError: (err: any) => toast.error(err?.message || 'Erro ao enviar nota'),
                  });
                }}
              >Enviar p/ Conferência</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PromotorLayout>
  );
}
