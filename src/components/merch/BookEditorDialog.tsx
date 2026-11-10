import { useState, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useSendEmail } from "@/hooks/use-email";
import { api, API_URL, getAuthToken } from "@/lib/api";
import { resolveMediaUrl } from "@/lib/media";
import { useBranding } from "@/hooks/use-branding";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  FileText, Download, Send, Mail, Eye, GripVertical, X, Loader2, 
  Image as ImageIcon, Link2, Copy, Check, MessageSquare, Settings2, Upload
} from "lucide-react";

interface BookPhoto {
  id: string;
  photo_url: string;
  photo_type: string;
  product_name?: string;
  category_name?: string;
  brand_name?: string;
  pdv_name?: string;
  promoter_name?: string;
  captured_at?: string;
  caption?: string;
}

interface BrandOption {
  id: string;
  name: string;
  logo_url?: string;
}

interface ReportBranding {
  agency_name?: string;
  agency_logo_url?: string;
  header_color?: string;
  footer_color?: string;
  header_text_color?: string;
  footer_text_color?: string;
}

interface BookEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photos: BookPhoto[];
  brandName?: string;
  brandLogoUrl?: string;
  clientEmail?: string;
  clientPhone?: string;
  brands?: BrandOption[];
}

const PHOTO_TYPES: Record<string, string> = {
  checkin: 'Check-in', checkout: 'Check-out', before: 'Antes', after: 'Depois',
  category_before: 'Antes (Categoria)', category_after: 'Depois (Categoria)',
  stock: 'Estoque', shelf: 'Prateleira', extra_point: 'Ponto Extra',
  damage: 'Avaria', expiry: 'Validade', contingency: 'Contingência',
};

const PHOTOS_PER_PAGE_OPTIONS = [
  { value: '1', label: '1 foto por página' },
  { value: '2', label: '2 fotos por página' },
  { value: '4', label: '4 fotos por página' },
  { value: '6', label: '6 fotos por página' },
];

function useReportBranding() {
  return useQuery({
    queryKey: ['report-branding'],
    queryFn: () => api<ReportBranding>('/api/merch/report-branding'),
  });
}

function useSaveReportBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ReportBranding) => api<any>('/api/merch/report-branding', { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-branding'] }),
  });
}

