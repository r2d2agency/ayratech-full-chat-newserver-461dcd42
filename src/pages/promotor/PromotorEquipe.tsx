import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  useSupervisorTeam,
  useSupervisorSendNotification,
  useSupervisorSendToRH,
  useSupervisorOvertimeRequests,
  useSupervisorApproveOvertime,
} from "@/hooks/use-promotor";
import { useUpload } from "@/hooks/use-upload";
import { PromotorLayout } from "./PromotorLayout";
import { LocalImage } from "@/components/promotor/LocalImage";
import {
  Users, MapPin, Bell, Send, FileText, Clock, ChevronRight,
  Loader2, Check, X, Search, Calendar, Navigation, Upload, ShieldAlert
} from "lucide-react";
import { format } from "date-fns";

function formatWorkSchedule(v: any): string {
  if (!v) return '—';
  if (typeof v === 'string') {
    // Tenta parsear JSON
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object') {
        // Extrai dias ativos
        const days = parsed.days || parsed;
        if (typeof days === 'object') {
          const dayNames: Record<string, string> = { seg: 'Seg', ter: 'Ter', qua: 'Qua', qui: 'Qui', sex: 'Sex', sab: 'Sáb', dom: 'Dom' };
          const active = Object.entries(days).filter(([_, val]) => val === true).map(([k]) => dayNames[k] || k);
          if (active.length) {
            const hours = parsed.start_time && parsed.end_time ? ` ${parsed.start_time}–${parsed.end_time}` : '';
            return active.join(', ') + hours;
          }
        }
      }
    } catch { /* não é JSON */ }
    // Trunca strings muito longas
    return v.length > 60 ? v.slice(0, 60) + '…' : v;
  }
  return String(v);
}

function safeDate(v: any, fmt: string, fb = '—') {
  if (!v) return fb;
  const d = new Date(String(v).replace(' ', 'T'));
  return d && !isNaN(d.getTime()) ? format(d, fmt) : fb;
}

