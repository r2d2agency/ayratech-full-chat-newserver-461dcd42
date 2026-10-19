import { useState, useMemo, useEffect } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { usePhotoBook, useRotatePhoto } from "@/hooks/use-merch-routes";
import { useBrands, useCategories } from "@/hooks/use-merchandising";
import { usePDVs } from "@/hooks/use-promotor";
import { usePromoters } from "@/hooks/use-access-control";
import { useEmployees } from "@/hooks/use-rh";
import { useRedes } from "@/hooks/use-price-research";
import { resolveMediaUrl } from "@/lib/media";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Camera, Image, Eye, Calendar, MapPin, Tag, User, ZoomIn, FileText, CheckSquare, RotateCw, RotateCcw, ChevronDown, X, Download } from "lucide-react";
import { BookEditorDialog } from "@/components/merch/BookEditorDialog";
import { exportPhotosAsJpg } from "@/lib/photo-export";
import { PhotoLightbox } from "@/components/merch/PhotoLightbox";
import { toast } from "sonner";


const PHOTO_TYPES: Record<string, string> = {
  checkin: 'Check-in', checkout: 'Check-out', before: 'Antes', after: 'Depois',
  category_before: 'Antes (Categoria)', category_after: 'Depois (Categoria)',
  stock: 'Estoque', shelf: 'Prateleira', extra_point: 'Ponto Extra',
  damage: 'Avaria', expiry: 'Validade', contingency: 'Contingência',
  rupture: 'Ruptura',
};

