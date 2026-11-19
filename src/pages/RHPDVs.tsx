import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useEmployees } from "@/hooks/use-rh";
import { usePDVs, useCreatePDV, useUpdatePDV, useDeletePDV, useTogglePDVActive } from "@/hooks/use-promotor";
import { useGeocode } from "@/hooks/use-rh";
import { useAuth } from "@/contexts/AuthContext";
import { getAuthToken } from "@/lib/api";
import { MapPin, Plus, Edit, Search, Loader2, Navigation, Upload, Download, Trash2, LayoutDashboard, Power } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PDVImportDialog } from "@/components/promotor/PDVImportDialog";
import { PdvGeofenceEditor, type PolygonPoint } from "@/components/promotor/PdvGeofenceEditor";

const EMPTY_PDV: any = { name: '', client_name: '', address: '', address_number: '', complement: '', zip_code: '', city: '', state: '', neighborhood: '', latitude: '', longitude: '', radius_meters: 200, supervisor_id: '', notes: '', active: true, geofence_polygon: null as PolygonPoint[] | null, type: 'pdv' };


function splitAddressAndNumber(address: string) {
  const normalized = String(address || '').trim().replace(/\s+/g, ' ');
  const match = normalized.match(/^(.*?)(?:,\s*|\s+)(?:n[ºo°.]?\s*)?(\d{1,6}[a-zA-Z]?)\s*$/i);
  if (!match) return { street: normalized, number: '' };
  return { street: String(match[1] || '').trim().replace(/,$/, ''), number: String(match[2] || '').trim() };
}