export function BookEditorDialog({ open, onOpenChange, photos: initialPhotos, brandName, brandLogoUrl, clientEmail, clientPhone, brands = [] }: BookEditorDialogProps) {
  const { toast } = useToast();
  const { branding } = useBranding();
  const sendEmail = useSendEmail();
  const { data: reportBranding } = useReportBranding();
  const saveReportBranding = useSaveReportBranding();
  
  const [tab, setTab] = useState("edit");
  const [selectedBrandId, setSelectedBrandId] = useState<string>(() => {
    if (!brandName || !brands.length) return '';
    const match = brands.find(b => b.name === brandName);
    return match?.id || '';
  });
  const selectedBrand = brands.find(b => b.id === selectedBrandId);
  const activeBrandName = selectedBrand?.name || brandName || 'Cliente';
  const activeBrandLogo = selectedBrand?.logo_url ? resolveMediaUrl(selectedBrand.logo_url) : (brandLogoUrl ? resolveMediaUrl(brandLogoUrl) : null);

  const [title, setTitle] = useState(`Book de Fotos — ${brandName || 'Cliente'}`);
  const [subtitle, setSubtitle] = useState(`Relatório fotográfico de merchandising`);
  const [notes, setNotes] = useState('');
  const [photosPerPage, setPhotosPerPage] = useState(2);
  const [bookPhotos, setBookPhotos] = useState<BookPhoto[]>(() => 
    initialPhotos.map(p => ({ ...p, caption: '', photo_url: resolveMediaUrl(p.photo_url) || '' }))
  );
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [webLink, setWebLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sendTo, setSendTo] = useState<'whatsapp' | 'email' | ''>('');
  const [recipientEmail, setRecipientEmail] = useState(clientEmail || '');
  const [recipientPhone, setRecipientPhone] = useState(clientPhone || '');

  // Report branding local state
  const [rbAgencyName, setRbAgencyName] = useState('');
  const [rbAgencyLogo, setRbAgencyLogo] = useState('');
  const [rbHeaderColor, setRbHeaderColor] = useState('#1e1e1e');
  const [rbFooterColor, setRbFooterColor] = useState('#1e1e1e');
  const [rbHeaderTextColor, setRbHeaderTextColor] = useState('#ffffff');
  const [rbFooterTextColor, setRbFooterTextColor] = useState('#999999');

  useEffect(() => {
    if (reportBranding) {
      setRbAgencyName(reportBranding.agency_name || '');
      setRbAgencyLogo(reportBranding.agency_logo_url || '');
      setRbHeaderColor(reportBranding.header_color || '#1e1e1e');
      setRbFooterColor(reportBranding.footer_color || '#1e1e1e');
      setRbHeaderTextColor(reportBranding.header_text_color || '#ffffff');
      setRbFooterTextColor(reportBranding.footer_text_color || '#999999');
    }
  }, [reportBranding]);

  const handleSaveReportBranding = async () => {
    try {
      await saveReportBranding.mutateAsync({
        agency_name: rbAgencyName,
        agency_logo_url: rbAgencyLogo,
        header_color: rbHeaderColor,
        footer_color: rbFooterColor,
        header_text_color: rbHeaderTextColor,
        footer_text_color: rbFooterTextColor,
      });
      toast({ title: 'Configuração de relatório salva!' });
    } catch {
      toast({ title: 'Erro ao salvar', variant: 'destructive' });
    }
  };

  const handleBrandChange = (brandId: string) => {
    setSelectedBrandId(brandId);
    const brand = brands.find(b => b.id === brandId);
    if (brand) {
      setTitle(`Book de Fotos — ${brand.name}`);
    }
  };

  const removePhoto = useCallback((id: string) => {
    setBookPhotos(prev => prev.filter(p => p.id !== id));
  }, []);

  const updateCaption = useCallback((id: string, caption: string) => {
    setBookPhotos(prev => prev.map(p => p.id === id ? { ...p, caption } : p));
  }, []);

  const movePhoto = useCallback((fromIdx: number, toIdx: number) => {
    setBookPhotos(prev => {
      const arr = [...prev];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
  }, []);

  const hexToRgb = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
  };

  // Generate and download PDF client-side
  const handleDownloadPdf = async () => {
    setGenerating(true);
    setGenProgress(0);
    try {
      const { default: jsPDF } = await import('jspdf');
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = 210;
      const pageH = 297;
      const margin = 15;
      const contentW = pageW - margin * 2;

      const hdrColor = hexToRgb(rbHeaderColor || '#1e1e1e');
      const ftrColor = hexToRgb(rbFooterColor || '#1e1e1e');
      const hdrTextColor = hexToRgb(rbHeaderTextColor || '#ffffff');
      const ftrTextColor = hexToRgb(rbFooterTextColor || '#999999');
      const agencyLogoUrl = rbAgencyLogo ? resolveMediaUrl(rbAgencyLogo) : null;
      
      // Helper: draw header on page
      const drawHeader = async () => {
        doc.setFillColor(hdrColor.r, hdrColor.g, hdrColor.b);
        doc.rect(0, 0, pageW, 14, 'F');
        if (agencyLogoUrl) {
          try {
            const lImg = await loadImage(agencyLogoUrl);
            const lH = 8;
            const lW = (lImg.width / lImg.height) * lH;
            doc.addImage(lImg, 'PNG', margin, 3, lW, lH);
          } catch { /* skip */ }
        }
        if (rbAgencyName) {
          doc.setTextColor(hdrTextColor.r, hdrTextColor.g, hdrTextColor.b);
          doc.setFontSize(8);
          doc.text(rbAgencyName, pageW - margin, 9, { align: 'right' });
        }
      };

      // Helper: draw footer
      const drawFooter = (pageNum: number, totalPages: number) => {
        doc.setFillColor(ftrColor.r, ftrColor.g, ftrColor.b);
        doc.rect(0, pageH - 12, pageW, 12, 'F');
        doc.setTextColor(ftrTextColor.r, ftrTextColor.g, ftrTextColor.b);
        doc.setFontSize(7);
        doc.text(`Página ${pageNum} de ${totalPages}`, pageW / 2, pageH - 5, { align: 'center' });
        if (rbAgencyName) {
          doc.text(rbAgencyName, margin, pageH - 5);
        }
      };

      const totalPhotoPages = Math.ceil(bookPhotos.length / photosPerPage);
      
      // Cover page
      doc.setFillColor(hdrColor.r, hdrColor.g, hdrColor.b);
      doc.rect(0, 0, pageW, pageH, 'F');

      // Brand logo (priority) or org logo on cover
      let coverLogoY = 40;
      const logoToUse = activeBrandLogo || branding.logo_topbar;
      if (logoToUse) {
        try {
          const img = await loadImage(logoToUse);
          const logoH = 20;
          const logoW = (img.width / img.height) * logoH;
          doc.addImage(compressImage(img, 400, 0.8), 'JPEG', (pageW - logoW) / 2, coverLogoY, logoW, logoH);
          coverLogoY += logoH + 10;
        } catch { coverLogoY += 10; }
      }

      // Agency logo below brand logo on cover
      if (agencyLogoUrl && agencyLogoUrl !== logoToUse) {
        try {
          const aImg = await loadImage(agencyLogoUrl);
          const aH = 12;
          const aW = (aImg.width / aImg.height) * aH;
          doc.addImage(aImg, 'PNG', (pageW - aW) / 2, coverLogoY, aW, aH);
        } catch { /* skip */ }
      }

      doc.setTextColor(hdrTextColor.r, hdrTextColor.g, hdrTextColor.b);
      doc.setFontSize(26);
      doc.text(title, pageW / 2, 90, { align: 'center' });
      doc.setFontSize(14);
      doc.setTextColor(180, 180, 180);
      doc.text(subtitle, pageW / 2, 105, { align: 'center' });
      
      const dateStr = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
      doc.setFontSize(11);
      doc.text(dateStr, pageW / 2, 120, { align: 'center' });
      
      if (notes) {
        doc.setFontSize(10);
        doc.setTextColor(160, 160, 160);
        const lines = doc.splitTextToSize(notes, contentW - 20);
        doc.text(lines, pageW / 2, 140, { align: 'center' });
      }

      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      doc.text(`${bookPhotos.length} fotos`, pageW / 2, pageH - 30, { align: 'center' });
      if (branding.company_name) {
        doc.text(branding.company_name, pageW / 2, pageH - 22, { align: 'center' });
      }

      // Photo pages
      const ppp = photosPerPage;
      const totalSteps = Math.ceil(bookPhotos.length / ppp) + 1;
      let step = 0;
      for (let i = 0; i < bookPhotos.length; i += ppp) {
        step++;
        setGenProgress(Math.round((step / totalSteps) * 100));
        doc.addPage();
        doc.setFillColor(255, 255, 255);
        doc.rect(0, 0, pageW, pageH, 'F');

        await drawHeader();
        const pageNum = Math.floor(i / ppp) + 1;
        drawFooter(pageNum, totalPhotoPages);

        const contentTop = 18;
        const contentBottom = pageH - 16;
        const availableH = contentBottom - contentTop;

        // Layout depending on photos per page
        if (ppp === 1) {
          const photo = bookPhotos[i];
          if (!photo) continue;
          const imgH = availableH - 20;
          const yOffset = contentTop + 2;
          await drawPhotoBlock(doc, photo, margin, yOffset, contentW, imgH, pageW);
        } else if (ppp === 2) {
          for (let j = 0; j < 2; j++) {
            const photo = bookPhotos[i + j];
            if (!photo) break;
            const slotH = (availableH - 4) / 2;
            const yOffset = contentTop + j * (slotH + 2);
            const imgH = slotH - 18;
            await drawPhotoBlock(doc, photo, margin, yOffset, contentW, imgH, pageW);
          }
        } else if (ppp === 4) {
          const cols = 2;
          const rows = 2;
          const gap = 4;
          const cellW = (contentW - gap) / cols;
          const cellH = (availableH - gap) / rows;
          for (let j = 0; j < 4; j++) {
            const photo = bookPhotos[i + j];
            if (!photo) break;
            const col = j % cols;
            const row = Math.floor(j / cols);
            const x = margin + col * (cellW + gap);
            const y = contentTop + row * (cellH + gap);
            const imgH = cellH - 16;
            await drawPhotoBlock(doc, photo, x, y, cellW, imgH, pageW, true);
          }
        } else if (ppp === 6) {
          const cols = 2;
          const rows = 3;
          const gap = 3;
          const cellW = (contentW - gap) / cols;
          const cellH = (availableH - gap * 2) / rows;
          for (let j = 0; j < 6; j++) {
            const photo = bookPhotos[i + j];
            if (!photo) break;
            const col = j % cols;
            const row = Math.floor(j / cols);
            const x = margin + col * (cellW + gap);
            const y = contentTop + row * (cellH + gap);
            const imgH = cellH - 14;
            await drawPhotoBlock(doc, photo, x, y, cellW, imgH, pageW, true);
          }
        }
      }

      setGenProgress(100);
      doc.save(`book-fotos-${brandName || 'cliente'}-${new Date().toISOString().slice(0, 10)}.pdf`);
      toast({ title: "PDF gerado!", description: "O download do book foi iniciado" });
    } catch (err: any) {
      console.error('PDF generation error:', err);
      try {
        const { logger } = await import('@/lib/logger');
        logger.error('[BookEditor] PDF generation failed', { error: err?.message, stack: err?.stack });
      } catch {}
      toast({ title: "Erro ao gerar PDF", description: err?.message || 'Erro desconhecido', variant: "destructive" });
    } finally {
      setGenerating(false);
      setGenProgress(0);
    }
  };

  // Create shareable web link with token
  const handleCreateWebLink = async () => {
    setSharing(true);
    try {
      const result = await api<{ token: string; url: string }>('/api/merch/photo-book/share', {
        method: 'POST',
        body: {
          title, subtitle, notes,
          photo_ids: bookPhotos.map(p => p.id),
          captions: bookPhotos.reduce((acc, p) => ({ ...acc, [p.id]: p.caption || '' }), {}),
          brand_logo_url: activeBrandLogo || undefined,
          photos_per_page: photosPerPage,
          report_branding: {
            agency_name: rbAgencyName,
            agency_logo_url: rbAgencyLogo,
            header_color: rbHeaderColor,
            footer_color: rbFooterColor,
            header_text_color: rbHeaderTextColor,
            footer_text_color: rbFooterTextColor,
          },
        },
      });
      const fullUrl = `${window.location.origin}/book/${result.token}`;
      setWebLink(fullUrl);
      toast({ title: "Link criado!", description: "O link do book está pronto para compartilhar" });
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    } finally {
      setSharing(false);
    }
  };

  const copyLink = () => {
    if (webLink) {
      navigator.clipboard.writeText(webLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSendWhatsApp = () => {
    if (!webLink) return;
    const text = encodeURIComponent(`📸 ${title}\n\n${subtitle}\n\nVeja o book completo: ${webLink}`);
    const phone = recipientPhone.replace(/\D/g, '');
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
  };

  const handleSendEmail = async () => {
    if (!webLink || !recipientEmail) return;
    try {
      await sendEmail.mutateAsync({
        to_email: recipientEmail,
        subject: title,
        body_html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #333;">${title}</h1>
            <p style="color: #666;">${subtitle}</p>
            ${notes ? `<p style="color: #888;">${notes}</p>` : ''}
            <p style="margin: 20px 0;">
              <a href="${webLink}" style="background: #e8600a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Ver Book de Fotos (${bookPhotos.length} fotos)
              </a>
            </p>
            <p style="color: #999; font-size: 12px;">${branding.company_name || ''}</p>
          </div>
        `,
        send_immediately: true,
        context_type: 'photo_book',
      });
    } catch { /* toast handled by hook */ }
  };

  const handleUploadAgencyLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const token = getAuthToken();
      const resp = await fetch(`${API_URL}/api/uploads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await resp.json();
      if (data.url) {
        setRbAgencyLogo(data.url);
        toast({ title: 'Logo enviada' });
      }
    } catch {
      toast({ title: 'Erro ao enviar logo', variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Editor do Book de Fotos ({bookPhotos.length} fotos)
          </DialogTitle>
          <DialogDescription>Personalize o título, textos e ordem das fotos antes de exportar</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="edit">✏️ Editar</TabsTrigger>
            <TabsTrigger value="branding">🏢 Timbrado</TabsTrigger>
            <TabsTrigger value="preview">👁️ Preview</TabsTrigger>
            <TabsTrigger value="share">📤 Compartilhar</TabsTrigger>
          </TabsList>

          <TabsContent value="edit" className="space-y-4 mt-4">
            <div className="grid gap-3">
              {brands.length > 0 && (
                <div>
                  <Label>Cliente / Marca</Label>
                  <div className="flex items-center gap-3">
                    <Select value={selectedBrandId || '__none__'} onValueChange={v => handleBrandChange(v === '__none__' ? '' : v)}>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Selecione o cliente" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Sem marca específica</SelectItem>
                        {brands.map(b => (
                          <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {activeBrandLogo && (
                      <img src={activeBrandLogo} alt="Logo" className="h-8 w-auto rounded border object-contain" />
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">A logo do cliente aparecerá na capa do book</p>
                </div>
              )}
              <div>
                <Label>Título do Book</Label>
                <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Título do relatório" />
              </div>
              <div>
                <Label>Subtítulo</Label>
                <Input value={subtitle} onChange={e => setSubtitle(e.target.value)} placeholder="Subtítulo" />
              </div>
              <div>
                <Label>Observações / Notas</Label>
                <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observações adicionais para o cliente..." rows={3} />
              </div>
              <div>
                <Label>Fotos por Página</Label>
                <Select value={String(photosPerPage)} onValueChange={v => setPhotosPerPage(Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PHOTOS_PER_PAGE_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Fotos ({bookPhotos.length})</Label>
              <p className="text-xs text-muted-foreground">Arraste para reordenar. Clique no X para remover. Adicione legendas individuais.</p>
              <div className="grid gap-2 max-h-[400px] overflow-y-auto">
                {bookPhotos.map((photo, idx) => (
                  <div key={photo.id} className="flex items-start gap-2 p-2 border rounded-lg bg-card">
                    <div className="flex flex-col items-center gap-1">
                      <button onClick={() => idx > 0 && movePhoto(idx, idx - 1)} className="text-muted-foreground hover:text-foreground text-xs">▲</button>
                      <span className="text-xs text-muted-foreground font-mono">{idx + 1}</span>
                      <button onClick={() => idx < bookPhotos.length - 1 && movePhoto(idx, idx + 1)} className="text-muted-foreground hover:text-foreground text-xs">▼</button>
                    </div>
                    <div className="w-16 h-16 rounded overflow-hidden bg-muted flex-shrink-0">
                      {photo.photo_url ? (
                        <img src={photo.photo_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center"><ImageIcon className="h-4 w-4 text-muted-foreground" /></div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-[10px]">{PHOTO_TYPES[photo.photo_type] || photo.photo_type}</Badge>
                        <span className="text-xs truncate">{photo.product_name || photo.category_name || photo.pdv_name || ''}</span>
                      </div>
                      <Input 
                        value={photo.caption || ''} 
                        onChange={e => updateCaption(photo.id, e.target.value)}
                        placeholder="Legenda (opcional)"
                        className="h-7 text-xs"
                      />
                    </div>
                    <button onClick={() => removePhoto(photo.id)} className="text-muted-foreground hover:text-destructive">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* BRANDING TAB - Global Report Settings */}
          <TabsContent value="branding" className="mt-4 space-y-4">
            <Card>
              <CardContent className="pt-4 space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <Settings2 className="h-4 w-4" />
                  <h3 className="text-sm font-semibold">Dados da Agência / Empresa (Global)</h3>
                </div>
                <p className="text-xs text-muted-foreground">Estas configurações são salvas globalmente e utilizadas em todos os relatórios (Book de Fotos, PDFs, etc).</p>

                <div className="grid gap-3">
                  <div>
                    <Label>Nome da Agência / Empresa</Label>
                    <Input value={rbAgencyName} onChange={e => setRbAgencyName(e.target.value)} placeholder="Minha Agência LTDA" />
                  </div>
                  <div>
                    <Label>Logo da Agência</Label>
                    <div className="flex items-center gap-3">
                      {rbAgencyLogo && (
                        <img src={resolveMediaUrl(rbAgencyLogo) || rbAgencyLogo} alt="Logo" className="h-10 w-auto rounded border object-contain bg-white p-1" />
                      )}
                      <label className="cursor-pointer">
                        <div className="flex items-center gap-2 px-3 py-2 border rounded-md text-xs hover:bg-muted">
                          <Upload className="h-3.5 w-3.5" />
                          {rbAgencyLogo ? 'Trocar logo' : 'Enviar logo'}
                        </div>
                        <input type="file" accept="image/*" onChange={handleUploadAgencyLogo} className="hidden" />
                      </label>
                      {rbAgencyLogo && (
                        <Button size="sm" variant="ghost" onClick={() => setRbAgencyLogo('')} className="text-xs text-destructive">
                          <X className="h-3 w-3 mr-1" /> Remover
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t">
                  <div>
                    <Label className="text-xs">Cor do Cabeçalho</Label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={rbHeaderColor} onChange={e => setRbHeaderColor(e.target.value)} className="w-8 h-8 rounded border cursor-pointer" />
                      <Input value={rbHeaderColor} onChange={e => setRbHeaderColor(e.target.value)} className="text-xs h-8" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Texto do Cabeçalho</Label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={rbHeaderTextColor} onChange={e => setRbHeaderTextColor(e.target.value)} className="w-8 h-8 rounded border cursor-pointer" />
                      <Input value={rbHeaderTextColor} onChange={e => setRbHeaderTextColor(e.target.value)} className="text-xs h-8" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Cor do Rodapé</Label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={rbFooterColor} onChange={e => setRbFooterColor(e.target.value)} className="w-8 h-8 rounded border cursor-pointer" />
                      <Input value={rbFooterColor} onChange={e => setRbFooterColor(e.target.value)} className="text-xs h-8" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Texto do Rodapé</Label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={rbFooterTextColor} onChange={e => setRbFooterTextColor(e.target.value)} className="w-8 h-8 rounded border cursor-pointer" />
                      <Input value={rbFooterTextColor} onChange={e => setRbFooterTextColor(e.target.value)} className="text-xs h-8" />
                    </div>
                  </div>
                </div>

                {/* Preview */}
                <div className="border rounded-lg overflow-hidden">
                  <div className="h-8 flex items-center px-3 justify-between" style={{ backgroundColor: rbHeaderColor }}>
                    {rbAgencyLogo && <img src={resolveMediaUrl(rbAgencyLogo) || rbAgencyLogo} alt="" className="h-5 object-contain" />}
                    <span className="text-[10px]" style={{ color: rbHeaderTextColor }}>{rbAgencyName || 'Nome da Agência'}</span>
                  </div>
                  <div className="h-20 bg-white flex items-center justify-center text-xs text-muted-foreground">
                    Conteúdo do relatório
                  </div>
                  <div className="h-6 flex items-center px-3 justify-between" style={{ backgroundColor: rbFooterColor }}>
                    <span className="text-[9px]" style={{ color: rbFooterTextColor }}>{rbAgencyName || 'Agência'}</span>
                    <span className="text-[9px]" style={{ color: rbFooterTextColor }}>Página 1 de 5</span>
                  </div>
                </div>

                <Button onClick={handleSaveReportBranding} disabled={saveReportBranding.isPending} className="w-full">
                  {saveReportBranding.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Settings2 className="h-4 w-4 mr-2" />}
                  Salvar Configurações de Relatório
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* PREVIEW TAB */}
          <TabsContent value="preview" className="mt-4">
            <div className="border rounded-lg overflow-hidden bg-muted/30">
              {/* Cover preview */}
              <div className="text-white p-8 text-center space-y-3" style={{ backgroundColor: rbHeaderColor }}>
                {(activeBrandLogo || branding.logo_topbar) && (
                  <img src={activeBrandLogo || branding.logo_topbar} alt="Logo" className="h-10 mx-auto mb-4" />
                )}
                {rbAgencyLogo && rbAgencyLogo !== (activeBrandLogo || '') && (
                  <img src={resolveMediaUrl(rbAgencyLogo) || rbAgencyLogo} alt="Agency" className="h-6 mx-auto mb-2 opacity-80" />
                )}
                <h1 className="text-xl font-bold">{title}</h1>
                <p className="text-sm opacity-70">{subtitle}</p>
                <p className="text-xs opacity-50">{new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
                {notes && <p className="text-xs opacity-50 max-w-md mx-auto">{notes}</p>}
                <p className="text-xs opacity-30 mt-4">{bookPhotos.length} fotos • {photosPerPage} por página</p>
              </div>
              {/* Photos preview grid */}
              <div className={`p-4 gap-3 max-h-[400px] overflow-y-auto grid ${photosPerPage >= 4 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {bookPhotos.map((photo, idx) => (
                  <div key={photo.id} className="space-y-1">
                    <div className="aspect-[4/3] rounded overflow-hidden bg-muted">
                      {photo.photo_url ? (
                        <img src={photo.photo_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center"><ImageIcon className="h-6 w-6 text-muted-foreground" /></div>
                      )}
                    </div>
                    <p className="text-[10px] font-medium">{PHOTO_TYPES[photo.photo_type] || photo.photo_type} — {photo.product_name || photo.category_name || 'Geral'}</p>
                    <p className="text-[9px] text-muted-foreground">{photo.pdv_name} • {photo.promoter_name}</p>
                    {photo.caption && <p className="text-[9px] text-muted-foreground italic">{photo.caption}</p>}
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* SHARE TAB */}
          <TabsContent value="share" className="mt-4 space-y-4">
            {/* Download PDF */}
            <Card>
              <CardContent className="pt-4 space-y-3">
                <h3 className="text-sm font-medium flex items-center gap-2"><Download className="h-4 w-4" /> Download PDF</h3>
                <p className="text-xs text-muted-foreground">Gere o book em PDF profissional com timbrado ({photosPerPage} fotos/página)</p>
                <Button onClick={handleDownloadPdf} disabled={generating || bookPhotos.length === 0} className="w-full">
                  {generating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Gerando PDF... {genProgress}%</> : <><Download className="h-4 w-4 mr-2" /> Baixar PDF</>}
                </Button>
                {generating && (
                  <div className="w-full h-2 bg-muted rounded overflow-hidden mt-2">
                    <div className="h-full bg-primary transition-all" style={{ width: `${genProgress}%` }} />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Web Link */}
            <Card>
              <CardContent className="pt-4 space-y-3">
                <h3 className="text-sm font-medium flex items-center gap-2"><Link2 className="h-4 w-4" /> Link Web (Token)</h3>
                <p className="text-xs text-muted-foreground">Crie um link seguro com token para o cliente visualizar online</p>
                {!webLink ? (
                  <Button onClick={handleCreateWebLink} disabled={sharing || bookPhotos.length === 0} variant="outline" className="w-full">
                    {sharing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Criando link...</> : <><Link2 className="h-4 w-4 mr-2" /> Gerar Link</>}
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Input value={webLink} readOnly className="text-xs" />
                      <Button size="sm" variant="outline" onClick={copyLink}>
                        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    
                    {/* Send via WhatsApp */}
                    <div className="space-y-2 pt-2 border-t">
                      <h4 className="text-xs font-medium flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5" /> Enviar via WhatsApp</h4>
                      <div className="flex gap-2">
                        <Input 
                          value={recipientPhone} 
                          onChange={e => setRecipientPhone(e.target.value)} 
                          placeholder="5511999999999" 
                          className="text-xs"
                        />
                        <Button size="sm" onClick={handleSendWhatsApp} disabled={!recipientPhone} className="bg-green-600 hover:bg-green-700">
                          <Send className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    {/* Send via Email */}
                    <div className="space-y-2 pt-2 border-t">
                      <h4 className="text-xs font-medium flex items-center gap-1"><Mail className="h-3.5 w-3.5" /> Enviar via Email</h4>
                      <div className="flex gap-2">
                        <Input 
                          value={recipientEmail} 
                          onChange={e => setRecipientEmail(e.target.value)} 
                          placeholder="cliente@email.com" 
                          className="text-xs"
                        />
                        <Button size="sm" onClick={handleSendEmail} disabled={!recipientEmail || sendEmail.isPending}>
                          {sendEmail.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

async function drawPhotoBlock(
  doc: any, photo: any, x: number, y: number, w: number, imgH: number, pageW: number, compact = false
) {
  try {
    const img = await loadImage(photo.photo_url);
    const ratio = img.width / img.height;
    let imgW = w;
    let actualH = imgH;
    if (ratio > w / imgH) {
      actualH = w / ratio;
    } else {
      imgW = imgH * ratio;
    }
    const dataUrl = compressImage(img);
    doc.addImage(dataUrl, 'JPEG', x + (w - imgW) / 2, y, imgW, actualH);
  } catch (e: any) {
    console.warn('[BookEditor] foto indisponível:', photo?.id, photo?.photo_url, e?.message);
    doc.setFillColor(240, 240, 240);
    doc.rect(x, y, w, imgH, 'F');
    doc.setTextColor(150, 150, 150);
    doc.setFontSize(compact ? 7 : 10);
    doc.text('Imagem indisponível', x + w / 2, y + imgH / 2, { align: 'center' });
  }

  const infoY = y + imgH + (compact ? 2 : 5);
  const fontSize = compact ? 7 : 9;
  const typeLabel = PHOTO_TYPES[photo.photo_type] || photo.photo_type;
  
  doc.setTextColor(50, 50, 50);
  doc.setFontSize(fontSize);
  const label = `${typeLabel} — ${photo.product_name || photo.category_name || 'Geral'}`;
  doc.text(label, x, infoY);
  
  if (!compact) {
    doc.setTextColor(130, 130, 130);
    doc.setFontSize(8);
    const meta = [
      photo.pdv_name && `PDV: ${photo.pdv_name}`,
      photo.promoter_name && `Promotor: ${photo.promoter_name}`,
      photo.captured_at && `Data: ${new Date(photo.captured_at).toLocaleDateString('pt-BR')}`,
    ].filter(Boolean).join('  |  ');
    doc.text(meta, x, infoY + 4);
  }

  if (photo.caption) {
    doc.setTextColor(70, 70, 70);
    doc.setFontSize(compact ? 6 : 8);
    const captionLines = doc.splitTextToSize(photo.caption, w);
    doc.text(captionLines, x, infoY + (compact ? 4 : 9));
  }
}

function compressImage(img: HTMLImageElement, maxDim = 1200, quality = 0.75): string {
  const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

function loadImage(url: string, timeoutMs = 15000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Timeout ao carregar imagem'));
    }, timeoutMs);
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Falha ao carregar imagem'));
    };
    img.src = url;
  });
}
