import { useState, useEffect, useMemo, useCallback } from "react";
import { useParams } from "react-router-dom";
import { API_URL } from "@/lib/api";
import { resolveMediaUrl } from "@/lib/media";
import { Camera, Calendar, MapPin, Tag, User, Loader2, ShieldAlert, Download, Filter, Clock, ChevronLeft, ChevronRight } from "lucide-react";

const PHOTO_TYPES: Record<string, string> = {
  checkin: 'Check-in', checkout: 'Check-out', before: 'Antes', after: 'Depois',
  category_before: 'Antes (Categoria)', category_after: 'Depois (Categoria)',
  stock: 'Estoque', shelf: 'Prateleira', extra_point: 'Ponto Extra',
  damage: 'Avaria', expiry: 'Validade', contingency: 'Contingência',
};

interface BookData {
  title: string;
  subtitle: string;
  notes: string;
  logo_url: string | null;
  company_name: string | null;
  photos: Array<{
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
  }>;
  created_at: string;
  expires_at: string | null;
}

function formatPtBRDate(iso: string | null | undefined) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }); } catch { return ''; }
}

function formatPtBRShort(iso: string | null | undefined) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('pt-BR'); } catch { return ''; }
}

// -------- PDF helpers (reused from BookEditorDialog) --------
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

