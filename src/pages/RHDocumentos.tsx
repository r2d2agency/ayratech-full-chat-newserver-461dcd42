import { useState } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useEmployees } from "@/hooks/use-rh";
import { useDocumentDeliveries, useSendDocumentDelivery, useInboundDocumentsRH, useDocumentTypes, useSendNotice, useDocumentDeliveryDetail } from "@/hooks/use-promotor";
import { FileUploadInput } from "@/components/ui/file-upload-input";
import { FileText, Send, Search, Megaphone, Loader2, Users, Eye, Globe, Monitor, Smartphone, MapPin, Clock, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";

const STATUS_MAP: Record<string, { label: string; variant: string }> = {
  criado: { label: 'Criado', variant: 'secondary' },
  pendente: { label: 'Pendente', variant: 'outline' },
  enviado: { label: 'Enviado', variant: 'default' },
  entregue: { label: 'Entregue', variant: 'default' },
  visualizado: { label: 'Visualizado', variant: 'outline' },
  confirmado: { label: 'Confirmado', variant: 'default' },
  assinado: { label: 'Assinado', variant: 'default' },
  recusado: { label: 'Recusado', variant: 'destructive' },
  expirado: { label: 'Expirado', variant: 'secondary' },
  cancelado: { label: 'Cancelado', variant: 'secondary' },
};

function parseSafe(val: unknown, mask: string) {
  if (!val) return '—';
  try {
    const d = new Date(String(val));
    return isNaN(d.getTime()) ? '—' : format(d, mask);
  } catch { return '—'; }
}

function deviceLabel(ua?: string | null) {
  if (!ua) return '—';
  const s = ua.toLowerCase();
  const device = /ipad|tablet|kindle|silk|playbook/.test(s) ? 'Tablet' : /mobile|android|iphone|ipod|blackberry|opera mini|iemobile/.test(s) ? 'Celular' : 'Computador';
  let browser = 'Navegador';
  if (s.includes('edg/')) browser = 'Edge';
  else if (s.includes('opr/') || s.includes('opera')) browser = 'Opera';
  else if (s.includes('chrome/')) browser = 'Chrome';
  else if (s.includes('firefox/')) browser = 'Firefox';
  else if (s.includes('safari/')) browser = 'Safari';
  return `${device} • ${browser}`;
}

function mapsLink(lat?: number | string | null, lng?: number | string | null) {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return `https://www.google.com/maps?q=${a},${b}`;
}

export default function RHDocumentos() {
  const [tab, setTab] = useState("enviados");
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [showNoticeDialog, setShowNoticeDialog] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const { data: deliveries } = useDocumentDeliveries({ status: statusFilter || undefined });
  const { data: inboundDocs } = useInboundDocumentsRH();
  const { data: employees } = useEmployees();
  const { data: docTypes } = useDocumentTypes();
  const { data: detail, isLoading: detailLoading } = useDocumentDeliveryDetail(detailId || undefined);
  const sendDelivery = useSendDocumentDelivery();
  const sendNotice = useSendNotice();
  const { toast } = useToast();

  // Send Document form
  const [sendForm, setSendForm] = useState({ title: '', description: '', employee_ids: [] as string[], sendToAll: false, file_url: '', requires_confirmation: true, requires_signature: false, document_type_id: '' });
  const [empSearch, setEmpSearch] = useState('');

  // Send Notice form
  const [noticeForm, setNoticeForm] = useState({ title: '', message: '', employee_ids: [] as string[], type: 'info', sendToAll: false });

  const activeEmployees = (employees || []).filter((e: any) => e.status === 'ativo');

  const DEFAULT_DOC_TYPES = [
    { id: '__atestado', name: 'Atestado Médico' },
    { id: '__contrato', name: 'Contrato' },
    { id: '__holerite', name: 'Holerite' },
    { id: '__comprovante', name: 'Comprovante' },
    { id: '__aviso', name: 'Aviso / Comunicado' },
    { id: '__outro', name: 'Outro' },
  ];
  const availableDocTypes = (docTypes && docTypes.length > 0) ? docTypes : DEFAULT_DOC_TYPES;

  const filteredEmployeesForSend = activeEmployees.filter((e: any) =>
    !empSearch || e.full_name?.toLowerCase().includes(empSearch.toLowerCase())
  );

  const toggleSendEmployee = (id: string) => {
    setSendForm(f => ({
      ...f,
      employee_ids: f.employee_ids.includes(id) ? f.employee_ids.filter(x => x !== id) : [...f.employee_ids, id]
    }));
  };

  const handleSend = async () => {
    const ids = sendForm.sendToAll ? activeEmployees.map((e: any) => e.id) : sendForm.employee_ids;
    if (!sendForm.title || ids.length === 0) { toast({ title: 'Preencha título e selecione ao menos um colaborador', variant: 'destructive' }); return; }
    try {
      const payload: any = {
        title: sendForm.title,
        description: sendForm.description,
        file_url: sendForm.file_url,
        requires_confirmation: sendForm.requires_confirmation,
        requires_signature: sendForm.requires_signature,
        employee_ids: ids,
      };
      if (sendForm.document_type_id && !sendForm.document_type_id.startsWith('__')) {
        payload.document_type_id = sendForm.document_type_id;
      }
      await sendDelivery.mutateAsync(payload);
      toast({ title: `Documento enviado para ${ids.length} colaborador(es)!` });
      setShowSendDialog(false);
      setSendForm({ title: '', description: '', employee_ids: [], sendToAll: false, file_url: '', requires_confirmation: true, requires_signature: false, document_type_id: '' });
      setEmpSearch('');
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleSendNotice = async () => {
    const ids = noticeForm.sendToAll ? activeEmployees.map((e: any) => e.id) : noticeForm.employee_ids;
    if (!noticeForm.title || ids.length === 0) { toast({ title: 'Preencha o título e selecione ao menos um colaborador', variant: 'destructive' }); return; }
    try {
      await sendNotice.mutateAsync({ title: noticeForm.title, message: noticeForm.message, employee_ids: ids, type: noticeForm.type });
      toast({ title: `Recado enviado para ${ids.length} colaborador(es)!` });
      setShowNoticeDialog(false);
      setNoticeForm({ title: '', message: '', employee_ids: [], type: 'info', sendToAll: false });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const toggleEmployee = (id: string) => {
    setNoticeForm(f => ({
      ...f,
      employee_ids: f.employee_ids.includes(id) ? f.employee_ids.filter(x => x !== id) : [...f.employee_ids, id]
    }));
  };

  const filteredDeliveries = (deliveries || []).filter((d: any) =>
    !search || d.employee_name?.toLowerCase().includes(search.toLowerCase()) || d.title?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <h1 className="text-xl font-bold flex items-center gap-2"><FileText className="h-5 w-5" /> Central de Documentos</h1>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowNoticeDialog(true)} className="gap-2">
              <Megaphone className="h-4 w-4" /> Enviar Recado
            </Button>
            <Button onClick={() => setShowSendDialog(true)} className="gap-2">
              <Send className="h-4 w-4" /> Enviar Documento
            </Button>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="enviados">Enviados ao Colaborador</TabsTrigger>
            <TabsTrigger value="recebidos">Recebidos do Colaborador</TabsTrigger>
          </TabsList>

          <TabsContent value="enviados" className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..." className="pl-9" />
              </div>
              <Select value={statusFilter || "__all__"} onValueChange={v => setStatusFilter(v === "__all__" ? "" : v)}>
                <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  <SelectItem value="enviado">Enviado</SelectItem>
                  <SelectItem value="visualizado">Visualizado</SelectItem>
                  <SelectItem value="confirmado">Confirmado</SelectItem>
                  <SelectItem value="assinado">Assinado</SelectItem>
                  <SelectItem value="recusado">Recusado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Documento</TableHead>
                    <TableHead>Colaborador</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Enviado em</TableHead>
                    <TableHead>Visualizado</TableHead>
                    <TableHead>Assinado</TableHead>
                    <TableHead className="w-[120px]">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDeliveries.map((d: any) => (
                    <TableRow key={d.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setDetailId(d.id)}>
                      <TableCell className="font-medium">{d.title}</TableCell>
                      <TableCell>{d.employee_name}</TableCell>
                      <TableCell><Badge variant={STATUS_MAP[d.status]?.variant as any || 'outline'}>{STATUS_MAP[d.status]?.label || d.status}</Badge></TableCell>
                      <TableCell className="text-xs">{parseSafe(d.sent_at, 'dd/MM/yy HH:mm')}</TableCell>
                      <TableCell className="text-xs">{parseSafe(d.viewed_at, 'dd/MM/yy HH:mm')}</TableCell>
                      <TableCell className="text-xs">{d.signed_at ? parseSafe(d.signed_at, 'dd/MM/yy HH:mm') : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell>
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); setDetailId(d.id); }}>
                          <Eye className="h-3.5 w-3.5 mr-1" /> Detalhes
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredDeliveries.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Nenhum documento encontrado</TableCell></TableRow>}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          <TabsContent value="recebidos" className="space-y-3">
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Categoria</TableHead>
                    <TableHead>Colaborador</TableHead>
                    <TableHead>Título</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Recebido em</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(inboundDocs || []).map((d: any) => (
                    <TableRow key={d.id}>
                      <TableCell><Badge variant="outline">{d.category}</Badge></TableCell>
                      <TableCell>{d.employee_name}</TableCell>
                      <TableCell>{d.title}</TableCell>
                      <TableCell><Badge variant="outline">{d.status}</Badge></TableCell>
                      <TableCell className="text-xs">{parseSafe(d.created_at, 'dd/MM/yy HH:mm')}</TableCell>
                    </TableRow>
                  ))}
                  {(inboundDocs || []).length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">Nenhum documento recebido</TableCell></TableRow>}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Send Document Dialog */}
      <Dialog open={showSendDialog} onOpenChange={setShowSendDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Send className="h-5 w-5" /> Enviar Documento</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label className="flex items-center gap-2"><Users className="h-4 w-4" /> Destinatários *</Label>
              <div className="flex items-center gap-2 pb-1">
                <Checkbox
                  id="docSendAll"
                  checked={sendForm.sendToAll}
                  onCheckedChange={(v) => setSendForm(f => ({ ...f, sendToAll: !!v, employee_ids: [] }))}
                />
                <label htmlFor="docSendAll" className="text-sm font-medium cursor-pointer">Enviar para todos ({activeEmployees.length})</label>
              </div>
              {!sendForm.sendToAll && (
                <>
                  <Input
                    placeholder="Buscar colaborador..."
                    value={empSearch}
                    onChange={e => setEmpSearch(e.target.value)}
                    className="h-8"
                  />
                  <div className="max-h-40 overflow-y-auto border rounded-lg p-2 space-y-1">
                    {filteredEmployeesForSend.map((e: any) => (
                      <div key={e.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`doc-emp-${e.id}`}
                          checked={sendForm.employee_ids.includes(e.id)}
                          onCheckedChange={() => toggleSendEmployee(e.id)}
                        />
                        <label htmlFor={`doc-emp-${e.id}`} className="text-sm cursor-pointer">{e.full_name}</label>
                      </div>
                    ))}
                    {filteredEmployeesForSend.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">Nenhum colaborador</p>}
                  </div>
                  {sendForm.employee_ids.length > 0 && (
                    <p className="text-xs text-muted-foreground">{sendForm.employee_ids.length} selecionado(s)</p>
                  )}
                </>
              )}
            </div>

            <div className="space-y-1"><Label>Título *</Label><Input value={sendForm.title} onChange={e => setSendForm(f => ({ ...f, title: e.target.value }))} placeholder="Ex: Holerite Janeiro/2026" /></div>
            <div className="space-y-1"><Label>Descrição</Label><Textarea value={sendForm.description} onChange={e => setSendForm(f => ({ ...f, description: e.target.value }))} rows={2} /></div>

            <div className="space-y-1">
              <Label>Tipo de Documento</Label>
              <Select value={sendForm.document_type_id || undefined} onValueChange={v => setSendForm(f => ({ ...f, document_type_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecione (opcional)..." /></SelectTrigger>
                <SelectContent>{availableDocTypes.map((t: any) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Arquivo</Label>
              <FileUploadInput
                value={sendForm.file_url}
                onChange={(url) => setSendForm(f => ({ ...f, file_url: url }))}
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
                placeholder="Selecione, cole (Ctrl+V) ou arraste o arquivo"
                previewType="file"
              />
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendForm.requires_confirmation} onChange={e => setSendForm(f => ({ ...f, requires_confirmation: e.target.checked }))} /> Confirmar recebimento</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendForm.requires_signature} onChange={e => setSendForm(f => ({ ...f, requires_signature: e.target.checked }))} /> Assinatura obrigatória</label>
            </div>
            <Button onClick={handleSend} className="w-full" disabled={sendDelivery.isPending}>
              {sendDelivery.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
              Enviar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Send Notice/Recado Dialog */}
      <Dialog open={showNoticeDialog} onOpenChange={setShowNoticeDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Megaphone className="h-5 w-5" /> Enviar Recado</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label>Título *</Label><Input value={noticeForm.title} onChange={e => setNoticeForm(f => ({ ...f, title: e.target.value }))} placeholder="Ex: Reunião amanhã às 8h" /></div>
            <div className="space-y-1"><Label>Mensagem</Label><Textarea value={noticeForm.message} onChange={e => setNoticeForm(f => ({ ...f, message: e.target.value }))} rows={3} placeholder="Detalhes do recado..." /></div>
            <div className="space-y-1"><Label>Tipo</Label>
              <Select value={noticeForm.type} onValueChange={v => setNoticeForm(f => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">ℹ️ Informativo</SelectItem>
                  <SelectItem value="alert">⚠️ Alerta</SelectItem>
                  <SelectItem value="document">📄 Documento</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Destinatários</Label>
              <div className="flex items-center gap-2 pb-1">
                <Checkbox
                  id="sendAll"
                  checked={noticeForm.sendToAll}
                  onCheckedChange={(v) => setNoticeForm(f => ({ ...f, sendToAll: !!v, employee_ids: [] }))}
                />
                <label htmlFor="sendAll" className="text-sm font-medium cursor-pointer">Enviar para todos ({activeEmployees.length})</label>
              </div>
              {!noticeForm.sendToAll && (
                <div className="max-h-40 overflow-y-auto border rounded-lg p-2 space-y-1">
                  {activeEmployees.map((e: any) => (
                    <div key={e.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`emp-${e.id}`}
                        checked={noticeForm.employee_ids.includes(e.id)}
                        onCheckedChange={() => toggleEmployee(e.id)}
                      />
                      <label htmlFor={`emp-${e.id}`} className="text-sm cursor-pointer">{e.full_name}</label>
                    </div>
                  ))}
                </div>
              )}
              {!noticeForm.sendToAll && noticeForm.employee_ids.length > 0 && (
                <p className="text-xs text-muted-foreground">{noticeForm.employee_ids.length} selecionado(s)</p>
              )}
            </div>

            <Button onClick={handleSendNotice} className="w-full" disabled={sendNotice.isPending}>
              {sendNotice.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Megaphone className="h-4 w-4 mr-2" />}
              Enviar Recado
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delivery / Signature Details Dialog */}
      <Dialog open={!!detailId} onOpenChange={(open) => { if (!open) setDetailId(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><FileText className="h-5 w-5" /> Detalhes do documento</DialogTitle></DialogHeader>
          {detailLoading ? (
            <div className="py-10 flex items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...</div>
          ) : detail?.delivery ? (() => {
            const d = detail.delivery;
            const signed = !!d.signed_at || d.status === 'assinado';
            const geoUrl = mapsLink(d.geo_lat_at_sign, d.geo_lng_at_sign);
            return (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{d.title}</p>
                    <p className="text-sm text-muted-foreground">{d.employee_name} {d.employee_cpf ? `• CPF ${d.employee_cpf}` : ''}</p>
                  </div>
                  <Badge variant={STATUS_MAP[d.status]?.variant as any || 'outline'}>{STATUS_MAP[d.status]?.label || d.status}</Badge>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-lg border p-3 text-sm"><p className="text-xs text-muted-foreground">Enviado em</p><p className="font-medium flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {parseSafe(d.sent_at, 'dd/MM/yyyy HH:mm:ss')}</p></div>
                  <div className="rounded-lg border p-3 text-sm"><p className="text-xs text-muted-foreground">Visualizado em</p><p className="font-medium flex items-center gap-1"><Eye className="h-3.5 w-3.5" /> {parseSafe(d.viewed_at, 'dd/MM/yyyy HH:mm:ss')}</p></div>
                </div>

                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium flex items-center gap-2">
                      {signed ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Clock className="h-4 w-4 text-muted-foreground" />}
                      Assinatura
                    </p>
                    <Badge variant={signed ? 'default' : 'outline'}>{signed ? 'Assinado' : 'Pendente'}</Badge>
                  </div>
                  {signed ? (
                    <div className="space-y-3 text-sm">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div><p className="text-xs text-muted-foreground">Data e hora da assinatura</p><p className="font-medium">{parseSafe(d.signed_at, 'dd/MM/yyyy HH:mm:ss')}</p></div>
                        <div><p className="text-xs text-muted-foreground">Nome declarado</p><p className="font-medium">{d.signed_name || d.employee_name || '—'}</p></div>
                        <div><p className="text-xs text-muted-foreground flex items-center gap-1"><Globe className="h-3.5 w-3.5" /> Endereço IP</p><p className="font-medium font-mono text-xs break-all">{d.ip_at_sign || '—'}</p></div>
                        <div>
                          <p className="text-xs text-muted-foreground flex items-center gap-1"><Monitor className="h-3.5 w-3.5" /> Dispositivo / navegador</p>
                          <p className="font-medium">{deviceLabel(d.device_at_sign)}</p>
                          {d.device_at_sign && <p className="text-[11px] text-muted-foreground mt-0.5 break-all" title={d.device_at_sign}>{d.device_at_sign}</p>}
                        </div>
                        <div className="sm:col-span-2">
                          <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> Geolocalização</p>
                          {d.geo_lat_at_sign != null && d.geo_lng_at_sign != null ? (
                            <p className="font-medium">
                              {Number(d.geo_lat_at_sign).toFixed(6)}, {Number(d.geo_lng_at_sign).toFixed(6)}
                              {geoUrl && <a href={geoUrl} target="_blank" rel="noreferrer" className="ml-2 text-primary underline text-xs">Ver no mapa</a>}
                            </p>
                          ) : <p className="text-muted-foreground">Não informada pelo dispositivo</p>}
                        </div>
                      </div>
                      {d.signature_image && (
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Assinatura capturada</p>
                          <img src={d.signature_image} alt="Assinatura" className="max-h-28 border rounded bg-white p-1" />
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Este documento ainda não foi assinado pelo colaborador.</p>
                  )}
                </div>

                {detail.events?.length > 0 && (
                  <div className="space-y-2">
                    <p className="font-medium text-sm">Histórico de eventos</p>
                    <div className="border rounded-lg divide-y max-h-56 overflow-y-auto">
                      {detail.events.map((ev: any) => (
                        <div key={ev.id} className="p-2.5 text-sm flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium capitalize">{String(ev.event_type || '').replace(/_/g, ' ')}</p>
                            <p className="text-xs text-muted-foreground">
                              {ev.actor_name || (ev.actor_type === 'colaborador' ? d.employee_name : ev.actor_type === 'rh' ? 'RH' : ev.actor_type) || ''}
                              {ev.ip_address ? ` • IP ${ev.ip_address}` : ''}
                              {ev.geo_lat != null && ev.geo_lng != null ? ` • ${Number(ev.geo_lat).toFixed(5)}, ${Number(ev.geo_lng).toFixed(5)}` : ''}
                            </p>
                            {ev.notes && <p className="text-xs text-muted-foreground mt-0.5">{ev.notes}</p>}
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">{parseSafe(ev.event_at, 'dd/MM/yy HH:mm:ss')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {d.signed_file_url && (
                  <Button className="w-full" onClick={() => window.open(d.signed_file_url, '_blank')}><CheckCircle2 className="h-4 w-4 mr-2" /> Abrir cópia assinada (com assinatura no PDF)</Button>
                )}
                {d.file_url && (
                  <Button variant="outline" className="w-full" onClick={() => window.open(d.file_url, '_blank')}>Abrir documento original</Button>
                )}
              </div>
            );
          })() : <p className="text-sm text-muted-foreground py-6 text-center">Não foi possível carregar os detalhes.</p>}
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
