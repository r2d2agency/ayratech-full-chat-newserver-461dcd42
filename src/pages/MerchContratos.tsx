import { useState, useMemo } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { FileUploadInput } from "@/components/ui/file-upload-input";
import { useBrands, useBrandPdvs } from "@/hooks/use-merchandising";
import { useBrandContracts, useCreateContract, useUpdateContract, useDeleteContract, useContractCompliance, useCheckCompliance, useOrgLetterhead, useUpdateLetterhead } from "@/hooks/use-brand-contracts";
import { FileText, Plus, Trash2, Pencil, GripVertical, Clock, MapPin, DollarSign, CheckCircle, AlertTriangle, XCircle, BarChart3, Calendar, Shield, Search, Building2, Settings, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { formatCalendarDate } from "@/lib/date-utils";

const emptyContract = {
  title: '', status: 'draft', start_date: '', end_date: '', auto_renew: false,
  hours_per_visit: '', visits_per_week: '', total_monthly_hours: '',
  pdv_ids: [] as string[], contract_value: '', payment_terms: '',
  clauses: [] as { order: number; title: string; content: string }[],
  notes: '', brand_id: '',
};

export default function MerchContratos() {
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [activeTab, setActiveTab] = useState('list');
  const [editingContract, setEditingContract] = useState<any>(null);
  const [form, setForm] = useState<any>({ ...emptyContract });
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const [letterheadOpen, setLetterheadOpen] = useState(false);
  const [letterheadForm, setLetterheadForm] = useState<any>({});

  const { data: brands = [] } = useBrands();
  const { data: contracts = [], isLoading } = useBrandContracts(brandFilter || undefined);
  const { data: brandPdvs = [] } = useBrandPdvs(form.brand_id || undefined);
  const { data: compliance = [] } = useContractCompliance(selectedContractId || undefined);
  const { data: letterhead } = useOrgLetterhead();

  const createContract = useCreateContract();
  const updateContract = useUpdateContract();
  const deleteContract = useDeleteContract();
  const checkCompliance = useCheckCompliance();
  const updateLetterhead = useUpdateLetterhead();

  const set = (k: string, v: any) => setForm((p: any) => ({ ...p, [k]: v }));

  // Filter contracts by search
  const filtered = useMemo(() => {
    if (!search) return contracts;
    const s = search.toLowerCase();
    return contracts.filter((c: any) =>
      c.title?.toLowerCase().includes(s) || c.notes?.toLowerCase().includes(s)
    );
  }, [contracts, search]);

  const openNew = () => {
    setForm({ ...emptyContract, brand_id: brandFilter || '' });
    setEditingContract(null);
    setActiveTab("editor");
  };

  const openEdit = (c: any) => {
    setForm({
      ...c,
      clauses: Array.isArray(c.clauses) ? c.clauses : JSON.parse(c.clauses || '[]'),
      pdv_ids: c.pdv_ids || [],
      start_date: c.start_date?.split('T')[0] || '',
      end_date: c.end_date?.split('T')[0] || '',
    });
    setEditingContract(c);
    setActiveTab("editor");
  };

  const handleSave = async () => {
    if (!form.title) { toast.error('Título obrigatório'); return; }
    if (!form.brand_id) { toast.error('Selecione uma marca'); return; }
    try {
      if (editingContract) {
        await updateContract.mutateAsync({ id: editingContract.id, ...form });
        toast.success('Contrato atualizado');
      } else {
        await createContract.mutateAsync(form);
        toast.success('Contrato criado');
      }
      setActiveTab("list");
    } catch (e: any) { toast.error(e.message); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Excluir contrato?')) return;
    try { await deleteContract.mutateAsync(id); toast.success('Excluído'); } catch (e: any) { toast.error(e.message); }
  };

  const addClause = () => {
    const clauses = [...(form.clauses || [])];
    clauses.push({ order: clauses.length + 1, title: '', content: '' });
    set('clauses', clauses);
  };

  const updateClause = (idx: number, field: string, value: string) => {
    const clauses = [...form.clauses];
    clauses[idx] = { ...clauses[idx], [field]: value };
    set('clauses', clauses);
  };

  const removeClause = (idx: number) => {
    const clauses = form.clauses.filter((_: any, i: number) => i !== idx);
    set('clauses', clauses.map((c: any, i: number) => ({ ...c, order: i + 1 })));
  };

  const togglePdv = (pdvId: string) => {
    const ids = form.pdv_ids.includes(pdvId)
      ? form.pdv_ids.filter((id: string) => id !== pdvId)
      : [...form.pdv_ids, pdvId];
    set('pdv_ids', ids);
  };

  const handleCheckCompliance = async (contractId: string) => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const end = now.toISOString().split('T')[0];
    try {
      const result = await checkCompliance.mutateAsync({ contractId, period_start: start, period_end: end });
      toast.success(`Conformidade: ${result.compliance_pct?.toFixed(1)}%`);
    } catch (e: any) { toast.error(e.message); }
  };

  const handleSaveLetterhead = async () => {
    try {
      await updateLetterhead.mutateAsync(letterheadForm);
      toast.success('Timbrado salvo');
      setLetterheadOpen(false);
    } catch (e: any) { toast.error(e.message); }
  };

  const statusColor = (s: string) => {
    switch (s) { case 'active': return 'default'; case 'draft': return 'secondary'; case 'expired': return 'outline'; case 'cancelled': return 'destructive'; default: return 'secondary'; }
  };
  const statusLabel = (s: string) => {
    switch (s) { case 'active': return 'Ativo'; case 'draft': return 'Rascunho'; case 'expired': return 'Expirado'; case 'cancelled': return 'Cancelado'; default: return s; }
  };

  const complianceIcon = (pct: number | null) => {
    if (!pct) return <Shield className="h-4 w-4 text-muted-foreground" />;
    if (pct >= 90) return <CheckCircle className="h-4 w-4 text-emerald-500" />;
    if (pct >= 70) return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    return <XCircle className="h-4 w-4 text-destructive" />;
  };

  const brandName = (id: string) => brands.find((b: any) => b.id === id)?.name || '—';

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            Contratos de Marca
          </h1>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setLetterheadForm(letterhead || {}); setLetterheadOpen(true); }}>
              <Settings className="h-4 w-4 mr-1" />Timbrado
            </Button>
            <Button onClick={openNew}><Plus className="h-4 w-4 mr-1" />Novo Contrato</Button>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="list">Contratos</TabsTrigger>
            <TabsTrigger value="editor">Editor</TabsTrigger>
            <TabsTrigger value="compliance">Conformidade</TabsTrigger>
          </TabsList>

          {/* LIST TAB */}
          <TabsContent value="list" className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Buscar contrato..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
              </div>
              <Select value={brandFilter} onValueChange={setBrandFilter}>
                <SelectTrigger className="w-[200px]"><SelectValue placeholder="Todas as marcas" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as marcas</SelectItem>
                  {brands.map((b: any) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="draft">Rascunho</SelectItem>
                  <SelectItem value="active">Ativo</SelectItem>
                  <SelectItem value="expired">Expirado</SelectItem>
                  <SelectItem value="cancelled">Cancelado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {filtered.length === 0 ? (
              <Card>
                <CardContent className="text-center py-12">
                  <FileText className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="text-muted-foreground">{brandFilter ? 'Nenhum contrato para esta marca' : 'Selecione uma marca para ver contratos'}</p>
                  {brandFilter && <Button variant="outline" className="mt-3" onClick={openNew}>Criar Contrato</Button>}
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3">
                {filtered.map((c: any) => (
                  <Card key={c.id} className="cursor-pointer hover:border-primary/30 transition-colors" onClick={() => openEdit(c)}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <p className="font-semibold truncate">{c.title}</p>
                            <Badge variant={statusColor(c.status) as any}>{statusLabel(c.status)}</Badge>
                            {complianceIcon(c.compliance_score)}
                            {c.compliance_score != null && (
                              <span className="text-xs text-muted-foreground">{Number(c.compliance_score).toFixed(0)}%</span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mb-2 flex items-center gap-1">
                            <Building2 className="h-3 w-3" /> {brandName(c.brand_id)}
                          </p>
                          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                            {c.contract_value && (
                              <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />R$ {Number(c.contract_value).toLocaleString('pt-BR')}/mês</span>
                            )}
                            {c.visits_per_week && (
                              <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{c.visits_per_week}x/semana</span>
                            )}
                            {c.hours_per_visit && (
                              <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{c.hours_per_visit}h/visita</span>
                            )}
                            {c.total_monthly_hours && (
                              <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{c.total_monthly_hours}h/mês</span>
                            )}
                            {c.pdv_ids?.length > 0 && (
                              <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{c.pdv_ids.length} PDVs</span>
                            )}
                            {c.start_date && (
                              <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />
                                {formatCalendarDate(c.start_date, 'dd/MM/yyyy')}
                                {c.end_date && ` — ${formatCalendarDate(c.end_date, 'dd/MM/yyyy')}`}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleCheckCompliance(c.id); }} title="Verificar conformidade">
                            <BarChart3 className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* EDITOR TAB */}
          <TabsContent value="editor">
            <ScrollArea className="h-[calc(100vh-260px)]">
              <div className="space-y-6 pr-4 pb-6">
                {/* Brand + Basic */}
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-sm">Dados do Contrato</CardTitle></CardHeader>
                  <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="col-span-full space-y-2">
                      <Label>Marca *</Label>
                      <Select value={form.brand_id} onValueChange={v => set('brand_id', v)}>
                        <SelectTrigger><SelectValue placeholder="Selecione a marca" /></SelectTrigger>
                        <SelectContent>
                          {brands.map((b: any) => (
                            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-full space-y-2">
                      <Label>Título *</Label>
                      <Input value={form.title} onChange={e => set('title', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Status</Label>
                      <Select value={form.status} onValueChange={v => set('status', v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="draft">Rascunho</SelectItem>
                          <SelectItem value="active">Ativo</SelectItem>
                          <SelectItem value="expired">Expirado</SelectItem>
                          <SelectItem value="cancelled">Cancelado</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Valor Mensal (R$)</Label>
                      <Input type="number" value={form.contract_value} onChange={e => set('contract_value', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Início</Label>
                      <Input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Término</Label>
                      <Input type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Condições de Pagamento</Label>
                      <Input value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} placeholder="Ex: 30 dias" />
                    </div>
                    <div className="flex items-center gap-2 pt-6">
                      <Switch checked={form.auto_renew} onCheckedChange={v => set('auto_renew', v)} />
                      <Label>Renovação automática</Label>
                    </div>
                  </CardContent>
                </Card>

                {/* Business Rules */}
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-sm">Regras de Execução</CardTitle></CardHeader>
                  <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>Horas por Visita</Label>
                      <Input type="number" step="0.5" value={form.hours_per_visit} onChange={e => set('hours_per_visit', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Visitas por Semana</Label>
                      <Input type="number" value={form.visits_per_week} onChange={e => set('visits_per_week', e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Total Horas/Mês</Label>
                      <Input type="number" value={form.total_monthly_hours} onChange={e => set('total_monthly_hours', e.target.value)} />
                    </div>
                  </CardContent>
                </Card>

                {/* PDVs */}
                {form.brand_id && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">PDVs Cobertos ({form.pdv_ids?.length || 0})</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {brandPdvs.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nenhum PDV vinculado a esta marca. Vincule PDVs na página de Marcas.</p>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                          {brandPdvs.map((bp: any) => (
                            <div key={bp.pdv_id || bp.id} className="flex items-center gap-2 p-2 rounded hover:bg-muted">
                              <Checkbox
                                checked={form.pdv_ids?.includes(bp.pdv_id)}
                                onCheckedChange={() => togglePdv(bp.pdv_id)}
                              />
                              <span className="text-sm truncate">{bp.pdv_name || bp.pdv_id}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Clauses */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">Cláusulas ({form.clauses?.length || 0})</CardTitle>
                      <Button variant="outline" size="sm" onClick={addClause}><Plus className="h-3 w-3 mr-1" />Adicionar</Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(form.clauses || []).map((clause: any, idx: number) => (
                      <div key={idx} className="border rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <GripVertical className="h-4 w-4 text-muted-foreground" />
                          <span className="text-xs font-medium text-muted-foreground">Cláusula {idx + 1}</span>
                          <div className="flex-1" />
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeClause(idx)}>
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </Button>
                        </div>
                        <Input
                          placeholder="Título da cláusula"
                          value={clause.title}
                          onChange={e => updateClause(idx, 'title', e.target.value)}
                          className="text-sm"
                        />
                        <Textarea
                          placeholder="Conteúdo da cláusula..."
                          value={clause.content}
                          onChange={e => updateClause(idx, 'content', e.target.value)}
                          rows={3}
                          className="text-sm"
                        />
                      </div>
                    ))}
                    {(!form.clauses || form.clauses.length === 0) && (
                      <p className="text-sm text-muted-foreground text-center py-4">Nenhuma cláusula adicionada</p>
                    )}
                  </CardContent>
                </Card>

                {/* Notes */}
                <div className="space-y-2">
                  <Label>Observações</Label>
                  <Textarea value={form.notes || ''} onChange={e => set('notes', e.target.value)} rows={2} />
                </div>
              </div>
            </ScrollArea>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" onClick={() => setActiveTab("list")}>Cancelar</Button>
              <Button onClick={handleSave} disabled={createContract.isPending || updateContract.isPending}>
                {editingContract ? 'Atualizar' : 'Criar'} Contrato
              </Button>
            </div>
          </TabsContent>

          {/* COMPLIANCE TAB */}
          <TabsContent value="compliance" className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              <Select value={brandFilter} onValueChange={setBrandFilter}>
                <SelectTrigger className="w-[200px]"><SelectValue placeholder="Selecione a marca" /></SelectTrigger>
                <SelectContent>
                  {brands.map((b: any) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {brandFilter && (
                <Select value={selectedContractId || ''} onValueChange={setSelectedContractId}>
                  <SelectTrigger className="w-[300px]"><SelectValue placeholder="Selecione um contrato" /></SelectTrigger>
                  <SelectContent>
                    {contracts.map((c: any) => (
                      <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {selectedContractId && (
                <Button size="sm" variant="outline" onClick={() => handleCheckCompliance(selectedContractId)} disabled={checkCompliance.isPending}>
                  <BarChart3 className="h-4 w-4 mr-1" />Verificar Agora
                </Button>
              )}
            </div>

            {selectedContractId && (() => {
              const contract = contracts.find((c: any) => c.id === selectedContractId);
              if (!contract) return null;
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Card>
                      <CardContent className="p-4 text-center">
                        <div className="flex justify-center mb-1">{complianceIcon(contract.compliance_score)}</div>
                        <p className="text-2xl font-bold">{contract.compliance_score != null ? `${Number(contract.compliance_score).toFixed(0)}%` : '—'}</p>
                        <p className="text-xs text-muted-foreground">Conformidade</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4 text-center">
                        <p className="text-2xl font-bold">{contract.visits_per_week || '—'}</p>
                        <p className="text-xs text-muted-foreground">Visitas/Semana</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4 text-center">
                        <p className="text-2xl font-bold">{contract.hours_per_visit || '—'}</p>
                        <p className="text-xs text-muted-foreground">Horas/Visita</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4 text-center">
                        <p className="text-2xl font-bold">{contract.pdv_ids?.length || 0}</p>
                        <p className="text-xs text-muted-foreground">PDVs</p>
                      </CardContent>
                    </Card>
                  </div>

                  <Card>
                    <CardHeader className="pb-3"><CardTitle className="text-sm">Histórico de Conformidade</CardTitle></CardHeader>
                    <CardContent>
                      {compliance.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-6">Nenhuma verificação realizada. Clique em "Verificar Agora" para iniciar.</p>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Período</TableHead>
                              <TableHead>Visitas</TableHead>
                              <TableHead>Horas</TableHead>
                              <TableHead>Conformidade</TableHead>
                              <TableHead>Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {compliance.map((c: any) => (
                              <TableRow key={c.id}>
                                <TableCell className="text-sm">
                                  {formatCalendarDate(c.period_start, 'dd/MM')} — {formatCalendarDate(c.period_end, 'dd/MM/yyyy')}
                                </TableCell>
                                <TableCell className="text-sm">{c.actual_visits}/{c.expected_visits}</TableCell>
                                <TableCell className="text-sm">{Number(c.actual_hours).toFixed(1)}/{Number(c.expected_hours).toFixed(1)}h</TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${Number(c.compliance_pct) >= 90 ? 'bg-emerald-500' : Number(c.compliance_pct) >= 70 ? 'bg-amber-500' : 'bg-destructive'}`}
                                        style={{ width: `${Math.min(100, Number(c.compliance_pct))}%` }}
                                      />
                                    </div>
                                    <span className="text-sm font-medium">{Number(c.compliance_pct).toFixed(0)}%</span>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <Badge variant={c.status === 'ok' ? 'default' : c.status === 'warning' ? 'secondary' : 'destructive'}>
                                    {c.status === 'ok' ? 'OK' : c.status === 'warning' ? 'Alerta' : 'Violação'}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </CardContent>
                  </Card>
                </>
              );
            })()}

            {!selectedContractId && (
              <Card>
                <CardContent className="text-center py-12">
                  <BarChart3 className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="text-muted-foreground">Selecione uma marca e um contrato para ver a conformidade</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Org Letterhead Dialog */}
      <Dialog open={letterheadOpen} onOpenChange={setLetterheadOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" />
              Timbrado da Organização
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Logotipo</Label>
              <FileUploadInput value={letterheadForm.logo_url || ''} onChange={v => setLetterheadForm((p: any) => ({ ...p, logo_url: v }))} accept="image/*" />
            </div>
            <div className="space-y-2">
              <Label>Imagem de Fundo (Timbrado)</Label>
              <FileUploadInput value={letterheadForm.background_url || ''} onChange={v => setLetterheadForm((p: any) => ({ ...p, background_url: v }))} accept="image/*" />
            </div>
            <div className="space-y-2">
              <Label>Texto do Cabeçalho</Label>
              <Input value={letterheadForm.header_text || ''} onChange={e => setLetterheadForm((p: any) => ({ ...p, header_text: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Texto do Rodapé</Label>
              <Input value={letterheadForm.footer_text || ''} onChange={e => setLetterheadForm((p: any) => ({ ...p, footer_text: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Cor Principal</Label>
              <Input type="color" value={letterheadForm.primary_color || '#000000'} onChange={e => setLetterheadForm((p: any) => ({ ...p, primary_color: e.target.value }))} className="h-10 w-20" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLetterheadOpen(false)}>Cancelar</Button>
            <Button onClick={handleSaveLetterhead} disabled={updateLetterhead.isPending}>Salvar Timbrado</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
