import { useState, useMemo, useEffect, useRef } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Calendar, ChevronLeft, ChevronRight, Plus, MapPin, Clock, User, UserPlus, Eye, Copy, Trash2, Edit, Filter, Repeat, Sparkles, Package, RefreshCw, X, CheckCircle2, Activity, Store, Info, ChevronsUpDown, Check, AlertTriangle, Camera, Boxes } from "lucide-react";
import { cn } from "@/lib/utils";
import AIRoutePlanner from "@/components/merch/AIRoutePlanner";
import { useMerchRoutes, useCreateMerchRoute, useUpdateMerchRoute, useDeleteMerchRoute, useDuplicateMerchRoute, useBulkDeleteMerchRoutes, useBrandChecklists, useBrandPromoters, useRouteMixPreview, useRouteProducts, useAddRouteProduct, useRemoveRouteProduct, useSyncRouteProducts, useJustifyRoute, useAssignPromoter, useTransferPromoterRoutes } from "@/hooks/use-merch-routes";
import { useSuperadmin } from "@/hooks/use-superadmin";
import { useAuth } from "@/contexts/AuthContext";
import { useBrands, useBrandPdvs, usePdvBrands } from "@/hooks/use-merchandising";
import { usePDVs } from "@/hooks/use-promotor";
import { useEmployees } from "@/hooks/use-rh";
import { toast } from "sonner";
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addMonths, subMonths, addWeeks, subWeeks, addDays, subDays, eachDayOfInterval, isSameDay, isSameMonth, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
  confirmed: 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-300',
  changed: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300',
  in_progress: 'bg-orange-500/20 text-orange-700 dark:text-orange-300',
  completed: 'bg-green-500/20 text-green-700 dark:text-green-300',
  not_done: 'bg-red-500/20 text-red-700 dark:text-red-300',
  pending_justification: 'bg-purple-500/20 text-purple-700 dark:text-purple-300',
  cancelled: 'bg-muted text-muted-foreground',
};

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Agendada', confirmed: 'Confirmada', changed: 'Alterada',
  in_progress: 'Em Andamento', completed: 'Concluída', not_done: 'Não Realizada',
  pending_justification: 'Pendente Justificativa', cancelled: 'Cancelada',
};