export default function PromotorEquipe() {
  const { data: team = [], isLoading } = useSupervisorTeam();
  const { data: otRequests = [] } = useSupervisorOvertimeRequests();
  const approveOt = useSupervisorApproveOvertime();
  const sendNotif = useSupervisorSendNotification();
  const sendRH = useSupervisorSendToRH();
  const { uploadFile, isUploading } = useUpload(() => localStorage.getItem('promotor_token'));
  const { toast } = useToast();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [selectedPromoter, setSelectedPromoter] = useState<any>(null);
  const [notifDialog, setNotifDialog] = useState(false);
  const [notifTarget, setNotifTarget] = useState<any>(null);
  const [notifForm, setNotifForm] = useState({ title: '', message: '' });
  const [rhDialog, setRhDialog] = useState(false);
  const [rhForm, setRhForm] = useState({ title: '', message: '', file_url: '', category: 'geral' });
  const [otNotes, setOtNotes] = useState<Record<string, string>>({});

  const filtered = team.filter((p: any) =>
    p.full_name?.toLowerCase().includes(search.toLowerCase())
  );

  const handleOtAction = async (id: string, status: 'aprovado' | 'recusado') => {
    try {
      await approveOt.mutateAsync({ id, status, supervisor_notes: otNotes[id] || '' });
      toast({ title: status === 'aprovado' ? 'Hora extra aprovada!' : 'Hora extra recusada' });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleSendNotif = async () => {
    if (!notifForm.title.trim() || !notifTarget) return;
    try {
      await sendNotif.mutateAsync({ employee_id: notifTarget.id, title: notifForm.title, message: notifForm.message });
      toast({ title: 'Notificação enviada!' });
      setNotifDialog(false);
      setNotifForm({ title: '', message: '' });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleSendRH = async () => {
    if (!rhForm.title.trim()) return;
    try {
      await sendRH.mutateAsync(rhForm);
      toast({ title: 'Enviado ao RH!' });
      setRhDialog(false);
      setRhForm({ title: '', message: '', file_url: '', category: 'geral' });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadFile(file);
      if (url) setRhForm(f => ({ ...f, file_url: url }));
    } catch (err: any) {
      toast({ title: 'Erro no upload', description: err.message, variant: 'destructive' });
    }
  };

  if (isLoading) return <PromotorLayout><div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div></PromotorLayout>;

  return (
    <PromotorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2"><Users className="h-5 w-5" /> Minha Equipe</h1>

        {/* Overtime Requests */}
        {otRequests.length > 0 && (
          <Card className="border-purple-300 dark:border-purple-700">
            <CardHeader className="p-3 pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-purple-600" /> Hora Extra Pendente ({otRequests.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 space-y-3">
              {otRequests.map((ot: any) => (
                <div key={ot.id} className="p-3 rounded-lg bg-purple-50/50 dark:bg-purple-950/10 border border-purple-200 dark:border-purple-800 space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium">{ot.employee_name}</p>
                      <p className="text-xs text-muted-foreground">{ot.position} • {safeDate(ot.request_date + 'T12:00:00', 'dd/MM')}</p>
                    </div>
                  </div>
                  <p className="text-sm bg-background/80 rounded p-2"><b>Motivo:</b> {ot.reason}</p>
                  {(ot.requested_start || ot.requested_end) && (
                    <p className="text-xs text-muted-foreground">
                      Horário: {ot.requested_start || '—'} a {ot.requested_end || '—'}
                    </p>
                  )}
                  <Textarea
                    placeholder="Observação (opcional)..."
                    value={otNotes[ot.id] || ''}
                    onChange={e => setOtNotes(n => ({ ...n, [ot.id]: e.target.value }))}
                    rows={2}
                    className="text-xs"
                  />
                  <div className="flex gap-2 justify-end">
                    <Button size="sm" variant="destructive" onClick={() => handleOtAction(ot.id, 'recusado')} disabled={approveOt.isPending} className="gap-1 text-xs">
                      <X className="h-3.5 w-3.5" /> Recusar
                    </Button>
                    <Button size="sm" onClick={() => handleOtAction(ot.id, 'aprovado')} disabled={approveOt.isPending} className="gap-1 text-xs">
                      <Check className="h-3.5 w-3.5" /> Aprovar
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" className="h-auto py-3 flex-col gap-1" onClick={() => setRhDialog(true)}>
            <Upload className="h-5 w-5 text-primary" />
            <span className="text-xs">Enviar ao RH</span>
          </Button>
          <Button variant="outline" className="h-auto py-3 flex-col gap-1" onClick={() => navigate('/promotor/home')}>
            <MapPin className="h-5 w-5 text-primary" />
            <span className="text-xs">Ver no Mapa</span>
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar promotor..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>

        {/* Promoter List */}
        <div className="space-y-2">
          {filtered.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">Nenhum promotor encontrado</p>
          )}
          {filtered.map((p: any) => (
            <Card key={p.id} className="cursor-pointer active:scale-[0.98] transition-all hover:border-primary/30"
              onClick={() => setSelectedPromoter(p)}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {p.photo_url ? (
                      <LocalImage src={p.photo_url} alt="" className="w-10 h-10 rounded-full object-cover border" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary">
                        {p.full_name?.charAt(0)}
                      </div>
                    )}
                    <div>
                      <p className="text-sm font-medium">{p.full_name}</p>
                      <p className="text-xs text-muted-foreground">{p.position || 'Promotor'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(() => {
                      const updatedTime = p.location_updated_at ? new Date(p.location_updated_at) : null;
                      const isLocRecent = updatedTime && (new Date().getTime() - updatedTime.getTime()) < 15 * 60 * 1000;
                      if (p.live_status === 'online' || isLocRecent) {
                        return <Badge className="bg-green-500/20 text-green-700 text-[10px]">Online</Badge>;
                      }
                      return null;
                    })()}
                    {p.last_latitude && (
                      <Navigation className="h-3.5 w-3.5 text-primary" />
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Promoter Detail Dialog */}
      <Dialog open={!!selectedPromoter} onOpenChange={(open) => { if (!open) setSelectedPromoter(null); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {selectedPromoter?.photo_url ? (
                <LocalImage src={selectedPromoter.photo_url} alt="" className="w-8 h-8 rounded-full object-cover" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary">
                  {selectedPromoter?.full_name?.charAt(0)}
                </div>
              )}
              {selectedPromoter?.full_name}
            </DialogTitle>
          </DialogHeader>
          {selectedPromoter && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-muted/50 rounded p-2">
                  <p className="text-muted-foreground">Cargo</p>
                  <p className="font-medium">{selectedPromoter.position || '—'}</p>
                </div>
                <div className="bg-muted/50 rounded p-2">
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium">{(() => {
                    const updatedTime = selectedPromoter.location_updated_at ? new Date(selectedPromoter.location_updated_at) : null;
                    const isLocRecent = updatedTime && (new Date().getTime() - updatedTime.getTime()) < 15 * 60 * 1000;
                    return (selectedPromoter.live_status === 'online' || isLocRecent) ? '🟢 Online' : '⚪ Offline';
                  })()}</p>
                </div>
                <div className="bg-muted/50 rounded p-2">
                  <p className="text-muted-foreground">Jornada</p>
                  <p className="font-medium break-all">{formatWorkSchedule(selectedPromoter.work_schedule)}</p>
                </div>
                <div className="bg-muted/50 rounded p-2">
                  <p className="text-muted-foreground">Rotas Hoje</p>
                  <p className="font-medium">{selectedPromoter.today_routes_count ?? '—'}</p>
                </div>
              </div>

              {selectedPromoter.last_latitude && selectedPromoter.last_longitude && (
                <Card className="bg-primary/5 border-primary/20">
                  <CardContent className="p-3 flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-primary" />
                    <div className="flex-1">
                      <p className="text-xs font-medium">Última localização</p>
                      <p className="text-[10px] text-muted-foreground">
                        {selectedPromoter.last_pdv_name || `${Number(selectedPromoter.last_latitude).toFixed(4)}, ${Number(selectedPromoter.last_longitude).toFixed(4)}`}
                      </p>
                    </div>
                    <a
                      href={`https://www.google.com/maps?q=${selectedPromoter.last_latitude},${selectedPromoter.last_longitude}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary underline"
                      onClick={e => e.stopPropagation()}
                    >
                      Abrir Mapa
                    </a>
                  </CardContent>
                </Card>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => {
                  setNotifTarget(selectedPromoter);
                  setNotifDialog(true);
                  setSelectedPromoter(null);
                }}>
                  <Bell className="h-3.5 w-3.5" /> Notificar
                </Button>
                <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => {
                  navigate('/promotor/agenda');
                  setSelectedPromoter(null);
                }}>
                  <Calendar className="h-3.5 w-3.5" /> Agenda
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Send Notification Dialog */}
      <Dialog open={notifDialog} onOpenChange={setNotifDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Bell className="h-5 w-5 text-primary" /> Enviar Notificação
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">Para: <b>{notifTarget?.full_name}</b></p>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Título *</Label>
              <Input value={notifForm.title} onChange={e => setNotifForm(f => ({ ...f, title: e.target.value }))} placeholder="Ex: Lembrete de checkin" />
            </div>
            <div>
              <Label className="text-xs">Mensagem</Label>
              <Textarea value={notifForm.message} onChange={e => setNotifForm(f => ({ ...f, message: e.target.value }))} placeholder="Detalhes..." rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNotifDialog(false)}>Cancelar</Button>
            <Button onClick={handleSendNotif} disabled={sendNotif.isPending || !notifForm.title.trim()}>
              {sendNotif.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
              Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send to RH Dialog */}
      <Dialog open={rhDialog} onOpenChange={setRhDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <FileText className="h-5 w-5 text-primary" /> Enviar ao RH
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Assunto *</Label>
              <Input value={rhForm.title} onChange={e => setRhForm(f => ({ ...f, title: e.target.value }))} placeholder="Ex: Relatório de campo" />
            </div>
            <div>
              <Label className="text-xs">Mensagem</Label>
              <Textarea value={rhForm.message} onChange={e => setRhForm(f => ({ ...f, message: e.target.value }))} placeholder="Detalhes..." rows={3} />
            </div>
            <div>
              <Label className="text-xs">Anexar arquivo</Label>
              {rhForm.file_url ? (
                <div className="flex items-center gap-2 text-xs text-primary">
                  <FileText className="h-4 w-4" />
                  <span className="truncate flex-1">Arquivo anexado</span>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setRhForm(f => ({ ...f, file_url: '' }))}>Remover</Button>
                </div>
              ) : (
                <Input type="file" onChange={handleFileUpload} disabled={isUploading} className="text-xs" />
              )}
              {isUploading && <p className="text-xs text-muted-foreground">Enviando...</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRhDialog(false)}>Cancelar</Button>
            <Button onClick={handleSendRH} disabled={sendRH.isPending || !rhForm.title.trim()}>
              {sendRH.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
              Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PromotorLayout>
  );
}