export default function RHPDVs() {
  const [showDialog, setShowDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_PDV);
  const [search, setSearch] = useState("");
  const [isSearchingCep, setIsSearchingCep] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { data: pdvs, isLoading } = usePDVs();
  const { data: employees } = useEmployees();
  const createPDV = useCreatePDV();
  const updatePDV = useUpdatePDV();
  const deletePDV = useDeletePDV();
  const toggleActive = useTogglePDVActive();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  const handleExport = async () => {
    try {
      const token = getAuthToken();
      const res = await fetch('/api/promotor/rh/pdvs/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Erro ao exportar');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pdvs_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'Exportação concluída' });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const supervisors = (employees || []).filter((e: any) => e.worker_profile === 'supervisor' || e.worker_profile === 'administrativo');

  const handleCep = useCallback(async (cep: string) => {
    const clean = cep.replace(/\D/g, '');
    if (clean.length !== 8) {
      toast({ title: 'CEP inválido', description: 'O CEP deve ter 8 dígitos.', variant: 'destructive' });
      return;
    }

    setIsSearchingCep(true);
    try {
      const res = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
      const data = await res.json();
      if (data.erro) {
        toast({ title: 'CEP não encontrado', variant: 'destructive' });
      } else {
        setForm(f => ({ 
          ...f, 
          zip_code: clean.replace(/^(\d{5})(\d{3})$/, '$1-$2'),
          address: data.logradouro || '', 
          neighborhood: data.bairro || '', 
          city: data.localidade || '', 
          state: data.uf || '' 
        }));
        toast({ title: 'Endereço preenchido!' });
      }
    } catch (err) {
      toast({ title: 'Erro ao consultar CEP', variant: 'destructive' });
    } finally {
      setIsSearchingCep(false);
    }
  }, [toast]);

  const openCreate = () => { setForm(EMPTY_PDV); setEditId(null); setShowDialog(true); };
  const openEdit = (pdv: any) => {
    const parsed = splitAddressAndNumber(pdv.address || '');
    setForm({ name: pdv.name, client_name: pdv.client_name || '', address: parsed.street || pdv.address || '', address_number: pdv.address_number || parsed.number || '', complement: pdv.complement || '', zip_code: pdv.zip_code || '', city: pdv.city || '', state: pdv.state || '', neighborhood: pdv.neighborhood || '', latitude: pdv.latitude || '', longitude: pdv.longitude || '', radius_meters: pdv.radius_meters || 200, supervisor_id: pdv.supervisor_id || '', notes: pdv.notes || '', active: pdv.active !== false, geofence_polygon: Array.isArray(pdv.geofence_polygon) ? pdv.geofence_polygon : null, type: pdv.type || 'pdv' });
    setEditId(pdv.id);
    setShowDialog(true);
  };

  const handleSave = async () => {
    if (!form.name) { toast({ title: 'Nome obrigatório', variant: 'destructive' }); return; }
    try {
      if (editId) {
        await updatePDV.mutateAsync({ 
          id: editId, 
          ...form, 
          type: form.type, // Explicitly ensuring type is passed
          address: [form.address, form.address_number].filter(Boolean).join(', '), 
          latitude: form.latitude ? Number(form.latitude) : null, 
          longitude: form.longitude ? Number(form.longitude) : null 
        });
      } else {
        await createPDV.mutateAsync({ 
          ...form, 
          type: form.type, // Explicitly ensuring type is passed
          address: [form.address, form.address_number].filter(Boolean).join(', '), 
          latitude: form.latitude ? Number(form.latitude) : null, 
          longitude: form.longitude ? Number(form.longitude) : null 
        });
      }
      toast({ title: editId ? 'PDV atualizado!' : 'PDV criado!' });
      setShowDialog(false);
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Tem certeza que deseja excluir este PDV? Esta ação não poderá ser desfeita.')) return;
    try {
      await deletePDV.mutateAsync(id);
      toast({ title: 'PDV excluído com sucesso!' });
    } catch (err: any) {
      toast({ title: 'Erro ao excluir', description: err.message, variant: 'destructive' });
    }
  };

  const handleToggleActive = async (pdv: any) => {
    const next = pdv.active === false;
    const action = next ? 'reativar' : 'desativar';
    if (!confirm(`Deseja ${action} o PDV "${pdv.name}"?${next ? '' : ' As rotas futuras agendadas deste PDV serão removidas; o histórico será mantido.'}`)) return;
    try {
      const r = await toggleActive.mutateAsync({ id: pdv.id, active: next });
      toast({
        title: `PDV ${next ? 'reativado' : 'desativado'}!`,
        description: !next && r?.future_routes_removed ? `${r.future_routes_removed} rota(s) futura(s) removida(s).` : undefined,
      });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const filtered = (pdvs || []).filter((p: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const qDigits = search.replace(/\D/g, '');
    return (
      (p.name || '').toLowerCase().includes(q) ||
      (p.client_name || '').toLowerCase().includes(q) ||
      (p.address || '').toLowerCase().includes(q) ||
      (p.city || '').toLowerCase().includes(q) ||
      (p.neighborhood || '').toLowerCase().includes(q) ||
      (!!qDigits && (p.zip_code || '').replace(/\D/g, '').includes(qDigits))
    );
  });

  const handleBulkDelete = async () => {
    if (!selectedIds.size) return;
    if (!confirm(`Excluir ${selectedIds.size} PDV(s) selecionado(s)? Esta ação também removerá os vínculos de marcas e mix destes PDVs.`)) return;
    
    let ok = 0, fail = 0;
    for (const id of selectedIds) {
      try { 
        await deletePDV.mutateAsync(id); 
        ok++; 
      } catch { 
        fail++; 
      }
    }
    setSelectedIds(new Set());
    toast({ title: 'Exclusão em massa concluída', description: `${ok} excluído(s)${fail ? `, ${fail} erro(s)` : ''}` });
  };

  const toggleAll = () => {
    if (selectedIds.size === filtered.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(filtered.map((p: any) => p.id)));
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold flex items-center gap-2"><MapPin className="h-5 w-5" /> PDVs & Sedes</h1>
            <Button variant="outline" size="sm" asChild>
              <Link to="/merch/dashboard" className="flex items-center gap-2">
                <LayoutDashboard className="h-4 w-4" /> Dashboard
              </Link>
            </Button>
          </div>
          <div className="flex gap-2">
            {selectedIds.size > 0 && (
              <Button variant="destructive" onClick={handleBulkDelete} disabled={deletePDV.isPending}>
                <Trash2 className="h-4 w-4 mr-2" /> Excluir Selecionados ({selectedIds.size})
              </Button>
            )}
            {isAdmin && (
              <>
                <Button variant="outline" onClick={handleExport}><Download className="h-4 w-4 mr-2" /> Exportar</Button>
                <Button variant="outline" onClick={() => setShowImportDialog(true)}><Upload className="h-4 w-4 mr-2" /> Importar</Button>
              </>
            )}
            <Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Novo Item</Button>
          </div>
        </div>

        <div className="relative max-w-sm"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar PDV..." className="pl-9" /></div>

        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox 
                    checked={filtered.length > 0 && selectedIds.size === filtered.length} 
                    onCheckedChange={toggleAll} 
                  />
                </TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Cidade/UF</TableHead>
                <TableHead>Raio (m)</TableHead>
                <TableHead>Supervisor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p: any) => (
                <TableRow key={p.id} className={selectedIds.has(p.id) ? 'bg-primary/5' : ''}>
                  <TableCell>
                    <Checkbox 
                      checked={selectedIds.has(p.id)} 
                      onCheckedChange={() => toggleOne(p.id)} 
                    />
                  </TableCell>
                  <TableCell>
                    {p.type === 'sede' ? (
                      <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Sede</Badge>
                    ) : (
                      <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">PDV</Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>{p.client_name || '-'}</TableCell>
                  <TableCell>{p.city ? `${p.city}/${p.state}` : '-'}</TableCell>
                  <TableCell>{p.radius_meters}m</TableCell>
                  <TableCell className="text-sm">{p.supervisor_name || '-'}</TableCell>
                  <TableCell>{p.active ? <Badge className="bg-green-500">Ativo</Badge> : <Badge variant="secondary">Inativo</Badge>}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => handleToggleActive(p)} disabled={toggleActive.isPending} title={p.active ? 'Desativar PDV' : 'Reativar PDV'}>
                        <Power className={p.active ? "h-4 w-4 text-amber-600" : "h-4 w-4 text-green-600"} />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(p)}><Edit className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(p.id)} disabled={deletePDV.isPending}>
                        {deletePDV.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">Nenhum PDV ou Sede cadastrado</TableCell></TableRow>}
            </TableBody>
          </Table>
        </Card>

        <PDVImportDialog open={showImportDialog} onOpenChange={setShowImportDialog} />
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editId ? 'Editar PDV' : 'Novo PDV'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>Tipo de Unidade *</Label>
                <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecionar tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pdv">PDV (Ponto de Venda)</SelectItem>
                    <SelectItem value="sede">Sede / Unidade da Empresa</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1"><Label>Nome *</Label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
              <div className="space-y-1"><Label>Cliente</Label><Input value={form.client_name} onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>CEP</Label>
                <div className="flex gap-2">
                  <Input 
                    value={form.zip_code} 
                    onChange={e => setForm(f => ({ ...f, zip_code: e.target.value }))} 
                    placeholder="00000-000" 
                    onBlur={e => e.target.value.replace(/\D/g, '').length === 8 && handleCep(e.target.value)}
                  />
                  <Button 
                    type="button" 
                    size="icon" 
                    variant="outline" 
                    onClick={() => handleCep(form.zip_code)}
                    disabled={isSearchingCep}
                  >
                    {isSearchingCep ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
                <div className="space-y-1 col-span-2"><Label>Endereço</Label><Input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1"><Label>Número *</Label><Input value={form.address_number} onChange={e => setForm(f => ({ ...f, address_number: e.target.value }))} /></div>
              <div className="space-y-1"><Label>Complemento</Label><Input value={form.complement} onChange={e => setForm(f => ({ ...f, complement: e.target.value }))} /></div>
              <div className="space-y-1"><Label>Bairro</Label><Input value={form.neighborhood} onChange={e => setForm(f => ({ ...f, neighborhood: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>Cidade</Label><Input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} /></div>
              <div className="space-y-1"><Label>UF</Label><Input value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} maxLength={2} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1"><Label>Latitude</Label><Input type="number" step="any" value={form.latitude} onChange={e => setForm(f => ({ ...f, latitude: e.target.value }))} placeholder="-23.550520" /></div>
              <div className="space-y-1"><Label>Longitude</Label><Input type="number" step="any" value={form.longitude} onChange={e => setForm(f => ({ ...f, longitude: e.target.value }))} placeholder="-46.633308" /></div>
              <div className="space-y-1"><Label>Raio (metros)</Label><Input type="number" value={form.radius_meters} onChange={e => setForm(f => ({ ...f, radius_meters: Number(e.target.value) }))} /></div>
            </div>
            <GeocodeButton form={form} setForm={setForm} />
            <PdvGeofenceEditor
              value={form.geofence_polygon}
              centerLat={form.latitude}
              centerLng={form.longitude}
              radiusMeters={form.radius_meters}
              onChange={(poly) => setForm((f: any) => ({ ...f, geofence_polygon: poly }))}
              onUseCentroid={(lat, lng) => {
                setForm((f: any) => ({ ...f, latitude: lat.toFixed(6), longitude: lng.toFixed(6) }));
                toast({ title: 'Coordenadas atualizadas', description: 'Centro do polígono aplicado como lat/lng do PDV.' });
              }}
            />

            <div className="space-y-1"><Label>Supervisor</Label>
              <Select value={form.supervisor_id} onValueChange={v => setForm(f => ({ ...f, supervisor_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>{supervisors.map((s: any) => <SelectItem key={s.id} value={s.id}>{s.full_name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>Observações</Label><Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} /></div>
            <Button onClick={handleSave} className="w-full" disabled={createPDV.isPending || updatePDV.isPending}>
              {(createPDV.isPending || updatePDV.isPending) ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {editId ? 'Salvar Alterações' : 'Criar PDV'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}

function GeocodeButton({ form, setForm }: { form: any; setForm: React.Dispatch<React.SetStateAction<any>> }) {
  const geocode = useGeocode();
  const { toast } = useToast();

  const handleGeocode = async () => {
    const parsed = splitAddressAndNumber(form.address);
    const addressNumber = String(form.address_number || parsed.number || '').trim();
    const addressStreet = String(parsed.street || form.address || '').trim();
    const cleanZip = String(form.zip_code || '').replace(/\D/g, '');
    const state = String(form.state || '').trim().toUpperCase();

    if (!addressStreet || !addressNumber || !form.neighborhood || !form.city || !state || cleanZip.length !== 8) {
      toast({
        title: 'Endereço incompleto',
        description: 'Informe rua + número, bairro, cidade, UF e CEP válido para geolocalizar.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const result = await geocode.mutateAsync({
        address: addressStreet,
        address_number: addressNumber,
        complement: form.complement,
        neighborhood: form.neighborhood,
        city: form.city,
        state,
        zip_code: cleanZip,
      });
      if (result.found) {
        setForm((f: any) => ({ ...f, latitude: String(result.latitude), longitude: String(result.longitude) }));
        toast({ title: 'Coordenadas geradas!', description: result.display_name });
      } else {
        toast({ title: 'Endereço não encontrado', description: result?.attempted_address ? `Busca: ${result.attempted_address}` : 'Tente um endereço mais completo', variant: 'destructive' });
      }
    } catch (err: any) {
      const desc = [err.message, err?.attempted_address ? `Busca: ${err.attempted_address}` : null].filter(Boolean).join(' • ');
      toast({ title: 'Erro na geocodificação', description: desc, variant: 'destructive' });
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleGeocode} disabled={geocode.isPending} className="gap-2 text-xs">
      {geocode.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Navigation className="h-3.5 w-3.5" />}
      Gerar Coordenadas pelo Endereço
    </Button>
  );
}
