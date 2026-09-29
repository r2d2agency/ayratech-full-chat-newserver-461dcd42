import { useState, useEffect, useMemo, useCallback } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { formatCalendarDate } from '@/lib/date-utils';
import { ptBR } from "date-fns/locale";
import {
  Send,
  Plus,
  Calendar as CalendarIcon,
  Clock,
  Play,
  Pause,
  CheckCircle2,
  AlertCircle,
  Trash2,
  Timer,
  Users,
  MessageSquare,
  Shuffle,
  Loader2,
  Coffee,
  Settings2,
  Check,
  RefreshCw,
  Search,
  Filter,
  X,
  Tag,
  GitBranch,
  BarChart3,
  TrendingUp,
  Wifi,
  WifiOff,
  Edit,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCampaigns, Campaign, CampaignReport } from "@/hooks/use-campaigns";
import { useContacts, ContactList } from "@/hooks/use-contacts";
import { useMessages, MessageTemplate } from "@/hooks/use-messages";
import { useFlows, Flow } from "@/hooks/use-flows";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { CampaignDetailModal } from "@/components/campanhas/CampaignDetailModal";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Connection {
  id: string;
  name: string;
  status: string;
}

interface ConversationTag {
  id: string;
  name: string;
  color: string;
  conversation_count: number;
}

const statusConfig = {
  pending: { icon: CalendarIcon, label: "Agendada", color: "text-muted-foreground", bgColor: "bg-muted" },
  running: { icon: Play, label: "Em Execução", color: "text-warning", bgColor: "bg-warning/10" },
  completed: { icon: CheckCircle2, label: "Concluída", color: "text-success", bgColor: "bg-success/10" },
  paused: { icon: Pause, label: "Pausada", color: "text-destructive", bgColor: "bg-destructive/10" },
  cancelled: { icon: AlertCircle, label: "Cancelada", color: "text-muted-foreground", bgColor: "bg-muted" },
};

