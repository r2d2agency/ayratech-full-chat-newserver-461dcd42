import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { API_URL } from "@/lib/api";
import { resolveMediaUrl } from "@/lib/media";
import { Camera, Calendar, MapPin, Tag, User, Loader2, ShieldAlert } from "lucide-react";

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

export default function PublicPhotoBook() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<BookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewPhoto, setViewPhoto] = useState<any>(null);

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
          {new Date(data.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}
        </p>
        {data.notes && (
          <p className="text-zinc-500 text-sm mt-4 max-w-lg mx-auto">{data.notes}</p>
        )}
        <p className="text-zinc-600 text-xs mt-6">{data.photos.length} fotos</p>
        {data.company_name && <p className="text-zinc-600 text-xs mt-1">{data.company_name}</p>}
      </div>

      {/* Photos */}
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {data.photos.map((photo) => {
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
                    {photo.captured_at && <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{new Date(photo.captured_at).toLocaleDateString('pt-BR')}</span>}
                  </div>
                  {photo.caption && <p className="text-xs text-zinc-500 italic">{photo.caption}</p>}
                </div>
              </div>
            );
          })}
        </div>
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