function MultiSelectPopover({ label, values, options, onToggle, onClear, searchPlaceholder = 'Buscar...', disabled = false }: { label: string; values: string[]; options: { id: string; name: string }[]; onToggle: (id: string) => void; onClear: () => void; searchPlaceholder?: string; disabled?: boolean }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.name?.toLowerCase().includes(q));
  }, [options, query]);
  return (
    <div className="flex-1 min-w-[170px]">
      <Popover onOpenChange={(open) => { if (!open) setQuery(''); }}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-between font-normal" disabled={disabled}>
            <span className="truncate">{label}</span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <div className="flex items-center justify-between p-2 border-b gap-2">
            <span className="text-xs text-muted-foreground">
              {values.length} selecionado{values.length === 1 ? '' : 's'}
            </span>
            {values.length > 0 && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClear}>
                <X className="h-3 w-3 mr-1" /> Limpar
              </Button>
            )}
          </div>
          <div className="p-2 border-b">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 text-sm"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-xs text-muted-foreground text-center">Nenhum resultado</div>
            )}
            {filtered.map((o) => (
              <label key={o.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-sm">
                <Checkbox checked={values.includes(o.id)} onCheckedChange={() => onToggle(o.id)} />
                <span className="truncate">{o.name}</span>
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function MerchBookFotos() {
  const [brandFilter, setBrandFilter] = useState('');
  const [pdvFilter, setPdvFilter] = useState<string[]>([]);
  const [promoterFilter, setPromoterFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [supervisorFilter, setSupervisorFilter] = useState<string[]>([]);
  const [extraSupervisors, setExtraSupervisors] = useState<{ id: string; name: string }[]>([]);
  const [photoTypeFilter, setPhotoTypeFilter] = useState<string[]>([]);
  const [redeFilter, setRedeFilter] = useState<string[]>([]);
  const [cityFilter, setCityFilter] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [dateTo, setDateTo] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
  const [sortMode, setSortMode] = useState<'date-pdv' | 'pdv-date' | 'supervisor-date' | 'promoter-date' | 'category-date' | 'brand-date'>('date-pdv');
  const [viewPhoto, setViewPhoto] = useState<any>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bookEditorOpen, setBookEditorOpen] = useState(false);
  const rotateMut = useRotatePhoto();

  const { data: brands = [] } = useBrands();
  const { data: pdvs = [] } = usePDVs();
  const { data: promoters = [] } = usePromoters();
  const { data: categories = [] } = useCategories();
  const { data: redes = [] } = useRedes();

  // Supervisors come from employees table (independent of photos having loaded).
  // A API de RH nao filtra por perfil, entao filtramos por worker_profile aqui.
  const supervisorQuery = useEmployees();
  const supervisorList = useMemo(() => {
    const arr = Array.isArray(supervisorQuery.data) ? supervisorQuery.data : [];
    return (arr as any[])
      .filter((e: any) => e?.id && (e.worker_profile === 'supervisor' || e.worker_profile === 'administrativo'))
      .map((e: any) => ({ id: e.id, name: e.full_name || e.name }));
  }, [supervisorQuery.data]);

  // City options derived from PDVs
  const cities = useMemo(() => {
    const set = new Set<string>();
    (pdvs as any[]).forEach((p: any) => { if (p.city) set.add(p.city); });
    return Array.from(set).sort();
  }, [pdvs]);

  const { data: photos = [], isLoading } = usePhotoBook({
    brand_id: brandFilter || undefined,
    pdv_id: pdvFilter.length ? pdvFilter.join(',') : undefined,
    promoter_id: promoterFilter.length ? promoterFilter.join(',') : undefined,
    category_id: categoryFilter.length ? categoryFilter.join(',') : undefined,
    supervisor_id: supervisorFilter.length ? supervisorFilter.join(',') : undefined,
    photo_type: photoTypeFilter.length ? photoTypeFilter.join(',') : undefined,
    rede_id: redeFilter.length ? redeFilter.join(',') : undefined,
    city: cityFilter.length ? cityFilter.join(',') : undefined,
    date_from: dateFrom, date_to: dateTo,
  });

  const toggleIn = (setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) => {
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const togglePdv = toggleIn(setPdvFilter);
  const togglePromoter = toggleIn(setPromoterFilter);
  const toggleCategory = toggleIn(setCategoryFilter);
  const toggleSupervisor = toggleIn(setSupervisorFilter);
  const togglePhotoType = toggleIn(setPhotoTypeFilter);
  const toggleRede = toggleIn(setRedeFilter);
  const toggleCity = toggleIn(setCityFilter);

  // Accumulate distinct supervisors seen in photos, merged over the employees list so the
  // dropdown still shows supervisors referenced by photos even if they are inactive.
  useEffect(() => {
    if (!Array.isArray(photos) || photos.length === 0) return;
    setExtraSupervisors(prev => {
      const map = new Map(prev.map(s => [s.id, s.name]));
      (photos as any[]).forEach((p: any) => {
        if (p.supervisor_id && p.supervisor_name && !map.has(p.supervisor_id)) {
          map.set(p.supervisor_id, p.supervisor_name);
        }
      });
      if (map.size === prev.length) return prev;
      return Array.from(map, ([id, name]) => ({ id, name }));
    });
  }, [photos]);

  const supervisorsFromPhotos = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    supervisorList.forEach(s => map.set(s.id, s));
    extraSupervisors.forEach(s => { if (!map.has(s.id)) map.set(s.id, s); });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [supervisorList, extraSupervisors]);

  const buildLabel = (arr: string[], list: { id: string; name: string }[], allLabel: string, singularSuffix = '') => {
    if (arr.length === 0) return allLabel;
    if (arr.length === 1) return list.find(x => x.id === arr[0])?.name || `1${singularSuffix}`;
    return `${arr.length} selecionados`;
  };
  const pdvLabel = buildLabel(pdvFilter, (pdvs as any[]).map((p: any) => ({ id: p.id, name: p.name })), 'Todos os PDVs');
  const promoterLabel = buildLabel(promoterFilter, (promoters as any[]).map((p: any) => ({ id: p.id, name: p.full_name || p.name })), 'Todos os colaboradores');
  const categoryLabel = buildLabel(categoryFilter, (categories as any[]).map((c: any) => ({ id: c.id, name: c.name })), 'Todas as categorias');
  const supervisorLabel = buildLabel(supervisorFilter, supervisorsFromPhotos, 'Todos os supervisores');
  const photoTypeLabel = photoTypeFilter.length === 0 ? 'Todos os tipos'
    : photoTypeFilter.length === 1 ? (PHOTO_TYPES[photoTypeFilter[0]] || photoTypeFilter[0])
    : `${photoTypeFilter.length} tipos`;
  const redeLabel = buildLabel(redeFilter, (redes as any[]).map((r: any) => ({ id: r.id, name: r.name })), 'Todas as redes');
  const cityLabel = cityFilter.length === 0 ? 'Todas as cidades'
    : cityFilter.length === 1 ? cityFilter[0]
    : `${cityFilter.length} cidades`;

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === photos.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set((photos as any[]).map((p: any) => p.id)));
    }
  };

  // Select all photos from a specific brand within a specific PDV
  const selectAllBrandPdv = (brandName: string, pdvName: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const matching = (photos as any[]).filter((p: any) => (p.brand_name || 'Marca') === brandName && (p.pdv_name || 'PDV') === pdvName);
      const allSelected = matching.every(p => next.has(p.id));
      if (allSelected) {
        matching.forEach(p => next.delete(p.id));
      } else {
        matching.forEach(p => next.add(p.id));
      }
      return next;
    });
  };

  const selectedPhotos = useMemo(() => 
    (photos as any[]).filter((p: any) => selectedIds.has(p.id)),
    [photos, selectedIds]
  );

  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const handleExportJpg = async () => {
    if (selectedPhotos.length === 0) return;
    setExporting(true);
    setExportProgress(0);
    try {
      const { ok, failed } = await exportPhotosAsJpg(selectedPhotos, {
        zipName: `fotos-${dateFrom}_${dateTo}`,
        onProgress: (done, total) => setExportProgress(Math.round((done / total) * 100)),
      });
      if (ok > 0) toast.success(`${ok} foto(s) exportada(s) em JPG${failed ? ` — ${failed} falharam` : ''}`);
      else toast.error('Não foi possível exportar as fotos selecionadas');
    } catch {
      toast.error('Erro ao exportar fotos');
    } finally {
      setExporting(false);
    }
  };


  // Get the first brand name from selection for the editor
  const firstBrand = selectedPhotos.length > 0 ? selectedPhotos[0].brand_name : '';
  
  // Find the matching brand object to pass logo_url
  const selectedBrandObj = useMemo(() => {
    if (!firstBrand) return null;
    return (brands as any[]).find((b: any) => b.name === firstBrand) || null;
  }, [firstBrand, brands]);

  // Two-level grouping controlled by sortMode.
  // Level 1 = section header, Level 2 = card. Photos inside a card are always sub-grouped by brand.
  const SORT_CONFIG: Record<typeof sortMode, { l1: (p: any) => string; l2: (p: any) => string; l1Label: string; l2Icon: 'date' | 'pdv' | 'user'; l1SortDesc?: boolean }> = {
    'date-pdv':       { l1: p => p.captured_at?.slice(0, 10) || 'sem-data', l2: p => p.pdv_name || 'PDV',           l1Label: 'date',       l2Icon: 'pdv',  l1SortDesc: true },
    'pdv-date':       { l1: p => p.pdv_name || 'PDV',                       l2: p => p.captured_at?.slice(0, 10) || 'sem-data', l1Label: 'text', l2Icon: 'date' },
    'supervisor-date':{ l1: p => p.supervisor_name || 'Sem supervisor',     l2: p => p.captured_at?.slice(0, 10) || 'sem-data', l1Label: 'text', l2Icon: 'date' },
    'promoter-date':  { l1: p => p.promoter_name || 'Sem promotor',         l2: p => p.captured_at?.slice(0, 10) || 'sem-data', l1Label: 'text', l2Icon: 'date' },
    'category-date':  { l1: p => p.category_name || 'Sem categoria',        l2: p => p.captured_at?.slice(0, 10) || 'sem-data', l1Label: 'text', l2Icon: 'date' },
    'brand-date':     { l1: p => p.brand_name || 'Sem marca',               l2: p => p.captured_at?.slice(0, 10) || 'sem-data', l1Label: 'text', l2Icon: 'date' },
  } as any;

  const cfg = SORT_CONFIG[sortMode];
  const grouped = (photos as any[]).reduce((acc: any, p: any) => {
    const k1 = cfg.l1(p);
    const k2 = cfg.l2(p);
    const brand = p.brand_name || 'Marca';
    if (!acc[k1]) acc[k1] = {};
    if (!acc[k1][k2]) acc[k1][k2] = {};
    if (!acc[k1][k2][brand]) acc[k1][k2][brand] = [];
    acc[k1][k2][brand].push(p);
    return acc;
  }, {} as Record<string, any>);

  const sortedL1 = Object.keys(grouped).sort((a, b) => cfg.l1SortDesc ? b.localeCompare(a) : a.localeCompare(b));
  const formatDateHeader = (d: string) => d && d !== 'sem-data'
    ? new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
    : 'Sem data';
  const renderL1Header = (k: string) => cfg.l1Label === 'date' ? formatDateHeader(k) : k;
  const sortedL2Keys = (obj: any) => Object.keys(obj).sort((a, b) => cfg.l2Icon === 'date' ? b.localeCompare(a) : a.localeCompare(b));

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Filters */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[150px]">
                <Select value={brandFilter || '__all__'} onValueChange={v => setBrandFilter(v === '__all__' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder="Marca" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Todas as marcas</SelectItem>
                    {brands.filter((b: any) => b?.id).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <MultiSelectPopover label={pdvLabel} values={pdvFilter} options={(pdvs as any[]).filter((p: any) => p?.id).map((p: any) => ({ id: p.id, name: p.name }))} onToggle={togglePdv} onClear={() => setPdvFilter([])} />
              <MultiSelectPopover label={promoterLabel} values={promoterFilter} options={(promoters as any[]).filter((p: any) => p?.id).map((p: any) => ({ id: p.id, name: p.full_name || p.name }))} onToggle={togglePromoter} onClear={() => setPromoterFilter([])} />
              <MultiSelectPopover label={supervisorLabel} values={supervisorFilter} options={supervisorsFromPhotos} onToggle={toggleSupervisor} onClear={() => setSupervisorFilter([])} disabled={supervisorsFromPhotos.length === 0} />
              <MultiSelectPopover label={categoryLabel} values={categoryFilter} options={(categories as any[]).filter((c: any) => c?.id).map((c: any) => ({ id: c.id, name: c.name }))} onToggle={toggleCategory} onClear={() => setCategoryFilter([])} />
              <MultiSelectPopover label={photoTypeLabel} values={photoTypeFilter} options={Object.entries(PHOTO_TYPES).map(([id, name]) => ({ id, name }))} onToggle={togglePhotoType} onClear={() => setPhotoTypeFilter([])} />
              <MultiSelectPopover label={redeLabel} values={redeFilter} options={(redes as any[]).filter((r: any) => r?.id).map((r: any) => ({ id: r.id, name: r.name }))} onToggle={toggleRede} onClear={() => setRedeFilter([])} />
              <MultiSelectPopover label={cityLabel} values={cityFilter} options={cities.map((c) => ({ id: c, name: c }))} onToggle={toggleCity} onClear={() => setCityFilter([])} />
              <div>
                <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36" />
              </div>
              <div>
                <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36" />
              </div>
              <div className="flex-1 min-w-[200px]">
                <Select value={sortMode} onValueChange={(v) => setSortMode(v as any)}>
                  <SelectTrigger><SelectValue placeholder="Ordenar por" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="date-pdv">Ordenar: Data → Loja</SelectItem>
                    <SelectItem value="pdv-date">Ordenar: Loja → Data</SelectItem>
                    <SelectItem value="supervisor-date">Ordenar: Supervisor → Data</SelectItem>
                    <SelectItem value="promoter-date">Ordenar: Colaborador → Data</SelectItem>
                    <SelectItem value="category-date">Ordenar: Categoria → Data</SelectItem>
                    <SelectItem value="brand-date">Ordenar: Marca → Data</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(brandFilter || pdvFilter.length || promoterFilter.length || categoryFilter.length || supervisorFilter.length || photoTypeFilter.length || redeFilter.length || cityFilter.length) ? (
                <Button variant="ghost" size="sm" onClick={() => { setBrandFilter(''); setPdvFilter([]); setPromoterFilter([]); setCategoryFilter([]); setSupervisorFilter([]); setPhotoTypeFilter([]); setRedeFilter([]); setCityFilter([]); }}>
                  <X className="h-4 w-4 mr-1" /> Limpar filtros
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Selection bar */}
        {photos.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <Button variant="outline" size="sm" onClick={toggleSelectAll}>
              <CheckSquare className="h-4 w-4 mr-1" />
              {selectedIds.size === photos.length ? 'Desmarcar tudo' : 'Selecionar tudo'}
            </Button>
            {selectedIds.size > 0 && (
              <>
                <Badge variant="default" className="text-sm">{selectedIds.size} selecionadas</Badge>
                <Button size="sm" onClick={() => setBookEditorOpen(true)}>
                  <FileText className="h-4 w-4 mr-1" /> Criar Book (PDF)
                </Button>
                <Button size="sm" variant="outline" disabled={exporting} onClick={handleExportJpg}>
                  <Download className="h-4 w-4 mr-1" />
                  {exporting ? `Exportando ${exportProgress}%` : 'Exportar JPG'}
                </Button>
              </>
            )}

          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="pt-4 text-center">
            <Camera className="h-5 w-5 mx-auto mb-1 text-primary" />
            <div className="text-2xl font-bold">{photos.length}</div>
            <p className="text-xs text-muted-foreground">Total de fotos</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4 text-center">
            <Calendar className="h-5 w-5 mx-auto mb-1 text-primary" />
            <div className="text-2xl font-bold">{new Set((photos as any[]).map((p: any) => p.captured_at?.slice(0,10))).size}</div>
            <p className="text-xs text-muted-foreground">Dias com fotos</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4 text-center">
            <MapPin className="h-5 w-5 mx-auto mb-1 text-primary" />
            <div className="text-2xl font-bold">{new Set((photos as any[]).map((p: any) => p.pdv_id)).size}</div>
            <p className="text-xs text-muted-foreground">PDVs</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4 text-center">
            <User className="h-5 w-5 mx-auto mb-1 text-primary" />
            <div className="text-2xl font-bold">{new Set((photos as any[]).map((p: any) => p.promoter_id)).size}</div>
            <p className="text-xs text-muted-foreground">Promotores</p>
          </CardContent></Card>
        </div>

        {/* Empty state: distinguish "no photos for these filters" from a broken filter */}
        {!isLoading && photos.length === 0 && (
          <Card><CardContent className="pt-6 text-center space-y-2">
            <Camera className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-sm font-medium">Nenhuma foto encontrada</p>
            <p className="text-xs text-muted-foreground">
              Nenhuma foto no período de {dateFrom} a {dateTo} com os filtros selecionados.
              {' '}Tente ampliar as datas ou limpar os filtros.
            </p>
            <Button variant="outline" size="sm" onClick={() => {
              setBrandFilter(''); setPdvFilter([]); setPromoterFilter([]); setCategoryFilter([]);
              setSupervisorFilter([]); setPhotoTypeFilter([]); setRedeFilter([]); setCityFilter([]);
            }}>
              <X className="h-4 w-4 mr-1" /> Limpar filtros
            </Button>
          </CardContent></Card>
        )}

        {/* Photo Grid grouped */}
        {sortedL1.map(k1 => (
          <div key={k1} className="space-y-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              {cfg.l1Label === 'date' ? <Calendar className="h-4 w-4" /> : cfg.l2Icon === 'date' && sortMode === 'pdv-date' ? <MapPin className="h-4 w-4" /> : <User className="h-4 w-4" />}
              {renderL1Header(k1)}
            </h2>
            {sortedL2Keys(grouped[k1]).map((k2) => {
              const brandGroups = grouped[k1][k2];
              const l2Title = cfg.l2Icon === 'date' ? formatDateHeader(k2) : k2;
              return (
              <Card key={k2}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">{cfg.l2Icon === 'date' ? <Calendar className="h-4 w-4" /> : <MapPin className="h-4 w-4" />} {l2Title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Object.entries(brandGroups).map(([brand, bPhotos]: [string, any]) => {
                    const allBrandPdvSelected = bPhotos.every((p: any) => selectedIds.has(p.id));
                    return (
                    <div key={brand}>
                      <div className="flex items-center gap-2 mb-2">
                        <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-xs font-medium">{brand}</span>
                        <Badge variant="secondary" className="text-[10px]">{bPhotos.length} fotos</Badge>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="h-6 px-2 text-[10px]"
                          onClick={() => {
                            setSelectedIds(prev => {
                              const next = new Set(prev);
                              const all = bPhotos.every((p: any) => next.has(p.id));
                              bPhotos.forEach((p: any) => all ? next.delete(p.id) : next.add(p.id));
                              return next;
                            });
                          }}
                        >
                          <CheckSquare className="h-3 w-3 mr-1" />
                          {allBrandPdvSelected ? 'Desmarcar' : 'Selecionar todas'}
                        </Button>
                      </div>
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                        {bPhotos.map((photo: any) => {
                          const photoUrl = resolveMediaUrl(photo.photo_url);
                          if (!photoUrl) return null;
                          const isSelected = selectedIds.has(photo.id);

                          return (
                          <div key={photo.id} className={`relative group cursor-pointer aspect-square rounded-lg overflow-hidden border bg-muted ${isSelected ? 'ring-2 ring-primary' : ''}`}>
                            {/* Checkbox */}
                            <div className="absolute top-1 left-1 z-10" onClick={e => { e.stopPropagation(); toggleSelect(photo.id); }}>
                              <Checkbox checked={isSelected} className="bg-background/80 border-background/80" />
                            </div>
                            <div onClick={() => setViewPhoto({ ...photo, photo_url: photoUrl })}>
                              {photoUrl ? (
                                <img 
                                  src={photoUrl} 
                                  alt={photo.product_name || photo.category_name || 'Foto de execução'} 
                                  className="w-full h-full object-cover transition-transform" 
                                  style={photo.rotation ? { transform: `rotate(${photo.rotation}deg)` } : undefined}
                                  loading="lazy" 
                                  onError={(e) => {
                                    // If image fails (session blob), hide it from the book selection
                                    const target = e.target as HTMLImageElement;
                                    const parent = target.closest('.relative');
                                    if (parent) (parent as HTMLElement).style.display = 'none';
                                  }}
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center"><Image className="h-6 w-6 text-muted-foreground" /></div>
                              )}
                              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                                <ZoomIn className="h-5 w-5 text-white" />
                              </div>
                            </div>
                            <Badge className="absolute bottom-1 left-1 text-[8px] py-0 px-1" variant="secondary">
                              {PHOTO_TYPES[photo.photo_type] || photo.photo_type}
                            </Badge>
                            {photo.upload_source === 'web' && (
                              <Badge className="absolute top-1 right-1 text-[8px] py-0 px-1 bg-orange-500 text-white">WEB</Badge>
                            )}
                          </div>
                        )})}
                      </div>
                    </div>
                  )})}
                </CardContent>
              </Card>
              );
            })}
          </div>
        ))}

        {photos.length === 0 && !isLoading && (
          <Card><CardContent className="py-12 text-center text-muted-foreground">
            <Camera className="h-12 w-12 mx-auto mb-3 opacity-40" />
            <p>Nenhuma foto encontrada no período selecionado</p>
          </CardContent></Card>
        )}
      </div>

      {/* Photo Viewer (zoom + rotação + download JPG) */}
      <PhotoLightbox
        photo={viewPhoto}
        onClose={() => setViewPhoto(null)}
        typeLabels={PHOTO_TYPES}
        onRotate={async (delta) => {
          try {
            const r = await rotateMut.mutateAsync({ id: viewPhoto.id, delta });
            setViewPhoto({ ...viewPhoto, rotation: r.rotation });
          } catch { toast.error('Não foi possível girar a foto'); }
        }}
      />


      {/* Book Editor */}
      {bookEditorOpen && (
        <BookEditorDialog
          open={bookEditorOpen}
          onOpenChange={setBookEditorOpen}
          photos={selectedPhotos}
          brandName={firstBrand}
          brandLogoUrl={selectedBrandObj?.logo_url || undefined}
          brands={brands as any[]}
        />
      )}
    </MainLayout>
  );
}