const Campanhas = () => {
  const { loading: loadingCampaigns, getCampaigns, createCampaign, updateStatus, deleteCampaign, getReports, updateCampaign } = useCampaigns();
  const { getLists } = useContacts();
  const { getMessages } = useMessages();
  const { getFlows } = useFlows();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [messages, setMessages] = useState<MessageTemplate[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [conversationTags, setConversationTags] = useState<ConversationTag[]>([]);

  const [activeTab, setActiveTab] = useState("list");
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  
  // Reports state
  const [reportData, setReportData] = useState<CampaignReport | null>(null);
  const [reportStartDate, setReportStartDate] = useState<Date | undefined>();
  const [reportEndDate, setReportEndDate] = useState<Date | undefined>();
  const [loadingReport, setLoadingReport] = useState(false);
  
  // Edit campaign dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [editConnection, setEditConnection] = useState("");
  const [editStartDate, setEditStartDate] = useState<Date | undefined>();
  const [editEndDate, setEditEndDate] = useState<Date | undefined>();
  const [editStartTime, setEditStartTime] = useState("08:00");
  const [editEndTime, setEditEndTime] = useState("18:00");
  
  // Auto-refresh state
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(30);
  
  // Filter state
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateFilterStart, setDateFilterStart] = useState<Date | undefined>();
  const [dateFilterEnd, setDateFilterEnd] = useState<Date | undefined>();
  const [showFilters, setShowFilters] = useState(false);
  
  // Form state - Basic
  const [campaignName, setCampaignName] = useState("");
  const [selectedConnection, setSelectedConnection] = useState("");
  const [selectedList, setSelectedList] = useState("");
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  
  // Form state - Content type (message or flow)
  const [contentType, setContentType] = useState<'message' | 'flow'>('message');
  const [selectedFlow, setSelectedFlow] = useState("");
  
  // Form state - Tag source
  const [contactSource, setContactSource] = useState<'list' | 'tag'>('list');
  const [selectedTag, setSelectedTag] = useState("");
  const [creatingListFromTag, setCreatingListFromTag] = useState(false);
  
  // Form state - Schedule
  const [startDate, setStartDate] = useState<Date>();
  const [endDate, setEndDate] = useState<Date>();
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("18:00");
  
  // Form state - Delays
  const [minDelay, setMinDelay] = useState("30");
  const [maxDelay, setMaxDelay] = useState("60");
  const [pauseAfterMessages, setPauseAfterMessages] = useState("20");
  const [pauseDuration, setPauseDuration] = useState("10");
  const [randomOrder, setRandomOrder] = useState(true);
  const [randomMessages, setRandomMessages] = useState(false);

  const loadData = useCallback(async () => {
    const results = await Promise.allSettled([
      getCampaigns(),
      getLists(),
      getMessages(),
      getFlows(),
      api<Connection[]>('/api/connections'),
      api<ConversationTag[]>('/api/chat/tags/with-count'),
    ]);

    const [campaignsRes, listsRes, messagesRes, flowsRes, connectionsRes, tagsRes] = results;

    if (campaignsRes.status === 'fulfilled') {
      setCampaigns(campaignsRes.value);
    } else {
      console.error('Erro ao carregar campanhas:', campaignsRes.reason);
      setCampaigns([]);
    }

    if (listsRes.status === 'fulfilled') {
      setLists(listsRes.value);
    } else {
      console.error('Erro ao carregar listas:', listsRes.reason);
      setLists([]);
    }

    if (messagesRes.status === 'fulfilled') {
      setMessages(messagesRes.value);
    } else {
      console.error('Erro ao carregar mensagens:', messagesRes.reason);
      setMessages([]);
    }

    if (flowsRes.status === 'fulfilled') {
      setFlows(flowsRes.value);
    } else {
      console.error('Erro ao carregar fluxos:', flowsRes.reason);
      setFlows([]);
    }

    if (connectionsRes.status === 'fulfilled') {
      setConnections(connectionsRes.value);
    } else {
      console.error('Erro ao carregar conexões:', connectionsRes.reason);
      setConnections([]);
    }

    if (tagsRes.status === 'fulfilled') {
      setConversationTags(tagsRes.value);
    } else {
      console.error('Erro ao carregar tags:', tagsRes.reason);
      setConversationTags([]);
    }
  }, [getCampaigns, getLists, getMessages, getFlows]);

  const loadReports = useCallback(async () => {
    setLoadingReport(true);
    try {
      const formatDate = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
      const data = await getReports(formatDate(reportStartDate), formatDate(reportEndDate));
      setReportData(data);
    } catch {
      toast.error("Erro ao carregar relatório");
    } finally {
      setLoadingReport(false);
    }
  }, [getReports, reportStartDate, reportEndDate]);

  const handleOpenEdit = (campaign: Campaign) => {
    setEditingCampaign(campaign);
    setEditConnection(campaign.connection_id || "");
    setEditStartDate(campaign.start_date ? new Date(campaign.start_date) : undefined);
    setEditEndDate(campaign.end_date ? new Date(campaign.end_date) : undefined);
    setEditStartTime(campaign.start_time || "08:00");
    setEditEndTime(campaign.end_time || "18:00");
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingCampaign) return;
    try {
      const formatDate = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
      await updateCampaign(editingCampaign.id, {
        connection_id: editConnection || undefined,
        start_date: formatDate(editStartDate),
        end_date: formatDate(editEndDate),
        start_time: editStartTime,
        end_time: editEndTime,
      });
      toast.success("Campanha atualizada com sucesso!");
      setEditDialogOpen(false);
      loadData();
    } catch {
      toast.error("Erro ao atualizar campanha");
    }
  };

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (activeTab === 'reports') {
      loadReports();
    }
  }, [activeTab, loadReports]);

  // Auto-refresh for campaign list
  useEffect(() => {
    if (!autoRefresh || activeTab !== 'list') return;
    
    // Check if any campaign is running/pending
    const hasActiveCampaigns = campaigns.some(c => 
      ['running', 'pending', 'paused'].includes(c.status)
    );
    
    if (!hasActiveCampaigns) return;

    const countdownInterval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          loadData();
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, [autoRefresh, activeTab, campaigns, loadData]);

  // Filtered campaigns
  const filteredCampaigns = useMemo(() => {
    return campaigns.filter(campaign => {
      // Search filter
      if (searchTerm) {
        const search = searchTerm.toLowerCase();
        const matchesName = campaign.name.toLowerCase().includes(search);
        const matchesList = campaign.list_name?.toLowerCase().includes(search);
        const matchesMessage = campaign.message_name?.toLowerCase().includes(search);
        if (!matchesName && !matchesList && !matchesMessage) return false;
      }
      
      // Status filter
      if (statusFilter !== 'all' && campaign.status !== statusFilter) {
        return false;
      }
      
      // Date filter
      if (dateFilterStart && campaign.start_date) {
        const campaignDate = new Date(campaign.start_date);
        if (campaignDate < dateFilterStart) return false;
      }
      
      if (dateFilterEnd && campaign.start_date) {
        const campaignDate = new Date(campaign.start_date);
        if (campaignDate > dateFilterEnd) return false;
      }
      
      return true;
    });
  }, [campaigns, searchTerm, statusFilter, dateFilterStart, dateFilterEnd]);

  const clearFilters = () => {
    setSearchTerm("");
    setStatusFilter("all");
    setDateFilterStart(undefined);
    setDateFilterEnd(undefined);
  };

  const hasActiveFilters = searchTerm || statusFilter !== 'all' || dateFilterStart || dateFilterEnd;

  const resetForm = () => {
    setCampaignName("");
    setSelectedConnection("");
    setSelectedList("");
    setSelectedMessages([]);
    setContentType('message');
    setSelectedFlow("");
    setContactSource('list');
    setSelectedTag("");
    setStartDate(undefined);
    setEndDate(undefined);
    setStartTime("08:00");
    setEndTime("18:00");
    setMinDelay("120");
    setMaxDelay("300");
    setPauseAfterMessages("20");
    setPauseDuration("10");
    setRandomOrder(true);
    setRandomMessages(false);
  };

  const toggleMessageSelection = (msgId: string) => {
    setSelectedMessages(prev => 
      prev.includes(msgId) 
        ? prev.filter(id => id !== msgId)
        : [...prev, msgId]
    );
  };

  // Format date for API without timezone conversion
  const formatDateForApi = (date?: Date) => {
    if (!date) return undefined;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const handleCreateCampaign = async () => {
    // Validate content selection
    const hasContent = contentType === 'flow' ? !!selectedFlow : selectedMessages.length > 0;
    
    // Validate based on contact source
    if (contactSource === 'list') {
      if (!campaignName || !selectedConnection || !selectedList || !hasContent) {
        toast.error("Preencha todos os campos obrigatórios");
        return;
      }
    } else {
      if (!campaignName || !selectedConnection || !selectedTag || !hasContent) {
        toast.error("Preencha todos os campos obrigatórios");
        return;
      }
    }

    const minDelayNum = parseInt(minDelay);
    const maxDelayNum = parseInt(maxDelay);
    
    if (minDelayNum < 5) {
      toast.error("Delay mínimo deve ser de pelo menos 5 segundos");
      return;
    }

    if (minDelayNum > maxDelayNum) {
      toast.error("Delay mínimo não pode ser maior que o máximo");
      return;
    }

    try {
      let listIdToUse = selectedList;

      // If using tag source, create list from tag first
      if (contactSource === 'tag' && selectedTag) {
        setCreatingListFromTag(true);
        try {
          const tagInfo = conversationTags.find(t => t.id === selectedTag);
          const result = await api<{ id: string; contact_count: number; message: string }>('/api/contacts/lists/from-tag', {
            method: 'POST',
            body: {
              tag_id: selectedTag,
              name: `${campaignName} - ${tagInfo?.name || 'Tag'}`,
              connection_id: selectedConnection,
            },
          });
          listIdToUse = result.id;
          toast.success(result.message);
          
          // Reload lists to show the new one
          const newLists = await getLists();
          setLists(newLists);
        } catch (tagErr: any) {
          toast.error(tagErr.message || "Erro ao criar lista a partir da tag");
          setCreatingListFromTag(false);
          return;
        }
        setCreatingListFromTag(false);
      }

      await createCampaign({
        name: campaignName,
        connection_id: selectedConnection,
        list_id: listIdToUse,
        message_ids: contentType === 'message' ? selectedMessages : [],
        flow_id: contentType === 'flow' ? selectedFlow : undefined,
        start_date: formatDateForApi(startDate),
        end_date: formatDateForApi(endDate),
        start_time: startTime,
        end_time: endTime,
        min_delay: minDelayNum,
        max_delay: maxDelayNum,
        pause_after_messages: parseInt(pauseAfterMessages),
        pause_duration: parseInt(pauseDuration),
        random_order: randomOrder,
        random_messages: randomMessages,
      });
      toast.success("Campanha criada com sucesso!");
      resetForm();
      setActiveTab("list");
      loadData();
    } catch (err) {
      toast.error("Erro ao criar campanha");
    }
  };

  const handleUpdateStatus = async (id: string, status: Campaign['status']) => {
    try {
      await updateStatus(id, status);
      toast.success("Status atualizado!");
      loadData();
    } catch (err) {
      toast.error("Erro ao atualizar status");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCampaign(id);
      toast.success("Campanha deletada!");
      loadData();
    } catch (err) {
      toast.error("Erro ao deletar campanha");
    }
  };

  const getProgress = (campaign: Campaign) => {
    const list = lists.find(l => l.id === campaign.list_id);
    const total = list?.contact_count || 0;
    if (total === 0) return 0;
    return ((campaign.sent_count + campaign.failed_count) / total) * 100;
  };

  return (
    <MainLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between animate-slide-up">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Campanhas</h1>
            <p className="mt-1 text-muted-foreground">
              Gerencie e acompanhe seus disparos de mensagens
            </p>
          </div>
          <Button variant="gradient" onClick={() => { resetForm(); setActiveTab("create"); }}>
            <Plus className="h-4 w-4" />
            Nova Campanha
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="list">Campanhas</TabsTrigger>
            <TabsTrigger value="reports">
              <BarChart3 className="h-4 w-4 mr-1" />
              Relatórios
            </TabsTrigger>
            <TabsTrigger value="create">Criar Campanha</TabsTrigger>
          </TabsList>

          <TabsContent value="list" className="space-y-4 mt-6">
            {/* Filters Bar */}
            <div className="flex flex-wrap items-center gap-3 p-4 rounded-lg bg-card border">
              {/* Search */}
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar campanhas..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9"
                />
              </div>
              
              {/* Status Filter */}
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os Status</SelectItem>
                  <SelectItem value="pending">Agendada</SelectItem>
                  <SelectItem value="running">Em Execução</SelectItem>
                  <SelectItem value="completed">Concluída</SelectItem>
                  <SelectItem value="paused">Pausada</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                </SelectContent>
              </Select>
              
              {/* Date Filter */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn(
                    "gap-2",
                    (dateFilterStart || dateFilterEnd) && "text-primary border-primary"
                  )}>
                    <CalendarIcon className="h-4 w-4" />
                    {dateFilterStart ? (
                      dateFilterEnd ? (
                        `${format(dateFilterStart, "dd/MM")} - ${format(dateFilterEnd, "dd/MM")}`
                      ) : (
                        format(dateFilterStart, "dd/MM/yy")
                      )
                    ) : (
                      "Data"
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <div className="p-3 border-b">
                    <p className="text-sm font-medium">Filtrar por data</p>
                    <p className="text-xs text-muted-foreground">Selecione o período</p>
                  </div>
                  <div className="flex gap-2 p-2">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1 px-1">De</p>
                      <Calendar
                        mode="single"
                        selected={dateFilterStart}
                        onSelect={setDateFilterStart}
                        locale={ptBR}
                      />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1 px-1">Até</p>
                      <Calendar
                        mode="single"
                        selected={dateFilterEnd}
                        onSelect={setDateFilterEnd}
                        locale={ptBR}
                      />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              
              {/* Clear Filters */}
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1">
                  <X className="h-4 w-4" />
                  Limpar
                </Button>
              )}
              
              <div className="flex-1" />
              
              {/* Auto-refresh controls */}
              <div className="flex items-center gap-2">
                {autoRefresh && campaigns.some(c => ['running', 'pending', 'paused'].includes(c.status)) && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {countdown}s
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  title={autoRefresh ? "Desativar atualização automática" : "Ativar atualização automática"}
                  className={cn(!autoRefresh && "text-muted-foreground")}
                >
                  {autoRefresh ? (
                    <RefreshCw className="h-4 w-4 text-primary" />
                  ) : (
                    <Pause className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    loadData();
                    setCountdown(30);
                  }}
                  disabled={loadingCampaigns}
                  title="Atualizar agora"
                >
                  <RefreshCw className={cn("h-4 w-4", loadingCampaigns && "animate-spin")} />
                </Button>
              </div>
            </div>
            
            {/* Results count */}
            {hasActiveFilters && (
              <p className="text-sm text-muted-foreground">
                Mostrando {filteredCampaigns.length} de {campaigns.length} campanha(s)
              </p>
            )}

            {loadingCampaigns && campaigns.length === 0 ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : filteredCampaigns.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Send className="h-12 w-12 mx-auto mb-4 opacity-50" />
                {hasActiveFilters ? (
                  <>
                    <p>Nenhuma campanha encontrada</p>
                    <p className="text-sm">Tente ajustar os filtros</p>
                    <Button variant="link" onClick={clearFilters} className="mt-2">
                      Limpar filtros
                    </Button>
                  </>
                ) : (
                  <>
                    <p>Nenhuma campanha criada</p>
                    <p className="text-sm">Clique em "Nova Campanha" para começar</p>
                  </>
                )}
              </div>
            ) : (
              filteredCampaigns.map((campaign, index) => {
                const config = statusConfig[campaign.status] || statusConfig.pending;
                const StatusIcon = config.icon;
                const progress = getProgress(campaign);
                const list = lists.find(l => l.id === campaign.list_id);
                const totalContacts = list?.contact_count || 0;

                return (
                  <Card
                    key={campaign.id}
                    className="transition-all duration-200 hover:shadow-elevated animate-fade-in cursor-pointer"
                    style={{ animationDelay: `${index * 100}ms` }}
                    onClick={() => {
                      setSelectedCampaignId(campaign.id);
                      setShowDetailModal(true);
                    }}
                  >
                    <CardContent className="p-6">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3">
                            <h3 className="text-lg font-semibold text-foreground">
                              {campaign.name}
                            </h3>
                            <Badge className={cn(config.bgColor, config.color, "border-0")}>
                              <StatusIcon className="h-3 w-3 mr-1" />
                              {config.label}
                            </Badge>
                            {campaign.random_order && (
                              <Badge variant="outline" className="text-xs">
                                <Shuffle className="h-3 w-3 mr-1" />
                                Aleatório
                              </Badge>
                            )}
                            {campaign.flow_id && (
                              <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">
                                <GitBranch className="h-3 w-3 mr-1" />
                                Fluxo
                              </Badge>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Users className="h-4 w-4" />
                              {campaign.list_name || "Lista removida"}
                            </span>
                            <span className="flex items-center gap-1">
                              {campaign.flow_id ? (
                                <>
                                  <GitBranch className="h-4 w-4" />
                                  {campaign.flow_name || "Fluxo removido"}
                                </>
                              ) : (
                                <>
                                  <MessageSquare className="h-4 w-4" />
                                  {campaign.message_name || "Mensagem removida"}
                                </>
                              )}
                            </span>
                            {campaign.start_date && (
                              <span className="flex items-center gap-1">
                                <CalendarIcon className="h-4 w-4" />
                                {formatCalendarDate(campaign.start_date, "dd/MM/yyyy")}
                                {campaign.end_date && ` - ${formatCalendarDate(campaign.end_date, "dd/MM/yyyy")}`}
                              </span>
                            )}
                            {campaign.start_time && campaign.end_time && (
                              <span className="flex items-center gap-1">
                                <Clock className="h-4 w-4" />
                                {campaign.start_time} - {campaign.end_time}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <Timer className="h-4 w-4" />
                              {campaign.min_delay}-{campaign.max_delay}s
                            </span>
                            <span className="flex items-center gap-1">
                              <Coffee className="h-4 w-4" />
                              Pausa a cada {campaign.pause_after_messages} msgs
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className="text-2xl font-bold text-foreground">
                              {campaign.sent_count}/{totalContacts}
                            </p>
                            <p className="text-sm text-muted-foreground">mensagens enviadas</p>
                          </div>
                          <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                            {campaign.status === "pending" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleUpdateStatus(campaign.id, "running")}
                              >
                                <Play className="h-4 w-4" />
                                Iniciar
                              </Button>
                            )}
                            {campaign.status === "running" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleUpdateStatus(campaign.id, "paused")}
                              >
                                <Pause className="h-4 w-4" />
                                Pausar
                              </Button>
                            )}
                            {campaign.status === "paused" && (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleUpdateStatus(campaign.id, "running")}
                                >
                                  <Play className="h-4 w-4" />
                                  Retomar
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleOpenEdit(campaign)}
                                >
                                  <Edit className="h-4 w-4" />
                                  Editar
                                </Button>
                              </>
                            )}
                            {campaign.status === "pending" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleOpenEdit(campaign)}
                              >
                                <Edit className="h-4 w-4" />
                                Editar
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(campaign.id)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      </div>
                      {campaign.status !== "pending" && (
                        <div className="mt-4">
                          <Progress value={progress} className="h-2" />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })
            )}
          </TabsContent>

          {/* Reports Tab */}
          <TabsContent value="reports" className="space-y-6 mt-6">
            {/* Report Filters */}
            <div className="flex flex-wrap items-center gap-3 p-4 rounded-lg bg-card border">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("gap-2", reportStartDate && "text-primary border-primary")}>
                    <CalendarIcon className="h-4 w-4" />
                    {reportStartDate ? format(reportStartDate, "dd/MM/yyyy", { locale: ptBR }) : "Data início"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={reportStartDate} onSelect={setReportStartDate} locale={ptBR} className="pointer-events-auto" />
                </PopoverContent>
              </Popover>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("gap-2", reportEndDate && "text-primary border-primary")}>
                    <CalendarIcon className="h-4 w-4" />
                    {reportEndDate ? format(reportEndDate, "dd/MM/yyyy", { locale: ptBR }) : "Data fim"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={reportEndDate} onSelect={setReportEndDate} locale={ptBR} className="pointer-events-auto" />
                </PopoverContent>
              </Popover>
              <Button variant="outline" onClick={loadReports} disabled={loadingReport}>
                {loadingReport ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Atualizar
              </Button>
              {(reportStartDate || reportEndDate) && (
                <Button variant="ghost" size="sm" onClick={() => { setReportStartDate(undefined); setReportEndDate(undefined); }}>
                  <X className="h-4 w-4" /> Limpar
                </Button>
              )}
            </div>

            {loadingReport && !reportData ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : reportData ? (
              <>
                {/* General Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                          <Send className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <p className="text-2xl font-bold">{Number(reportData.general.total_campaigns)}</p>
                          <p className="text-xs text-muted-foreground">Total Campanhas</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-success/10">
                          <CheckCircle2 className="h-5 w-5 text-success" />
                        </div>
                        <div>
                          <p className="text-2xl font-bold">{Number(reportData.general.total_sent).toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground">Total Enviadas</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-destructive/10">
                          <AlertCircle className="h-5 w-5 text-destructive" />
                        </div>
                        <div>
                          <p className="text-2xl font-bold">{Number(reportData.general.total_failed).toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground">Total Falhadas</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-warning/10">
                          <TrendingUp className="h-5 w-5 text-warning" />
                        </div>
                        <div>
                          <p className="text-2xl font-bold">{reportData.general.success_rate}%</p>
                          <p className="text-xs text-muted-foreground">Taxa de Sucesso</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Connections Stats */}
                {reportData.connections.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Wifi className="h-5 w-5 text-primary" />
                        Envios por Conexão
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Conexão</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Campanhas</TableHead>
                            <TableHead className="text-right">Enviadas</TableHead>
                            <TableHead className="text-right">Falhadas</TableHead>
                            <TableHead className="text-right">Sucesso</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {reportData.connections.map((conn) => (
                            <TableRow key={conn.connection_id}>
                              <TableCell className="font-medium">{conn.connection_name}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className={cn(
                                  conn.connection_status === 'connected' ? 'text-success border-success' : 'text-destructive border-destructive'
                                )}>
                                  {conn.connection_status === 'connected' ? (
                                    <><Wifi className="h-3 w-3 mr-1" /> Online</>
                                  ) : (
                                    <><WifiOff className="h-3 w-3 mr-1" /> Offline</>
                                  )}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">{conn.campaign_count}</TableCell>
                              <TableCell className="text-right font-medium text-success">{Number(conn.total_sent).toLocaleString()}</TableCell>
                              <TableCell className="text-right text-destructive">{Number(conn.total_failed).toLocaleString()}</TableCell>
                              <TableCell className="text-right">
                                <Badge className={cn(
                                  Number(conn.success_rate) >= 90 ? 'bg-success/10 text-success' :
                                  Number(conn.success_rate) >= 70 ? 'bg-warning/10 text-warning' :
                                  'bg-destructive/10 text-destructive',
                                  'border-0'
                                )}>
                                  {conn.success_rate}%
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                )}

                {/* Campaigns Table */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <BarChart3 className="h-5 w-5 text-primary" />
                      Detalhes por Campanha
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="max-h-[400px]">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Campanha</TableHead>
                            <TableHead>Conexão</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Contatos</TableHead>
                            <TableHead className="text-right">Enviadas</TableHead>
                            <TableHead className="text-right">Falhadas</TableHead>
                            <TableHead className="text-right">Sucesso</TableHead>
                            <TableHead>Data</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {reportData.campaigns.map((c) => {
                            const config = statusConfig[c.status as keyof typeof statusConfig] || statusConfig.pending;
                            return (
                              <TableRow key={c.id} className="cursor-pointer" onClick={() => { setSelectedCampaignId(c.id); setShowDetailModal(true); }}>
                                <TableCell className="font-medium">{c.name}</TableCell>
                                <TableCell className="text-muted-foreground">{c.connection_name}</TableCell>
                                <TableCell>
                                  <Badge className={cn(config.bgColor, config.color, "border-0 text-xs")}>
                                    {config.label}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right">{c.total_contacts}</TableCell>
                                <TableCell className="text-right font-medium text-success">{c.sent_count}</TableCell>
                                <TableCell className="text-right text-destructive">{c.failed_count}</TableCell>
                                <TableCell className="text-right">
                                  <Badge className={cn(
                                    Number(c.success_rate) >= 90 ? 'bg-success/10 text-success' :
                                    Number(c.success_rate) >= 70 ? 'bg-warning/10 text-warning' :
                                    'bg-destructive/10 text-destructive',
                                    'border-0'
                                  )}>
                                    {c.success_rate}%
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-muted-foreground text-sm">
                                  {c.created_at ? format(new Date(c.created_at), "dd/MM/yy", { locale: ptBR }) : '-'}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Nenhum dado disponível</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="create" className="mt-6">
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Campaign Details */}
              <Card className="animate-fade-in shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Send className="h-5 w-5 text-primary" />
                    Nova Campanha
                  </CardTitle>
                  <CardDescription>
                    Configure os detalhes da sua campanha de envio
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="campaignName">Nome da Campanha</Label>
                    <Input
                      id="campaignName"
                      placeholder="Ex: Promoção de Verão"
                      value={campaignName}
                      onChange={(e) => setCampaignName(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Conexão WhatsApp</Label>
                     <Select value={selectedConnection} onValueChange={setSelectedConnection} disabled={connections.length === 0}>
                       <SelectTrigger>
                         <SelectValue placeholder={connections.length === 0 ? "Nenhuma conexão disponível" : "Selecione uma conexão"} />
                       </SelectTrigger>
                       <SelectContent>
                         {connections.length === 0 ? (
                           <div className="px-2 py-2 text-sm text-muted-foreground">Nenhuma conexão encontrada</div>
                         ) : (
                           connections.map((conn) => (
                             <SelectItem key={conn.id} value={conn.id}>
                               {conn.name} ({conn.status})
                             </SelectItem>
                           ))
                         )}
                       </SelectContent>
                     </Select>
                  </div>

                  {/* Contact Source Toggle */}
                  <div className="space-y-3">
                    <Label>Origem dos Contatos</Label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant={contactSource === 'list' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setContactSource('list')}
                        className="flex-1"
                      >
                        <Users className="h-4 w-4 mr-2" />
                        Lista
                      </Button>
                      <Button
                        type="button"
                        variant={contactSource === 'tag' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setContactSource('tag')}
                        className="flex-1"
                      >
                        <Tag className="h-4 w-4 mr-2" />
                        Tag de Conversa
                      </Button>
                    </div>
                  </div>

                  {contactSource === 'list' ? (
                    <div className="space-y-2">
                      <Label>Lista de Contatos</Label>
                       <Select value={selectedList} onValueChange={setSelectedList} disabled={lists.length === 0}>
                         <SelectTrigger>
                           <SelectValue placeholder={lists.length === 0 ? "Nenhuma lista disponível" : "Selecione uma lista"} />
                         </SelectTrigger>
                         <SelectContent>
                           {lists.length === 0 ? (
                             <div className="px-2 py-2 text-sm text-muted-foreground">Nenhuma lista encontrada</div>
                           ) : (
                             lists.map((list) => (
                               <SelectItem key={list.id} value={list.id}>
                                 {list.name} ({list.contact_count || 0} contatos)
                               </SelectItem>
                             ))
                           )}
                         </SelectContent>
                       </Select>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>Tag de Conversa</Label>
                      <Select value={selectedTag} onValueChange={setSelectedTag} disabled={conversationTags.length === 0}>
                        <SelectTrigger>
                          <SelectValue placeholder={conversationTags.length === 0 ? "Nenhuma tag disponível" : "Selecione uma tag"} />
                        </SelectTrigger>
                        <SelectContent>
                          {conversationTags.length === 0 ? (
                            <div className="px-2 py-2 text-sm text-muted-foreground">Nenhuma tag encontrada</div>
                          ) : (
                            conversationTags.filter(t => t.conversation_count > 0).map((tag) => (
                              <SelectItem key={tag.id} value={tag.id}>
                                <div className="flex items-center gap-2">
                                  <div 
                                    className="w-3 h-3 rounded-full" 
                                    style={{ backgroundColor: tag.color }}
                                  />
                                  {tag.name} ({tag.conversation_count} conversas)
                                </div>
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Será criada uma lista com os números das conversas que possuem esta tag
                      </p>
                    </div>
                  )}

                  {/* Content Type Toggle */}
                  <div className="space-y-3">
                    <Label>Tipo de Conteúdo</Label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant={contentType === 'message' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setContentType('message')}
                        className="flex-1"
                      >
                        <MessageSquare className="h-4 w-4 mr-2" />
                        Mensagem
                      </Button>
                      <Button
                        type="button"
                        variant={contentType === 'flow' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setContentType('flow')}
                        className="flex-1"
                      >
                        <GitBranch className="h-4 w-4 mr-2" />
                        Fluxo
                      </Button>
                    </div>
                  </div>

                  {contentType === 'message' ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Mensagens ({selectedMessages.length} selecionadas)</Label>
                        {selectedMessages.length > 1 && (
                          <Badge variant="outline" className="text-xs">
                            <Shuffle className="h-3 w-3 mr-1" />
                            Envio aleatório
                          </Badge>
                        )}
                      </div>
                       <div className="space-y-2 max-h-40 overflow-y-auto rounded-lg border p-2">
                         {messages.length === 0 ? (
                           <div className="p-3 text-sm text-muted-foreground">
                             Nenhuma mensagem encontrada
                           </div>
                         ) : (
                           messages.map((msg) => (
                             <div
                               key={msg.id}
                               className={cn(
                                 "flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors",
                                 selectedMessages.includes(msg.id)
                                   ? "bg-primary/10 border border-primary"
                                   : "hover:bg-accent"
                               )}
                               onClick={() => toggleMessageSelection(msg.id)}
                             >
                               <div className={cn(
                                 "w-4 h-4 rounded border flex items-center justify-center",
                                 selectedMessages.includes(msg.id) ? "bg-primary border-primary" : "border-muted-foreground"
                               )}>
                                 {selectedMessages.includes(msg.id) && (
                                   <Check className="h-3 w-3 text-primary-foreground" />
                                 )}
                               </div>
                               <span className="text-sm">{msg.name}</span>
                             </div>
                           ))
                         )}
                       </div>
                      <p className="text-xs text-muted-foreground">
                        Selecione múltiplas mensagens para envio aleatório entre contatos. Use <code className="bg-muted px-1 rounded">{'{nome}'}</code>, <code className="bg-muted px-1 rounded">{'{telefone}'}</code> nas mensagens para personalização.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>Fluxo de Automação</Label>
                      <Select value={selectedFlow} onValueChange={setSelectedFlow} disabled={flows.length === 0}>
                        <SelectTrigger>
                          <SelectValue placeholder={flows.length === 0 ? "Nenhum fluxo disponível" : "Selecione um fluxo"} />
                        </SelectTrigger>
                        <SelectContent>
                          {flows.length === 0 ? (
                            <div className="px-2 py-2 text-sm text-muted-foreground">Nenhum fluxo encontrado</div>
                          ) : (
                            flows.filter(f => f.is_active).map((flow) => (
                              <SelectItem key={flow.id} value={flow.id}>
                                <div className="flex items-center gap-2">
                                  <GitBranch className="h-4 w-4 text-primary" />
                                  {flow.name}
                                  <Badge variant="outline" className="text-xs ml-1">
                                    {flow.node_count} nós
                                  </Badge>
                                </div>
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        O fluxo será iniciado para cada contato da lista. Variáveis do contato estarão disponíveis no fluxo.
                      </p>
                    </div>
                  )}

                  {/* Random Order Toggle */}
                  <div className="flex items-center justify-between rounded-lg bg-accent/50 p-4">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <Shuffle className="h-4 w-4 text-primary" />
                        <Label className="font-medium">Ordem Aleatória</Label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Enviar para contatos em ordem aleatória
                      </p>
                    </div>
                    <Switch
                      checked={randomOrder}
                      onCheckedChange={setRandomOrder}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Schedule Settings */}
              <div className="space-y-6">
                <Card className="animate-fade-in shadow-card">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CalendarIcon className="h-5 w-5 text-primary" />
                      Período de Envio
                    </CardTitle>
                    <CardDescription>
                      Configure quando a campanha deve ser executada
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Data de Início</Label>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className={cn(
                                "w-full justify-start text-left font-normal",
                                !startDate && "text-muted-foreground"
                              )}
                            >
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {startDate ? format(startDate, "dd/MM/yyyy", { locale: ptBR }) : "Hoje"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0">
                            <Calendar
                              mode="single"
                              selected={startDate}
                              onSelect={setStartDate}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                      </div>
                      <div className="space-y-2">
                        <Label>Data de Término</Label>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className={cn(
                                "w-full justify-start text-left font-normal",
                                !endDate && "text-muted-foreground"
                              )}
                            >
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {endDate ? format(endDate, "dd/MM/yyyy", { locale: ptBR }) : "Sem limite"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0">
                            <Calendar
                              mode="single"
                              selected={endDate}
                              onSelect={setEndDate}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="startTime">Horário de Início</Label>
                        <Input
                          id="startTime"
                          type="time"
                          value={startTime}
                          onChange={(e) => setStartTime(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="endTime">Horário de Término</Label>
                        <Input
                          id="endTime"
                          type="time"
                          value={endTime}
                          onChange={(e) => setEndTime(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                      <Clock className="inline h-3 w-3 mr-1" />
                      Envios serão feitos apenas entre {startTime} e {endTime}
                    </div>
                  </CardContent>
                </Card>

                <Card className="animate-fade-in shadow-card">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Settings2 className="h-5 w-5 text-primary" />
                      Configurações de Delay
                    </CardTitle>
                    <CardDescription>
                      Proteja sua conta com delays e pausas automáticas
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="minDelay">Delay Mínimo (seg)</Label>
                        <Input
                          id="minDelay"
                          type="number"
                          min="5"
                          value={minDelay}
                          onChange={(e) => setMinDelay(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">Mínimo: 5s</p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="maxDelay">Delay Máximo (seg)</Label>
                        <Input
                          id="maxDelay"
                          type="number"
                          min="5"
                          value={maxDelay}
                          onChange={(e) => setMaxDelay(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">Sem limite máximo</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="pauseAfterMessages">Pausar após (msgs)</Label>
                        <Input
                          id="pauseAfterMessages"
                          type="number"
                          min="5"
                          max="50"
                          value={pauseAfterMessages}
                          onChange={(e) => setPauseAfterMessages(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pauseDuration">Duração da pausa (min)</Label>
                        <Input
                          id="pauseDuration"
                          type="number"
                          min="5"
                          max="30"
                          value={pauseDuration}
                          onChange={(e) => setPauseDuration(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="rounded-lg bg-accent/50 p-4">
                      <div className="flex items-start gap-3">
                        <Coffee className="h-5 w-5 text-primary mt-0.5" />
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            Pausas Automáticas
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            A cada {pauseAfterMessages} mensagens, o sistema fará uma pausa de {pauseDuration} minutos
                            para proteger sua conta.
                          </p>
                        </div>
                      </div>
                    </div>

                    <Button 
                      variant="gradient" 
                      className="w-full"
                      onClick={handleCreateCampaign}
                      disabled={loadingCampaigns || creatingListFromTag}
                    >
                      {loadingCampaigns || creatingListFromTag ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {creatingListFromTag ? 'Criando lista da tag...' : 'Criando campanha...'}
                        </>
                      ) : (
                        <>
                          <Send className="h-4 w-4" />
                          Criar Campanha
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Campaign Detail Modal */}
        <CampaignDetailModal
          campaignId={selectedCampaignId}
          open={showDetailModal}
          onClose={() => {
            setShowDetailModal(false);
            setSelectedCampaignId(null);
          }}
        />

        {/* Edit Campaign Dialog */}
        <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Edit className="h-5 w-5 text-primary" />
                Editar Campanha
              </DialogTitle>
              <DialogDescription>
                {editingCampaign?.name} — altere a conexão ou reagende
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Conexão WhatsApp</Label>
                <Select value={editConnection} onValueChange={setEditConnection}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione uma conexão" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((conn) => (
                      <SelectItem key={conn.id} value={conn.id}>
                        <div className="flex items-center gap-2">
                          {conn.status === 'connected' ? (
                            <Wifi className="h-3 w-3 text-success" />
                          ) : (
                            <WifiOff className="h-3 w-3 text-destructive" />
                          )}
                          {conn.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Data de Início</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !editStartDate && "text-muted-foreground")}>
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {editStartDate ? format(editStartDate, "dd/MM/yyyy", { locale: ptBR }) : "Selecione"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <Calendar mode="single" selected={editStartDate} onSelect={setEditStartDate} locale={ptBR} className="pointer-events-auto" />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <Label>Data de Término</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !editEndDate && "text-muted-foreground")}>
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {editEndDate ? format(editEndDate, "dd/MM/yyyy", { locale: ptBR }) : "Sem limite"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <Calendar mode="single" selected={editEndDate} onSelect={setEditEndDate} locale={ptBR} className="pointer-events-auto" />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Horário Início</Label>
                  <Input type="time" value={editStartTime} onChange={(e) => setEditStartTime(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Horário Término</Label>
                  <Input type="time" value={editEndTime} onChange={(e) => setEditEndTime(e.target.value)} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancelar</Button>
              <Button onClick={handleSaveEdit} disabled={loadingCampaigns}>
                {loadingCampaigns ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Salvar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </MainLayout>
  );
};

export default Campanhas;