export default function MerchRotas() {
  const [viewMode, setViewMode] = useState<'month' | 'week' | 'day'>('day');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showCreate, setShowCreate] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState<any>(null);
  const [viewRoute, setViewRoute] = useState<any>(null);
  const [filterPromoter, setFilterPromoter] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPdv, setFilterPdv] = useState('');
  const [pdvOpen, setPdvOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [promoterOpen, setPromoterOpen] = useState(false);
  const [showAIPlanner, setShowAIPlanner] = useState(false);
  const [scopeDialog, setScopeDialog] = useState<{ action: 'edit' | 'delete'; data?: any } | null>(null);
  const [justifyRoute, setJustifyRoute] = useState<any>(null);
  const [justifyReason, setJustifyReason] = useState('');
  const justifyMutation = useJustifyRoute();
  const assignPromoterMutation = useAssignPromoter();
  const [supportRoute, setSupportRoute] = useState<any>(null);
  const [supportEmployeeId, setSupportEmployeeId] = useState('');
  const [supportReason, setSupportReason] = useState('');
  // Transferencia de rotas entre promotores (promotora que saiu)
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferFrom, setTransferFrom] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferFromDate, setTransferFromDate] = useState('');
  const [transferToDate, setTransferToDate] = useState('');
  const [transferIncludeCompleted, setTransferIncludeCompleted] = useState(false);
  const [transferReason, setTransferReason] = useState('');
  const [transferPreview, setTransferPreview] = useState<any>(null);
  const transferMutation = useTransferPromoterRoutes();
  // A API de RH nao filtra por perfil, entao separamos os promotores aqui.
  const promoterOptions = useMemo(() => {
    const arr = Array.isArray(employees) ? (employees as any[]) : [];
    const filtered = arr.filter((e: any) => e?.id && (e.worker_profile === 'promotor' || e.worker_profile === 'operacional'));
    return filtered.length > 0 ? filtered : arr.filter((e: any) => e?.id);
  }, [employees]);

  // Calculate date range
  const dateRange = useMemo(() => {
    if (viewMode === 'month') return { from: format(startOfMonth(currentDate), 'yyyy-MM-dd'), to: format(endOfMonth(currentDate), 'yyyy-MM-dd') };
    if (viewMode === 'week') return { from: format(startOfWeek(currentDate, { weekStartsOn: 1 }), 'yyyy-MM-dd'), to: format(endOfWeek(currentDate, { weekStartsOn: 1 }), 'yyyy-MM-dd') };
    return { from: format(currentDate, 'yyyy-MM-dd'), to: format(currentDate, 'yyyy-MM-dd') };
  }, [viewMode, currentDate]);

  const { data: routes = [], isLoading } = useMerchRoutes({
    date_from: dateRange.from, date_to: dateRange.to,
    promoter_id: filterPromoter || undefined,
    brand_id: filterBrand || undefined,
    status: filterStatus || undefined,
  });
  const { data: pdvs = [] } = usePDVs();
  const { data: employees = [] } = useEmployees();
  const createRoute = useCreateMerchRoute();
  const updateRoute = useUpdateMerchRoute();
  const deleteRoute = useDeleteMerchRoute();
  const duplicateRoute = useDuplicateMerchRoute();
  const bulkDelete = useBulkDeleteMerchRoutes();

  // Admin/Superadmin check for bulk maintenance
  const { checkSuperadmin } = useSuperadmin();
  const { user } = useAuth();
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState<null | { includeFuture: boolean }>(null);
  useEffect(() => {
    checkSuperadmin().then((su) => {
      const isAdmin = ['owner', 'admin'].includes((user as any)?.role || '');
      setIsSuperadmin(!!su || isAdmin);
    });
  }, [checkSuperadmin, user]);
  useEffect(() => { setSelectedIds(new Set()); }, [viewMode, currentDate, filterPromoter, filterBrand, filterStatus, filterPdv]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = (ids: string[]) => {
    setSelectedIds(prev => {
      const allSelected = ids.every(id => prev.has(id));
      const next = new Set(prev);
      if (allSelected) ids.forEach(id => next.delete(id));
      else ids.forEach(id => next.add(id));
      return next;
    });
  };

  const runBulkDelete = (includeFuture: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkDelete.mutate({ ids, include_future: includeFuture }, {
      onSuccess: (res: any) => {
        toast.success(`${res?.deleted || ids.length} rota(s) excluída(s)${includeFuture && res?.future_deleted ? ` + ${res.future_deleted} futura(s)` : ''}`);
        setSelectedIds(new Set());
        setBulkConfirm(null);
      },
      onError: () => { toast.error('Erro ao excluir em massa'); setBulkConfirm(null); },
    });
  };

  // Check if route has future siblings (recurrence)
  const hasFutureSiblings = (route: any) => {
    if (!route?.recurrence) return false;
    const rec = typeof route.recurrence === 'string' ? JSON.parse(route.recurrence) : route.recurrence;
    return rec?.type && rec.type !== 'none';
  };

  const handleSaveIntent = (data: any) => {
    // Suporte a criação em lote: promotor(es) x PDV(s)
    if (Array.isArray(data) && !selectedRoute?.id) {
      const payloads = data.map((d: any) => ({ ...d, brands: d.brands || [] }));
      let ok = 0, fail = 0;
      let done = 0;
      const total = payloads.length;
      payloads.forEach((p) => {
        createRoute.mutate(p, {
          onSuccess: () => { ok++; },
          onError: () => { fail++; },
          onSettled: () => {
            done++;
            if (done === total) {
              if (fail === 0) toast.success(`${ok} rota(s) criada(s)`);
              else toast.warning(`${ok} criada(s), ${fail} com erro`);
              setShowCreate(false);
              setSelectedRoute(null);
            }
          },
        });
      });
      return;
    }

    // Garantir que as marcas estejam no payload
    const finalData = {
      ...data,
      brands: data.brands || []
    };
    
    console.log("Saving route data:", finalData);
    
    if (selectedRoute?.id && hasFutureSiblings(selectedRoute)) {
      setScopeDialog({ action: 'edit', data: finalData });
    } else if (selectedRoute?.id) {
      updateRoute.mutate({ id: selectedRoute.id, ...finalData }, { 
        onSuccess: () => { 
          toast.success('Rota atualizada'); 
          setSelectedRoute(null); 
          setShowCreate(false);
        } 
      });
    } else {
      createRoute.mutate(finalData, { 
        onSuccess: () => { 
          toast.success('Rota criada'); 
          setShowCreate(false); 
          setSelectedRoute(null);
        } 
      });
    }
  };

  const handleDeleteIntent = () => {
    if (selectedRoute?.id && hasFutureSiblings(selectedRoute)) {
      setScopeDialog({ action: 'delete' });
    } else if (selectedRoute?.id) {
      deleteRoute.mutate({ id: selectedRoute.id }, { onSuccess: () => { toast.success('Rota excluída'); setSelectedRoute(null); } });
    }
  };

  const executeScopeAction = (scope: 'single' | 'future') => {
    if (!selectedRoute?.id) return;
    const routeId = selectedRoute.id;
    const action = scopeDialog?.action;
    const editData = scopeDialog?.data;
    // Close dialog immediately so it doesn't stay open regardless of mutation outcome
    setScopeDialog(null);
    if (action === 'delete') {
      deleteRoute.mutate({ id: routeId, scope }, {
        onSuccess: () => { toast.success(scope === 'future' ? 'Rotas futuras excluídas' : 'Rota excluída'); setSelectedRoute(null); },
        onError: () => { toast.error('Erro ao excluir rota'); },
      });
    } else if (action === 'edit' && editData) {
      updateRoute.mutate({ id: routeId, ...editData, _scope: scope }, {
        onSuccess: () => { toast.success(scope === 'future' ? 'Rotas futuras atualizadas' : 'Rota atualizada'); setSelectedRoute(null); },
        onError: () => { toast.error('Erro ao atualizar rota'); },
      });
    }
  };

  const navigate = (dir: 'prev' | 'next') => {
    if (viewMode === 'month') setCurrentDate(dir === 'next' ? addMonths(currentDate, 1) : subMonths(currentDate, 1));
    else if (viewMode === 'week') setCurrentDate(dir === 'next' ? addWeeks(currentDate, 1) : subWeeks(currentDate, 1));
    else setCurrentDate(dir === 'next' ? addDays(currentDate, 1) : subDays(currentDate, 1));
  };

  const calendarDays = useMemo(() => {
    if (viewMode === 'month') {
      const start = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
      const end = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });
      return eachDayOfInterval({ start, end });
    }
    if (viewMode === 'week') {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      const end = endOfWeek(currentDate, { weekStartsOn: 1 });
      return eachDayOfInterval({ start, end });
    }
    return [currentDate];
  }, [viewMode, currentDate]);

  const routesByDay = useMemo(() => {
    const map: Record<string, any[]> = {};
    const filtered = filterPdv ? routes.filter((r: any) => r.pdv_id === filterPdv) : routes;
    filtered.forEach((r: any) => {
      const key = r.visit_date?.split('T')[0] || r.visit_date;
      if (!map[key]) map[key] = [];
      map[key].push(r);
    });
    return map;
  }, [routes, filterPdv]);

  const headerLabel = viewMode === 'month'
    ? format(currentDate, 'MMMM yyyy', { locale: ptBR })
    : viewMode === 'week'
    ? `${format(startOfWeek(currentDate, { weekStartsOn: 1 }), 'dd/MM')} - ${format(endOfWeek(currentDate, { weekStartsOn: 1 }), 'dd/MM/yyyy')}`
    : format(currentDate, "EEEE, dd 'de' MMMM", { locale: ptBR });

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" /> Rotas & Agenda
            </h1>
            <p className="text-sm text-muted-foreground">Planejamento e acompanhamento de visitas</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowAIPlanner(true)} className="border-primary/30 text-primary hover:bg-primary/10">
              <Sparkles className="h-4 w-4 mr-1" /> Planejamento IA
            </Button>
            {isSuperadmin && (
              <Button variant="outline" size="sm" onClick={() => { setTransferOpen(true); setTransferPreview(null); }}>
                <UserPlus className="h-4 w-4 mr-1" /> Transferir rotas
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)}>
              <Filter className="h-4 w-4 mr-1" /> Filtros
            </Button>
            <Button size="sm" onClick={() => { setShowCreate(true); setSelectedRoute(null); }}>
              <Plus className="h-4 w-4 mr-1" /> Nova Rota
            </Button>
          </div>
        </div>

        {/* Promoter Search - always visible */}
        <div className="flex flex-wrap items-center gap-3">
          <Popover open={promoterOpen} onOpenChange={setPromoterOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" aria-expanded={promoterOpen} className="w-[280px] justify-between">
                <span className="truncate">
                  {filterPromoter
                    ? employees.find((e: any) => e.id === filterPromoter)?.full_name || 'Promotor'
                    : 'Buscar promotor...'}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-0" align="start">
              <Command>
                <CommandInput placeholder="Digite o nome do promotor..." />
                <CommandList>
                  <CommandEmpty>Nenhum promotor encontrado.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem value="__all__" onSelect={() => { setFilterPromoter(''); setPromoterOpen(false); }}>
                      <Check className={cn("mr-2 h-4 w-4", !filterPromoter ? "opacity-100" : "opacity-0")} />
                      Todos os promotores
                    </CommandItem>
                    {employees.filter((e: any) => e?.id).map((e: any) => (
                      <CommandItem key={e.id} value={e.full_name} onSelect={() => { setFilterPromoter(e.id); setPromoterOpen(false); }}>
                        <Check className={cn("mr-2 h-4 w-4", filterPromoter === e.id ? "opacity-100" : "opacity-0")} />
                        {e.full_name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {filterPromoter && (
            <Button variant="ghost" size="sm" onClick={() => setFilterPromoter('')} className="h-8 px-2 text-muted-foreground">
              <X className="h-3 w-3 mr-1" /> Limpar
            </Button>
          )}

          <Popover open={pdvOpen} onOpenChange={setPdvOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" aria-expanded={pdvOpen} className="w-[280px] justify-between">
                <span className="truncate">
                  {filterPdv
                    ? pdvs.find((p: any) => p.id === filterPdv)?.name || 'PDV'
                    : 'Buscar PDV...'}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[320px] p-0" align="start">
              <Command>
                <CommandInput placeholder="Digite nome, cidade, código..." />
                <CommandList>
                  <CommandEmpty>Nenhum PDV encontrado.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem value="__all__" onSelect={() => { setFilterPdv(''); setPdvOpen(false); }}>
                      <Check className={cn("mr-2 h-4 w-4", !filterPdv ? "opacity-100" : "opacity-0")} />
                      Todos os PDVs
                    </CommandItem>
                    {pdvs.filter((p: any) => p?.id).map((p: any) => (
                      <CommandItem
                        key={p.id}
                        value={`${p.name || ''} ${p.city || ''} ${p.state || ''} ${p.internal_code || ''} ${p.cnpj || ''}`}
                        onSelect={() => { setFilterPdv(p.id); setPdvOpen(false); }}
                      >
                        <Check className={cn("mr-2 h-4 w-4", filterPdv === p.id ? "opacity-100" : "opacity-0")} />
                        <div className="flex flex-col min-w-0">
                          <span className="truncate">{p.name}</span>
                          <span className="text-[10px] text-muted-foreground truncate">{[p.city, p.state].filter(Boolean).join(' - ')}</span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {filterPdv && (
            <Button variant="ghost" size="sm" onClick={() => setFilterPdv('')} className="h-8 px-2 text-muted-foreground">
              <X className="h-3 w-3 mr-1" /> Limpar
            </Button>
          )}
        </div>

        {/* Additional Filters */}
        {showFilters && (
          <Card>
            <CardContent className="p-3 flex flex-wrap gap-3">
              <Select value={filterStatus || "__all__"} onValueChange={(v) => setFilterStatus(v === "__all__" ? "" : v)}>
                <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  {Object.entries(STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        )}

        {/* Calendar Navigation */}
        <Card>
          <CardHeader className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" onClick={() => navigate('prev')}><ChevronLeft className="h-4 w-4" /></Button>
                <span className="text-sm font-semibold capitalize min-w-[180px] text-center">{headerLabel}</span>
                <Button variant="ghost" size="icon" onClick={() => navigate('next')}><ChevronRight className="h-4 w-4" /></Button>
                <Button variant="outline" size="sm" onClick={() => setCurrentDate(new Date())}>Hoje</Button>
              </div>
              <div className="flex bg-muted rounded-lg p-0.5">
                {(['month', 'week', 'day'] as const).map(m => (
                  <button key={m} onClick={() => setViewMode(m)}
                    className={`px-3 py-1 text-xs rounded-md transition-colors ${viewMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                    {m === 'month' ? 'Mês' : m === 'week' ? 'Semana' : 'Dia'}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-2">
            {/* Weekday headers */}
            {viewMode !== 'day' && (
              <div className="grid grid-cols-7 gap-1 mb-1">
                {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map(d => (
                  <div key={d} className="text-center text-[10px] font-medium text-muted-foreground py-1">{d}</div>
                ))}
              </div>
            )}

            {/* Calendar grid */}
            <div className={viewMode === 'day' ? '' : 'grid grid-cols-7 gap-1'}>
              {calendarDays.map(day => {
                const dayStr = format(day, 'yyyy-MM-dd');
                const dayRoutes = routesByDay[dayStr] || [];
                const isToday = isSameDay(day, new Date());
                const isCurrentMonth = isSameMonth(day, currentDate);

                if (viewMode === 'day') {
                  const dayIds = dayRoutes.map((r: any) => r.id);
                  const allSelected = dayIds.length > 0 && dayIds.every(id => selectedIds.has(id));
                  return (
                    <div key={dayStr} className="space-y-2">
                      {isSuperadmin && dayRoutes.length > 0 && (
                        <div className="flex items-center justify-between rounded-lg border border-dashed bg-muted/30 px-3 py-2">
                          <label className="flex items-center gap-2 text-xs cursor-pointer">
                            <Checkbox checked={allSelected} onCheckedChange={() => toggleSelectAll(dayIds)} />
                            <span className="font-medium">Manutenção (superadmin) — selecionar todas</span>
                          </label>
                          {selectedIds.size > 0 && (
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary">{selectedIds.size} selecionada(s)</Badge>
                              <Button size="sm" variant="outline" onClick={() => setBulkConfirm({ includeFuture: false })}>
                                <Trash2 className="h-3 w-3 mr-1" /> Apagar selecionadas
                              </Button>
                              <Button size="sm" variant="destructive" onClick={() => setBulkConfirm({ includeFuture: true })}>
                                <Trash2 className="h-3 w-3 mr-1" /> Apagar selecionadas + futuras
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                      {dayRoutes.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-8">Nenhuma rota para este dia</p>
                      ) : dayRoutes.map((r: any) => (
                        <Card key={r.id} className={cn("hover:border-primary/50 transition-colors", selectedIds.has(r.id) && "border-primary ring-1 ring-primary/30")}>
                          <CardContent className="p-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                {isSuperadmin && (
                                  <Checkbox
                                    checked={selectedIds.has(r.id)}
                                    onCheckedChange={() => toggleSelect(r.id)}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                )}
                                <div className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer" onClick={() => setViewRoute(r)}>
                                  <div className="text-sm font-mono font-medium">{r.scheduled_time?.slice(0, 5) || '--:--'}</div>
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold truncate flex items-center gap-1.5">
                                      {r.pdv_name}
                                      {r.has_stock_count && (
                                        <Badge variant="outline" className="border-amber-500/50 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 gap-1 px-1.5 py-0 h-4 text-[9px]">
                                          <Boxes className="h-2.5 w-2.5" /> Saldo
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                                      <span className="flex items-center gap-1"><User className="h-3 w-3" />{r.promoter_name}</span>
                                      <span>•</span>
                                      <span>{r.brand_name}</span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 cursor-pointer" onClick={() => setViewRoute(r)}>
                                {r.progress_pct > 0 && <span className="text-xs font-mono">{Math.round(r.progress_pct)}%</span>}
                                {(r.has_alert || r.not_done_reason) && (
                                  <span title={r.not_done_reason || 'Alerta'}>
                                    <AlertTriangle className="h-4 w-4 text-red-600" />
                                  </span>
                                )}
                                <Badge className={STATUS_COLORS[r.status] || 'bg-muted'}>{STATUS_LABELS[r.status] || r.status}</Badge>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  );
                }


                const hasStock = dayRoutes.some((r: any) => r.has_stock_count);
                return (
                  <div key={dayStr}
                    onClick={() => { setCurrentDate(day); if (viewMode === 'month') setViewMode('day'); }}
                    className={`min-h-[80px] p-1 rounded-lg border cursor-pointer transition-colors relative
                      ${isToday ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-muted/30'}
                      ${hasStock && !isToday ? 'ring-1 ring-amber-500/50 bg-amber-50/40 dark:bg-amber-950/10' : ''}
                      ${!isCurrentMonth && viewMode === 'month' ? 'opacity-40' : ''}`}>
                    {hasStock && (
                      <Boxes className="h-3 w-3 absolute top-1 right-1 text-amber-600" />
                    )}
                    <div className="text-xs font-medium mb-0.5">
                      {format(day, 'd')}
                      {dayRoutes.length > 0 && <Badge variant="secondary" className="ml-1 text-[9px] h-4 px-1">{dayRoutes.length}</Badge>}
                    </div>
                    <div className="space-y-0.5">
                      {dayRoutes.slice(0, 3).map((r: any) => (
                        <div key={r.id} className={`text-[10px] px-1 py-0.5 rounded truncate flex items-center gap-1 ${STATUS_COLORS[r.status] || 'bg-muted'}`}
                          onClick={(e) => { e.stopPropagation(); setViewRoute(r); }}>
                          <span className="flex-1 truncate">{r.scheduled_time?.slice(0, 5)} {r.pdv_name}</span>
                          {r.has_stock_count && <Boxes className="h-2.5 w-2.5 text-amber-600 shrink-0" />}
                        </div>
                      ))}
                      {dayRoutes.length > 3 && <div className="text-[10px] text-muted-foreground pl-1">+{dayRoutes.length - 3} mais</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Route Detail Summary Popup */}
        <Dialog open={!!viewRoute} onOpenChange={() => setViewRoute(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Store className="h-5 w-5 text-primary" />
                {viewRoute?.pdv_name}
              </DialogTitle>
            </DialogHeader>
            {viewRoute && (
              <div className="space-y-4">
                {/* Status badge */}
                <div className="flex items-center justify-between">
                  <Badge className={`${STATUS_COLORS[viewRoute.status] || 'bg-muted'}`}>
                    {STATUS_LABELS[viewRoute.status] || viewRoute.status}
                  </Badge>
                  {viewRoute.visit_date && (
                    <span className="text-xs text-muted-foreground">
                      {format(parseISO(viewRoute.visit_date.split('T')[0]), "dd/MM/yyyy")} • {viewRoute.scheduled_time?.slice(0, 5) || '--:--'}
                    </span>
                  )}
                </div>

                {viewRoute.has_stock_count && (
                  <Badge variant="outline" className="border-amber-500/60 text-amber-700 dark:text-amber-300 bg-amber-500/10 gap-1">
                    <Boxes className="h-3 w-3" /> Contagem de saldo neste dia
                  </Badge>
                )}


                {(viewRoute.has_alert || viewRoute.not_done_reason) && (
                  <Card className="border-red-500/40 bg-red-500/5">
                    <CardContent className="p-3">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5" />
                        <div className="text-sm">
                          <div className="font-semibold text-red-700 dark:text-red-300">Rota fechada com justificativa</div>
                          <div className="text-muted-foreground mt-1">{viewRoute.not_done_reason || 'Sem detalhes'}</div>
                          {viewRoute.not_done_at && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {format(parseISO(viewRoute.not_done_at), "dd/MM/yyyy HH:mm")}
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="text-[10px] text-muted-foreground">Promotor</div>
                      <div className="font-medium truncate">{viewRoute.promoter_name || '—'}</div>
                      {Array.isArray(viewRoute.co_promoters) && viewRoute.co_promoters.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {viewRoute.co_promoters.map((cp: any) => (
                            <Badge key={cp.employee_id} variant="secondary" className="text-[9px] gap-1 pr-1">
                              <UserPlus className="h-2.5 w-2.5" />
                              {cp.employee_name || cp.employee_id}
                              <button
                                type="button"
                                className="ml-0.5 rounded hover:bg-muted-foreground/20 p-0.5"
                                title="Remover apoio"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!confirm(`Remover ${cp.employee_name} como apoio?`)) return;
                                  assignPromoterMutation.mutate(
                                    { routeId: viewRoute.id, employee_id: cp.employee_id, action: 'remove', reason: 'Removido pela supervisão' } as any,
                                    { onSuccess: () => { toast.success('Apoio removido'); setViewRoute({ ...viewRoute, co_promoters: viewRoute.co_promoters.filter((x: any) => x.employee_id !== cp.employee_id) }); } }
                                  );
                                }}
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-[10px] text-muted-foreground">Marca</div>
                      <div className="font-medium">
                        {viewRoute.is_multi_brand
                          ? `${viewRoute.route_brands?.length || 0} marcas`
                          : (viewRoute.brand_name || '—')}
                      </div>
                    </div>
                  </div>
                  {/* Multi-brand list */}
                  {viewRoute.is_multi_brand && viewRoute.route_brands?.length > 0 && (
                    <div className="col-span-2 space-y-1">
                      <div className="text-[10px] text-muted-foreground font-medium">Marcas da rota</div>
                      {viewRoute.route_brands.map((rb: any) => {
                        const pct = Math.round(Number(rb.progress_pct || 0));
                        const photos = Number(rb.photos_count || 0);
                        const routeDone = viewRoute.status === 'completed';
                        const effectiveStatus = pct >= 100 || rb.status === 'completed' || (routeDone && pct >= 100)
                          ? 'completed'
                          : (pct > 0 || rb.status === 'in_progress' ? 'in_progress' : 'pending');
                        const label = effectiveStatus === 'completed'
                          ? 'Concluída'
                          : effectiveStatus === 'in_progress' ? 'Em andamento' : 'Pendente';
                        const icon = effectiveStatus === 'completed' ? '✅' : effectiveStatus === 'in_progress' ? '🔄' : '⏳';
                        return (
                          <div key={rb.id || rb.brand_id} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/30">
                            <span className="font-medium truncate">{rb.brand_name || rb.brand_id}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] font-mono tabular-nums">{pct}%</span>
                              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                                <Camera className="h-3 w-3" />{photos}
                              </span>
                              <Badge variant="outline" className="text-[9px] h-4">
                                {icon} {label}
                              </Badge>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {!viewRoute.is_multi_brand && viewRoute.checklist_name && (
                    <div className="flex items-center gap-2 col-span-2">
                      <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-[10px] text-muted-foreground">Checklist</div>
                        <div className="font-medium">{viewRoute.checklist_name}</div>
                      </div>
                    </div>
                  )}
                  {viewRoute.pdv_city && (
                    <div className="flex items-center gap-2 col-span-2">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{viewRoute.pdv_city}</span>
                    </div>
                  )}
                </div>

                {/* Execution progress */}
                {(viewRoute.status === 'in_progress' || viewRoute.status === 'completed') && (
                  <Card className={viewRoute.status === 'in_progress' ? 'border-orange-500/30 bg-orange-500/5' : 'border-green-500/30 bg-green-500/5'}>
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5">
                          <Activity className="h-4 w-4" />
                          {viewRoute.status === 'in_progress' ? 'Em execução' : 'Execução concluída'}
                        </span>
                        <span className="font-mono font-bold">{Math.round(viewRoute.progress_pct || 0)}%</span>
                      </div>
                      <Progress value={viewRoute.progress_pct || 0} className="h-2" />
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>Produtos: {viewRoute.completed_products || 0}/{viewRoute.total_products || 0}</span>
                        {viewRoute.checkin_at && (
                          <span>Check-in: {new Date(viewRoute.checkin_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                        )}
                        {viewRoute.completed_at && (
                          <span>Concluída: {new Date(viewRoute.completed_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Notes */}
                {viewRoute.notes && (
                  <div className="text-xs text-muted-foreground bg-muted/30 p-2 rounded-md">{viewRoute.notes}</div>
                )}

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2 pt-2">
                  {(() => {
                    const locked = viewRoute.status === 'in_progress' || viewRoute.status === 'completed';
                    return (
                      <Button
                        size="sm"
                        className="flex-1 min-w-[120px]"
                        title={locked ? 'Rota em execução: apenas reatribuição de promotor/supervisor e observações' : ''}
                        onClick={() => {
                          if (locked) {
                            toast.info('Rota em execução: você só pode reatribuir promotor/supervisor ou editar observações. Mudanças de PDV, marca, checklist ou horário estão bloqueadas.');
                          }
                          setSelectedRoute(viewRoute);
                          setViewRoute(null);
                        }}
                      >
                        <Edit className="h-4 w-4 mr-1" /> {locked ? 'Editar (restrito)' : 'Editar'}
                      </Button>
                    );
                  })()}
                  {['scheduled', 'confirmed', 'in_progress'].includes(viewRoute.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-500/40 text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10"
                      onClick={() => {
                        setJustifyRoute(viewRoute);
                        setJustifyReason('');
                        setViewRoute(null);
                      }}
                    >
                      <AlertTriangle className="h-4 w-4 mr-1" /> Justificar
                    </Button>
                  )}
                  {viewRoute.status !== 'completed' && viewRoute.status !== 'not_done' && viewRoute.status !== 'cancelled' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-blue-500/40 text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/10"
                      onClick={() => {
                        setSupportRoute(viewRoute);
                        setSupportEmployeeId('');
                        setSupportReason('');
                        setViewRoute(null);
                      }}
                    >
                      <UserPlus className="h-4 w-4 mr-1" /> Adicionar apoio
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => {
                    duplicateRoute.mutate({ id: viewRoute.id }, {
                      onSuccess: () => { toast.success('Rota duplicada'); setViewRoute(null); }
                    });
                  }}>
                    <Copy className="h-4 w-4 mr-1" /> Duplicar
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => {
                    setSelectedRoute(viewRoute);
                    setViewRoute(null);
                    setTimeout(() => handleDeleteIntent(), 100);
                  }}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>


        {/* Route Detail / Edit Dialog */}
        <RouteFormDialog
          open={showCreate || !!selectedRoute}
          route={selectedRoute}
          onClose={() => { setShowCreate(false); setSelectedRoute(null); }}
          pdvs={pdvs}
          employees={employees}
          onSave={handleSaveIntent}
          onDelete={selectedRoute?.id ? handleDeleteIntent : undefined}
          onDuplicate={selectedRoute?.id ? () => {
            duplicateRoute.mutate({ id: selectedRoute.id }, { onSuccess: () => { toast.success('Rota duplicada'); setSelectedRoute(null); } });
          } : undefined}
        />

        {/* Scope Confirmation Dialog */}
        <AlertDialog open={!!scopeDialog} onOpenChange={() => setScopeDialog(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {scopeDialog?.action === 'delete' ? 'Excluir rota recorrente' : 'Editar rota recorrente'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                Esta rota faz parte de uma série recorrente. Deseja aplicar a {scopeDialog?.action === 'delete' ? 'exclusão' : 'alteração'} apenas nesta rota ou em todas as rotas futuras da série?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col sm:flex-row gap-2">
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <Button variant="outline" onClick={() => executeScopeAction('single')}>
                Apenas esta rota
              </Button>
              <Button variant={scopeDialog?.action === 'delete' ? 'destructive' : 'default'} onClick={() => executeScopeAction('future')}>
                Esta e todas futuras
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Bulk delete confirm (superadmin) */}
        <AlertDialog open={!!bulkConfirm} onOpenChange={(o) => !o && setBulkConfirm(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirmar exclusão em massa</AlertDialogTitle>
              <AlertDialogDescription>
                {bulkConfirm?.includeFuture
                  ? `Serão excluídas as ${selectedIds.size} rota(s) selecionada(s) e TODAS as rotas futuras agendadas/confirmadas com o mesmo promotor, PDV e marca. Esta ação não pode ser desfeita.`
                  : `Serão excluídas as ${selectedIds.size} rota(s) selecionada(s). Esta ação não pode ser desfeita.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col sm:flex-row gap-2">
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <Button variant="destructive" disabled={bulkDelete.isPending} onClick={() => runBulkDelete(!!bulkConfirm?.includeFuture)}>
                {bulkDelete.isPending ? 'Excluindo...' : 'Confirmar exclusão'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Transferir rotas entre promotores (admin/superadmin) */}
        <Dialog open={transferOpen} onOpenChange={(o) => { if (!o) { setTransferOpen(false); setTransferPreview(null); } }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <UserPlus className="h-5 w-5 text-primary" />
                Transferir rotas de um promotor para outro
              </DialogTitle>
              <DialogDescription>
                Use quando uma promotora sair da empresa. Todas as rotas dela no período escolhido passam a
                pertencer ao promotor de destino, com registro de auditoria e histórico de atribuição.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="transfer-from">Promotor de origem (saiu)</Label>
                  <Select value={transferFrom} onValueChange={(v) => { setTransferFrom(v); setTransferPreview(null); }}>
                    <SelectTrigger id="transfer-from">
                      <SelectValue placeholder="Selecione..." />
                    </SelectTrigger>
                    <SelectContent>
                      {promoterOptions.map((e: any) => (
                        <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="transfer-to">Promotor de destino (assume)</Label>
                  <Select value={transferTo} onValueChange={(v) => { setTransferTo(v); setTransferPreview(null); }}>
                    <SelectTrigger id="transfer-to">
                      <SelectValue placeholder="Selecione..." />
                    </SelectTrigger>
                    <SelectContent>
                      {promoterOptions.filter((e: any) => e.id !== transferFrom).map((e: any) => (
                        <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="transfer-from-date">De (data inicial)</Label>
                  <Input id="transfer-from-date" type="date" value={transferFromDate} onChange={(e) => { setTransferFromDate(e.target.value); setTransferPreview(null); }} />
                  <p className="text-[11px] text-muted-foreground">Vazio = a partir de hoje</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="transfer-to-date">Até (data final)</Label>
                  <Input id="transfer-to-date" type="date" value={transferToDate} onChange={(e) => { setTransferToDate(e.target.value); setTransferPreview(null); }} />
                  <p className="text-[11px] text-muted-foreground">Vazio = sem limite</p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={transferIncludeCompleted}
                  onCheckedChange={(c) => { setTransferIncludeCompleted(!!c); setTransferPreview(null); }}
                />
                Incluir rotas já concluídas
              </label>
              <div className="space-y-1.5">
                <Label htmlFor="transfer-reason">Motivo (opcional)</Label>
                <Input
                  id="transfer-reason"
                  value={transferReason}
                  onChange={(e) => setTransferReason(e.target.value)}
                  placeholder="Ex.: saída da promotora"
                />
              </div>
              {transferPreview && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
                  <div className="font-medium">
                    {transferPreview.total} rota(s) serão transferidas
                  </div>
                  {Object.entries(transferPreview.by_status || {}).map(([st, n]: any) => (
                    <div key={st} className="text-xs text-muted-foreground">
                      {STATUS_LABELS[st] || st}: {n}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => { setTransferOpen(false); setTransferPreview(null); }}>Cancelar</Button>
              <Button
                variant="outline"
                disabled={!transferFrom || !transferTo || transferMutation.isPending}
                onClick={() => {
                  transferMutation.mutate({
                    from_promoter_id: transferFrom,
                    to_promoter_id: transferTo,
                    from_date: transferFromDate || undefined,
                    to_date: transferToDate || undefined,
                    include_completed: transferIncludeCompleted,
                    preview: true,
                  } as any, {
                    onSuccess: (res: any) => setTransferPreview(res),
                    onError: (e: any) => toast.error(e?.message || 'Erro ao simular a transferência'),
                  });
                }}
              >
                Simular
              </Button>
              <Button
                disabled={!transferFrom || !transferTo || transferMutation.isPending}
                onClick={() => {
                  transferMutation.mutate({
                    from_promoter_id: transferFrom,
                    to_promoter_id: transferTo,
                    from_date: transferFromDate || undefined,
                    to_date: transferToDate || undefined,
                    include_completed: transferIncludeCompleted,
                    reason: transferReason.trim() || undefined,
                  } as any, {
                    onSuccess: (res: any) => {
                      toast.success(`${res?.transferred || 0} rota(s) transferida(s) para o novo promotor`);
                      setTransferOpen(false);
                      setTransferPreview(null);
                      setTransferFrom('');
                      setTransferTo('');
                      setTransferReason('');
                    },
                    onError: (e: any) => toast.error(e?.message || 'Erro ao transferir rotas'),
                  });
                }}
              >
                {transferMutation.isPending ? 'Transferindo...' : 'Transferir rotas'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Add Support Promoter Dialog */}
        <Dialog open={!!supportRoute} onOpenChange={(o) => { if (!o) { setSupportRoute(null); setSupportEmployeeId(''); setSupportReason(''); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <UserPlus className="h-5 w-5 text-blue-600" />
                Adicionar promotor de apoio
              </DialogTitle>
              <DialogDescription>
                O promotor selecionado poderá abrir esta rota no app junto com o titular e executar itens do checklist. Cada ação fica registrada com o autor real.
              </DialogDescription>
            </DialogHeader>
            {supportRoute && (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
                  <div><b>PDV:</b> {supportRoute.pdv_name}</div>
                  <div><b>Titular:</b> {supportRoute.promoter_name || '—'}</div>
                  <div><b>Data:</b> {supportRoute.visit_date ? format(parseISO(supportRoute.visit_date.split('T')[0]), 'dd/MM/yyyy') : '—'}</div>
                </div>
                <div>
                  <Label className="text-xs">Promotor de apoio *</Label>
                  <Select value={supportEmployeeId} onValueChange={setSupportEmployeeId}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione um promotor" /></SelectTrigger>
                    <SelectContent>
                      {employees
                        .filter((e: any) => e.id !== supportRoute.promoter_id && !(supportRoute.co_promoters || []).some((c: any) => c.employee_id === e.id))
                        .map((e: any) => (
                          <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Motivo (opcional)</Label>
                  <Textarea
                    value={supportReason}
                    onChange={(e) => setSupportReason(e.target.value)}
                    placeholder="Ex.: Apoio para PDV com alto volume; treinamento; cobertura de férias..."
                    className="mt-1 min-h-[80px]"
                  />
                </div>
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => { setSupportRoute(null); setSupportEmployeeId(''); setSupportReason(''); }}>Cancelar</Button>
              <Button
                disabled={assignPromoterMutation.isPending || !supportEmployeeId}
                onClick={() => {
                  if (!supportRoute?.id || !supportEmployeeId) return;
                  assignPromoterMutation.mutate(
                    { routeId: supportRoute.id, employee_id: supportEmployeeId, action: 'add', reason: supportReason.trim() || 'Apoio adicionado pela supervisão' } as any,
                    {
                      onSuccess: () => {
                        toast.success('Promotor de apoio adicionado');
                        setSupportRoute(null);
                        setSupportEmployeeId('');
                        setSupportReason('');
                      },
                      onError: (e: any) => toast.error(e?.message || 'Falha ao adicionar apoio'),
                    }
                  );
                }}
              >
                {assignPromoterMutation.isPending ? 'Adicionando...' : 'Adicionar apoio'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Justify Route Dialog */}
        <Dialog open={!!justifyRoute} onOpenChange={(o) => { if (!o) { setJustifyRoute(null); setJustifyReason(''); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-5 w-5 text-red-600" />
                Justificar rota não realizada
              </DialogTitle>
              <DialogDescription>
                A rota será fechada com status <b>Não Realizada</b> e ficará registrada com o motivo abaixo. Isso libera o promotor de justificar posteriormente e mantém o histórico da ocorrência para relatórios.
              </DialogDescription>
            </DialogHeader>
            {justifyRoute && (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
                  <div><b>PDV:</b> {justifyRoute.pdv_name}</div>
                  <div><b>Promotor:</b> {justifyRoute.promoter_name || '—'}</div>
                  <div><b>Data:</b> {justifyRoute.visit_date ? format(parseISO(justifyRoute.visit_date.split('T')[0]), 'dd/MM/yyyy') : '—'}</div>
                </div>
                <div>
                  <Label className="text-xs">Motivo *</Label>
                  <Textarea
                    value={justifyReason}
                    onChange={(e) => setJustifyReason(e.target.value)}
                    placeholder="Ex.: Promotor faltou por atestado; PDV fechado; alteração de escala; etc."
                    className="mt-1 min-h-[100px]"
                    autoFocus
                  />
                </div>
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => { setJustifyRoute(null); setJustifyReason(''); }}>Cancelar</Button>
              <Button
                variant="destructive"
                disabled={justifyMutation.isPending || !justifyReason.trim()}
                onClick={() => {
                  if (!justifyRoute?.id || !justifyReason.trim()) return;
                  justifyMutation.mutate(
                    { id: justifyRoute.id, reason: justifyReason.trim() },
                    {
                      onSuccess: () => {
                        toast.success('Rota justificada e fechada como não realizada');
                        setJustifyRoute(null);
                        setJustifyReason('');
                      },
                      onError: (e: any) => toast.error(e?.message || 'Erro ao justificar rota'),
                    }
                  );
                }}
              >
                {justifyMutation.isPending ? 'Salvando...' : 'Confirmar justificativa'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* AI Route Planner */}
        <AIRoutePlanner open={showAIPlanner} onClose={() => setShowAIPlanner(false)} />



      </div>
    </MainLayout>
  );
}

// Route Form Dialog
function RouteFormDialog({ open, route, onClose, pdvs, employees, onSave, onDelete, onDuplicate }: any) {
  const [form, setForm] = useState<any>({});
  const [multiBrands, setMultiBrands] = useState<{ brand_id: string; checklist_id?: string; weekdays?: number[]; checklists?: { checklist_id: string; weekdays: number[] }[] }[]>([]);
  const [configuringBrandId, setConfiguringBrandId] = useState<string | null>(null);
  const [pdvOpen, setPdvOpen] = useState(false);
  const [promotersOpen, setPromotersOpen] = useState(false);
  const [pdvSearch, setPdvSearch] = useState('');
  const [promoterSearch, setPromoterSearch] = useState('');
  // Multi-select (usado apenas na criação): permite escolher vários promotores e PDVs para gerar rotas em lote
  const [promoterIds, setPromoterIds] = useState<string[]>([]);
  const [pdvIds, setPdvIds] = useState<string[]>([]);
  const isCreating = !route;
  const { data: brands = [] } = useBrands();
  // Em criação, usa todos os PDVs selecionados para buscar a união das marcas vinculadas
  const selectedPdvIds = isCreating ? pdvIds : (form.pdv_id ? [form.pdv_id] : []);
  const { data: pdvBrands = [] } = usePdvBrands(selectedPdvIds);
  const primaryPdvId = selectedPdvIds[0] || '';
  
  // Use currently configuring brand, or first brand, or form brand
  const activeBrandId = configuringBrandId || (multiBrands.length > 0 ? multiBrands[0].brand_id : form.brand_id);
  const { data: checklists = [] } = useBrandChecklists(activeBrandId);
  const { data: brandPromoters = [] } = useBrandPromoters(activeBrandId);

  const { data: mixPreview = [] } = useRouteMixPreview(primaryPdvId, activeBrandId);
  const { data: routeProducts = [] } = useRouteProducts(route?.id);
  const addProduct = useAddRouteProduct();
  const removeProduct = useRemoveRouteProduct();
  const syncProducts = useSyncRouteProducts();

  // Sort employees: brand-linked promoters first
  const sortedEmployees = useMemo(() => {
    if (!employees?.length) return [];
    const linkedIds = new Set(brandPromoters.map((bp: any) => bp.employee_id));
    return [...employees].sort((a: any, b: any) => {
      const aLinked = linkedIds.has(a.id) ? 0 : 1;
      const bLinked = linkedIds.has(b.id) ? 0 : 1;
      return aLinked - bLinked;
    });
  }, [employees, brandPromoters]);

  const displayProducts = route?.id ? routeProducts : mixPreview;
  const routeProductIds = new Set(routeProducts.map((p: any) => p.product_id));
  const WEEKDAY_LABELS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

  // Múltiplos checklists por marca, cada um com sua própria recorrência de dias
  const BrandChecklistsEditor = ({
    brandId,
    entries,
    onChange,
    showWeekdays,
  }: {
    brandId: string;
    entries: { checklist_id: string; weekdays: number[] }[];
    onChange: (v: { checklist_id: string; weekdays: number[] }[]) => void;
    showWeekdays: boolean;
  }) => {
    const { data: cls = [] } = useBrandChecklists(brandId);
    const brandName = brands.find((b: any) => b.id === brandId)?.name || brandId;
    const available = cls.filter((c: any) => c?.id);

    const update = (idx: number, patch: Partial<{ checklist_id: string; weekdays: number[] }>) =>
      onChange(entries.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

    if (available.length === 0) {
      return (
        <div className="text-[10px] p-2 bg-muted/20 rounded border border-dashed text-center">
          Nenhum checklist disponível para {brandName}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Checklists da Marca</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] text-primary hover:bg-primary/10"
            onClick={() => onChange([...entries, { checklist_id: '', weekdays: [] }])}
          >
            + Adicionar checklist
          </Button>
        </div>

        {entries.length === 0 && (
          <div className="text-[10px] p-2 bg-muted/20 rounded border border-dashed text-center">
            Nenhum checklist adicionado — clique em "+ Adicionar checklist"
          </div>
        )}

        {entries.map((entry, idx) => (
          <div key={idx} className="rounded-md border bg-muted/10 p-2 space-y-2">
            <div className="flex items-center gap-2">
              <Select
                value={entry.checklist_id || '__none__'}
                onValueChange={(v) => update(idx, { checklist_id: v === '__none__' ? '' : v })}
              >
                <SelectTrigger className="h-8 text-xs flex-1">
                  <SelectValue placeholder="Selecione o checklist" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sem checklist (apenas instrução)</SelectItem>
                  {available.map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                onClick={() => onChange(entries.filter((_, i) => i !== idx))}
                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {showWeekdays && (
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Dias deste checklist</Label>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAY_LABELS.map((lbl, i) => {
                    const wd = i === 6 ? 0 : i + 1;
                    const active = (entry.weekdays || []).includes(wd);
                    return (
                      <button
                        key={wd}
                        type="button"
                        onClick={() => {
                          const cur = entry.weekdays || [];
                          update(idx, { weekdays: cur.includes(wd) ? cur.filter(d => d !== wd) : [...cur, wd] });
                        }}
                        className={cn(
                          'h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors',
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background text-muted-foreground border-border hover:bg-muted'
                        )}
                      >{lbl}</button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Vazio = vale em todos os dias gerados. Ex: checklist A seg–sex, checklist B ter/qua (complementar).
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };


  useEffect(() => {
    if (open) {
      if (route) {
        console.log("Loading route for edit:", route);
        const rec = route.recurrence ? (typeof route.recurrence === 'string' ? JSON.parse(route.recurrence) : route.recurrence) : null;
        setForm({
          promoter_id: route.promoter_id, supervisor_id: route.supervisor_id,
          pdv_id: route.pdv_id, brand_id: route.brand_id, checklist_id: route.checklist_id,
          visit_date: route.visit_date?.split('T')[0], scheduled_time: route.scheduled_time?.slice(0, 5),
          window_start: route.window_start, window_end: route.window_end,
          estimated_duration_min: route.estimated_duration_min, priority: route.priority,
          visit_type: route.visit_type, notes: route.notes, status: route.status,
          recurrence_type: rec?.type || 'none',
          recurrence_interval: rec?.interval || 1,
          recurrence_until: rec?.until || '',
          recurrence_weekdays: rec?.weekdays || [],
        });
        
        // Load multi-brand data with fallbacks
        const rawBrands = route.route_brands || route.brands;
        if (Array.isArray(rawBrands) && rawBrands.length > 0) {
          setMultiBrands(rawBrands.map((rb: any) => {
            const ids: string[] = Array.isArray(rb.checklist_ids)
              ? rb.checklist_ids
              : (rb.checklist_id ? [rb.checklist_id] : []);
            return {
              brand_id: rb.brand_id || rb.id || rb,
              checklist_id: ids[0] || null,
              checklists: ids.map((id: string) => ({ checklist_id: id, weekdays: [] })),
              weekdays: Array.isArray(rb.weekdays) ? rb.weekdays : [],
            };
          }));

        } else if (route.brand_id) {
          setMultiBrands([{ 
            brand_id: route.brand_id, 
            checklist_id: route.checklist_id || null,
            weekdays: [],
          }]);
        } else {
          setMultiBrands([]);
        }
      } else {
        setForm({
          visit_date: format(new Date(), 'yyyy-MM-dd'), priority: 'normal', visit_type: 'regular',
          estimated_duration_min: 60, recurrence_type: 'none', recurrence_interval: 1,
          recurrence_weekdays: [], recurrence_until: '',
        });
        setMultiBrands([]);
        setConfiguringBrandId(null);
        setPromoterIds([]);
        setPdvIds([]);
      }
    }
  }, [route, open]);

  const handleAddMixProduct = (product: any) => {
    if (route?.id) {
      addProduct.mutate({ routeId: route.id, product_id: product.product_id, category_id: product.category_id }, {
        onSuccess: () => toast.success('Produto adicionado'),
      });
    }
  };

  const handleAddAllProducts = () => {
    if (route?.id && availableToAdd.length > 0) {
      availableToAdd.forEach((p: any) => {
        addProduct.mutate({ routeId: route.id, product_id: p.product_id, category_id: p.category_id });
      });
      toast.success(`${availableToAdd.length} produtos sendo adicionados...`);
    }
  };

  const handleRemoveProduct = (productId: string) => {
    if (route?.id) {
      removeProduct.mutate({ routeId: route.id, productId }, {
        onSuccess: () => toast.success('Produto removido'),
      });
    }
  };

  const handleSyncProducts = () => {
    if (route?.id) {
      syncProducts.mutate(route.id, {
        onSuccess: () => toast.success('Produtos sincronizados do mix'),
      });
    }
  };

  const availableToAdd = route?.id
    ? mixPreview.filter((mp: any) => !routeProductIds.has(mp.product_id))
    : [];

  const availableBrands = (brands || []).filter((b: any) => {
    if (!b?.id) return false;
    
    // Regra: Marcas inativas não devem aparecer para seleção em roteiros
    if (b.status === 'inactive') return false;
    
    // Filtro de marca por PDV
    if (selectedPdvIds.length > 0) {
      // A marca deve estar vinculada a pelo menos um dos PDVs selecionados
      const isLinkedToAnySelectedPdv = pdvBrands.some((pb: any) => pb.brand_id === b.id);
      if (!isLinkedToAnySelectedPdv) return false;
    }

    // Não permitir duplicados no formulário
    return !multiBrands.some(mb => mb.brand_id === b.id);
  });

  const handleSave = () => {
    const brandsPayload = multiBrands.map(mb => {
      const checklists = (mb.checklists && mb.checklists.length > 0)
        ? mb.checklists.filter(c => c.checklist_id).map(c => ({ checklist_id: c.checklist_id, weekdays: c.weekdays || [] }))
        : (mb.checklist_id ? [{ checklist_id: mb.checklist_id, weekdays: [] }] : []);
      return {
        brand_id: mb.brand_id,
        checklist_id: checklists[0]?.checklist_id || mb.checklist_id || null,
        checklists,
        weekdays: Array.isArray(mb.weekdays) ? mb.weekdays : [],
      };
    });


    // CRIAÇÃO EM LOTE: múltiplos promotores e/ou múltiplos PDVs
    if (isCreating) {
      if (promoterIds.length === 0 || pdvIds.length === 0 || multiBrands.length === 0) {
        toast.error('Selecione ao menos 1 promotor, 1 PDV e 1 marca');
        return;
      }
      const payloads: any[] = [];
      for (const promoter_id of promoterIds) {
        for (const pdv_id of pdvIds) {
          const p: any = {
            ...form,
            promoter_id,
            pdv_id,
            brands: brandsPayload,
          };
          if (brandsPayload.length > 0) {
            p.brand_id = brandsPayload[0].brand_id;
            p.checklist_id = brandsPayload[0].checklist_id || null;
          }
          payloads.push(p);
        }
      }
      // Se for apenas 1 combinação, envia como objeto; senão como array
      onSave(payloads.length === 1 ? payloads[0] : payloads);
      return;
    }

    // EDIÇÃO: mantém comportamento single
    if (!form.promoter_id || !form.pdv_id || multiBrands.length === 0) {
      toast.error('Preencha os campos obrigatórios (Promotor, PDV e Marcas)');
      return;
    }
    const payload: any = { ...form, brands: brandsPayload };
    if (brandsPayload.length > 0) {
      payload.brand_id = brandsPayload[0].brand_id;
      payload.checklist_id = brandsPayload[0].checklist_id || null;
    }
    onSave(payload);
  };

  const isMultiBrand = multiBrands.length > 1;

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{route ? 'Editar Rota' : 'Nova Rota'}</DialogTitle>
          {isMultiBrand && (
            <Badge className="bg-primary/20 text-primary w-fit">🏷️ Multi-marca ({multiBrands.length} marcas)</Badge>
          )}
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Promotor(es) *</Label>
              {isCreating ? (
                <Popover open={promotersOpen} onOpenChange={(o) => { setPromotersOpen(o); if (!o) setPromoterSearch(''); }}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" className="w-full justify-between">
                      <span className="truncate">
                        {promoterIds.length === 0
                          ? 'Selecione promotores'
                          : promoterIds.length === 1
                            ? (employees.find((e: any) => e.id === promoterIds[0])?.full_name || '1 promotor')
                            : `${promoterIds.length} promotores`}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[360px] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput placeholder="Buscar promotor..." value={promoterSearch} onValueChange={setPromoterSearch} />
                      <CommandList>
                        <CommandEmpty>Nenhum promotor encontrado.</CommandEmpty>
                        <CommandGroup>
                          {(sortedEmployees || [])
                            .filter((e: any) => e?.id && (e.full_name || '').toLowerCase().includes(promoterSearch.toLowerCase()))
                            .map((e: any) => {
                              const isLinked = brandPromoters.some((bp: any) => bp.employee_id === e.id);
                              const checked = promoterIds.includes(e.id);
                              return (
                                <CommandItem key={e.id} value={e.full_name} onSelect={() => {
                                  setPromoterIds(prev => prev.includes(e.id) ? prev.filter(x => x !== e.id) : [...prev, e.id]);
                                }}>
                                  <Check className={cn("mr-2 h-4 w-4", checked ? "opacity-100" : "opacity-0")} />
                                  <span>{e.full_name}{isLinked ? ' ⭐' : ''}</span>
                                </CommandItem>
                              );
                            })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              ) : (
                <Select value={form.promoter_id || ''} onValueChange={v => setForm({ ...form, promoter_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    {(sortedEmployees || []).filter((e: any) => e?.id).map((e: any) => {
                      const isLinked = brandPromoters.some((bp: any) => bp.employee_id === e.id);
                      return <SelectItem key={e.id} value={e.id}>{e.full_name}{isLinked ? ' ⭐' : ''}</SelectItem>;
                    })}
                  </SelectContent>
                </Select>
              )}
              {isCreating && promoterIds.length > 1 && (
                <p className="text-[10px] text-muted-foreground mt-1">Uma rota será criada para cada promotor selecionado.</p>
              )}
            </div>
            <div>
              <Label className="text-xs">PDV(s) *</Label>
              <Popover open={pdvOpen} onOpenChange={(o) => { setPdvOpen(o); if (!o) setPdvSearch(''); }}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" aria-expanded={pdvOpen} className="w-full justify-between">
                    <span className="truncate">
                      {isCreating
                        ? (pdvIds.length === 0
                            ? 'Selecione o(s) PDV(s)'
                            : pdvIds.length === 1
                              ? (pdvs.find((p: any) => p.id === pdvIds[0])?.name || '1 PDV')
                              : `${pdvIds.length} PDVs`)
                        : (form.pdv_id ? pdvs.find((p: any) => p.id === form.pdv_id)?.name || "PDV" : "Selecione o PDV")}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Buscar PDV..." value={pdvSearch} onValueChange={setPdvSearch} />
                    <CommandList>
                      <CommandEmpty>Nenhum PDV encontrado.</CommandEmpty>
                      <CommandGroup>
                        {(pdvs || [])
                          .filter((p: any) => (p.name || '').toLowerCase().includes(pdvSearch.toLowerCase()) || (p.city || '').toLowerCase().includes(pdvSearch.toLowerCase()))
                          .map((p: any) => {
                            const checked = isCreating ? pdvIds.includes(p.id) : form.pdv_id === p.id;
                            return (
                              <CommandItem key={p.id} value={p.name} onSelect={() => {
                                if (isCreating) {
                                  setPdvIds(prev => prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id]);
                                } else {
                                  setForm({ ...form, pdv_id: p.id });
                                  setPdvOpen(false);
                                }
                              }}>
                                <Check className={cn("mr-2 h-4 w-4", checked ? "opacity-100" : "opacity-0")} />
                                <div className="flex flex-col">
                                  <span>{p.name}</span>
                                  <span className="text-[10px] text-muted-foreground">{p.city} - {p.state}</span>
                                </div>
                              </CommandItem>
                            );
                          })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {isCreating && pdvIds.length > 1 && (
                <p className="text-[10px] text-muted-foreground mt-1">Uma rota será criada para cada PDV selecionado.</p>
              )}
            </div>
          </div>

          {isCreating && promoterIds.length * pdvIds.length > 1 && multiBrands.length > 0 && (
            <div className="flex items-center gap-2 text-[11px] p-2 rounded-md border bg-primary/5 text-primary">
              <Info className="h-3.5 w-3.5" />
              <span>
                Serão criadas <b>{promoterIds.length * pdvIds.length}</b> rotas ({promoterIds.length} promotor{promoterIds.length > 1 ? 'es' : ''} × {pdvIds.length} PDV{pdvIds.length > 1 ? 's' : ''}), cada uma com {multiBrands.length} marca{multiBrands.length > 1 ? 's' : ''}.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Data início *</Label>
              <Input type="date" value={form.visit_date || ''} onChange={e => setForm({ ...form, visit_date: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Horário</Label>
              <Input type="time" value={form.scheduled_time || ''} onChange={e => setForm({ ...form, scheduled_time: e.target.value })} />
            </div>
          </div>

          {!route && (
            <div className="space-y-2 p-3 rounded-lg border bg-muted/30">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Repeat className="h-4 w-4 text-primary" /> Recorrência
              </div>
              <Select value={form.recurrence_type || 'none'} onValueChange={v => setForm({ ...form, recurrence_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem recorrência (única)</SelectItem>
                  <SelectItem value="daily">Diária</SelectItem>
                  <SelectItem value="weekly">Semanal</SelectItem>
                  <SelectItem value="monthly">Mensal</SelectItem>
                </SelectContent>
              </Select>

              {form.recurrence_type && form.recurrence_type !== 'none' && (
                <div className="space-y-3 pt-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Intervalo</Label>
                      <Input type="number" min={1} value={form.recurrence_interval || 1} onChange={e => setForm({ ...form, recurrence_interval: parseInt(e.target.value) || 1 })} />
                    </div>
                    <div>
                      <Label className="text-xs">Até (data fim)</Label>
                      <Input type="date" value={form.recurrence_until || ''} onChange={e => setForm({ ...form, recurrence_until: e.target.value })} />
                    </div>
                  </div>
                  {form.recurrence_type === 'weekly' && (
                    <p className="text-[10px] text-muted-foreground">
                      Os dias da semana são definidos por marca, logo abaixo, ao configurar cada marca.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Package className="h-4 w-4 text-primary" /> Marcas {multiBrands.length > 0 && `(${multiBrands.length})`}
                </div>
                {!primaryPdvId && <span className="text-[10px] text-orange-500 font-medium">Selecione um PDV primeiro</span>}
                {primaryPdvId && pdvBrands.length === 0 && (
                  <span className="text-[10px] text-red-500 font-medium flex items-center gap-1">
                    <AlertTriangle className="h-2.5 w-2.5" /> Nenhuma marca vinculada a este PDV
                  </span>
                )}
              </div>
              {primaryPdvId && (
                <div className="flex items-center gap-2">
                  {pdvBrands.length === 0 && (
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-7 text-[10px] text-blue-600 hover:text-blue-700"
                      onClick={() => window.open('/merchandising/marcas', '_blank')}
                    >
                      Vincular Marcas <Eye className="ml-1 h-3 w-3" />
                    </Button>
                  )}
                  <Select value="" onValueChange={(v) => {
                    if (v) {
                    setMultiBrands(prev => [...prev, { brand_id: v }]);
                    setConfiguringBrandId(v);
                  }
                }}>
                  <SelectTrigger className="w-48 h-8 text-xs bg-background">
                    <SelectValue placeholder="+ Adicionar marca" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBrands.length > 0 ? (
                      availableBrands.map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)
                    ) : <div className="p-2 text-xs text-muted-foreground text-center">Sem marcas disponíveis</div>}
                  </SelectContent>
                </Select>
                </div>
              )}
            </div>

            {multiBrands.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-3 bg-background/50 rounded-md border border-dashed">Selecione pelo menos uma marca</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {multiBrands.map((mb) => {
                  const brand = brands.find((b: any) => b.id === mb.brand_id);
                  const isConfiguring = configuringBrandId === mb.brand_id;
                  return (
                    <div key={mb.brand_id} onClick={() => setConfiguringBrandId(mb.brand_id)}
                      className={cn("flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs cursor-pointer transition-all", isConfiguring ? "bg-primary text-primary-foreground border-primary shadow-sm" : "bg-background hover:bg-muted border-border")}>
                      <span className="font-medium">{brand?.name || mb.brand_id}</span>
                      <button onClick={(e) => { e.stopPropagation(); setMultiBrands(prev => prev.filter(b => b.brand_id !== mb.brand_id)); if (configuringBrandId === mb.brand_id) setConfiguringBrandId(null); }}
                        className={cn("p-0.5 rounded-full hover:bg-black/10", isConfiguring ? "text-primary-foreground" : "text-muted-foreground")}>
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {configuringBrandId && (
              <div className="p-3 rounded-md border bg-background space-y-4 animate-in fade-in slide-in-from-top-1 shadow-sm">
                <div className="flex items-center justify-between border-b pb-2">
                  <div className="text-xs font-semibold flex items-center gap-2 text-primary">
                    <Sparkles className="h-3 w-3" /> Configurando: {brands.find((b: any) => b.id === configuringBrandId)?.name}
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-primary hover:bg-primary/10" onClick={() => setConfiguringBrandId(null)}>
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Concluir Marca
                  </Button>
                </div>
                
                <BrandChecklistsEditor
                  brandId={configuringBrandId}
                  showWeekdays={!route && (form.recurrence_type === 'weekly' || form.recurrence_type === 'daily')}
                  entries={(() => {
                    const cfg = multiBrands.find(b => b.brand_id === configuringBrandId);
                    if (cfg?.checklists && cfg.checklists.length > 0) return cfg.checklists;
                    if (cfg?.checklist_id) return [{ checklist_id: cfg.checklist_id, weekdays: [] }];
                    return [];
                  })()}
                  onChange={(v) => setMultiBrands(prev => prev.map(b => b.brand_id === configuringBrandId
                    ? { ...b, checklists: v, checklist_id: v[0]?.checklist_id || '' }
                    : b))}
                />


                {!route && form.recurrence_type === 'weekly' && (
                  <div className="space-y-1 border-t pt-2">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Dias da semana desta marca</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKDAY_LABELS.map((lbl, idx) => {
                        const wd = idx === 6 ? 0 : idx + 1;
                        const brandCfg = multiBrands.find(b => b.brand_id === configuringBrandId);
                        const active = (brandCfg?.weekdays || []).includes(wd);
                        return (
                          <button
                            key={wd}
                            type="button"
                            onClick={() => {
                              setMultiBrands(prev => prev.map(b => {
                                if (b.brand_id !== configuringBrandId) return b;
                                const cur = b.weekdays || [];
                                return { ...b, weekdays: cur.includes(wd) ? cur.filter(d => d !== wd) : [...cur, wd] };
                              }));
                            }}
                            className={cn(
                              'h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors',
                              active
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-background text-muted-foreground border-border hover:bg-muted'
                            )}
                          >{lbl}</button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Vazio = repete no dia da data de início. Ex: Marca A seg/qua/sex, Marca B ter/qui.
                    </p>
                  </div>
                )}

                <div className="space-y-2 border-t pt-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Mix de Produtos</Label>
                    <span className="text-[10px] font-mono font-medium">{displayProducts.length} itens</span>
                  </div>
                  
                  {displayProducts.length === 0 ? (
                    <div className="text-[10px] text-muted-foreground text-center py-2 bg-muted/10 rounded border border-dashed">Sem produtos no mix</div>
                  ) : (
                    <div className="max-h-32 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                      {displayProducts.map((p: any) => (
                        <div key={p.product_id || p.id} className="flex items-center justify-between py-1 px-2 rounded bg-muted/20 text-[10px] border border-border/30">
                          <span className="truncate flex-1">{p.product_name}</span>
                          {p.mandatory && <Badge variant="secondary" className="text-[8px] h-3 px-1 ml-1 bg-orange-100 text-orange-700">Obrigatório</Badge>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>


          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Duração (min)</Label>
              <Input type="number" value={form.estimated_duration_min || 60} onChange={e => setForm({ ...form, estimated_duration_min: parseInt(e.target.value) })} />
            </div>
            <div>
              <Label className="text-xs">Prioridade</Label>
              <Select value={form.priority || 'normal'} onValueChange={v => setForm({ ...form, priority: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Baixa</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">Alta</SelectItem>
                  <SelectItem value="urgent">Urgente</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label className="text-xs">Observações</Label>
            <Textarea className="h-16 text-xs" value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Instruções para o promotor..." />
          </div>

          <DialogFooter className="flex-row gap-2 pt-2 border-t mt-4">
            <div className="flex-1">
              {onDelete && <Button variant="destructive" size="sm" onClick={onDelete}><Trash2 className="h-4 w-4 mr-2" /> Excluir</Button>}
            </div>
            <Button variant="outline" size="sm" onClick={onClose}>Cancelar</Button>
            <Button size="sm" onClick={handleSave}>Salvar Rota</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

