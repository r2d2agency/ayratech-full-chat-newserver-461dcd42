import { useState, useMemo } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import { useLiveRoutes, useMerchDamages, useReturnRequests, useMerchRouteDetail, useManualCompleteRoute, useContingencyPhotoUpload } from "@/hooks/use-merch-routes";
import { MapPin, Clock, User, Camera, AlertTriangle, CheckCircle2, Activity, Package, Eye, Store, ChevronRight, Calendar, Filter, Upload } from "lucide-react";
import { CameraCapture } from "@/components/promotor/CameraCapture";
import { useUpload } from "@/hooks/use-upload";
import { resolveMediaUrl } from "@/lib/media";
import { exportPhotosAsJpg } from "@/lib/photo-export";
import { PhotoLightbox } from "@/components/merch/PhotoLightbox";
import { Checkbox } from "@/components/ui/checkbox";
import { Download, CheckSquare } from "lucide-react";
import { format, subDays, startOfWeek, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";

const PERIOD_PRESETS = [
  { value: 'today', label: 'Hoje' },
  { value: 'yesterday', label: 'Ontem' },
  { value: 'week', label: 'Esta semana' },
  { value: 'month', label: 'Este mês' },
  { value: 'custom', label: 'Personalizado' },
];

function getDateRange(preset: string): { from: string; to: string } {
  const today = new Date();
  switch (preset) {
    case 'today': return { from: format(today, 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
    case 'yesterday': { const y = subDays(today, 1); return { from: format(y, 'yyyy-MM-dd'), to: format(y, 'yyyy-MM-dd') }; }
    case 'week': return { from: format(startOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
    case 'month': return { from: format(startOfMonth(today), 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
    default: return { from: format(today, 'yyyy-MM-dd'), to: format(today, 'yyyy-MM-dd') };
  }
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Agendada', confirmed: 'Confirmada', in_progress: 'Em Andamento',
  completed: 'Concluída', not_done: 'Não Realizada', cancelled: 'Cancelada',
};

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-500/20 text-blue-700',
  confirmed: 'bg-cyan-500/20 text-cyan-700',
  in_progress: 'bg-orange-500/20 text-orange-700',
  completed: 'bg-green-500/20 text-green-700',
  not_done: 'bg-red-500/20 text-red-700',
  cancelled: 'bg-muted text-muted-foreground',
};

const DAMAGE_STATUS: Record<string, string> = {
  registered: 'Registrada', awaiting_invoice: 'Aguardando Nota', invoice_sent: 'Nota Enviada',
  in_review: 'Em Conferência', completed: 'Concluída', cancelled: 'Cancelada',
};

function defaultDatetimeLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function getContingencyCategories(viewRoute: any, brandId: string): Array<{ id: string; name: string }> {
  if (!viewRoute) return [];
  const seen = new Map<string, string>();
  const execs: any[] = viewRoute.executions || [];
  execs.forEach((e) => {
    if (!e.category_id) return;
    if (brandId && e.route_brand_id && e.route_brand_id !== brandId) return;
    if (!seen.has(e.category_id)) seen.set(e.category_id, e.category_name || 'Categoria');
  });
  const cp: any[] = viewRoute.category_progress || [];
  cp.forEach((c) => {
    if (c.category_id && !seen.has(c.category_id)) seen.set(c.category_id, c.category_name || 'Categoria');
  });
  return Array.from(seen, ([id, name]) => ({ id, name }));
}

export default function MerchExecucao() {
  const [period, setPeriod] = useState('today');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const dateRange = useMemo(() => {
    if (period === 'custom' && dateFrom && dateTo) return { from: dateFrom, to: dateTo };
    return getDateRange(period);
  }, [period, dateFrom, dateTo]);

  const { data: liveRoutesAll = [] } = useLiveRoutes({ date_from: dateRange.from, date_to: dateRange.to });
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const liveRoutes = useMemo(() => {
    const s = searchTerm.trim().toLowerCase();
    return (liveRoutesAll as any[]).filter((r: any) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (!s) return true;
      return [r.promoter_name, r.pdv_name, r.pdv_city, r.pdv_state, r.brand_name, r.checklist_name]
        .some((v: any) => v && String(v).toLowerCase().includes(s));
    });
  }, [liveRoutesAll, searchTerm, statusFilter]);
  const [damageFilter, setDamageFilter] = useState('');
  const { data: damages = [] } = useMerchDamages({ status: damageFilter || undefined });
  const { data: returnRequests = [] } = useReturnRequests();
  const [viewRouteId, setViewRouteId] = useState<string | null>(null);
  const [showCompleteDialog, setShowCompleteDialog] = useState(false);
  const [completeNotes, setCompleteNotes] = useState('');
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [contingencyPhotos, setContingencyPhotos] = useState<string[]>([]);
  const [contingencyFiles, setContingencyFiles] = useState<File[]>([]);
  const [contingencyPhotoProgress, setContingencyPhotoProgress] = useState<Record<string, 'queued' | 'processing' | 'done' | 'failed'>>({});
  const { uploadFile: uploadPhotoFile } = useUpload();
  const [contingencyCapturedAt, setContingencyCapturedAt] = useState<string>(() => defaultDatetimeLocal());
  const [contingencyBrandId, setContingencyBrandId] = useState<string>('');
  const [contingencyCategoryId, setContingencyCategoryId] = useState<string>('');
  const [contingencyPhotoType, setContingencyPhotoType] = useState<string>('contingency');
  const [contingencyReason, setContingencyReason] = useState<string>('');
  const [viewPhoto, setViewPhoto] = useState<any>(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [exportingJpg, setExportingJpg] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const { data: routeDetail, isLoading: isLoadingDetail } = useMerchRouteDetail(viewRouteId || undefined);
  const viewRoute = routeDetail || liveRoutes.find((r: any) => r.id === viewRouteId);
  const manualComplete = useManualCompleteRoute();
  const contingencyUpload = useContingencyPhotoUpload();

  // Somente fotos exibíveis (URLs sincronizadas) — evita divergência entre total e galeria
  const routePhotos = useMemo(
    () => ((viewRoute?.photos || []) as any[]).filter((p: any) => !!resolveMediaUrl(p.photo_url)),
    [viewRoute]
  );
  const pendingPhotos = ((viewRoute?.photos || []) as any[]).length - routePhotos.length;

  const togglePhoto = (id: string) => setSelectedPhotoIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const handleExportRoutePhotos = async () => {
    const list = selectedPhotoIds.size > 0
      ? routePhotos.filter((p: any) => selectedPhotoIds.has(p.id))
      : routePhotos;
    if (list.length === 0) return;
    setExportingJpg(true);
    setExportProgress(0);
    try {
      const { ok, failed } = await exportPhotosAsJpg(list, {
        zipName: `execucao-${viewRoute?.pdv_name || 'rota'}-${(viewRoute?.scheduled_date || '').slice(0, 10)}`,
        onProgress: (done, total) => setExportProgress(Math.round((done / total) * 100)),
      });
      if (ok > 0) toast.success(`${ok} foto(s) exportada(s) em JPG${failed ? ` — ${failed} falharam` : ''}`);
      else toast.error('Não foi possível exportar as fotos');
    } catch {
      toast.error('Erro ao exportar fotos');
    } finally {
      setExportingJpg(false);
    }
  };


  const handleManualComplete = () => {
    if (!viewRouteId) return;
    manualComplete.mutate({ id: viewRouteId, notes: completeNotes }, {
      onSuccess: () => {
        toast.success('Rota finalizada manualmente');
        setShowCompleteDialog(false);
        setCompleteNotes('');
      }
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setUploadFile(file);
  };

  const submitPhoto = async () => {
    if (!viewRouteId || !uploadFile) return;
    setUploading(true);
    try {
      // Em um cenário real, você faria upload para o storage primeiro (ex: Supabase storage ou seu backend)
      // Aqui vamos simular o upload e pegar uma URL. 
      // Como não temos o componente de upload configurado aqui, vou apenas mostrar o fluxo.
      // Supondo que o backend aceite uma URL ou que tenhamos um endpoint de upload.
      
      // Simulação simplificada (em produção usaria um componente de Upload dedicado)
      toast.info("Funcionalidade de upload manual requer integração com storage");
      setUploading(false);
    } catch (err) {
      toast.error("Erro ao subir foto");
      setUploading(false);
    }
  };

  const inProgress = liveRoutes.filter((r: any) => r.status === 'in_progress');
  const completed = liveRoutes.filter((r: any) => r.status === 'completed');
  const scheduled = liveRoutes.filter((r: any) => r.status === 'scheduled' || r.status === 'confirmed');

  const totalProducts = liveRoutes.reduce((sum: number, r: any) => sum + (parseInt(r.total_products) || 0), 0);
  const completedProducts = liveRoutes.reduce((sum: number, r: any) => sum + (parseInt(r.completed_products) || 0), 0);

  const periodLabel = period === 'today' ? 'do dia' : period === 'yesterday' ? 'de ontem' : period === 'week' ? 'da semana' : period === 'month' ? 'do mês' : 'do período';

  return (
    <MainLayout>
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" /> Execução em Campo
          </h1>
          <p className="text-sm text-muted-foreground">Acompanhamento das rotas {periodLabel}</p>
        </div>

        {/* Period Filter */}
        <Card className="p-3">
          <div className="flex gap-3 flex-wrap items-end">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Período</label>
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PERIOD_PRESETS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {period === 'custom' && (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">De</label>
                  <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-40" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Até</label>
                  <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-40" />
                </div>
              </>
            )}
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Buscar</label>
              <Input
                placeholder="Promotor, loja, cidade, marca..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
              <Select value={statusFilter || "__all__"} onValueChange={v => setStatusFilter(v === "__all__" ? "" : v)}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  {Object.entries(STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {(searchTerm || statusFilter) && (
              <Button variant="ghost" size="sm" onClick={() => { setSearchTerm(''); setStatusFilter(''); }}>
                Limpar
              </Button>
            )}
          </div>
        </Card>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card><CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-primary">{liveRoutes.length}</div>
            <div className="text-xs text-muted-foreground">Total Hoje</div>
          </CardContent></Card>
          <Card><CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-orange-500">{inProgress.length}</div>
            <div className="text-xs text-muted-foreground">Em Andamento</div>
          </CardContent></Card>
          <Card><CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-green-500">{completed.length}</div>
            <div className="text-xs text-muted-foreground">Concluídas</div>
          </CardContent></Card>
          <Card><CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-blue-500">{scheduled.length}</div>
            <div className="text-xs text-muted-foreground">Pendentes</div>
          </CardContent></Card>
          <Card><CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-primary">{completedProducts}/{totalProducts}</div>
            <div className="text-xs text-muted-foreground">Produtos</div>
          </CardContent></Card>
        </div>

        <Tabs defaultValue="live">
          <TabsList>
            <TabsTrigger value="live">Tempo Real</TabsTrigger>
            <TabsTrigger value="damages">Avarias ({damages.length})</TabsTrigger>
            <TabsTrigger value="returns">Devoluções ({returnRequests.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="live" className="space-y-3">
            {/* In Progress */}
            {inProgress.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-orange-600 flex items-center gap-1">
                  <Activity className="h-4 w-4 animate-pulse" /> Em Andamento ({inProgress.length})
                </h3>
                {inProgress.map((r: any) => (
                  <Card key={r.id} className="border-orange-500/30 cursor-pointer hover:border-orange-500/60 transition-colors"
                    onClick={() => setViewRouteId(r.id)}>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <div className="font-semibold text-sm">{r.pdv_name}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2">
                            <span className="flex items-center gap-1"><User className="h-3 w-3" />{r.promoter_name}</span>
                            <span>•</span>
                            {r.is_multi_brand ? (
                              <span className="flex items-center gap-1">🏷️ {r.route_brands?.length || 0} marcas</span>
                            ) : (
                              <span>{r.brand_name}</span>
                            )}
                            {!r.is_multi_brand && r.checklist_name && <><span>•</span><span>{r.checklist_name}</span></>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-right">
                            <div className="text-lg font-bold text-orange-500">{Math.round(r.progress_pct || 0)}%</div>
                            <div className="text-[10px] text-muted-foreground">
                              {r.completed_products || 0}/{r.total_products || 0} produtos
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>
                      <Progress value={r.progress_pct || 0} className="h-1.5" />
                      {/* Multi-brand mini progress */}
                      {r.is_multi_brand && r.route_brands?.length > 0 && (
                        <div className="flex gap-2 mt-2">
                          {r.route_brands.map((rb: any) => (
                            <div key={rb.brand_id} className="flex-1 text-center">
                              <div className="text-[9px] text-muted-foreground truncate">{rb.brand_name}</div>
                              <Progress value={rb.progress_pct || 0} className="h-1 mt-0.5" />
                              <div className="text-[9px] font-mono">{Math.round(rb.progress_pct || 0)}%</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {r.checkin_at && (
                        <div className="text-[10px] text-muted-foreground mt-1">
                          Check-in: {new Date(r.checkin_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          {r.pdv_city && ` • ${r.pdv_city}`}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Completed */}
            {completed.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-green-600">✅ Concluídas Hoje ({completed.length})</h3>
                {completed.map((r: any) => (
                  <Card key={r.id} className="border-green-500/20 cursor-pointer hover:border-green-500/40 transition-colors"
                    onClick={() => setViewRouteId(r.id)}>
                    <CardContent className="p-3 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-sm">{r.pdv_name}</div>
                        <div className="text-xs text-muted-foreground">{r.promoter_name} • {r.brand_name}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {r.completed_products || 0}/{r.total_products || 0} produtos
                          {r.completed_at && ` • Concluída ${new Date(r.completed_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
                        </div>
                      </div>
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Scheduled */}
            {scheduled.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-blue-600">📅 Aguardando ({scheduled.length})</h3>
                {scheduled.map((r: any) => (
                  <Card key={r.id} className="cursor-pointer hover:border-primary/30 transition-colors"
                    onClick={() => setViewRouteId(r.id)}>
                    <CardContent className="p-3 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-sm">{r.pdv_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.scheduled_time?.slice(0, 5)} • {r.promoter_name} • {r.brand_name}
                        </div>
                      </div>
                      <Badge variant="secondary">{r.scheduled_time?.slice(0, 5) || 'S/ horário'}</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {liveRoutes.length === 0 && (
              <p className="text-center text-muted-foreground py-8">Nenhuma rota agendada para hoje</p>
            )}
          </TabsContent>

          <TabsContent value="damages" className="space-y-3">
            <div className="flex gap-2">
              <Select value={damageFilter || "__all__"} onValueChange={(v) => setDamageFilter(v === "__all__" ? "" : v)}>
                <SelectTrigger className="w-48"><SelectValue placeholder="Filtrar status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  {Object.entries(DAMAGE_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {damages.map((d: any) => {
              const photoUrl = resolveMediaUrl(d.photo_url);
              return (
              <Card key={d.id}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-sm">{d.product_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {d.pdv_name} • {d.brand_name} • {d.promoter_name}
                      </div>
                      <div className="text-xs mt-1">
                        Loja: {d.qty_store} | Estoque: {d.qty_stock} | <strong>Total: {d.qty_total}</strong>
                      </div>
                      {d.reason && <div className="text-xs text-muted-foreground mt-0.5">{d.reason}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      {photoUrl && (
                        <div 
                          className="h-10 w-10 rounded overflow-hidden border bg-muted cursor-pointer shadow-sm"
                          onClick={() => setViewPhoto({ id: d.id, photo_url: d.photo_url, photo_type: 'damage', product_name: d.product_name, pdv_name: d.pdv_name, brand_name: d.brand_name, promoter_name: d.promoter_name })}
                        >
                          <img 
                            src={photoUrl} 
                            alt="Avaria" 
                            className="h-full w-full object-cover" 
                            onError={(e) => {
                              // If image fails to load (e.g. invalid blob from session), hide the container
                              (e.target as HTMLImageElement).style.display = 'none';
                              (e.target as HTMLImageElement).parentElement!.style.display = 'none';
                            }}
                          />
                        </div>
                      )}
                      <Badge className="text-[10px]">{DAMAGE_STATUS[d.status] || d.status}</Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )})}
            {damages.length === 0 && <p className="text-center text-muted-foreground py-8">Nenhuma avaria registrada</p>}
          </TabsContent>

          <TabsContent value="returns" className="space-y-3">
            {returnRequests.map((r: any) => (
              <Card key={r.id}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-sm">{r.pdv_name} - {r.brand_name}</div>
                      <div className="text-xs text-muted-foreground">{r.promoter_name} • {r.item_count} item(s)</div>
                    </div>
                    <Badge>{DAMAGE_STATUS[r.status] || r.status}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
            {returnRequests.length === 0 && <p className="text-center text-muted-foreground py-8">Nenhuma solicitação de devolução</p>}
          </TabsContent>
        </Tabs>

        {/* Route Detail Dialog */}
        <Dialog open={!!viewRouteId} onOpenChange={(open) => !open && setViewRouteId(null)}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Store className="h-5 w-5 text-primary" />
                {viewRoute?.pdv_name}
              </DialogTitle>
            </DialogHeader>
            {viewRoute && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge className={STATUS_COLORS[viewRoute.status] || 'bg-muted'}>
                      {STATUS_LABELS[viewRoute.status] || viewRoute.status}
                    </Badge>
                    {viewRoute.edited && (
                      <Badge variant="outline" className="border-yellow-500 text-yellow-600 bg-yellow-50">
                        Editada
                      </Badge>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {viewRoute.status !== 'completed' && (
                      <Button size="sm" variant="outline" className="h-8 border-green-500 text-green-600 hover:bg-green-50" 
                        onClick={() => setShowCompleteDialog(true)}>
                        <CheckCircle2 className="h-4 w-4 mr-1" /> Finalizar Rota
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-8" onClick={() => setShowUploadDialog(true)}>
                      <Camera className="h-4 w-4 mr-1" /> Subir Foto
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase font-bold">Promotor</div>
                    <div className="font-medium flex items-center gap-1"><User className="h-3.5 w-3.5" /> {viewRoute.promoter_name}</div>
                  </div>
                  {viewRoute.supervisor_name && (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase font-bold">Supervisor</div>
                      <div className="font-medium flex items-center gap-1"><User className="h-3.5 w-3.5 text-blue-500" /> {viewRoute.supervisor_name}</div>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase font-bold">Marca</div>
                    <div className="font-medium">
                      {viewRoute.is_multi_brand
                        ? `🏷️ ${viewRoute.route_brands?.length || 0} marcas`
                        : viewRoute.brand_name}
                    </div>
                  </div>
                  {viewRoute.checkin_at && (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase font-bold">Check-in</div>
                      <div className="font-medium flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-green-500" /> {new Date(viewRoute.checkin_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  )}
                  {viewRoute.checkout_at && (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase font-bold">Check-out</div>
                      <div className="font-medium flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-red-500" /> {new Date(viewRoute.checkout_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  )}
                  {!viewRoute.is_multi_brand && viewRoute.checklist_name && (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase font-bold">Checklist</div>
                      <div className="font-medium truncate">{viewRoute.checklist_name}</div>
                    </div>
                  )}
                </div>

                {/* Multi-brand detailed view */}
                {viewRoute.is_multi_brand && viewRoute.route_brands?.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground">Progresso por Marca</div>
                    {viewRoute.route_brands.map((rb: any) => (
                      <Card key={rb.brand_id} className={`${rb.status === 'completed' ? 'border-green-500/30 bg-green-500/5' : rb.status === 'in_progress' ? 'border-orange-500/30 bg-orange-500/5' : 'border-border'}`}>
                        <CardContent className="p-3 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">{rb.brand_name}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold">{Math.round(rb.progress_pct || 0)}%</span>
                              <Badge variant="outline" className="text-[9px]">
                                {rb.status === 'completed' ? '✅ Concluída' : rb.status === 'in_progress' ? '🔄 Em Andamento' : '⏳ Pendente'}
                              </Badge>
                            </div>
                          </div>
                          <Progress value={rb.progress_pct || 0} className="h-1.5" />
                          {rb.checklist_name && (
                            <div className="text-[10px] text-muted-foreground">Checklist: {rb.checklist_name}</div>
                          )}
                          {rb.started_at && (
                            <div className="text-[10px] text-muted-foreground">
                              Início: {new Date(rb.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                              {rb.completed_at && ` • Fim: ${new Date(rb.completed_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}

                {/* Execution progress */}
                {(viewRoute.status === 'in_progress' || viewRoute.status === 'completed') && (
                  <Card className={viewRoute.status === 'in_progress' ? 'border-orange-500/30 bg-orange-500/5' : 'border-green-500/30 bg-green-500/5'}>
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5">
                          <Activity className="h-4 w-4" />
                          {viewRoute.status === 'in_progress' ? 'Executando agora' : 'Concluída'}
                        </span>
                        <span className="font-mono font-bold">{Math.round(viewRoute.progress_pct || 0)}%</span>
                      </div>
                      <Progress value={viewRoute.progress_pct || 0} className="h-2" />
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>Produtos: {viewRoute.completed_products || 0}/{viewRoute.total_products || 0}</span>
                        {viewRoute.checkin_at && (
                          <span>Check-in: {new Date(viewRoute.checkin_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                        )}
                      </div>

                      {/* Category progress */}
                      {viewRoute.category_progress && Array.isArray(viewRoute.category_progress) && (
                        <div className="space-y-1 pt-1 border-t">
                          <div className="text-[10px] font-semibold text-muted-foreground">Categorias</div>
                          {viewRoute.category_progress.map((cat: any, i: number) => (
                            <div key={i} className="flex items-center justify-between text-[10px]">
                              <span className="truncate flex-1">{cat.category_name}</span>
                              <div className="flex items-center gap-1.5">
                                {cat.point_type && (
                                  <Badge variant="outline" className="text-[8px] px-1 h-4">
                                    {cat.point_type === 'natural' ? '📍' : '🎯'} {cat.point_type}
                                  </Badge>
                                )}
                                {cat.completed ? (
                                  <CheckCircle2 className="h-3 w-3 text-green-500" />
                                ) : cat.products_unlocked ? (
                                  <Activity className="h-3 w-3 text-orange-500" />
                                ) : (
                                  <Clock className="h-3 w-3 text-muted-foreground" />
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Check-in/out Photos */}
                {(viewRoute.checkin_photo || viewRoute.checkout_photo) && (
                  <div className="grid grid-cols-2 gap-3">
                    {viewRoute.checkin_photo && (
                      <div className="space-y-1">
                        <div className="text-[10px] font-semibold text-muted-foreground uppercase">Foto Check-in</div>
                        <div className="aspect-video rounded-md overflow-hidden bg-muted border flex items-center justify-center relative">
                          {resolveMediaUrl(viewRoute.checkin_photo) ? (
                            <img 
                              src={resolveMediaUrl(viewRoute.checkin_photo)!} 
                              alt="Check-in" 
                              className="w-full h-full object-cover cursor-pointer" 
                              onClick={() => setViewPhoto({ id: `${viewRoute.id}-checkin`, photo_url: viewRoute.checkin_photo, photo_type: 'checkin', pdv_name: viewRoute.pdv_name, promoter_name: viewRoute.promoter_name, captured_at: viewRoute.checkin_at })} 
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                                const parent = (e.target as HTMLImageElement).parentElement;
                                if (parent) {
                                  const placeholder = document.createElement('div');
                                  placeholder.className = 'flex flex-col items-center gap-1 text-muted-foreground p-4';
                                  placeholder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-6 w-6"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg><span class="text-[8px] text-center">Imagem expirada ou aguardando sincronismo</span>';
                                  parent.appendChild(placeholder);
                                }
                              }}
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-1 text-muted-foreground">
                              <Camera className="h-6 w-6" />
                              <span className="text-[8px]">Aguardando sincronismo</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {viewRoute.checkout_photo && (
                      <div className="space-y-1">
                        <div className="text-[10px] font-semibold text-muted-foreground uppercase">Foto Check-out</div>
                        <div className="aspect-video rounded-md overflow-hidden bg-muted border flex items-center justify-center relative">
                          {resolveMediaUrl(viewRoute.checkout_photo) ? (
                            <img 
                              src={resolveMediaUrl(viewRoute.checkout_photo)!} 
                              alt="Check-out" 
                              className="w-full h-full object-cover cursor-pointer" 
                              onClick={() => setViewPhoto({ id: `${viewRoute.id}-checkout`, photo_url: viewRoute.checkout_photo, photo_type: 'checkout', pdv_name: viewRoute.pdv_name, promoter_name: viewRoute.promoter_name, captured_at: viewRoute.checkout_at })} 
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                                const parent = (e.target as HTMLImageElement).parentElement;
                                if (parent) {
                                  const placeholder = document.createElement('div');
                                  placeholder.className = 'flex flex-col items-center gap-1 text-muted-foreground p-4';
                                  placeholder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-6 w-6"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg><span class="text-[8px] text-center">Imagem expirada ou aguardando sincronismo</span>';
                                  parent.appendChild(placeholder);
                                }
                              }}
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-1 text-muted-foreground">
                              <Camera className="h-6 w-6" />
                              <span className="text-[8px]">Aguardando sincronismo</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Photos Section */}
                {routePhotos.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground flex items-center gap-2 flex-wrap">
                      <span className="flex items-center gap-1"><Camera className="h-4 w-4" /> Fotos da Execução ({routePhotos.length})</span>
                      {pendingPhotos > 0 && (
                        <Badge variant="outline" className="text-[9px] border-amber-400 text-amber-700">
                          {pendingPhotos} aguardando sincronismo do app
                        </Badge>
                      )}
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => {
                        setSelectedPhotoIds(prev => prev.size === routePhotos.length ? new Set() : new Set(routePhotos.map((p: any) => p.id)));
                      }}>
                        <CheckSquare className="h-3 w-3 mr-1" />
                        {selectedPhotoIds.size === routePhotos.length ? 'Desmarcar tudo' : 'Selecionar tudo'}
                      </Button>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={exportingJpg} onClick={handleExportRoutePhotos}>
                        <Download className="h-3 w-3 mr-1" />
                        {exportingJpg ? `Exportando ${exportProgress}%` : selectedPhotoIds.size > 0 ? `Exportar JPG (${selectedPhotoIds.size})` : 'Exportar todas JPG'}
                      </Button>
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {routePhotos.map((photo: any) => {
                        const url = resolveMediaUrl(photo.photo_url)!;
                        const isSelected = selectedPhotoIds.has(photo.id);
                        return (
                        <div key={photo.id} className={`relative aspect-square rounded-md overflow-hidden bg-muted border group ${isSelected ? 'ring-2 ring-primary' : ''}`}>
                          <div className="absolute top-1 left-1 z-10" onClick={(e) => { e.stopPropagation(); togglePhoto(photo.id); }}>
                            <Checkbox checked={isSelected} className="bg-background/80 border-background/80" />
                          </div>
                          <img 
                            src={url} 
                            alt={photo.category_name || 'Foto de execução'} 
                            className="w-full h-full object-cover cursor-pointer transition-transform group-hover:scale-105" 
                            style={photo.rotation ? { transform: `rotate(${photo.rotation}deg)` } : undefined}
                            loading="lazy"
                            onClick={() => setViewPhoto({
                              ...photo,
                              pdv_name: viewRoute.pdv_name,
                              brand_name: photo.brand_name || viewRoute.brand_name,
                              promoter_name: viewRoute.promoter_name,
                            })}
                          />
                          {photo.category_name && (
                            <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[8px] text-white p-1 truncate pointer-events-none">
                              {photo.category_name}
                            </div>
                          )}
                        </div>
                      )})}
                    </div>
                  </div>
                )}


                {/* Damages & Ruptures */}
                {(viewRoute.damages?.length > 0 || viewRoute.ruptures?.length > 0) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {viewRoute.damages?.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-red-600 flex items-center gap-1">
                          <AlertTriangle className="h-4 w-4" /> Avarias ({viewRoute.damages.length})
                        </div>
                        <div className="space-y-1">
                          {viewRoute.damages.map((d: any) => (
                            <div key={d.id} className="text-[10px] bg-red-50 p-1.5 rounded border border-red-100">
                              <span className="font-bold">{d.product_name}</span>: {d.qty_total} un.
                              {d.reason && <div className="text-muted-foreground italic mt-0.5">{d.reason}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {viewRoute.ruptures?.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-orange-600 flex items-center gap-1">
                          <Package className="h-4 w-4" /> Rupturas ({viewRoute.ruptures.length})
                        </div>
                        <div className="space-y-1">
                          {viewRoute.ruptures.map((r: any) => (
                            <div key={r.id} className="text-[10px] bg-orange-100 p-1.5 rounded border border-orange-200">
                              <span className="font-bold text-orange-900">{r.product_name}</span>
                              {r.reason && <div className="text-orange-800 italic mt-0.5">{r.reason}</div>}
                              {r.observation && <div className="text-orange-700 text-[9px] mt-0.5">{r.observation}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Logs / Timeline */}
                {viewRoute.logs && viewRoute.logs.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                      <Activity className="h-4 w-4" /> Histórico da Rota
                    </div>
                    <div className="space-y-1.5 border-l-2 border-muted ml-2 pl-3 py-1">
                      {viewRoute.logs.slice(-5).map((log: any) => (
                        <div key={log.id} className="relative">
                          <div className="absolute -left-[17px] top-1.5 w-2 h-2 rounded-full bg-primary" />
                          <div className="text-[10px]">
                            <span className="font-medium text-muted-foreground">{new Date(log.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                            <span className="ml-2">{log.action_description || log.action_type}</span>
                          </div>
                        </div>
                      ))}
                      {viewRoute.logs.length > 5 && (
                        <div className="text-[9px] text-primary cursor-pointer hover:underline">Ver todo o histórico (+{viewRoute.logs.length - 5})</div>
                      )}
                    </div>
                  </div>
                )}

                {viewRoute.notes && (
                  <div className="space-y-1">
                    <div className="text-xs font-semibold text-muted-foreground uppercase">Observações</div>
                    <div className="text-xs text-muted-foreground bg-muted/30 p-2 rounded-md border italic">
                      "{viewRoute.notes}"
                    </div>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Manual Complete Dialog */}
        <Dialog open={showCompleteDialog} onOpenChange={setShowCompleteDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Finalizar Rota Manualmente</DialogTitle>
              <DialogDescription>
                Deseja marcar esta rota como concluída? Isso será registrado no histórico.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <Label className="text-xs">Observações / Motivo</Label>
              <Textarea 
                placeholder="Ex: Finalizado via supervisor pois promotor ficou sem bateria..." 
                value={completeNotes}
                onChange={(e) => setCompleteNotes(e.target.value)}
                className="text-sm"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCompleteDialog(false)}>Cancelar</Button>
              <Button onClick={handleManualComplete} disabled={manualComplete.isPending}>
                {manualComplete.isPending ? "Processando..." : "Confirmar Finalização"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Upload Dialog (Contingência com data/hora + categoria + marca) */}
        <Dialog open={showUploadDialog} onOpenChange={(open) => {
          setShowUploadDialog(open);
          if (!open) {
            setContingencyCapturedAt(defaultDatetimeLocal());
            setContingencyBrandId('');
            setContingencyCategoryId('');
            setContingencyPhotoType('contingency');
            setContingencyReason('');
            setContingencyPhotos([]);
            setContingencyFiles([]);
            setContingencyPhotoProgress({});
          }
        }}>
          <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Subir Foto Manualmente (Contingência)</DialogTitle>
              <DialogDescription>
                Registre uma foto tirada fora do app (ex.: celular quebrado). Defina data/hora, marca e categoria para que ela entre na galeria no local correto.
              </DialogDescription>
            </DialogHeader>
            {viewRoute && (
              <div className="space-y-3 py-2">
                <div className="space-y-1">
                  <Label className="text-xs">Data e hora da foto *</Label>
                  <Input
                    type="datetime-local"
                    value={contingencyCapturedAt}
                    onChange={(e) => setContingencyCapturedAt(e.target.value)}
                    max={defaultDatetimeLocal()}
                  />
                </div>

                {viewRoute.is_multi_brand && viewRoute.route_brands?.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-xs">Marca *</Label>
                    <Select value={contingencyBrandId} onValueChange={(v) => { setContingencyBrandId(v); setContingencyCategoryId(''); }}>
                      <SelectTrigger><SelectValue placeholder="Selecione a marca" /></SelectTrigger>
                      <SelectContent>
                        {viewRoute.route_brands.map((rb: any) => (
                          <SelectItem key={rb.id} value={rb.id}>{rb.brand_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-1">
                  <Label className="text-xs">Categoria</Label>
                  <Select value={contingencyCategoryId} onValueChange={setContingencyCategoryId}>
                    <SelectTrigger><SelectValue placeholder="Selecione a categoria (opcional)" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sem categoria</SelectItem>
                      {getContingencyCategories(viewRoute, contingencyBrandId).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Tipo da foto *</Label>
                  <Select value={contingencyPhotoType} onValueChange={setContingencyPhotoType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="before">Antes</SelectItem>
                      <SelectItem value="after">Depois</SelectItem>
                      <SelectItem value="contingency">Contingência (avulsa)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Motivo / Observação</Label>
                  <Textarea
                    placeholder="Ex.: celular do promotor quebrou — foto enviada por WhatsApp"
                    value={contingencyReason}
                    onChange={(e) => setContingencyReason(e.target.value)}
                    className="text-sm"
                    rows={2}
                  />
                </div>

                <div className="pt-2 border-t space-y-3">
                  <Label className="text-xs mb-2 block">Fotos (mesma categoria/marca)</Label>
                  <Input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={uploading}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      setContingencyFiles(prev => [...prev, ...files]);
                      setContingencyPhotoProgress(prev => ({ ...prev, ...Object.fromEntries(files.map(file => [file.name, 'queued'])) }));
                    }}
                  />
                  {contingencyFiles.length > 0 && (
                    <div className="max-h-48 space-y-1 overflow-x-hidden overflow-y-auto rounded-md border bg-muted/20 p-2 text-xs">
                      {contingencyFiles.map((file, index) => (
                        <div key={`${file.name}-${index}`} className="flex min-w-0 items-center gap-2 rounded border px-2 py-1">
                          <span className="min-w-0 flex-1 truncate" title={file.name}>{index + 1}. {file.name}</span>
                          <span className="shrink-0 whitespace-nowrap text-muted-foreground">{contingencyPhotoProgress[`${file.name}#${index}`] || 'Aguardando'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {contingencyPhotos.map((url, index) => (
                    <div key={`${url}-${index}`} className="flex items-center justify-between rounded border px-2 py-1 text-xs">
                      <span className="min-w-0 flex-1 truncate">Foto capturada {index + 1}</span>
                      <span className="shrink-0 whitespace-nowrap">{contingencyPhotoProgress[url] === 'done' ? 'Registrada' : contingencyPhotoProgress[url] === 'failed' ? 'Falhou' : 'Aguardando'}</span>
                    </div>
                  ))}
                  <CameraCapture
                    onCapture={async (url) => {
                      if (!contingencyCapturedAt) { toast.error('Informe a data/hora da foto'); return; }
                      if (viewRoute.is_multi_brand && !contingencyBrandId) { toast.error('Selecione a marca'); return; }
                      try {
                        await contingencyUpload.mutateAsync({ routeId: viewRoute.id, photo_url: url, photo_type: contingencyPhotoType, category_id: contingencyCategoryId && contingencyCategoryId !== '__none__' ? contingencyCategoryId : null, route_brand_id: contingencyBrandId || null, captured_at: new Date(contingencyCapturedAt).toISOString(), reason: contingencyReason || 'Contingência operacional' });
                        toast.success('Foto registrada na galeria da rota');
                        setShowUploadDialog(false);
                      } catch (err: any) { toast.error('Falha ao registrar foto: ' + (err?.message || '')); }
                    }}
                    watermark={{
                      pdvName: viewRoute.pdv_name,
                      brandName: viewRoute.is_multi_brand
                        ? (viewRoute.route_brands?.find((rb: any) => rb.id === contingencyBrandId)?.brand_name || 'Multi-marca')
                        : viewRoute.brand_name,
                      promotorName: viewRoute.promoter_name,
                      photoType: `Contingência (${contingencyPhotoType})`,
                    }}
                    buttonLabel="Selecionar arquivo e validar"
                    allowManualUpload={true}
                    requireConfirmation={true}
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowUploadDialog(false)} disabled={uploading}>Fechar</Button>
              <Button
                disabled={uploading || !viewRoute || (!contingencyFiles.length && !contingencyPhotos.length)}
                onClick={async () => {
                  if (!viewRoute) return;
                  if (!contingencyCapturedAt) { toast.error('Informe a data/hora da foto'); return; }
                  if (viewRoute.is_multi_brand && !contingencyBrandId) { toast.error('Selecione a marca'); return; }
                  setUploading(true);
                  let ok = 0;
                  for (let i = 0; i < contingencyFiles.length; i++) {
                    const file = contingencyFiles[i];
                    const key = `${file.name}#${i}`;
                    setContingencyPhotoProgress(prev => ({ ...prev, [key]: 'processing' }));
                    try {
                      const url = await uploadPhotoFile(file);
                      if (!url) throw new Error('Upload sem URL');
                      await contingencyUpload.mutateAsync({
                        routeId: viewRoute.id, photo_url: url, photo_type: contingencyPhotoType,
                        category_id: contingencyCategoryId && contingencyCategoryId !== '__none__' ? contingencyCategoryId : null,
                        route_brand_id: contingencyBrandId || null, captured_at: new Date(contingencyCapturedAt).toISOString(),
                        reason: contingencyReason || 'Contingência operacional',
                      });
                      setContingencyPhotoProgress(prev => ({ ...prev, [key]: 'done' })); ok++;
                    } catch (err: any) {
                      setContingencyPhotoProgress(prev => ({ ...prev, [key]: 'failed' }));
                      toast.error(`Falha na foto ${i + 1}: ${err?.message || 'erro'}`);
                    }
                  }
                  if (contingencyPhotos.length) {
                    for (let i = 0; i < contingencyPhotos.length; i++) {
                      const url = contingencyPhotos[i];
                      setContingencyPhotoProgress(prev => ({ ...prev, [url]: 'processing' }));
                      try {
                        await contingencyUpload.mutateAsync({ routeId: viewRoute.id, photo_url: url, photo_type: contingencyPhotoType, category_id: contingencyCategoryId && contingencyCategoryId !== '__none__' ? contingencyCategoryId : null, route_brand_id: contingencyBrandId || null, captured_at: new Date(contingencyCapturedAt).toISOString(), reason: contingencyReason || 'Contingência operacional' });
                        setContingencyPhotoProgress(prev => ({ ...prev, [url]: 'done' })); ok++;
                      } catch { setContingencyPhotoProgress(prev => ({ ...prev, [url]: 'failed' })); }
                    }
                  }
                  setUploading(false);
                  if (ok) toast.success(`${ok} foto(s) registrada(s) na galeria da rota`);
                }}
              >{uploading ? 'Processando fotos...' : 'Processar fotos'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Photo Lightbox (ampliar / girar / baixar JPG) */}
        <PhotoLightbox photo={viewPhoto} onClose={() => setViewPhoto(null)} />
      </div>
    </MainLayout>
  );
}