function loadImage(url: string, timeoutMs = 60000): Promise<HTMLImageElement> {
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

async function drawPhotoBlock(doc: any, photo: any, x: number, y: number, w: number, imgH: number, pageW: number, compact = false) {
  const photoUrl = resolveMediaUrl(photo.photo_url);
  try {
    const img = await loadImage(photoUrl);
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
  } catch {
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
      photo.captured_at && `Data: ${formatPtBRShort(photo.captured_at)}`,
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

export default function PublicPhotoBook() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<BookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewPhoto, setViewPhoto] = useState<any>(null);

  // Filters
  const [filterPdv, setFilterPdv] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'date_desc' | 'date_asc' | 'pdv' | 'product'>('date_desc');

  // Pagination
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;

  // Photos per page for PDF
  const [photosPerPage, setPhotosPerPage] = useState(2);

  const PHOTOS_PER_PAGE_OPTIONS = [
    { value: 1, label: '1 foto por página' },
    { value: 2, label: '2 fotos por página' },
    { value: 4, label: '4 fotos por página' },
    { value: 6, label: '6 fotos por página' },
  ];

  useEffect(() => {
    if (!token) return;
    const fetchBook = async () => {
      try {
        const res = await fetch(`${API_URL}/api/public/photo-book/${token}`);
        if (!res.ok) {
          if (res.status === 404) throw new Error('Book não encontrado ou expirado');
          throw new Error('Erro ao carregar book');
        }
        const result = await res.json();
        setData(result);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchBook();
  }, [token]);

  const photos = useMemo(() => {
    if (!data) return [];
    let list = [...data.photos];

    // PDV filter
    if (filterPdv) {
      const f = filterPdv.toLowerCase();
      list = list.filter(p => (p.pdv_name || '').toLowerCase().includes(f));
    }

    // Date range filter
    if (filterDateFrom || filterDateTo) {
      list = list.filter(p => {
        if (!p.captured_at) return true;
        const d = new Date(p.captured_at).toISOString().slice(0, 10);
        if (filterDateFrom && d < filterDateFrom) return false;
        if (filterDateTo && d > filterDateTo) return false;
        return true;
      });
    }

    // Ordering
    list.sort((a, b) => {
      const da = a.captured_at ? new Date(a.captured_at).getTime() : 0;
      const db = b.captured_at ? new Date(b.captured_at).getTime() : 0;
      if (sortBy === 'date_desc') return db - da;
      if (sortBy === 'date_asc') return da - db;
      if (sortBy === 'pdv') return (a.pdv_name || '').localeCompare(b.pdv_name || '');
      if (sortBy === 'product') return (a.product_name || a.category_name || '').localeCompare(b.product_name || b.category_name || '');
      return 0;
    });

    return list;
  }, [data, filterPdv, filterDateFrom, filterDateTo, sortBy]);

  const totalPages = Math.max(1, Math.ceil(photos.length / PAGE_SIZE));
  const currentPagePhotos = photos.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pdvOptions = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    return data.photos
      .filter(p => p.pdv_name && !seen.has(p.pdv_name) && (seen.add(p.pdv_name), true))
      .map(p => p.pdv_name!);
  }, [data]);

  // -------- PDF --------
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);

  const handleDownloadPdf = useCallback(async () => {
    if (!data || currentPagePhotos.length === 0) return;
    setPdfGenerating(true);
    setPdfProgress(0);
    try {
      const { default: jsPDF } = await import('jspdf');
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = 210;
      const pageH = 297;
      const margin = 15;
      const contentW = pageW - margin * 2;

      // Cover page
      doc.setFillColor(30, 30, 30);
      doc.rect(0, 0, pageW, pageH, 'F');
      if (data.logo_url) {
        try {
          const img = await loadImage(resolveMediaUrl(data.logo_url));
          const logoH = 20;
          const logoW = (img.width / img.height) * logoH;
          doc.addImage(compressImage(img, 400, 0.8), 'JPEG', (pageW - logoW) / 2, 60, logoW, logoH);
        } catch { /* skip */ }
      }
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(26);
      doc.text(data.title || 'Book de Fotos', pageW / 2, 95, { align: 'center' });
      doc.setFontSize(14);
      doc.setTextColor(180, 180, 180);
      doc.text(data.subtitle, pageW / 2, 110, { align: 'center' });
      doc.setFontSize(11);
      doc.text(new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }), pageW / 2, 125, { align: 'center' });
      if (data.notes) {
        doc.setFontSize(10);
        doc.setTextColor(160, 160, 160);
        const lines = doc.splitTextToSize(data.notes, contentW - 20);
        doc.text(lines, pageW / 2, 145, { align: 'center' });
      }
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      doc.text(`${currentPagePhotos.length} fotos`, pageW / 2, pageH - 30, { align: 'center' });

      // Photo pages — layout conforme escolha do usuário
      const ppp = photosPerPage;
      const cols = ppp <= 2 ? 1 : 2;
      const rows = Math.ceil(ppp / cols);
      for (let i = 0; i < currentPagePhotos.length; i += ppp) {
        doc.addPage();
        doc.setFillColor(255, 255, 255);
        doc.rect(0, 0, pageW, pageH, 'F');

        const pageNum = Math.floor(i / ppp) + 1;
        const totalPhotoPages = Math.ceil(currentPagePhotos.length / ppp);

        // header strip
        doc.setFillColor(30, 30, 30);
        doc.rect(0, 0, pageW, 14, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(8);
        doc.text(data.title || 'Book de Fotos', margin, 9);
        doc.text(`Página ${pageNum} de ${totalPhotoPages}`, pageW - margin, 9, { align: 'right' });

        const contentTop = 20;
        const contentBottom = pageH - 14;
        const availableH = contentBottom - contentTop;
        const gap = 4;
        const cellW = (contentW - gap * (cols - 1)) / cols;
        const cellH = (availableH - gap * (rows - 1)) / rows;

        for (let j = 0; j < ppp; j++) {
          const photo = currentPagePhotos[i + j];
          if (!photo) break;
          const col = j % cols;
          const row = Math.floor(j / cols);
          const x = margin + col * (cellW + gap);
          const y = contentTop + row * (cellH + gap);
          const imgH = cellH - 14;
          await drawPhotoBlock(doc, photo, x, y, cellW, imgH, pageW, true);
        }

        setPdfProgress(Math.round(((i + ppp) / currentPagePhotos.length) * 100));
      }

      setPdfProgress(100);
      const safeTitle = (data.title || 'book-fotos').replace(/[^a-z0-9\-_]/gi, '-').toLowerCase();
      doc.save(`book-${safeTitle}-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err: any) {
      console.error('PDF generation error:', err);
      alert('Erro ao gerar PDF: ' + (err?.message || 'Erro desconhecido'));
    } finally {
      setPdfGenerating(false);
      setPdfProgress(0);
    }
  }, [data, currentPagePhotos, photosPerPage]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 p-4">
        <ShieldAlert className="h-16 w-16 text-zinc-300 mb-4" />
        <h1 className="text-xl font-semibold text-zinc-700 mb-2">Acesso indisponível</h1>
        <p className="text-zinc-500 text-center">{error || 'Este link não é válido ou expirou.'}</p>
      </div>
    );
  }

  const hasFilters = Boolean(filterPdv || filterDateFrom || filterDateTo);

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Cover */}
      <div className="bg-zinc-900 text-white py-16 px-6 text-center">
        {data.logo_url && (
          <img src={resolveMediaUrl(data.logo_url) || ''} alt="Logo" className="h-12 mx-auto mb-6" />
        )}
        <h1 className="text-2xl md:text-3xl font-bold mb-2">{data.title}</h1>
        <p className="text-zinc-400">{data.subtitle}</p>
        <p className="text-zinc-500 text-sm mt-2">
          {formatPtBRDate(data.created_at)}
        </p>
        {data.notes && (
          <p className="text-zinc-500 text-sm mt-4 max-w-lg mx-auto">{data.notes}</p>
        )}
        <p className="text-zinc-600 text-xs mt-6">{data.photos.length} fotos</p>
        {data.company_name && <p className="text-zinc-600 text-xs mt-1">{data.company_name}</p>}
      </div>

      {/* Controls bar */}
      <div className="max-w-5xl mx-auto px-4 py-4">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <button
            onClick={handleDownloadPdf}
            disabled={pdfGenerating || data.photos.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pdfGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {pdfGenerating ? 'Gerando PDF...' : 'Baixar PDF'}
          </button>

          {/* PDV filter chips */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setFilterPdv('')}
              className={`px-3 py-1.5 rounded text-sm border font-medium transition ${!filterPdv ? 'bg-orange-100 border-orange-200 text-orange-800' : 'bg-white border-zinc-400 text-zinc-900'}`}
            >
              Limpar PDV
            </button>
            {pdvOptions.map(pdv => (
              <button
                key={pdv}
                onClick={() => setFilterPdv(pdv)}
                className={`px-3 py-1.5 rounded text-sm border font-medium transition ${filterPdv === pdv ? 'bg-orange-100 border-orange-300 text-orange-800' : 'bg-white border-zinc-400 text-zinc-900'}`}
              >
                {pdv}
              </button>
            ))}
          </div>

          {/* Date range filters */}
          <div className="flex gap-2">
            <input
              type="date"
              value={filterDateFrom}
              onChange={e => setFilterDateFrom(e.target.value)}
              className="px-2 py-1.5 rounded border border-zinc-400 text-sm bg-white text-zinc-900 placeholder:text-zinc-500 focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none"
              placeholder="De"
            />
            <input
              type="date"
              value={filterDateTo}
              onChange={e => setFilterDateTo(e.target.value)}
              className="px-2 py-1.5 rounded border border-zinc-400 text-sm bg-white text-zinc-900 placeholder:text-zinc-500 focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none"
              placeholder="Até"
            />
            <button
              onClick={() => { setFilterDateFrom(''); setFilterDateTo(''); }}
              className="px-2 py-1.5 rounded border border-zinc-400 text-xs text-zinc-700 bg-white hover:bg-zinc-100 hover:text-zinc-900"
            >
              limpar
            </button>
          </div>

          {/* Ordering */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-zinc-700">Ordenar por:</label>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              className="px-2 py-1.5 rounded border border-zinc-400 text-sm bg-white text-zinc-900 focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none"
            >
              <option value="date_desc">Data (mais recente)</option>
              <option value="date_asc">Data (mais antiga)</option>
              <option value="pdv">PDV</option>
              <option value="product">Produto</option>
            </select>
          </div>

          {/* Photos per page for PDF */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-zinc-700">Fotos por página (PDF):</label>
            <select
              value={photosPerPage}
              onChange={e => setPhotosPerPage(Number(e.target.value))}
              className="px-2 py-1.5 rounded border border-zinc-400 text-sm bg-white text-zinc-900 focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none"
            >
              {PHOTOS_PER_PAGE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {hasFilters && (
            <button
              onClick={() => { setFilterPdv(''); setFilterDateFrom(''); setFilterDateTo(''); }}
              className="px-3 py-1.5 rounded border border-red-200 text-red-600 text-sm bg-white hover:bg-red-50"
            >
              Limpar filtros
            </button>
          )}
        </div>

        <p className="text-xs text-zinc-500 mb-2">
          {photos.length} de {data.photos.length} foto{photos.length === 1 ? '' : 's'} exibida{photos.length === 1 ? '' : 's'}
        </p>

        {/* Photos grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {currentPagePhotos.length === 0 ? (
            <div className="col-span-full text-center py-12">
              <Camera className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
              <p className="text-zinc-500 text-sm">Nenhuma foto encontrada com os filtros aplicados.</p>
            </div>
          ) : (
            currentPagePhotos.map((photo) => {
              const photoUrl = resolveMediaUrl(photo.photo_url);
              return (
                <div key={photo.id} className="bg-white rounded-xl shadow-sm overflow-hidden border cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => setViewPhoto({ ...photo, photo_url: photoUrl })}>
                  <div className="aspect-[4/3] bg-zinc-100">
                    {photoUrl ? (
                      <img src={photoUrl} alt={photo.product_name || 'Foto'} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Camera className="h-8 w-8 text-zinc-300" />
                      </div>
                    )}
                  </div>
                  <div className="p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-block px-2 py-0.5 text-xs bg-orange-100 text-orange-700 rounded-full">
                        {PHOTO_TYPES[photo.photo_type] || photo.photo_type}
                      </span>
                      {photo.brand_name && (
                        <span className="inline-block px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full font-medium">
                          {photo.brand_name}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-zinc-600 truncate block">{photo.product_name || photo.category_name || ''}</span>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
                      {photo.pdv_name && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{photo.pdv_name}</span>}
                      {photo.promoter_name && <span className="flex items-center gap-1"><User className="h-3 w-3" />{photo.promoter_name}</span>}
                      {photo.captured_at && <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{formatPtBRShort(photo.captured_at)}</span>}
                    </div>
                    {photo.caption && <p className="text-xs text-zinc-500 italic">{photo.caption}</p>}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-6 flex items-center justify-between px-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 rounded border border-zinc-300 text-sm text-zinc-700 bg-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-zinc-50"
            >
              <ChevronLeft className="h-4 w-4 mr-2" /> Anterior
            </button>
            <span className="text-xs text-zinc-500">
              Página {page} de {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 rounded border border-zinc-300 text-sm text-zinc-700 bg-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-zinc-50"
            >
              Próximo <ChevronRight className="h-4 w-4 ml-2" />
            </button>
          </div>
        )}
      </div>

      {/* Photo viewer overlay */}
      {viewPhoto && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setViewPhoto(null)}>
          <div className="max-w-3xl w-full" onClick={e => e.stopPropagation()}>
            {viewPhoto.photo_url && (
              <img src={viewPhoto.photo_url} alt="" className="w-full max-h-[80vh] object-contain rounded-lg" />
            )}
            <div className="text-white text-center mt-3 space-y-1">
              <p className="text-sm">{PHOTO_TYPES[viewPhoto.photo_type] || viewPhoto.photo_type} — {viewPhoto.product_name || viewPhoto.category_name || 'Geral'}</p>
              {viewPhoto.caption && <p className="text-xs text-zinc-400 italic">{viewPhoto.caption}</p>}
            </div>
            <button onClick={() => setViewPhoto(null)} className="absolute top-4 right-4 text-white text-2xl">&times;</button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="bg-zinc-100 border-t py-4 text-center text-xs text-zinc-400">
        Book de fotos gerado automaticamente • {data.company_name || ''}
      </div>
    </div>
  );
}
