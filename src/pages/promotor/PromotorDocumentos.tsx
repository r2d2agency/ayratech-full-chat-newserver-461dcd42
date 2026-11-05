import { useState, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { usePromotorDocuments, usePromotorConfirmDocument, usePromotorViewDocument, usePromotorPayslips, usePromotorTimesheets, usePromotorInboundDocuments, usePromotorSendDocument, usePromotorSignDocument } from "@/hooks/use-promotor";
import { useUpload } from "@/hooks/use-upload";
import { PromotorLayout } from "./PromotorLayout";
import { FileText, Eye, Check, Clock, Loader2, Upload, Camera, Image, Download, Send, CheckCircle2 } from "lucide-react";
import { LocalImage } from "@/components/promotor/LocalImage";
import { format } from "date-fns";

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  enviado: { label: 'Novo', color: 'bg-blue-500' },
  entregue: { label: 'Entregue', color: 'bg-blue-400' },
  visualizado: { label: 'Visualizado', color: 'bg-yellow-500' },
  confirmado: { label: 'Confirmado', color: 'bg-green-500' },
  assinado: { label: 'Assinado', color: 'bg-green-600' },
  recusado: { label: 'Recusado', color: 'bg-red-500' },
  expirado: { label: 'Expirado', color: 'bg-gray-500' },
  cancelado: { label: 'Cancelado', color: 'bg-gray-400' },
};

const DOC_CATEGORIES = [
  { value: 'atestado', label: 'Atestado Médico' },
  { value: 'comprovante', label: 'Comprovante' },
  { value: 'documento_pessoal', label: 'Documento Pessoal' },
  { value: 'recibo', label: 'Recibo' },
  { value: 'relatorio', label: 'Relatório' },
  { value: 'solicitacao', label: 'Solicitação' },
  { value: 'outro', label: 'Outro' },
];

