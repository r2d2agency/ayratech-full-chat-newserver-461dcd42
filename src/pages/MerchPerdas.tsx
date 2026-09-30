import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertTriangle, Trash2, CheckCircle2, XCircle, Mail, Phone, Image as ImageIcon, FileText } from "lucide-react";
import { toast } from "sonner";

function KindBadge({ kind }: { kind?: string }) {
  if (kind === 'discard') return <Badge className="bg-red-500/15 text-red-700 border-red-500/30"><Trash2 className="h-3 w-3 mr-1" />Descarte</Badge>;
  return <Badge className="bg-orange-500/15 text-orange-700 border-orange-500/30"><AlertTriangle className="h-3 w-3 mr-1" />Avaria</Badge>;
}

export default function MerchPerdas() {
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const qc = useQueryClient();
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['perdas-pending', tab],
    queryFn: () => api<any[]>(`/api/merch/perdas/pending-review?status=${tab}`, { auth: true }),
  });

  const [reviewing, setReviewing] = useState<any | null>(null);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [notes, setNotes] = useState('');

  const reviewMutation = useMutation({
    mutationFn: ({ id, decision, notes }: any) =>
      api(`/api/merch/perdas/invoices/${id}/review`, { method: 'POST', body: { decision, notes }, auth: true }),
    onSuccess: () => {
      toast.success(decision === 'approved' ? 'Aprovada e enviada à marca' : 'Reprovada');
      qc.invalidateQueries({ queryKey: ['perdas-pending'] });
      setReviewing(null); setDecision(null); setNotes('');
    },
    onError: (e: any) => toast.error(e?.message || 'Erro na conferência'),
  });

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-6 w-6 text-orange-500" />
        <h1 className="text-2xl font-bold">Perdas — Conferência</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Avarias e descartes registrados no campo. Confira a nota fiscal, valide a divergência (Descarte PDV) e aprove o envio à marca.
      </p>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="pending">Pendentes</TabsTrigger>
          <TabsTrigger value="approved">Aprovadas</TabsTrigger>
          <TabsTrigger value="rejected">Reprovadas</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-4 space-y-3">
          {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {!isLoading && invoices.length === 0 && (
            <Card><CardContent className="py-12 text-center text-muted-foreground">Nada por aqui.</CardContent></Card>
          )}
          {invoices.map((inv: any) => (
            <Card key={inv.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between flex-wrap gap-2">
                  <div>
                    <CardTitle className="text-base">
                      {inv.brand_name} — {inv.pdv_name}
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1">
                      NF {inv.invoice_number || '-'} · {inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('pt-BR') : 'sem data'} · Promotor: {inv.promoter_name}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {inv.photo_url && <a href={inv.photo_url} target="_blank" rel="noreferrer"><Button size="sm" variant="outline"><ImageIcon className="h-3 w-3 mr-1" />Foto da nota</Button></a>}
                    {inv.pdf_url && <a href={inv.pdf_url} target="_blank" rel="noreferrer"><Button size="sm" variant="outline"><FileText className="h-3 w-3 mr-1" />PDF</Button></a>}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="rounded-md bg-muted p-2"><div className="text-xs text-muted-foreground">Registrado promotor</div><div className="font-bold">{inv.total_registered_qty || 0}</div></div>
                  <div className="rounded-md bg-muted p-2"><div className="text-xs text-muted-foreground">Total NF</div><div className="font-bold">{inv.invoice_total_qty || 0}</div></div>
                  <div className={`rounded-md p-2 ${inv.divergence_qty > 0 ? 'bg-red-500/10 text-red-700' : 'bg-muted'}`}><div className="text-xs">Descarte PDV</div><div className="font-bold">{inv.divergence_qty || 0}</div></div>
                </div>

                <div className="border rounded-md divide-y">
                  {(inv.items || []).map((it: any) => (
                    <div key={it.damage_id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <KindBadge kind={it.kind} />
                        <span className="truncate">{it.product_name}</span>
                        {it.reason && <span className="text-xs text-muted-foreground truncate">· {it.reason}</span>}
                      </div>
                      <div className="text-xs whitespace-nowrap">
                        Loja {it.qty_store} | Est {it.qty_stock} | <strong>{it.qty_total}</strong>
                        {it.photo_url && <a href={it.photo_url} target="_blank" rel="noreferrer" className="ml-2 underline">foto</a>}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="text-xs text-muted-foreground flex items-center gap-3">
                    {inv.brand_email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{inv.brand_email}</span>}
                    {inv.brand_phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{inv.brand_phone}</span>}
                  </div>
                  {tab === 'pending' && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => { setReviewing(inv); setDecision('rejected'); }}>
                        <XCircle className="h-4 w-4 mr-1" />Reprovar
                      </Button>
                      <Button size="sm" onClick={() => { setReviewing(inv); setDecision('approved'); }}>
                        <CheckCircle2 className="h-4 w-4 mr-1" />Aprovar & enviar à marca
                      </Button>
                    </div>
                  )}
                  {tab === 'approved' && inv.sent_to_brand_at && (
                    <div className="text-xs text-green-700">Enviado à marca em {new Date(inv.sent_to_brand_at).toLocaleString('pt-BR')}</div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <Dialog open={!!reviewing} onOpenChange={(v) => !v && setReviewing(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{decision === 'approved' ? 'Aprovar & enviar à marca' : 'Reprovar conferência'}</DialogTitle></DialogHeader>
          {decision === 'approved' && (
            <p className="text-xs text-muted-foreground">A marca será notificada no painel, por e-mail e WhatsApp (quando configurados).</p>
          )}
          <Textarea placeholder="Observações (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReviewing(null); setDecision(null); }}>Cancelar</Button>
            <Button
              disabled={reviewMutation.isPending}
              onClick={() => reviewing && decision && reviewMutation.mutate({ id: reviewing.id, decision, notes })}
            >Confirmar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
