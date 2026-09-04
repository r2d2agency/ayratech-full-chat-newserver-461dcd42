import { useMemo, useState } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Sparkles, Search, Plus, Pencil, Trash2, Download, Bug, Wrench } from "lucide-react";
import { toast } from "sonner";
import {
  useChangelog, useChangelogAreas, useCreateChangelogEntry,
  useUpdateChangelogEntry, useDeleteChangelogEntry,
  type ChangelogEntry, type ChangelogEntryInput,
} from "@/hooks/use-changelog";

const EMPTY_FORM: ChangelogEntryInput = {
  entry_date: new Date().toISOString().slice(0, 10),
  type: "bug",
  area: "",
  title: "",
  problem_text: "",
  solution_text: "",
  ref: "",
};

function brDate(d?: string | null) {
  if (!d) return "-";
  return new Date(`${d}T12:00:00`).toLocaleDateString("pt-BR");
}

export default function RHChangelog() {
  const [typeFilter, setTypeFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filters = useMemo(() => ({
    type: typeFilter !== "all" ? typeFilter : undefined,
    area: areaFilter !== "all" ? areaFilter : undefined,
    q: search || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  }), [typeFilter, areaFilter, search, dateFrom, dateTo]);

  const { data: entries = [], isLoading } = useChangelog(filters);
  const { data: areas = [] } = useChangelogAreas();

  const createEntry = useCreateChangelogEntry();
  const updateEntry = useUpdateChangelogEntry();
  const deleteEntry = useDeleteChangelogEntry();

  const [showEditor, setShowEditor] = useState(false);
  const [editing, setEditing] = useState<ChangelogEntry | null>(null);
  const [form, setForm] = useState<ChangelogEntryInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setShowEditor(true); };
  const openEdit = (e: ChangelogEntry) => {
    setEditing(e);
    setForm({
      entry_date: e.entry_date?.slice(0, 10) || EMPTY_FORM.entry_date,
      type: e.type, area: e.area || "", title: e.title,
      problem_text: e.problem_text || "", solution_text: e.solution_text || "", ref: e.ref || "",
    });
    setShowEditor(true);
  };

  const handleSave = async () => {
    if (!form.title?.trim()) { toast.error("Escreva um título para a entrada."); return; }
    setSaving(true);
    try {
      if (editing) {
        await updateEntry.mutateAsync({ id: editing.id, ...form });
        toast.success("Entrada atualizada.");
      } else {
        await createEntry.mutateAsync(form);
        toast.success("Entrada publicada no changelog.");
      }
      setShowEditor(false);
    } catch (err: any) {
      toast.error(err?.message || "Erro ao salvar entrada.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (e: ChangelogEntry) => {
    if (!window.confirm(`Remover "${e.title}" do changelog?`)) return;
    try {
      await deleteEntry.mutateAsync(e.id);
      toast.success("Entrada removida.");
    } catch (err: any) {
      toast.error(err?.message || "Erro ao remover entrada.");
    }
  };

  const handleExportPDF = async () => {
    if (!entries.length) { toast.error("Nada para exportar com os filtros atuais."); return; }
    try {
      const [{ default: jsPDF }, autoTableMod] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);
      const autoTable = (autoTableMod as any).default || (autoTableMod as any);
      const doc = new jsPDF("l", "mm", "a4");
      const pageWidth = doc.internal.pageSize.getWidth();

      doc.setFillColor(30, 30, 46);
      doc.rect(0, 0, pageWidth, 32, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("Changelog — Correções e Melhorias", 12, 14);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      const periodStr = (dateFrom || dateTo)
        ? `Período: ${dateFrom ? brDate(dateFrom) : "início"} a ${dateTo ? brDate(dateTo) : "hoje"} • Gerado em ${new Date().toLocaleString("pt-BR")}`
        : `Gerado em ${new Date().toLocaleString("pt-BR")}`;
      doc.text(periodStr, 12, 21);

      const body = entries.map((e) => [
        brDate(e.entry_date),
        e.type === "melhoria" ? "Melhoria" : "Bug",
        e.area || "-",
        e.title,
        e.problem_text || "-",
        e.solution_text || "-",
      ]);

      autoTable(doc, {
        startY: 38,
        head: [["Data", "Tipo", "Área", "Título", "Problema", "Solução"]],
        body,
        styles: { fontSize: 7.5, cellPadding: 2, overflow: "linebreak", valign: "top" },
        headStyles: { fillColor: [30, 30, 46], textColor: 255, fontStyle: "bold", fontSize: 7.5 },
        alternateRowStyles: { fillColor: [245, 245, 250] },
        columnStyles: {
          0: { cellWidth: 20 }, 1: { cellWidth: 18 }, 2: { cellWidth: 38 },
          3: { cellWidth: 48 }, 4: { cellWidth: 62 }, 5: { cellWidth: 62 },
        },
        margin: { left: 8, right: 8 },
      });

      const pageCount = doc.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(150, 150, 150);
        doc.text(`AyraTech • Changelog do produto • Página ${i}/${pageCount}`,
          pageWidth / 2, doc.internal.pageSize.getHeight() - 5, { align: "center" });
      }
      doc.save(`changelog_${dateFrom || "inicio"}_${dateTo || "hoje"}.pdf`);
    } catch (err: any) {
      toast.error("Erro ao exportar PDF: " + (err?.message || err));
    }
  };

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Sparkles className="h-6 w-6 text-primary" /> Atualizações
            </h1>
            <p className="text-muted-foreground text-sm">
              Registro interno de bugs corrigidos e melhorias entregues no app — use para comunicar o cliente.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExportPDF} className="gap-2">
              <Download className="h-4 w-4" /> Exportar PDF
            </Button>
            <Button size="sm" onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" /> Nova entrada
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-3 flex-wrap">
              <div className="flex-1 min-w-[220px] relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Buscar por título, área ou descrição..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full md:w-44"><SelectValue placeholder="Tipo" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os tipos</SelectItem>
                  <SelectItem value="bug">Bug corrigido</SelectItem>
                  <SelectItem value="melhoria">Melhoria</SelectItem>
                </SelectContent>
              </Select>
              <Select value={areaFilter} onValueChange={setAreaFilter}>
                <SelectTrigger className="w-full md:w-52"><SelectValue placeholder="Área" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as áreas</SelectItem>
                  {areas.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input type="date" className="w-full md:w-40" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              <Input type="date" className="w-full md:w-40" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              {(typeFilter !== "all" || areaFilter !== "all" || search || dateFrom || dateTo) && (
                <Button variant="ghost" size="sm" onClick={() => { setTypeFilter("all"); setAreaFilter("all"); setSearch(""); setDateFrom(""); setDateTo(""); }}>
                  Limpar filtros
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-8">Carregando...</p>
        ) : entries.length === 0 ? (
          <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">
            Nenhuma entrada encontrada com esses filtros.
          </CardContent></Card>
        ) : (
          <div className="space-y-3">
            {entries.map((e) => (
              <Card key={e.id} className="hover:border-primary/30 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={e.type === "melhoria"
                        ? "gap-1 border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                        : "gap-1 border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"}>
                        {e.type === "melhoria" ? <Wrench className="h-3 w-3" /> : <Bug className="h-3 w-3" />}
                        {e.type === "melhoria" ? "Melhoria" : "Bug corrigido"}
                      </Badge>
                      {e.area && <Badge variant="secondary" className="text-[11px]">{e.area}</Badge>}
                      <span className="text-xs text-muted-foreground">{brDate(e.entry_date)}</span>
                      {e.ref && <span className="text-[10px] font-mono text-muted-foreground">#{e.ref}</span>}
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(e)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(e)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <h3 className="font-semibold mt-2">{e.title}</h3>
                  {(e.problem_text || e.solution_text) && (
                    <div className="grid md:grid-cols-2 gap-3 mt-2">
                      {e.problem_text && (
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Problema</p>
                          <p className="text-sm text-muted-foreground mt-0.5">{e.problem_text}</p>
                        </div>
                      )}
                      {e.solution_text && (
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">O que mudou</p>
                          <p className="text-sm text-muted-foreground mt-0.5">{e.solution_text}</p>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={showEditor} onOpenChange={setShowEditor}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar entrada" : "Nova entrada no changelog"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Data</Label>
                <Input type="date" value={form.entry_date} onChange={(e) => setForm((f) => ({ ...f, entry_date: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Tipo</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bug">Bug corrigido</SelectItem>
                    <SelectItem value="melhoria">Melhoria</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Área</Label>
              <Input placeholder="Ex.: Fotos e marca d'água" value={form.area || ""} onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Título</Label>
              <Input placeholder="Resumo em uma linha" value={form.title || ""} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Problema (opcional)</Label>
              <Textarea rows={3} placeholder="O que o usuário via de errado" value={form.problem_text || ""} onChange={(e) => setForm((f) => ({ ...f, problem_text: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>O que mudou (opcional)</Label>
              <Textarea rows={3} placeholder="O que foi corrigido/entregue" value={form.solution_text || ""} onChange={(e) => setForm((f) => ({ ...f, solution_text: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Referência (opcional)</Label>
              <Input placeholder="Ex.: hash do commit" value={form.ref || ""} onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditor(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