export default function PromotorDocumentos() {
  const [tab, setTab] = useState("pendentes");
  const [selectedDoc, setSelectedDoc] = useState<any>(null);
  const { data: docs, isLoading } = usePromotorDocuments();
  const { data: payslips } = usePromotorPayslips();
  const { data: timesheets } = usePromotorTimesheets();
  const { data: inboundDocs } = usePromotorInboundDocuments();
  const confirmDoc = usePromotorConfirmDocument();
  const viewDoc = usePromotorViewDocument();
  const sendDoc = usePromotorSendDocument();
  const signDoc = usePromotorSignDocument();
  const { uploadFile, isUploading, progress } = useUpload(() => localStorage.getItem('promotor_token'));
  const { toast } = useToast();

  const [signName, setSignName] = useState("");
  const [geo, setGeo] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });

  const requestGeo = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeo({ lat: null, lng: null }),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Send form state
  const [category, setCategory] = useState("");
  const [title, setTitle] = useState("");
  const [observation, setObservation] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const pending = (docs || []).filter((d: any) => ['enviado', 'entregue', 'visualizado'].includes(d.status));
  const completed = (docs || []).filter((d: any) => ['confirmado', 'assinado'].includes(d.status));

  const handleView = async (doc: any) => {
    setSelectedDoc(doc);
    if (['enviado', 'entregue'].includes(doc.status)) {
      try { await viewDoc.mutateAsync(doc.id); } catch {}
    }
  };

  const handleConfirm = async (id: string) => {
    try {
      await confirmDoc.mutateAsync(id);
      toast({ title: 'Recebimento confirmado!' });
      setSelectedDoc(null);
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleSign = async (id: string, signature_image?: string) => {
    try {
      requestGeo();
      await signDoc.mutateAsync({
        id,
        data: {
          signature_name: signName || selectedDoc?.employee_name || undefined,
          signature_image: signature_image || undefined,
          latitude: geo.lat,
          longitude: geo.lng,
        },
      });
      toast({ title: 'Documento assinado com sucesso!' });
      setSelectedDoc(null);
      setSignName("");
      setGeo({ lat: null, lng: null });
    } catch (err: any) {
      toast({ title: 'Erro ao assinar', description: err.message, variant: 'destructive' });
    }
  };

  const handleFileSelect = (file: File | null) => {
    if (!file) return;
    setSelectedFile(file);
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  };

  const handleSendDocument = async () => {
    if (!category || !selectedFile) {
      toast({ title: 'Preencha a categoria e selecione um arquivo', variant: 'destructive' });
      return;
    }

    try {
      const fileUrl = await uploadFile(selectedFile);
      if (!fileUrl) throw new Error('Falha no upload');

      await sendDoc.mutateAsync({
        category,
        title: title || `${DOC_CATEGORIES.find(c => c.value === category)?.label || category} - ${format(new Date(), 'dd/MM/yyyy')}`,
        file_url: fileUrl,
        observation,
      });

      toast({ title: 'Documento enviado com sucesso!' });
      setCategory("");
      setTitle("");
      setObservation("");
      setSelectedFile(null);
      setPreviewUrl(null);
    } catch (err: any) {
      toast({ title: 'Erro ao enviar', description: err.message, variant: 'destructive' });
    }
  };

  const resetForm = () => {
    setCategory("");
    setTitle("");
    setObservation("");
    setSelectedFile(null);
    setPreviewUrl(null);
  };

  return (
    <PromotorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2"><FileText className="h-5 w-5" /> Meus Documentos</h1>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full grid grid-cols-5">
            <TabsTrigger value="pendentes" className="text-[10px] px-1">Pendentes{pending.length > 0 && ` (${pending.length})`}</TabsTrigger>
            <TabsTrigger value="concluidos" className="text-[10px] px-1">Concluídos</TabsTrigger>
            <TabsTrigger value="enviar" className="text-[10px] px-1">Enviar</TabsTrigger>
            <TabsTrigger value="holerites" className="text-[10px] px-1">Holerites</TabsTrigger>
            <TabsTrigger value="espelho" className="text-[10px] px-1">Espelho</TabsTrigger>
          </TabsList>

          <TabsContent value="pendentes" className="space-y-2 mt-3">
            {pending.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">Nenhum documento pendente</p>}
            {pending.map((doc: any) => (
              <Card key={doc.id} className="cursor-pointer hover:bg-muted/30" onClick={() => handleView(doc)}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.title}</p>
                    <p className="text-xs text-muted-foreground">{doc.type_name || 'Documento'} • {format(new Date(doc.created_at), 'dd/MM/yyyy HH:mm')}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {doc.requires_signature && <Badge variant="outline" className="text-[10px]">Assinar</Badge>}
                    <Badge className={STATUS_MAP[doc.status]?.color || 'bg-gray-400'}>{STATUS_MAP[doc.status]?.label || doc.status}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="concluidos" className="space-y-2 mt-3">
            {completed.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">Nenhum documento concluído</p>}
            {completed.map((doc: any) => (
              <Card key={doc.id} className="cursor-pointer hover:bg-muted/30" onClick={() => handleView(doc)}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.title}</p>
                    <p className="text-xs text-muted-foreground">{format(new Date(doc.created_at), 'dd/MM/yyyy')}</p>
                  </div>
                  <Badge className="bg-green-500">{STATUS_MAP[doc.status]?.label}</Badge>
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          {/* ENVIAR DOCUMENTO */}
          <TabsContent value="enviar" className="space-y-4 mt-3">
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Categoria *</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a categoria" />
                    </SelectTrigger>
                    <SelectContent>
                      {DOC_CATEGORIES.map(c => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-medium">Título (opcional)</Label>
                  <Input
                    placeholder="Ex: Atestado médico 30/03"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-medium">Descrição (opcional)</Label>
                  <Textarea
                    placeholder="Observações sobre o documento..."
                    value={observation}
                    onChange={e => setObservation(e.target.value)}
                    rows={2}
                  />
                </div>

                {/* File selection */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Arquivo *</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Image className="h-4 w-4 mr-2" />
                      Galeria
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => cameraInputRef.current?.click()}
                    >
                      <Camera className="h-4 w-4 mr-2" />
                      Câmera
                    </Button>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
                    className="hidden"
                    onChange={e => handleFileSelect(e.target.files?.[0] || null)}
                  />
                  <input
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={e => handleFileSelect(e.target.files?.[0] || null)}
                  />
                </div>

                {/* Preview */}
                {selectedFile && (
                  <div className="rounded-lg border border-border p-3 bg-muted/30">
                    {previewUrl ? (
                      <LocalImage src={previewUrl} alt="Preview" className="w-full max-h-48 object-contain rounded" />
                    ) : (
                      <div className="flex items-center gap-2">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                        <span className="text-sm truncate">{selectedFile.name}</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      {selectedFile.name} • {(selectedFile.size / 1024).toFixed(0)} KB
                    </p>
                  </div>
                )}

                {/* Upload progress */}
                {isUploading && (
                  <div className="space-y-1">
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
                    </div>
                    <p className="text-xs text-muted-foreground text-center">Enviando... {progress}%</p>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={resetForm} disabled={isUploading || sendDoc.isPending}>
                    Limpar
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={handleSendDocument}
                    disabled={!category || !selectedFile || isUploading || sendDoc.isPending}
                  >
                    {(isUploading || sendDoc.isPending) ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Send className="h-4 w-4 mr-2" />
                    )}
                    Enviar
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Sent documents list */}
            {(inboundDocs || []).length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-muted-foreground">Enviados anteriormente</h3>
                {(inboundDocs || []).map((doc: any) => (
                  <Card key={doc.id}>
                    <CardContent className="p-3 flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{doc.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {DOC_CATEGORIES.find(c => c.value === doc.category)?.label || doc.category}
                          {doc.created_at && ` • ${format(new Date(doc.created_at), 'dd/MM/yyyy HH:mm')}`}
                        </p>
                      </div>
                      <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="holerites" className="space-y-2 mt-3">
            {(payslips || []).length === 0 && <p className="text-center text-sm text-muted-foreground py-8">Nenhum holerite disponível</p>}
            {(payslips || []).map((p: any) => (
              <Card key={p.id}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Competência: {p.reference_month}</p>
                    <p className="text-xs text-muted-foreground">Líquido: R$ {Number(p.net_salary || 0).toFixed(2)}</p>
                  </div>
                  {p.pdf_url && <Button size="sm" variant="outline"><Download className="h-3 w-3 mr-1" /> PDF</Button>}
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="espelho" className="space-y-2 mt-3">
            {(timesheets || []).length === 0 && <p className="text-center text-sm text-muted-foreground py-8">Nenhum espelho de ponto</p>}
            {(timesheets || []).map((t: any) => (
              <Card key={t.id}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Referência: {t.reference_month}</p>
                    <p className="text-xs text-muted-foreground">Total: {t.total_hours}h • Extras: {t.overtime_hours}h</p>
                  </div>
                  <Badge variant="outline">{t.status}</Badge>
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        </Tabs>
      </div>

      {/* Document detail dialog */}
      <Dialog open={!!selectedDoc} onOpenChange={() => setSelectedDoc(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{selectedDoc?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{selectedDoc?.description || 'Sem descrição'}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Enviado em {selectedDoc?.sent_at ? format(new Date(selectedDoc.sent_at), 'dd/MM/yyyy HH:mm') : '-'}</span>
            </div>
            {selectedDoc?.file_url && (
              (() => {
                const needsAction =
                  (selectedDoc?.requires_signature && !['assinado'].includes(selectedDoc?.status)) ||
                  (!selectedDoc?.requires_signature && selectedDoc?.requires_confirmation && !['confirmado', 'assinado'].includes(selectedDoc?.status));
                if (needsAction) {
                  return (
                    <p className="text-xs text-center text-muted-foreground">
                      Visualize o arquivo apenas após confirmar/assinar o recebimento.
                    </p>
                  );
                }
                return (
                  <div className="space-y-2">
                    {selectedDoc.signed_file_url ? (
                      <Button variant="outline" className="w-full" onClick={() => window.open(selectedDoc.signed_file_url, '_blank')}>
                        <Eye className="h-4 w-4 mr-2" /> Visualizar Cópia Assinada
                      </Button>
                    ) : (
                      <Button variant="outline" className="w-full" onClick={() => window.open(selectedDoc.file_url, '_blank')}>
                        <Eye className="h-4 w-4 mr-2" /> Visualizar Documento
                      </Button>
                    )}
                  </div>
                );
              })()
            )}
            {selectedDoc?.requires_signature && !['assinado', 'recusado', 'cancelado', 'expirado'].includes(selectedDoc?.status) && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground text-center">
                  Este documento exige assinatura. Desenhe sua assinatura abaixo e confirme o recebimento.
                </p>
                <div className="space-y-1">
                  <Label>Nome completo</Label>
                  <Input value={signName} onChange={(e) => setSignName(e.target.value)} placeholder={selectedDoc?.employee_name || 'Digite seu nome completo'} />
                </div>
                <div className="space-y-1">
                  <Label>Assinatura digital (desenhe)</Label>
                  <div className="border rounded-lg overflow-hidden bg-white">
                    <canvas
                      ref={(el) => { (window as any)._sigCanvas = el; }}
                      width={320}
                      height={120}
                      className="w-full touch-none"
                      onPointerDown={(e) => {
                        const canvas = e.currentTarget as HTMLCanvasElement;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) return;
                        (canvas as any)._drawing = true;
                        const rect = canvas.getBoundingClientRect();
                        ctx.beginPath();
                        ctx.moveTo((e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height));
                      }}
                      onPointerMove={(e) => {
                        const canvas = e.currentTarget as HTMLCanvasElement;
                        if (!(canvas as any)._drawing) return;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) return;
                        const rect = canvas.getBoundingClientRect();
                        ctx.lineWidth = 2;
                        ctx.lineCap = 'round';
                        ctx.strokeStyle = '#000';
                        ctx.lineTo((e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height));
                        ctx.stroke();
                      }}
                      onPointerUp={(e) => { const canvas = e.currentTarget as HTMLCanvasElement; (canvas as any)._drawing = false; }}
                      onPointerLeave={(e) => { const canvas = e.currentTarget as HTMLCanvasElement; (canvas as any)._drawing = false; }}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => {
                      const canvas = (window as any)._sigCanvas as HTMLCanvasElement;
                      if (canvas) {
                        const ctx = canvas.getContext('2d');
                        ctx?.clearRect(0,0,canvas.width,canvas.height);
                      }
                    }}>Limpar</Button>
                  </div>
                </div>
                <Button className="w-full" onClick={async () => {
                  const canvas = (window as any)._sigCanvas as HTMLCanvasElement;
                  let sigData: string | undefined;
                  if (canvas) {
                    try { sigData = canvas.toDataURL('image/png'); } catch {}
                  }
                  handleSign(selectedDoc.id, sigData);
                }} disabled={signDoc.isPending}>
                  {signDoc.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                  Assinar e Confirmar Recebimento
                </Button>
                {(geo.lat != null && geo.lng != null) && (
                  <p className="text-xs text-muted-foreground text-center">Geolocalização capturada</p>
                )}
              </div>
            )}
            {!selectedDoc?.requires_signature && selectedDoc?.requires_confirmation && !['confirmado', 'assinado'].includes(selectedDoc?.status) && (
              <Button className="w-full" onClick={() => handleConfirm(selectedDoc.id)} disabled={confirmDoc.isPending}>
                {confirmDoc.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}
                Confirmar Recebimento
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </PromotorLayout>
  );
}
