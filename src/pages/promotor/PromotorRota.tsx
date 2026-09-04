import { useState, useMemo, useCallback, useEffect } from "react";
import { useOfflineSync } from "@/hooks/use-offline-sync";
import { useParams, useNavigate } from "react-router-dom";
import { PromotorLayout } from "./PromotorLayout";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CameraCapture, type PhotoQualityConfig } from "@/components/promotor/CameraCapture";
import { FaceVerifyDialog } from "@/components/facial-recognition/FaceVerifyDialog";
import { LocalImage } from "@/components/promotor/LocalImage";
import { PhotoLightbox } from "@/components/merch/PhotoLightbox";
import {
  usePromotorRouteDetail, usePromotorCheckin, usePromotorCheckout,
  usePromotorUpdateExecution, usePromotorReportDamage, usePromotorReportRupture,
  usePromotorAddValidity, usePromotorReportDiscard,
  usePromotorSetPointType, usePromotorCategoryPhoto, usePromotorCategoryAfterPhoto,
  usePromotorRegisterExtraPoint,
} from "@/hooks/use-promotor-routes";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MapPin, Camera, Check, AlertTriangle, Archive, Clock,
  CheckCircle2, Circle, Calendar as CalendarIcon, Trash2, Store, Info,
  Lock, Unlock, ChevronRight, ChevronDown, ChevronUp, Target, ImagePlus, Plus, ScanFace, Package, X,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { logger } from "@/lib/logger";
import { SyncStatusIndicator } from "@/components/promotor/SyncStatusIndicator";
import { StockCountCard } from "@/components/promotor/StockCountCard";
import { useRouteStockCount } from "@/hooks/use-stock-count";

// ===== Photo capture with Approve/Reject preview =====
function PhotoApprovalCapture({
  photos, onPhotosChange, min, isSending, onSubmit,
  cameraProps, label, accentColorClass = 'text-primary',
}: {
  photos: string[];
  onPhotosChange: (next: string[]) => void;
  min: number;
  allowExtras?: boolean; // ignored — kept for backward compatibility
  isSending: boolean;
  onSubmit: (photos: string[]) => void;
  cameraProps: any;
  label: string;
  submitLabel?: string; // ignored — kept for backward compatibility
  accentColorClass?: string;
}) {
  const reachedMin = photos.length >= min;
  const needsMore = photos.length < min;

  const handleCapture = (url: string) => {
    onPhotosChange([...photos, url]);
  };

  const removeAt = (i: number) => {
    onPhotosChange(photos.filter((_, idx) => idx !== i));
  };

  return (
    <div className="space-y-2">
      <Label className={`text-xs font-semibold flex items-center gap-1 ${accentColorClass}`}>
        <Camera className="h-3.5 w-3.5" /> {label}
      </Label>
      {min > 1 && (
        <p className="text-[10px] text-muted-foreground">
          {reachedMin ? `${photos.length}/${min} fotos registradas` : `Tire ${min} foto(s). Faltam ${min - photos.length}.`}
        </p>
      )}

      {/* Thumbnails */}
      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((url, i) => (
            <div key={i} className="relative group">
              <LocalImage src={url} alt={`Foto ${i + 1}`} className="w-full h-20 rounded-lg border-2 border-green-500/40 object-cover" />
              <button
                onClick={() => removeAt(i)}
                className="absolute top-1 right-1 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center text-[10px]"
                disabled={isSending}
              >✕</button>
              <div className="absolute bottom-1 left-1 bg-green-600 text-white rounded px-1 text-[9px] font-medium flex items-center gap-0.5">
                <Check className="h-2.5 w-2.5" /> {i + 1}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Camera (only while we still need more) */}
      {needsMore && (
        <CameraCapture
          {...cameraProps}
          onCapture={handleCapture}
          buttonLabel={photos.length === 0 ? 'Tirar foto' : `Tirar foto ${photos.length + 1}`}
        />
      )}

      {/* Confirmação explícita: o mínimo já foi atingido, mas o envio só
          acontece quando o promotor confirma — nada de disparo automático
          invisível que pode nunca completar sem feedback nenhum. */}
      {reachedMin && (
        <Button
          type="button"
          className="w-full h-11 bg-green-600 hover:bg-green-700 text-white"
          onClick={() => onSubmit(photos)}
          disabled={isSending}
        >
          {isSending ? (
            <>Enviando...</>
          ) : (
            <><Check className="h-4 w-4 mr-1.5" /> Confirmar {photos.length > 1 ? `${photos.length} fotos` : 'foto'}</>
          )}
        </Button>
      )}

    </div>
  );
}

const EXEC_STATUS_ICON: Record<string, any> = {
  pending: <Circle className="h-4 w-4 text-muted-foreground" />,
  in_progress: <Clock className="h-4 w-4 text-yellow-500" />,
  completed: <CheckCircle2 className="h-4 w-4 text-green-500" />,
};

type ActionType = 'validity' | 'rupture' | 'damage' | 'discard' | null;

// PDV checkout hook
const usePromotorPdvCheckout = () => {
  const { queueApiCall } = useOfflineSync();
  const checkout = (data: any) => {
    return queueApiCall({
      url: '/api/merch/promotor/pdv-checkout',
      method: 'POST',
      body: data,
      headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` }
    });
  };
  return { checkout };
};

// ===== Category Preparation Component =====
function CategoryPreparation({ category, catId, routeBrandId, categoryName, routeId, pdvName, brandName, promotorName, qualityConfig, minPhotos, photoMode, facialRequired, storedDescriptor, storedPhotoUrl, onUnlocked, onPointTypeSet, onCaptureOptimistic }: {
  category: any; catId: string; routeBrandId?: string; categoryName: string; routeId: string; pdvName: string; brandName: string; promotorName?: string; qualityConfig?: PhotoQualityConfig; minPhotos: number; photoMode?: 'before' | 'after' | 'both'; facialRequired?: boolean; storedDescriptor?: number[]; storedPhotoUrl?: string; onUnlocked: () => void; onPointTypeSet?: () => void; onCaptureOptimistic?: (url: string, type: string) => void;
}) {
  const setPointType = usePromotorSetPointType();
  const setCategoryPhoto = usePromotorCategoryPhoto();
  const [photos, setPhotos] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  // Estado local: garante que o promotor avance mesmo sem internet / com rede ruim,
  // independentemente do backend confirmar o point_type.
  const [localPointTypeSet, setLocalPointTypeSet] = useState(false);
  const { queueApiCall } = useOfflineSync();
  const [showFaceVerify, setShowFaceVerify] = useState(false);
  const [pendingPointType, setPendingPointType] = useState<string | null>(null);


  // category may be null/undefined if no merch_execution_categories entry exists yet
  const hasPointType = !!category?.point_type || localPointTypeSet;
  const hasPhoto = !!category?.category_before_photo;
  const isUnlocked = !!category?.products_unlocked || (hasPointType && (hasPhoto || photoMode === 'after'));
  const photoCount = photos.length + (hasPhoto ? 1 : 0);
  const min = Math.max(1, minPhotos || 1);

  const handleSetPointType = (type: string, facialVerified = false) => {
    // If it's a 'natural' point type set by the effect, skip facial verification if it's already verified or if the user hasn't interacted yet.
    // However, the request asks that ON CLICKING it opens the camera.
    // Since 'natural' is auto-set, we only trigger facial on manual point type selection OR when entering the category.
    if (facialRequired && storedDescriptor && !facialVerified) {
      setPendingPointType(type);
      setShowFaceVerify(true);
      return;
    }


    logger.info(`Promotor selecionando tipo de ponto (offline-first): ${type}`, { routeId, catId, categoryName });

    // Se o modo for "after" (Somente Depois), já desbloqueamos os produtos imediatamente após escolher o tipo de ponto
    const shouldUnlockImmediately = photoMode === 'after';

    // Offline-first: a chamada SEMPRE vai para a fila (que sincroniza sozinha quando
    // houver rede). Assim, internet ruim ou ausente nunca travam o promotor.
    queueApiCall({
      url: `/api/merch/promotor/routes/${routeId}/categories/${catId}/point-type`,
      method: 'POST',
      body: {
        route_brand_id: routeBrandId,
        point_type: type,
        products_unlocked: shouldUnlockImmediately,
      },
      headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` },
    });

    setLocalPointTypeSet(true);
    if (shouldUnlockImmediately) onUnlocked();
    else onPointTypeSet?.();
  };

  const handleFaceVerifyResult = (result: { match: boolean; score: number; imageDataUrl: string }) => {
    setShowFaceVerify(false);
    if (result.match && pendingPointType) {
      if (pendingPointType === 'CAPTURE_AFTER_FACE') {
        handleUploadPhoto();
      } else {
        handleSetPointType(pendingPointType, true);
      }
      setPendingPointType(null);
    } else {
      toast.error("Reconhecimento facial falhou. Tente novamente.");
    }

  };


  const handleUploadPhoto = async (submittedPhotos?: string[]) => {
    const effective = submittedPhotos && submittedPhotos.length ? submittedPhotos : photos;
    if (effective.length < min) return toast.error(`É necessário enviar pelo menos ${min} foto(s) ANTES.`);
    setIsSending(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 5000 })
      ).catch(() => null);

      const body = {
        route_brand_id: routeBrandId, 
        photo_url: effective[0], 
        photos: effective,
        latitude: pos?.coords.latitude, 
        longitude: pos?.coords.longitude,
      };

      // Always use background queue for photo-related actions for performance
      queueApiCall({
        url: `/api/merch/promotor/routes/${routeId}/categories/${catId}/photo`,
        method: 'POST',
        body: { ...body, routeId, catId },
        headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` },
        dependsOnUploadId: effective[0]?.startsWith('local-file://') ? effective[0].replace('local-file://', '') : undefined
      });
      
      setPhotos([]);
      setIsSending(false);
      onCaptureOptimistic?.(effective[0], 'category_before');
      onUnlocked();
    } catch (e: any) {
      setIsSending(false);
      setPhotos([]);
      toast.error('Falha ao enviar a foto ANTES. Tire a foto novamente.');
      logger.error('[CategoryPreparation] Falha ao enviar foto', { message: e?.message, routeId, catId });
    }
  };

  const handleAddPhoto = (url: string) => {
    setPhotos(prev => [...prev, url]);
  };

  const handleRemovePhoto = (index: number) => {
    setPhotos(prev => prev.filter((_, i) => i !== index));
  };

  // Auto-set point type to 'natural' by default — extra points are added via the dedicated "Registrar Ponto Extra" flow
  useEffect(() => {
    if (!isUnlocked && !hasPointType && !setPointType.isPending) {
      // For auto-setting, we bypass the facial verification state but the backend will still check.
      // However, to satisfy "al clicar ja libere a camera e faça o ponto com a facial",
      // we need the facial to trigger when the user interacts.
      handleSetPointType('natural', true);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPointType, isUnlocked]);

  if (isUnlocked) return null;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="p-4 space-y-4">
        {/* Tabs Antes / Depois */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-muted rounded-lg">
          <div className="text-center py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold">
            📷 Foto Antes
          </div>
          <div className="text-center py-1.5 rounded-md text-xs font-medium text-muted-foreground/60 cursor-not-allowed flex items-center justify-center gap-1">
            <Lock className="h-3 w-3" /> Foto Depois
          </div>
        </div>

        {/* Bloco 1: Identification */}
        <div className="flex items-center gap-2 text-sm">
          <Target className="h-4 w-4 text-primary" />
          <div>
            <span className="font-bold">{categoryName}</span>
            <span className="text-muted-foreground ml-2">• {pdvName} • {brandName}</span>
          </div>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-[11px] flex-wrap">
          {photoMode !== 'after' && (
            <>
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${(hasPhoto || photos.length > 0) ? 'bg-green-500/20 text-green-700' : 'bg-yellow-500/20 text-yellow-700'}`}>
                {(hasPhoto || photos.length > 0) ? <CheckCircle2 className="h-3 w-3" /> : <span className="font-bold">1</span>}
                Foto{photoCount > 1 ? `s (${photoCount})` : ''}
              </div>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </>
          )}
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            <Lock className="h-3 w-3" />
            Produtos
          </div>
        </div>

        {/* Bloco 3: Photos (multiple) */}
        {!hasPhoto && photoMode !== 'after' && (
          <PhotoApprovalCapture
            photos={photos}
            onPhotosChange={setPhotos}
            min={min}
            allowExtras={min > 1}
            isSending={isSending}
            onSubmit={(submittedPhotos) => {
              if (facialRequired && storedDescriptor) {
                setPendingPointType('CAPTURE_AFTER_FACE'); // Marker
                setShowFaceVerify(true);
                return;
              }
              handleUploadPhoto(submittedPhotos);
            }}
            cameraProps={{
              watermark: { pdvName, brandName, promotorName, categoryName, photoType: 'Categoria (antes)' },
              customTokenGetter: () => localStorage.getItem('promotor_token') || localStorage.getItem('auth_token'),
              qualityConfig,
              allowManualUpload: false,
            }}
            label="Foto da categoria (ANTES da execução)"
            submitLabel="Registrar e liberar produtos"
          />

        )}

        {/* Lock message */}
        <div className="flex items-center gap-2 p-2 rounded bg-destructive/10 text-destructive text-xs">
          <Lock className="h-4 w-4 flex-shrink-0" />
          <span>
            {photoMode === 'after'
              ? 'Liberando produtos...'
              : photos.length === 0 && !hasPhoto
                ? 'É necessário tirar a foto da categoria antes de acessar os produtos.'
                : 'Registre a(s) foto(s) para liberar os produtos.'}
          </span>
        </div>

        {showFaceVerify && storedDescriptor && (
          <FaceVerifyDialog
            open={showFaceVerify}
            onOpenChange={setShowFaceVerify}
            storedDescriptor={storedDescriptor}
            storedPhotoUrl={storedPhotoUrl}
            personName={promotorName}
            onResult={handleFaceVerifyResult}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ===== Extra Point Photo Gate (no point type, only photo) =====
function ExtraPointPhotoGate({ catId, routeBrandId, categoryName, routeId, pdvName, brandName, promotorName, qualityConfig, onPhotoTaken, onCaptureOptimistic }: {
  catId: string; routeBrandId?: string; categoryName: string; routeId: string; pdvName: string; brandName: string; promotorName?: string; qualityConfig?: PhotoQualityConfig; onPhotoTaken: () => void; onCaptureOptimistic?: (url: string, type: string) => void;
}) {
  const [photos, setPhotos] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const { queueApiCall } = useOfflineSync();


  const handleUploadPhoto = async (submittedPhotos?: string[]) => {
    const effective = submittedPhotos && submittedPhotos.length ? submittedPhotos : photos;
    if (effective.length === 0) return toast.error('É necessário tirar pelo menos 1 foto do ponto extra.');
    setIsSending(true);
    try {
      const pos = await import('@/lib/photo-perf').then(m => m.getCachedGeolocation({ timeoutMs: 1500 })).catch(() => null);

      const body = {
        photo_type: 'extra_point',
        category_id: catId,
        route_brand_id: routeBrandId,
        exposure_point: 'extra',
        photo_url: effective[0],
        latitude: pos?.lat, longitude: pos?.lng,
      };

      await queueApiCall({
        url: `/api/merch/promotor/routes/${routeId}/photos`,
        method: 'POST',
        body,
        headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` },
        dependsOnUploadId: effective[0]?.startsWith('local-file://') ? effective[0].replace('local-file://', '') : undefined
      });
      
      setPhotos([]);
      setIsSending(false);
      onCaptureOptimistic?.(effective[0], 'extra_point');
      onPhotoTaken();
    } catch (e: any) {
      setIsSending(false);
      setPhotos([]);
      toast.error('Falha ao enviar a foto do ponto extra. Tire a foto novamente.');
      logger.error('[ExtraPointPhotoGate] Falha ao enviar foto', { message: e?.message, routeId, catId });
    }
  };


  return (
    <Card className="border-orange-400/40 bg-orange-50/50">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2 text-sm">
          <Target className="h-4 w-4 text-orange-600" />
          <div>
            <span className="font-bold">{categoryName}</span>
            <span className="text-muted-foreground ml-2">• {pdvName} • {brandName}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 text-green-700">
            <CheckCircle2 className="h-3 w-3" /> Ponto Extra
          </div>
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${photos.length > 0 ? 'bg-green-500/20 text-green-700' : 'bg-yellow-500/20 text-yellow-700'}`}>
            {photos.length > 0 ? <CheckCircle2 className="h-3 w-3" /> : <span className="font-bold">1</span>}
            Foto{photos.length > 1 ? `s (${photos.length})` : ''}
          </div>
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            <Lock className="h-3 w-3" /> Produtos
          </div>
        </div>

        <PhotoApprovalCapture
          photos={photos}
          onPhotosChange={setPhotos}
          min={1}
          allowExtras={false}
          isSending={isSending}
          onSubmit={handleUploadPhoto}
          cameraProps={{
            watermark: { pdvName, brandName, promotorName, categoryName, photoType: 'Ponto Extra' },
            customTokenGetter: () => localStorage.getItem('promotor_token') || localStorage.getItem('auth_token'),
            qualityConfig,
            allowManualUpload: false,
          }}
          label="Foto do Ponto Extra (obrigatória)"
          submitLabel="Confirmar e liberar produtos"
          accentColorClass="text-orange-700"
        />

        <div className="flex items-center gap-2 p-2 rounded-md bg-orange-100/50 text-orange-800 text-[11px]">
          <Camera className="h-4 w-4 flex-shrink-0" />
          <span>Tire a foto do ponto extra antes de acessar os produtos.</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ===== Category After Photo Gate (required to close/complete category) =====
function CategoryAfterPhotoGate({ catId, routeBrandId, categoryName, routeId, pdvName, brandName, promotorName, qualityConfig, minPhotos, beforePhotoUrl, afterOnly, onCompleted, onCaptureOptimistic }: {
  catId: string; routeBrandId?: string; categoryName: string; routeId: string; pdvName: string; brandName: string; promotorName?: string; qualityConfig?: PhotoQualityConfig; minPhotos: number; beforePhotoUrl?: string | null; afterOnly?: boolean; onCompleted: () => void; onCaptureOptimistic?: (url: string, type: string) => void;
}) {
  const setCategoryAfterPhoto = usePromotorCategoryAfterPhoto();
  const [photos, setPhotos] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const { isOnline, queueApiCall } = useOfflineSync();

  const min = Math.max(1, minPhotos || 1);

  const handleUpload = async (submittedPhotos?: string[]) => {
    const effective = submittedPhotos && submittedPhotos.length ? submittedPhotos : photos;
    if (effective.length < min) return toast.error(`É necessário enviar pelo menos ${min} foto(s) DEPOIS.`);
    setIsSending(true);
    try {
      const pos = await import('@/lib/photo-perf').then(m => m.getCachedGeolocation({ timeoutMs: 1500 })).catch(() => null);

      const body = {
        routeId, catId, route_brand_id: routeBrandId, photo_url: effective[0], photos: effective,
        latitude: pos?.lat, longitude: pos?.lng,
      };

      await queueApiCall({
        url: `/api/merch/promotor/routes/${routeId}/categories/${catId}/after-photo`,
        method: 'POST',
        body,
        headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` },
        dependsOnUploadId: effective[0]?.startsWith('local-file://') ? effective[0].replace('local-file://', '') : undefined
      });

      setPhotos([]);
      setIsSending(false);
      onCaptureOptimistic?.(effective[0], 'category_after');
      onCompleted();
    } catch (e: any) {
      setIsSending(false);
      setPhotos([]);
      toast.error('Falha ao enviar a foto DEPOIS. Tire a foto novamente.');
      logger.error('[CategoryAfterPhotoGate] Falha ao enviar foto', { message: e?.message, routeId, catId });
    }
  };



  return (
    <Card className="border-green-500/40 bg-green-50/50 mt-2">
      <CardContent className="p-4 space-y-3">
        {/* Tabs Antes / Depois */}
        <div className={`grid ${afterOnly ? 'grid-cols-1' : 'grid-cols-2'} gap-1 p-1 bg-muted rounded-lg`}>
          {!afterOnly && (
            <div className="text-center py-1.5 rounded-md text-xs font-medium text-green-700 flex items-center justify-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Foto Antes
            </div>
          )}
          <div className="text-center py-1.5 rounded-md bg-green-600 text-white text-xs font-semibold">
            📷 Foto Depois
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Camera className="h-4 w-4 text-green-600" />
          <div>
            <span className="font-bold">{categoryName}</span>
            <Badge variant="secondary" className="ml-2 text-[9px] bg-green-100 text-green-700">Foto DEPOIS</Badge>
          </div>
        </div>

        {beforePhotoUrl && (
          <div className="space-y-1">
            <Label className="text-xs font-semibold text-primary">Foto ANTES já registrada</Label>
            <LocalImage
              src={beforePhotoUrl}
              alt="Foto antes da categoria"
              className="w-full h-24 rounded-lg border-2 border-primary/40 object-cover"
            />
          </div>
        )}

        <PhotoApprovalCapture
          photos={photos}
          onPhotosChange={setPhotos}
          min={min}
          allowExtras={min > 1}
          isSending={isSending || setCategoryAfterPhoto.isPending}
          onSubmit={handleUpload}
          cameraProps={{
            watermark: { pdvName, brandName, promotorName, categoryName, photoType: 'Categoria (depois)' },
            customTokenGetter: () => localStorage.getItem('promotor_token') || localStorage.getItem('auth_token'),
            qualityConfig,
            allowManualUpload: false,
          }}
          label="Foto da categoria DEPOIS da execução"
          submitLabel="Registrar fotos e concluir categoria"
          accentColorClass="text-green-700"
        />

        <div className="flex items-center gap-2 p-2 rounded-md bg-green-100/50 text-green-800 text-[11px]">
          <Camera className="h-4 w-4 flex-shrink-0" />
          <span>Foto DEPOIS obrigatória para concluir esta categoria.</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ===== Painel de fotos extras da categoria (visualizar + adicionar mais) =====
function CategoryExtraPhotosPanel({
  routeId, catId, routeBrandId, photos, hasAnyAfter, hasAnyBefore, completed,
  unlockBeforeUrl, unlockAfterUrl,
  pdvName, brandName, promotorName, qualityConfig, onUploaded,
}: {
  routeId: string; catId: string; routeBrandId?: string;
  photos: any[]; hasAnyAfter: boolean; hasAnyBefore: boolean; completed: boolean;
  unlockBeforeUrl?: string | null; unlockAfterUrl?: string | null;
  pdvName: string; brandName: string; promotorName?: string;
  qualityConfig?: PhotoQualityConfig;
  onUploaded: (url?: string, type?: 'category_before' | 'category_after') => void;
}) {
  const { queueApiCall } = useOfflineSync();
  const [mode, setMode] = useState<'before' | 'after' | null>(null);
  const [newPhotos, setNewPhotos] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  // Índice da foto em visualização ampliada (lightbox). null = fechado.
  const [viewIdx, setViewIdx] = useState<number | null>(null);

  // Dedupe photos by photo_url (offline retries podem ter gerado duplicatas
  // no passado; aqui garantimos que a mesma URL nunca renderize duas vezes).
  const dedupeByUrl = (list: any[]) => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const p of list) {
      const key = p?.photo_url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  };
  const beforePhotosRaw = dedupeByUrl(photos.filter((p: any) => p.photo_type === 'category_before'));
  const afterPhotosRaw = dedupeByUrl(photos.filter((p: any) => p.photo_type === 'category_after'));

  // Separa a foto de "desbloqueio" da categoria (a primeira, exibida como
  // "Foto da Categoria") das fotos ANTES/DEPOIS adicionais.
  const beforePrimary =
    beforePhotosRaw.find((p: any) => p.photo_url === unlockBeforeUrl) ||
    beforePhotosRaw[0] || null;
  const afterPrimary =
    afterPhotosRaw.find((p: any) => p.photo_url === unlockAfterUrl) ||
    afterPhotosRaw[0] || null;
  const beforePhotos = beforePhotosRaw.filter((p) => p !== beforePrimary);
  const afterPhotos = afterPhotosRaw.filter((p) => p !== afterPrimary);

  // Regra: só pode adicionar mais ANTES se ainda NÃO começou fotos DEPOIS
  const canAddBefore = !hasAnyAfter;
  // Adicionar mais DEPOIS: sempre permitido
  const canAddAfter = true;

  const handleRemove = (i: number) => setNewPhotos((prev) => prev.filter((_, idx) => idx !== i));

  const handleCapture = (url: string) => {
    if (!mode) return;
    // Guard contra duplicidade se o CameraCapture disparar onCapture duas vezes.
    setNewPhotos((prev) => (prev.includes(url) ? prev : [...prev, url]));
    // Enfileira em background — NÃO bloqueia a UI. O promotor pode continuar
    // tirando fotos imediatamente; o upload segue pelo useOfflineSync.
    (async () => {
      try {
        const pos = await import('@/lib/photo-perf').then(m => m.getCachedGeolocation({ timeoutMs: 1500 })).catch(() => null);
        const lat = pos?.lat;
        const lng = pos?.lng;
        const type = mode === 'before' ? 'category_before' : 'category_after';
        const endpoint = mode === 'before' ? 'photo' : 'after-photo';
        
        await queueApiCall({
          url: `/api/merch/promotor/routes/${routeId}/categories/${catId}/${endpoint}`,
          method: 'POST',
          body: {
            route_brand_id: routeBrandId,
            photo_url: url,
            photos: [url],
            latitude: lat,
            longitude: lng,
            routeId, catId,
          },
          headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` },
          dependsOnUploadId: url.startsWith('local-file://') ? url.replace('local-file://', '') : undefined
        });
        toast.success('Foto adicionada');
        onUploaded(url, type);
      } catch {
        toast.error('Erro ao enviar foto');
      }
    })();
  };


  // Mescla otimista com URLs do servidor, sem duplicar.
  const serverBeforeUrls = new Set(beforePhotosRaw.map((p: any) => p.photo_url));
  const serverAfterUrls = new Set(afterPhotosRaw.map((p: any) => p.photo_url));
  const optimisticBefore = mode === 'before' ? newPhotos.filter((u) => !serverBeforeUrls.has(u)) : [];
  const optimisticAfter = mode === 'after' ? newPhotos.filter((u) => !serverAfterUrls.has(u)) : [];
  const totalBefore = beforePhotos.length + optimisticBefore.length;
  const totalAfter = afterPhotos.length + optimisticAfter.length;

  // Lista unificada de todas as fotos visualizáveis (Antes + Depois, incluindo
  // as primárias de desbloqueio/conclusão e as otimistas). Usada para o lightbox
  // com navegação anterior/próximo, permitindo ao promotor conferir o que há
  // em ANTES e DEPOIS.
  const allViewable: any[] = [
    ...(beforePrimary ? [beforePrimary] : []),
    ...beforePhotos,
    ...optimisticBefore.map((u) => ({ photo_url: u, photo_type: 'category_before' })),
    ...(afterPrimary ? [afterPrimary] : []),
    ...afterPhotos,
    ...optimisticAfter.map((u) => ({ photo_url: u, photo_type: 'category_after' })),
  ];
  const findViewIdx = (url: string) => allViewable.findIndex((p) => p.photo_url === url);

  return (
    <div className="mt-2 p-3 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 space-y-3">
      <div className="space-y-2">
        {beforePrimary && (
          <div>
            <div className="text-[10px] font-semibold uppercase text-primary mb-1">🏷️ Foto da Categoria (Antes)</div>
            <div className="grid grid-cols-4 gap-1.5">
              <LocalImage src={beforePrimary.photo_url} alt="Foto da categoria" className="w-full h-16 rounded border-2 border-primary/50 object-cover cursor-pointer hover:opacity-80" onClick={() => setViewIdx(findViewIdx(beforePrimary.photo_url))} />
            </div>
          </div>
        )}
        {totalBefore > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">📷 Antes ({totalBefore})</div>
            <div className="grid grid-cols-4 gap-1.5">
              {beforePhotos.map((p: any, i: number) => (
                <LocalImage key={p.id || `b-${p.photo_url}`} src={p.photo_url} alt={`Antes ${i+1}`} className="w-full h-16 rounded border object-cover cursor-pointer hover:opacity-80" onClick={() => setViewIdx(findViewIdx(p.photo_url))} />
              ))}
              {optimisticBefore.map((u, i) => (
                <LocalImage key={`ob-${u}`} src={u} alt={`Antes nova ${i+1}`} className="w-full h-16 rounded border border-primary/40 object-cover ring-1 ring-primary/30 cursor-pointer hover:opacity-80" onClick={() => setViewIdx(findViewIdx(u))} />
              ))}
            </div>
          </div>
        )}
        {afterPrimary && (
          <div>
            <div className="text-[10px] font-semibold uppercase text-green-700 mb-1">🏁 Foto Final da Categoria (Depois)</div>
            <div className="grid grid-cols-4 gap-1.5">
              <LocalImage src={afterPrimary.photo_url} alt="Foto final da categoria" className="w-full h-16 rounded border-2 border-green-500/60 object-cover cursor-pointer hover:opacity-80" onClick={() => setViewIdx(findViewIdx(afterPrimary.photo_url))} />
            </div>
          </div>
        )}
        {totalAfter > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase text-green-700 mb-1">✅ Depois ({totalAfter})</div>
            <div className="grid grid-cols-4 gap-1.5">
              {afterPhotos.map((p: any, i: number) => (
                <LocalImage key={p.id || `a-${p.photo_url}`} src={p.photo_url} alt={`Depois ${i+1}`} className="w-full h-16 rounded border border-green-500/40 object-cover cursor-pointer hover:opacity-80" onClick={() => setViewIdx(findViewIdx(p.photo_url))} />
              ))}
              {optimisticAfter.map((u, i) => (
                <LocalImage key={`oa-${u}`} src={u} alt={`Depois nova ${i+1}`} className="w-full h-16 rounded border border-green-500/60 object-cover ring-1 ring-green-500/40 cursor-pointer hover:opacity-80" onClick={() => setViewIdx(findViewIdx(u))} />
              ))}
            </div>
          </div>
        )}
        {!beforePrimary && !afterPrimary && totalBefore === 0 && totalAfter === 0 && (
          <p className="text-xs text-muted-foreground text-center">Nenhuma foto registrada ainda.</p>
        )}
      </div>

      {mode === null ? (
        <div className="flex flex-col gap-1.5">
          {canAddBefore && (
            <Button size="sm" variant="outline" onClick={() => setMode('before')} className="justify-start h-8">
              <ImagePlus className="h-3.5 w-3.5 mr-1.5" /> Adicionar mais fotos ANTES
            </Button>
          )}
          {canAddAfter && (
            <Button size="sm" variant="outline" onClick={() => setMode('after')} className="justify-start h-8 border-green-500/40 text-green-700 hover:bg-green-50">
              <ImagePlus className="h-3.5 w-3.5 mr-1.5" /> Adicionar mais fotos DEPOIS
            </Button>
          )}
          {!canAddBefore && hasAnyAfter && (
            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Lock className="h-3 w-3" /> Não é possível adicionar fotos ANTES após iniciar as fotos DEPOIS.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold">
              Adicionando {mode === 'before' ? 'ANTES' : 'DEPOIS'}
            </Label>
            <Button size="sm" variant="ghost" onClick={() => { setMode(null); setNewPhotos([]); }} disabled={sending} className="h-7 text-[11px]">Concluir</Button>
          </div>
          <CameraCapture
            watermark={{ pdvName, brandName, promotorName, photoType: mode === 'before' ? 'Categoria (antes - extra)' : 'Categoria (depois - extra)' }}
            customTokenGetter={() => localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}
            qualityConfig={qualityConfig}
            allowManualUpload={false}
            autoOpen={newPhotos.length === 0}
            onCapture={handleCapture}
            disabled={sending}
            buttonLabel={sending ? 'Enviando...' : (newPhotos.length === 0 ? 'Tirar foto' : `Tirar outra foto`)}
          />
        </div>

      )}

      {/* Visualização ampliada: clique em qualquer foto para conferir ANTES/DEPOIS */}
      {viewIdx !== null && allViewable[viewIdx] && (
        <PhotoLightbox
          photo={{ ...allViewable[viewIdx], pdv_name: pdvName, brand_name: brandName, promoter_name: promotorName }}
          onClose={() => setViewIdx(null)}
          onPrev={viewIdx > 0 ? () => setViewIdx((i) => (i! - 1)) : undefined}
          onNext={viewIdx < allViewable.length - 1 ? () => setViewIdx((i) => (i! + 1)) : undefined}
          typeLabels={{ category_before: 'Foto Antes', category_after: 'Foto Depois' }}
        />
      )}
    </div>
  );
}

export default function PromotorRota() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: route, isLoading, refetch, error: routeError } = usePromotorRouteDetail(id);
  const checkin = usePromotorCheckin();
  const checkout = usePromotorCheckout();
  const updateExec = usePromotorUpdateExecution();
  const { isOnline, isSyncing, queueApiCall } = useOfflineSync();
  const reportDamage = usePromotorReportDamage();
  const reportRupture = usePromotorReportRupture();
  const addValidity = usePromotorAddValidity();
  const reportDiscard = usePromotorReportDiscard();
  const pdvCheckout = usePromotorPdvCheckout();
  const registerExtraPoint = usePromotorRegisterExtraPoint();
  const [photoQualityConfig, setPhotoQualityConfig] = useState<PhotoQualityConfig | undefined>();
  const [activeBrandId, setActiveBrandId] = useState<string | null>(null);

  const [activeAction, setActiveAction] = useState<ActionType>(null);
  const [selectedExec, setSelectedExec] = useState<any>(null);
  const [actionForm, setActionForm] = useState<any>({});
  const [showCompleteRoute, setShowCompleteRoute] = useState(false);
  const [showPdvCheckout, setShowPdvCheckout] = useState(false);
  const [pdvCheckoutPhoto, setPdvCheckoutPhoto] = useState('');
  const [checkinPhotoUrl, setCheckinPhotoUrl] = useState('');
  const [checkinSubmitted, setCheckinSubmitted] = useState(false);
  const [checkinGeoError, setCheckinGeoError] = useState<{ title: string; message: string; details: any } | null>(null);


  // Load photo quality config
  useEffect(() => {
    api<any>('/api/merch/photo-quality-config')
      .then(d => { if (d?.config) setPhotoQualityConfig(d.config); })
      .catch(() => { /* use defaults */ });
  }, []);

  const [routeCompletionResult, setRouteCompletionResult] = useState<any>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [showExtraPointDialog, setShowExtraPointDialog] = useState<{ catId: string; categoryName: string } | null>(null);
  const [selectedExtraProducts, setSelectedExtraProducts] = useState<string[]>([]);
  const [showExtraPointCategoryPicker, setShowExtraPointCategoryPicker] = useState(false);
  const [extraGroupPhotos, setExtraGroupPhotos] = useState<Record<string, boolean>>({});
  const [optimisticBeforeUnlock, setOptimisticBeforeUnlock] = useState<Record<string, boolean>>({});
  const [optimisticAfterPhoto, setOptimisticAfterPhoto] = useState<Record<string, boolean>>({});
  const [optimisticPhotos, setOptimisticPhotos] = useState<any[]>([]);

  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [extraPhotosOpen, setExtraPhotosOpen] = useState<Record<string, boolean>>({});
  const [showFaceVerify, setShowFaceVerify] = useState(false);
  const [faceVerifyAction, setFaceVerifyAction] = useState<'checkin' | 'checkout' | 'pdv_checkout' | null>(null);

  // Facial config
  const promotorToken = localStorage.getItem('promotor_token') || localStorage.getItem('auth_token');
  const { data: facialConfig } = useQuery({
    queryKey: ['promotor-facial-config'],
    queryFn: async () => {
      try {
        return await api<any>('/api/promotor/facial-config');
      } catch (err) {
        return null;
      }
    },
    retry: false,
    staleTime: 300000,
  });

  const { data: faceEnrollment } = useQuery({
    queryKey: ['promotor-face-enrollment'],
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = localStorage.getItem('promotor_token') || localStorage.getItem('auth_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const url = `${(import.meta.env.VITE_API_URL || '').replace(/\/$/, '')}/api/promotor/face-enrollment`;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 300000,
  });

  const facialRequired = !!(facialConfig?.enabled && facialConfig?.use_for_attendance);
  const storedDescriptor = faceEnrollment?.descriptor;
  const storedPhotoUrl = faceEnrollment?.face_photo_url;
  const isFacialActiveCheckin = facialConfig?.enabled && 
    facialConfig?.use_for_checkin && 
    facialConfig?.has_enrollment && 
    facialConfig?.verification_enabled !== false;

  // Multi-brand support
  const isMultiBrand = route?.is_multi_brand && route?.route_brands?.length > 1;
  const routeBrands = route?.route_brands || [];
  const currentBrand = useMemo(() => routeBrands.find((rb: any) => rb.brand_id === activeBrandId), [routeBrands, activeBrandId]);

  useEffect(() => {
    if (routeError) {
      logger.error('Erro ao carregar rota', { routeId: id, error: routeError });
      toast.error('Rota não encontrada ou erro ao carregar.');
      navigate('/promotor/home');
    }
  }, [routeError, id, navigate]);

  useEffect(() => {
    if (route && !isMultiBrand && !activeBrandId) {
      setActiveBrandId(route.brand_id);
    }
  }, [route, isMultiBrand, activeBrandId]);

  // Evita ciclo "volta para tela de check-in" ao abrir uma rota recém-check-inada
  // pela Home do promotor:
  //   1) se backend já retornou checkin_at / status=in_progress, marca submitted
  //   2) se tem pdv_visit com checkin_at na promotor-home c/ mesmo pdv, marca submitted
  //   3) senão apaga o cache stale de 30min e refaz fetch fresco do servidor
  useEffect(() => {
    if (!route || !id) return;
    if (route.checkin_at || route.status === 'in_progress' || route.status === 'completed') {
      setCheckinSubmitted(true);
      return;
    }
    try {
      const home = (qc.getQueryData(['promotor-home']) as any) || null;
      const homePdvId = home?.dailyAssignment?.pdv_id || home?.availablePdvs?.[0]?.id || null;
      const alreadyCheckedInAtHome =
        homePdvId &&
        Array.isArray(home?.pdvVisits) &&
        home.pdvVisits.some((v: any) => v && v.pdv_id === homePdvId && v.checkin_at);
      if (alreadyCheckedInAtHome && homePdvId === route.pdv_id) {
        setCheckinSubmitted(true);
        return;
      }
    } catch {}
    qc.removeQueries({ queryKey: ['promotor-route', id] });
    refetch().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Timer to keep current time updated for min duration check
  useEffect(() => {
    if (route?.status === 'in_progress') {
      const timer = setInterval(() => setCurrentTime(new Date()), 10000);
      return () => clearInterval(timer);
    }
  }, [route?.status]);

  // Build category status map - filter by active brand if multi-brand
  const categoryStatusMap = useMemo(() => {
    const map: Record<string, any> = {};
    (route?.category_statuses || []).forEach((cs: any) => {
      // Create keys for both specific (with brand) and general category access
      const key = cs.route_brand_id ? `${cs.category_id}_${cs.route_brand_id}` : cs.category_id;
      map[key] = cs;
    });
    return map;
  }, [route?.category_statuses]);

  const checklistType = useMemo(() => (isMultiBrand ? currentBrand?.checklist_type : route?.checklist_type) || 'standard', [isMultiBrand, currentBrand, route]);
  const isCheckinOnlyMode = checklistType === 'checkin_only';

  const requireStockCountRaw = useMemo(() => (isMultiBrand ? currentBrand?.require_stock_count : route?.require_stock_count) ?? false, [isMultiBrand, currentBrand, route]);
  const requireValidityCheckRaw = useMemo(() => (isMultiBrand ? currentBrand?.require_validity_check : route?.require_validity_check) ?? false, [isMultiBrand, currentBrand, route]);

  const requireStockCount = isCheckinOnlyMode ? false : requireStockCountRaw;
  const requireValidityCheck = isCheckinOnlyMode ? false : requireValidityCheckRaw;
  const canQuickCheck = !requireStockCount && !requireValidityCheck;

  // Stock count executions (Contagem de Saldo) for this route
  const { data: stockCountExecs = [] } = useRouteStockCount(id);
  const stockCountBlocking = useMemo(() => {
    if (isCheckinOnlyMode) return [];
    // Sempre bloqueia a conclusão da rota quando houver contagem pendente.
    // Só libera se a contagem foi concluída, justificada ou adiada com motivo.
    return (stockCountExecs as any[]).filter((e: any) => {
      const resolved = e.status === 'completed' || e.status === 'justified' || e.status === 'postponed';
      return !resolved;
    });
  }, [stockCountExecs, isCheckinOnlyMode]);




  // Filter executions by active brand
  const filteredExecs = useMemo(() => {
    if (!route?.executions) return [];
    if (!isMultiBrand || !activeBrandId) return route.executions;
    return route.executions.filter((e: any) => {
      if (e.route_brand_id) {
        const rb = routeBrands.find((b: any) => b.id === e.route_brand_id);
        return rb?.brand_id === activeBrandId;
      }
      return e.brand_id === activeBrandId;
    });
  }, [route?.executions, isMultiBrand, activeBrandId, routeBrands]);

  const groupedExecs = useMemo(() => {
    const groups: Record<string, { catId: string; execs: any[]; isExtraGroup?: boolean }> = {};
    filteredExecs.forEach((e: any) => {
      const baseCat = e.category_name || 'Sem Categoria';
      if (e.exposure_point === 'extra') {
        const extraKey = `${baseCat} (Ponto Extra)`;
        if (!groups[extraKey]) groups[extraKey] = { catId: e.category_id, execs: [], isExtraGroup: true };
        groups[extraKey].execs.push(e);
      } else {
        if (!groups[baseCat]) groups[baseCat] = { catId: e.category_id, execs: [] };
        groups[baseCat].execs.push(e);
      }
    });
    return groups;
  }, [filteredExecs]);

  const productsWithExtraPoint = useMemo(() => {
    const set = new Set<string>();
    route?.executions?.forEach((e: any) => {
      if (e.exposure_point === 'extra') {
        set.add(`${e.category_id}_${e.product_id}`);
      }
    });
    return set;
  }, [route?.executions]);

  const persistedExtraPointPhotoKeys = useMemo(() => {
    const set = new Set<string>();
    route?.photos?.forEach((photo: any) => {
      const isExtraPointPhoto = photo.photo_type === 'extra_point' || photo.exposure_point === 'extra';
      if (!isExtraPointPhoto) return;
      set.add(`extra_${photo.category_id || 'null'}_${photo.route_brand_id || 'null'}`);
    });
    return set;
  }, [route?.photos]);

  // Photo-only mode: auto-complete pending products ONLY after the required
  // category photos (before/after according to checklist) have been registered.
  // This keeps progress tied to actual photos taken.
  useEffect(() => {
    if (!route?.executions?.length) return;
    Object.values(groupedExecs).forEach(({ catId, execs, isExtraGroup }) => {
      const routeBrandId = execs[0]?.route_brand_id;
      const categoryKey = `${catId}_${routeBrandId || 'null'}`;
      const catStatus = categoryStatusMap[categoryKey] || categoryStatusMap[catId];
      const rbConfig = isMultiBrand ? routeBrands.find((b: any) => b.id === routeBrandId) : null;
      const source = rbConfig || (route as any);
      // Per-brand (ou rota): se contagem OU validade são exigidas, NÃO auto-completa.
      // Progresso tem que ser produto a produto via formulário do produto.
      const brandRequiresStock = !!source?.require_stock_count;
      const brandRequiresValidity = !!source?.require_validity_check;
      // Extra-point groups don't collect stock/validity — they are photo-only,
      // so the stock/validity guard should NOT block their auto-completion
      // (otherwise the route can never be concluded when a ponto extra is registered).
      if (!isExtraGroup && (brandRequiresStock || brandRequiresValidity)) return;

      const requireCategoryPhotos = source?.require_category_photos !== false;
      const photoMode = source?.category_photo_mode || 'both';

      let photosSatisfied = false;
      if (isExtraGroup) {
        const extraKey = `extra_${catId || 'null'}_${execs[0]?.route_brand_id || 'null'}`;
        photosSatisfied = !!extraGroupPhotos[extraKey] || persistedExtraPointPhotoKeys.has(extraKey);
      } else if (!requireCategoryPhotos) {
        photosSatisfied = true;
      } else {
        const hasBefore = !!catStatus?.category_before_photo;
        // O backend marca `completed` somente quando o mínimo configurado foi atingido.
        const hasAfter = !!catStatus?.completed || !!catStatus?.category_after_photo || !!optimisticAfterPhoto[categoryKey];
        if (photoMode === 'before') photosSatisfied = hasBefore;
        else if (photoMode === 'after') photosSatisfied = hasAfter;
        else photosSatisfied = hasBefore && hasAfter;
      }
      if (!photosSatisfied) return;

      execs.forEach((exec: any) => {
        if (exec.status !== 'completed' && !exec.has_rupture && !exec.has_damage) {
          updateExec.mutate({
            id: exec.id,
            status: 'completed',
            checked: true,
            qty_store: 0,
            qty_stock: 0,
          });
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedExecs, categoryStatusMap, extraGroupPhotos, persistedExtraPointPhotoKeys, optimisticAfterPhoto, isMultiBrand, routeBrands, route]);

  const handleCheckin = useCallback(async (photoOverride?: string) => {
    const effectivePhotoUrl = photoOverride || checkinPhotoUrl;
    if (!id) return;
    
    // Guarda contra múltiplos cliques (queueApiCall não expõe isPending)
    if ((handleCheckin as any)._running || checkinSubmitted) {
      logger.warn('[handleCheckin] Check-in já em andamento, ignorando duplicado');
      return;
    }
    (handleCheckin as any)._running = true;
    
    // Check if route is already in progress or completed
    if (route?.status === 'in_progress' || route?.status === 'completed') {
      (handleCheckin as any)._running = false;
      logger.warn('[handleCheckin] Rota já em andamento ou concluída, ignorando check-in duplicado', { 
        status: route?.status, 
        routeId: id 
      });
      return;
    }

    if ((route as any)?.require_checkin_photo !== false && !effectivePhotoUrl) {
      (handleCheckin as any)._running = false;
      toast.error('Esta rota exige foto obrigatória no check-in');
      return;
    }

    setCheckinGeoError(null);

    // 1) OBTÉM GPS E VALIDA GEODEFENCE ANTES MESMO DE PEDIR FACIAL —
    //    usuário não deve perder tempo com biometria se está longe do PDV/Sede.
    const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('GPS não suportado pelo seu navegador.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    }).catch(err => {
      logger.error('[handleCheckin] Erro de GPS no check-in', { err, routeId: id });
      if (err.code === 1) throw new Error('Permissão de GPS negada. Por favor, autorize o acesso à localização.');
      if (err.code === 2) throw new Error('Posição indisponível. Verifique se o GPS está ativado.');
      if (err.code === 3) throw new Error('Tempo limite do GPS esgotado. Tente novamente em um local mais aberto.');
      return null;
    });

    logger.info('[handleCheckin] Localização obtida para check-in', {
      routeId: id,
      lat: pos?.coords.latitude,
      lng: pos?.coords.longitude,
      accuracy: pos?.coords.accuracy,
    });

    if (pos) {
      try {
        const { validatePdvLocation, formatDistanceMeters } = await import('@/lib/geofence');
        const r = route as any || {};
        const preCheck = validatePdvLocation({
          userLat: pos.coords.latitude,
          userLng: pos.coords.longitude,
          pdvLat: r.pdv_lat,
          pdvLng: r.pdv_lng,
          radiusMeters: r.pdv_radius,
          polygon: r.pdv_geofence_polygon || null,
        });
        if (preCheck.status === 'outside') {
          const pdvType = r.pdv_type;
          const placeType = pdvType === 'sede' ? 'Sede' : (r.pdv_name || 'PDV');
          const distFormatted = formatDistanceMeters(preCheck.distance);
          const isPolygon = preCheck.mode === 'polygon';
          const modeLabel = isPolygon
            ? 'polígono geográfico (perímetro)'
            : (r.pdv_radius != null ? `raio de ${Number(r.pdv_radius)} m` : 'raio de alcance');
          const distText = distFormatted.label ? ` — você está a ${distFormatted.label}` : '';
          const msg = `Você precisa estar ${pdvType === 'sede' ? 'na Sede cadastrada' : `no PDV de destino da rota${r.pdv_name ? ` (${r.pdv_name})` : ''}`} dentro da área permitida para fazer o check-in.${distText}`;
          const hint = isPolygon
            ? 'Você está fora do perímetro (polígono geográfico) cadastrado para este local. Aproxime-se para concluir o check-in.'
            : `Você está fora do raio de alcance (em metros) cadastrado para este local. Verificação: ${modeLabel}. Aproxime-se do local para habilitar o check-in. Caso esteja impossibilitado, envie justificativa.`;
          setCheckinGeoError({
            title: '📍 Fora da área permitida',
            message: msg,
            details: {
              place_type: pdvType || 'pdv',
              place_name: r.pdv_name || null,
              mode: preCheck.mode,
              mode_hint: isPolygon ? 'Você está fora do perímetro (polígono geográfico) cadastrado para este local.' : 'Você está fora do raio de alcance (em metros) cadastrado para este local.',
              distance_meters: preCheck.distance,
              radius_meters: r.pdv_radius != null ? Number(r.pdv_radius) : null,
              user_coords: { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
              accept_justification: true,
              hint,
              placeType,
            },
          });
          logger.warn('[handleCheckin] Pré-validação geo local reprovou ANTES de facial', { routeId: id, preCheck });
          toast.error(msg, { duration: 10000 });
          toast.error(hint, { duration: 10000 });
          (handleCheckin as any)._running = false;
          return;
        }
      } catch (e: any) {
        // não bloqueia por erro da importação; segue para validação do backend
        logger.warn('[handleCheckin] Pré-validação geo local falhou, seguindo para validação backend', { message: e?.message });
      }
    }

    // 2) Geolocalização OK (ou sem GPS para validar em modo offline):
    //    SÓ pede facial SE e SOMENTE SE passou pela etapa de GPS.
    if (isFacialActiveCheckin && faceVerifyAction !== 'checkin') {
      (handleCheckin as any)._running = false;
      setFaceVerifyAction('checkin');
      setShowFaceVerify(true);
      return;
    }
    setFaceVerifyAction(null);
    try {
      logger.info('[handleCheckin] Iniciando check-in da rota (após validação GPS OK)', { routeId: id, pdvName: route?.pdv_name });

      const body = {
        id,
        latitude: pos?.coords.latitude,
        longitude: pos?.coords.longitude,
        device: navigator.userAgent || 'Unknown Device',
        photo_url: effectivePhotoUrl || undefined,
        facial_verified: isFacialActiveCheckin || undefined,
        all_routes_at_pdv: true,
      };

      if (isOnline) {
        try {
          const token = localStorage.getItem('promotor_token') || localStorage.getItem('auth_token') || '';
          const baseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
          const url = `${baseUrl}/api/merch/promotor/routes/${id}/checkin`;
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
          });
          let result: any = {};
          try { result = await response.json(); } catch {}
          const errorCode = result?.error_code || result?.error || '';
          const details = result?.details || {};
          const isGeoError =
            result?.error === 'outside_geofence' ||
            errorCode === 'GEO_OUT_OF_RANGE' ||
            (typeof result?.error === 'string' && result.error.includes('área permitida'));

          if (!response.ok && isGeoError) {
            const placeType = details.place_type === 'sede' ? 'Sede' : (details.place_name || 'PDV');
            const modeLabel = details.mode === 'polygon'
              ? 'polígono geográfico (perímetro)'
              : (details.radius_meters != null ? `raio de ${Number(details.radius_meters)} m` : 'raio de alcance');
            const distText = details.distance_meters != null
              ? ` — você está a ~${details.distance_meters >= 1000
                  ? `${(details.distance_meters/1000).toFixed(1).replace('.',',')} km`
                  : `${details.distance_meters} m`} do local`
              : '';
            const fullMsg = result?.message || `Você precisa estar no ${placeType} para fazer check-in.${distText}`;
            const hintMsg = details.mode_hint
              ? `${details.mode_hint} Aproxime-se para concluir o check-in.`
              : `Verificação: ${modeLabel}. Aproxime-se do local para habilitar o check-in.${details.accept_justification ? ' Caso esteja impossibilitado, envie justificativa.' : ''}`;
            setCheckinGeoError({ title: '📍 Fora da área permitida', message: fullMsg, details: { ...details, hint: hintMsg, placeType } });
            logger.warn('[handleCheckin] Check-in bloqueado por geofence', { routeId: id, details });
            toast.error(fullMsg, { duration: 10000 });
            toast.error(hintMsg, { duration: 10000 });
            return;
          }
          if (!response.ok) {
            throw new Error(result?.error || result?.message || `Erro na requisição (${response.status})`);
          }
        } catch (e: any) {
          if (e?.message && (
            e.message.includes('área permitida') ||
            e.message.includes('GEO_OUT_OF_RANGE') ||
            e.message.includes('outside_geofence')
          )) {
            throw e;
          }
          logger.warn('[handleCheckin] Chamada síncrona falhou, caindo para queueApiCall', { error: e?.message });
          await queueApiCall({
            url: `/api/merch/promotor/routes/${id}/checkin`,
            method: 'POST',
            body,
            headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` },
            dependsOnUploadId: effectivePhotoUrl?.startsWith('local-file://') ? effectivePhotoUrl.replace('local-file://', '') : undefined
          });
        }
      } else {
        await queueApiCall({
          url: `/api/merch/promotor/routes/${id}/checkin`,
          method: 'POST',
          body,
          headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` },
          dependsOnUploadId: effectivePhotoUrl?.startsWith('local-file://') ? effectivePhotoUrl.replace('local-file://', '') : undefined
        });
      }
      // Removed toast per user request

      // Otimista: libera a UI imediatamente para o promotor seguir o trabalho
      // sem esperar o refetch (a chamada de check-in é processada em background).
      setCheckinSubmitted(true);
      // We still want to refetch the route data to show updated status, 
      // but we do it immediately without waiting for the checkin call to finish.
      // The backend check-in usually takes care of the status.
      setTimeout(() => refetch(), 1000); 
    } catch (err: any) {
      (handleCheckin as any)._running = false;
      logger.error('[handleCheckin] Erro fatal no check-in', { message: err.message, routeId: id }, err);
      toast.error(err.message || 'Não foi possível realizar o check-in');
    }
  }, [id, checkin, route, checkinPhotoUrl, isFacialActiveCheckin, faceVerifyAction, isOnline, queueApiCall, refetch, checkinSubmitted]);

  const handleCompleteRoute = useCallback(async () => {
    if (!id) return;
    if (isFacialActiveCheckin && faceVerifyAction !== 'checkout') {
      setFaceVerifyAction('checkout');
      setShowFaceVerify(true);
      return;
    }
    setFaceVerifyAction(null);

    // Prioritize background queue for all checkouts to ensure they work offline
    queueApiCall({
      url: `/api/merch/promotor/routes/${id}/checkout`,
      method: 'POST',
      body: { notes: actionForm.notes },
      headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` }
    });
    
    // Optimistically update UI and redirect immediately
    setShowCompleteRoute(false);
    navigate('/promotor/home');

  }, [id, actionForm.notes, navigate, isFacialActiveCheckin, faceVerifyAction, queueApiCall]);

  const handlePdvCheckout = useCallback(async () => {
    if (!route?.pdv_id) return;
    if (isFacialActiveCheckin && faceVerifyAction !== 'pdv_checkout') {
      setFaceVerifyAction('pdv_checkout');
      setShowFaceVerify(true);
      return;
    }
    setFaceVerifyAction(null);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
      ).catch(() => null);

      const body = {
        pdv_id: route.pdv_id,
        latitude: pos?.coords.latitude,
        longitude: pos?.coords.longitude,
        photo_url: pdvCheckoutPhoto || undefined,
        status_override: !pdvCheckoutPhoto ? 'awaiting_photo' : 'completed',
        notes: actionForm.pdv_notes,
      };

      // Always use background queue for PDV checkout for performance
      queueApiCall({
        url: '/api/merch/promotor/pdv-checkout',
        method: 'POST',
        body,
        headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` },
        dependsOnUploadId: pdvCheckoutPhoto?.startsWith('local-file://') ? pdvCheckoutPhoto.replace('local-file://', '') : undefined
      });
      // Removed toast per user request

      setShowPdvCheckout(false);
      navigate('/promotor/home');
    } catch (err: any) {
      toast.error(err.message || 'Erro no checkout do PDV');
    }
  }, [route?.pdv_id, pdvCheckout, pdvCheckoutPhoto, actionForm, navigate, isOnline, queueApiCall]);

  const handleOpenProduct = useCallback((exec: any) => {
    const routeBrandId = exec.route_brand_id;
    const categoryKey = `${exec.category_id}_${routeBrandId || 'null'}`;
    const catStatus = categoryStatusMap[categoryKey] || categoryStatusMap[exec.category_id];
    
    // Check checklist settings for this brand
    const rb = isMultiBrand ? routeBrands.find((b: any) => b.id === routeBrandId) : null;
    const requireCategoryPhotos = (rb || route as any)?.require_category_photos !== false;
    const photoMode = (rb || route as any)?.category_photo_mode || 'both';
    const hasCategoryAccess = !!catStatus?.products_unlocked || !!catStatus?.category_before_photo || !!optimisticBeforeUnlock[categoryKey] || (photoMode === 'after' && !!catStatus?.point_type);
    
    if (requireCategoryPhotos && !hasCategoryAccess) {
      toast.error('Finalize a etapa de preparação da categoria antes de executar produtos.');
      return;
    }
    setSelectedExec(exec);
    setActionForm({
      qty_store: exec.qty_store || 0,
      qty_stock: exec.qty_stock || 0,
      expiry_date: exec.nearest_expiry_date ? String(exec.nearest_expiry_date).slice(0, 10) : '',
      val_qty_store: exec.nearest_expiry_qty_store ?? 0,
      val_qty_stock: exec.nearest_expiry_qty_stock ?? 0,
      product_observation: exec.observation ?? '',
    });
    setActiveAction(null);
  }, [categoryStatusMap, optimisticBeforeUnlock]);

  // 3 fontes de verdade para needsCheckin (evita "volta para tela de check-in"):
  //   (1) status do backend (scheduled/confirmed → candidata a precisa)
  //   (2) checkin_at populado na própria rota → já check-inou
  //   (3) submitted otimista OU pdv_visit em promotor-home com checkin_at → já check-inou
  const needsCheckin = useMemo(() => {
    if (!route) return false;
    const statusNeeds = route.status === 'scheduled' || route.status === 'confirmed';
    if (!statusNeeds) return false;
    if (route.checkin_at) return false;
    if (checkinSubmitted) return false;
    try {
      const home = (qc.getQueryData(['promotor-home']) as any) || null;
      if (Array.isArray(home?.pdvVisits)) {
        const hasVisit = home.pdvVisits.some((v: any) => v && v.pdv_id === route.pdv_id && v.checkin_at);
        if (hasVisit) return false;
      }
    } catch {}
    return true;
  }, [route, checkinSubmitted, qc]);

  if (isLoading) return <PromotorLayout><div className="flex items-center justify-center h-64"><div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" /></div></PromotorLayout>;
  if (!route) return <PromotorLayout><div className="text-center py-12 text-muted-foreground">Rota não encontrada</div></PromotorLayout>;

  const isActive = route.status === 'in_progress' || route.status === 'completed' || !!route.checkin_at || !needsCheckin;
  const isCompleted = route.status === 'completed';
  // Foto de check-in: padrão do checklist é obrigatória. Só liberamos sem foto quando o flag vier explicitamente false.
  const requireCheckinPhoto = (route as any)?.require_checkin_photo !== false;

  // Multi-brand: show brand selection screen after check-in
  const showBrandSelector = isMultiBrand && isActive && !activeBrandId;

  const categoriesBlock = (isActive && (!isMultiBrand || activeBrandId)) ? (
          <div className="space-y-4">
            {isCheckinOnlyMode ? (
              <Card className="border-emerald-300/60 bg-emerald-50/60">
                <CardContent className="p-5 text-center space-y-3">
                  <div className="w-14 h-14 rounded-full bg-emerald-100 mx-auto flex items-center justify-center">
                    <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                  </div>
                  <div>
                    <h3 className="font-bold text-emerald-900">
                      {isMultiBrand && currentBrand?.brand_name ? `${currentBrand.brand_name} · ` : ''}
                      Checklist de Presença
                    </h3>
                    <p className="text-sm text-emerald-800 mt-1">
                      Este checklist é apenas para confirmar sua presença no PDV.
                      Não são necessários produtos, estoque, validade ou fotos de categorias.
                    </p>
                  </div>
                  <div className="flex flex-col items-center gap-1 text-[11px] text-emerald-700 pt-1">
                    <p className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Check-in realizado
                    </p>
                    <p className="text-muted-foreground text-[10px]">
                      Ao finalizar a rota abaixo, sua visita será registrada.
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : (
            <>
            {(() => {
              const stockBrandId = isMultiBrand ? activeBrandId : route?.brand_id;
              const stockBrandName = isMultiBrand ? (currentBrand?.brand_name || route.brand_name) : route?.brand_name;
              return stockBrandId && route?.pdv_id ? (
                <StockCountCard
                  routeId={id!}
                  brandId={stockBrandId}
                  brandName={stockBrandName}
                  pdvId={route.pdv_id}
                  promoterId={route.promoter_id || route.promotor_id || route.employee_id || ''}
                />
              ) : null;
            })()}
            {Object.entries(groupedExecs).map(([category, { catId, execs, isExtraGroup }]) => {
              const routeBrandId = execs[0]?.route_brand_id;
              const categoryKey = `${catId}_${routeBrandId || 'null'}`;
              const catStatus = categoryStatusMap[categoryKey] || categoryStatusMap[catId];
              
              // Use checklist settings if available
              const rb = isMultiBrand ? routeBrands.find((b: any) => b.brand_id === activeBrandId) : null;
              const photoMode = (rb || route as any)?.category_photo_mode || 'both';
              const requireCategoryPhotos = (rb || route as any)?.require_category_photos !== false;
              
              const extraPhotoKey = `extra_${catId || 'null'}_${routeBrandId || 'null'}`;
              const hasExtraPhoto = !!extraGroupPhotos[extraPhotoKey] || persistedExtraPointPhotoKeys.has(extraPhotoKey);
              
              // Unlocked depends on photoMode:
              // if 'after', products_unlocked comes from point-type selection
              // if 'before' or 'both', products_unlocked comes from before-photo upload
              const anyExecDone = execs.some((e: any) => e.status !== 'pending');
              const hasBeforeUnlock = !!catStatus?.products_unlocked || !!catStatus?.category_before_photo || !!optimisticBeforeUnlock[categoryKey];
              const isLocked = requireCategoryPhotos 
                ? (isExtraGroup ? (!hasExtraPhoto && !anyExecDone) : !hasBeforeUnlock) 
                : false;
                
              // Se o modo for "Só Depois" e já tiver selecionado o tipo de ponto, liberamos os produtos mesmo se o backend ainda não marcou products_unlocked
              const effectivelyLocked = isLocked && !(photoMode === 'after' && catStatus?.point_type);
                
              const doneCount = execs.filter((e: any) => e.status === 'completed').length;
              const allProductsDone = doneCount === execs.length && execs.length > 0;
              const afterPhotoKey = `${catId}_${routeBrandId || 'null'}`;
              const minAfterPhotos = Math.max(1, parseInt((rb || route as any)?.min_category_photos_after, 10) || 1);
              const afterPhotoCount = new Set(
                [...(route?.photos || []), ...optimisticPhotos]
                  .filter((p: any) =>
                    (p.category_id || null) === (catId || null) &&
                    (p.route_brand_id || null) === (routeBrandId || null) &&
                    p.photo_type === 'category_after'
                  )
                  .map((p: any) => p.photo_url)
                  .filter(Boolean)
              ).size;
              const hasAfterPhoto = !!catStatus?.completed || !!catStatus?.category_after_photo || !!optimisticAfterPhoto[afterPhotoKey] || afterPhotoCount >= minAfterPhotos;
              const accordionKey = categoryKey;
              const isCompletedCategory = hasAfterPhoto;
              
              const photoOnlyMode = !requireStockCount && !requireValidityCheck;
              const readyForAfterPhoto =
                allProductsDone ||
                execs.length === 0 ||
                (photoOnlyMode && !effectivelyLocked) ||
                (photoMode === 'after' && !effectivelyLocked);

              // Show after photo gate when products are done OR photo-only checklist asks only after-photo
              const needsAfterPhoto = requireCategoryPhotos && 
                readyForAfterPhoto && 
                !effectivelyLocked && 
                !hasAfterPhoto && 
                (photoMode === 'both' || photoMode === 'after');


              // Visual state: active = unlocked & not completed; locked = needs photo; done = after photo taken
              const isActiveCategory = !effectivelyLocked && !isCompletedCategory && (isExtraGroup ? hasExtraPhoto : hasBeforeUnlock);
              const wrapperClass = isCompletedCategory
                ? 'border-green-500/30 bg-green-500/5'
                : isActiveCategory
                  ? 'border-primary ring-2 ring-primary/40 bg-primary/5 shadow-md shadow-primary/10'
                  : effectivelyLocked
                    ? 'border-dashed border-muted-foreground/30 bg-muted/30 opacity-70'
                    : 'border-border bg-card';

              return (

                <div key={category} className={`rounded-xl border p-3 transition-all ${wrapperClass}`}>
                  {isActiveCategory && (
                    <div className="flex items-center gap-1.5 mb-2 text-[10px] font-bold uppercase tracking-wider text-primary">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                      Categoria em andamento
                    </div>
                  )}
                  {/* Category preparation for normal groups */}
                  {effectivelyLocked && !isExtraGroup && (
                    <CategoryPreparation
                      category={catStatus}
                      catId={catId}
                      routeBrandId={routeBrandId}
                      categoryName={category}
                      routeId={id!}
                      pdvName={route.pdv_name}
                      brandName={currentBrand?.brand_name || route.brand_name}
                      promotorName={route.promoter_name}
                      qualityConfig={photoQualityConfig}
                      photoMode={photoMode}
                      minPhotos={Math.max(1, parseInt((rb || route as any)?.min_category_photos_before, 10) || 1)}
                      onUnlocked={() => {
                        setOptimisticBeforeUnlock(prev => ({ ...prev, [categoryKey]: true }));
                        // O card já reage ao estado otimista acima; o refetch atrasado
                        // serve só para atualizar campos que só existem no servidor
                        // (ex.: progress_pct da rota/marca), sem sobrescrever a UI
                        // otimista antes da chamada enfileirada ter chance de processar.
                        setTimeout(() => refetch(), 1000);
                      }}
                      onPointTypeSet={() => { /* offline-first state handled in component */ }}
                      facialRequired={facialRequired}
                      storedDescriptor={storedDescriptor}
                      storedPhotoUrl={storedPhotoUrl}
                      onCaptureOptimistic={(url, type) => setOptimisticPhotos(prev => [...prev, { photo_url: url, photo_type: type, category_id: catId, route_brand_id: routeBrandId }])}

                    />
                  )}

                  {/* Extra group: only needs photo, no point type */}
                  {isExtraGroup && !hasExtraPhoto && (
                    <ExtraPointPhotoGate
                      catId={catId}
                      routeBrandId={routeBrandId}
                      categoryName={category}
                      routeId={id!}
                      pdvName={route.pdv_name}
                      brandName={currentBrand?.brand_name || route.brand_name}
                      promotorName={route.promoter_name}
                      qualityConfig={photoQualityConfig}
                      onPhotoTaken={() => {
                        setExtraGroupPhotos(prev => ({ ...prev, [extraPhotoKey]: true }));
                        setTimeout(() => refetch(), 1000);
                      }}
                      onCaptureOptimistic={(url, type) => setOptimisticPhotos(prev => [...prev, { photo_url: url, photo_type: type, category_id: catId, route_brand_id: routeBrandId }])}
                    />
                  )}

                  {/* Category header */}
                  <div
                    className={`flex items-center justify-between mb-2 rounded-md px-2 py-1.5 transition-colors ${isCompletedCategory ? 'cursor-pointer' : ''}`}
                    onClick={isCompletedCategory ? () => setExpandedCategories(prev => ({ ...prev, [accordionKey]: !prev[accordionKey] })) : undefined}
                  >
                    <div className="flex items-center gap-2">
                      {hasAfterPhoto ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : isExtraGroup ? <Target className="h-4 w-4 text-orange-600" /> : (requireCategoryPhotos && effectivelyLocked) ? <Lock className="h-4 w-4 text-muted-foreground" /> : <Unlock className="h-4 w-4 text-primary" />}
                      <h3 className={`text-sm font-bold ${isActiveCategory ? 'text-primary' : ''}`}>{category}</h3>
                      {hasAfterPhoto && (
                        <Badge variant="secondary" className="text-[9px] bg-green-100 text-green-700">✅ OK</Badge>
                      )}
                      {isExtraGroup && !hasAfterPhoto ? (
                        <Badge variant="secondary" className="text-[9px] bg-orange-100 text-orange-700 border-orange-300">🎯 Extra</Badge>
                      ) : !hasAfterPhoto && catStatus?.point_type && (
                        <Badge variant="outline" className="text-[9px]">
                          {catStatus.point_type === 'natural' ? '📍 Natural' : '🎯 Extra'}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {!isExtraGroup && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[10px]"
                          onClick={(e) => { e.stopPropagation(); setExtraPhotosOpen(prev => ({ ...prev, [accordionKey]: !prev[accordionKey] })); }}
                          title="Ver fotos / adicionar mais"
                        >
                          <Camera className="h-3.5 w-3.5 mr-1" />
                          Fotos
                        </Button>
                      )}
                      {!photoOnlyMode && (
                        <Badge variant={isActiveCategory ? 'default' : 'outline'} className="text-[10px]">{doneCount}/{execs.length}</Badge>
                      )}
                      {isCompletedCategory && (expandedCategories[accordionKey] ? <ChevronUp className="h-4 w-4 text-green-700" /> : <ChevronDown className="h-4 w-4 text-green-700" />)}
                    </div>
                  </div>

                  {/* Painel de fotos extras da categoria */}
                  {extraPhotosOpen[accordionKey] && !isExtraGroup && (
                    <CategoryExtraPhotosPanel
                      routeId={id!}
                      catId={catId}
                      routeBrandId={routeBrandId}
                      photos={[...(route?.photos || []), ...optimisticPhotos].filter((p: any) =>
                        (p.category_id || null) === (catId || null) &&
                        (p.route_brand_id || null) === (routeBrandId || null) &&
                        (p.photo_type === 'category_before' || p.photo_type === 'category_after')
                      )}
                      hasAnyBefore={
                        !!catStatus?.category_before_photo ||
                        [...(route?.photos || []), ...optimisticPhotos].some((p: any) =>
                          (p.category_id || null) === (catId || null) &&
                          (p.route_brand_id || null) === (routeBrandId || null) &&
                          p.photo_type === 'category_before'
                        )
                      }
                      hasAnyAfter={
                        !!catStatus?.category_after_photo ||
                        [...(route?.photos || []), ...optimisticPhotos].some((p: any) =>
                          (p.category_id || null) === (catId || null) &&
                          (p.route_brand_id || null) === (routeBrandId || null) &&
                          p.photo_type === 'category_after'
                        )
                      }
                      completed={isCompletedCategory}
                      unlockBeforeUrl={catStatus?.category_before_photo || null}
                      unlockAfterUrl={catStatus?.category_after_photo || null}
                      pdvName={route.pdv_name}
                      brandName={currentBrand?.brand_name || route.brand_name}
                      promotorName={route.promoter_name}
                      categoryName={category}
                      qualityConfig={photoQualityConfig}
                      onUploaded={(url, type) => {
                        if (url && type) {
                          // Não marcamos a categoria como concluída aqui incondicionalmente:
                          // adicionar à lista otimista já faz `afterPhotoCount` (e portanto
                          // `hasAfterPhoto`) recalcular corretamente contra o mínimo exigido
                          // pelo checklist — uma única foto extra não deve pular esse mínimo.
                          setOptimisticPhotos(prev => [...prev, { photo_url: url, photo_type: type, category_id: catId, route_brand_id: routeBrandId }]);
                        }
                        refetch();
                      }}
                    />
                  )}

                  {/* Photo-only mode: collapse products into accordion (only matters when stock/validity counting is OFF) */}
                  {(() => {
                    const photoOnlyMode = !requireStockCount && !requireValidityCheck;
                    const isExpanded = isCompletedCategory ? !!expandedCategories[accordionKey] : photoOnlyMode ? !!expandedCategories[accordionKey] : true;
                    const showProducts = isCompletedCategory ? isExpanded : (!photoOnlyMode || isExpanded);
                    return (
                      <>
                        {photoOnlyMode && !isCompletedCategory && !effectivelyLocked && (
                          <button
                            type="button"
                            onClick={() => setExpandedCategories(prev => ({ ...prev, [accordionKey]: !prev[accordionKey] }))}
                            className="w-full flex items-center justify-between gap-2 text-[11px] text-muted-foreground py-1.5 px-2 rounded hover:bg-muted/50 border border-dashed border-muted-foreground/20 mb-1.5"
                          >
                            <span className="flex items-center gap-1.5">
                              <Package className="h-3 w-3" />
                              {isExpanded ? 'Ocultar produtos' : `Ver ${execs.length} produto(s) para registrar avaria/ruptura/validade`}
                            </span>
                            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                        )}

                        {showProducts && (
                          <div className={`space-y-1.5 ${effectivelyLocked ? 'opacity-40 pointer-events-none select-none' : ''}`}>
                            {execs.map((exec: any) => (
                              <Card key={exec.id} className={`transition-colors hover:border-primary/40 ${exec.status === 'completed' ? 'border-green-500/30 bg-green-500/5' : ''}`}>
                                <CardContent className="p-3">
                                  <div className="flex items-center gap-3">
                                    <div className="flex-shrink-0 cursor-pointer" onClick={() => {
                                      if (canQuickCheck) {
                                        updateExec.mutate({
                                          id: exec.id,
                                          status: exec.status === 'completed' ? 'pending' : 'completed',
                                          checked: exec.status !== 'completed',
                                          qty_store: 0,
                                          qty_stock: 0
                                        }, {
                                          onSuccess: () => { /* toast removed */ },
                                          onError: (err: any) => toast.error(err.message)
                                        });
                                      } else {
                                        handleOpenProduct(exec);
                                      }
                                    }}>
                                      {EXEC_STATUS_ICON[exec.status] || EXEC_STATUS_ICON.pending}
                                    </div>
                                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleOpenProduct(exec)}>
                                      <div className="text-sm font-medium truncate">{exec.product_name}</div>
                                      {exec.exposure_point !== 'natural' && <Badge variant="secondary" className="text-[9px] mt-0.5">{exec.exposure_point}</Badge>}
                                      {requireStockCount && (exec.qty_store > 0 || exec.qty_stock > 0) && (
                                        <div className="text-[10px] text-muted-foreground mt-0.5">
                                          Loja: {exec.qty_store} | Estoque: {exec.qty_stock} | Total: {exec.qty_total}
                                        </div>
                                      )}
                                      {requireValidityCheck && exec.nearest_expiry_date && (
                                        <div className="text-[10px] text-blue-600 mt-0.5 flex items-center gap-1">
                                          <CalendarIcon className="h-2.5 w-2.5" /> Val: {new Date(exec.nearest_expiry_date).toLocaleDateString('pt-BR')}
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => handleOpenProduct(exec)}>
                                      {exec.has_rupture && <AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
                                      {exec.has_damage && <Archive className="h-3.5 w-3.5 text-orange-500" />}
                                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                    </div>
                                  </div>
                                </CardContent>
                              </Card>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* After Photo Gate - shown when all products done but category not yet completed */}
                  {needsAfterPhoto && (
                    <CategoryAfterPhotoGate
                      catId={catId}
                      routeBrandId={routeBrandId}
                      categoryName={category}
                      routeId={id!}
                      pdvName={route.pdv_name}
                      brandName={currentBrand?.brand_name || route.brand_name}
                      promotorName={route.promoter_name}
                      qualityConfig={photoQualityConfig}
                      minPhotos={minAfterPhotos}
                      afterOnly={photoMode === 'after'}
                      beforePhotoUrl={
                        catStatus?.category_before_photo ||
                        ([...(route?.photos || []), ...optimisticPhotos].find((p: any) =>
                          (p.category_id || null) === (catId || null) &&
                          (p.route_brand_id || null) === (routeBrandId || null) &&
                          p.photo_type === 'category_before'
                        )?.photo_url ?? null)
                      }
                      onCompleted={() => {
                        setOptimisticAfterPhoto(p => ({ ...p, [afterPhotoKey]: true }));
                        // O card fica verde na hora pelo estado otimista acima; o refetch
                        // atrasado atualiza a barra de progresso (route.progress_pct), que
                        // só é recalculada no servidor após a chamada enfileirada processar.
                        setTimeout(() => refetch(), 1000);
                      }}
                      onCaptureOptimistic={(url, type) => setOptimisticPhotos(prev => [...prev, { photo_url: url, photo_type: type, category_id: catId, route_brand_id: routeBrandId }])}
                    />
                  )}
                </div>
              );
            })}
            </>
            )}

            {/* Complete Route button */}
            {(() => {
              // Para rotas multi-marcas, a conclusão global deve checar TODOS os produtos de TODAS as marcas
              const allExecutions = route?.executions || [];
              const productIsRequired = (exec: any) => {
                const rbConfig = isMultiBrand ? routeBrands.find((b: any) => b.id === exec.route_brand_id) : null;
                const source = rbConfig || (route as any);
                const photoOnlyAfter = source?.require_category_photos !== false &&
                  (source?.category_photo_mode || 'both') === 'after' &&
                  !source?.require_stock_count && !source?.require_validity_check;
                return !photoOnlyAfter;
              };
              // Em checklist "Somente Depois" sem estoque/validade, os produtos são
              // opcionais: a categoria é concluída exclusivamente pelo mínimo de fotos.
              const requiredProductExecutions = allExecutions.filter(productIsRequired);
              const totalExecsGlobalRaw = requiredProductExecutions.length;
              const completedExecsGlobalRaw = requiredProductExecutions.filter((e: any) => e.status === 'completed').length;

              // MODO CHECKIN_ONLY: zera as exigências de produtos/fotos de categoria
              const totalExecsGlobal = isCheckinOnlyMode ? 0 : totalExecsGlobalRaw;
              const completedExecsGlobal = isCheckinOnlyMode ? 0 : completedExecsGlobalRaw;
               const allProductsDoneGlobal = isCheckinOnlyMode ? true : (totalExecsGlobal === 0 || completedExecsGlobal === totalExecsGlobal);
              
              // Verificação global de fotos de categoria (DEPOIS) em todas as marcas/categorias
              const allExecutionsGroupedGlobal = allExecutions.reduce((acc: any, e: any) => {
                const key = e.route_brand_id ? `${e.category_id}_${e.route_brand_id}` : e.category_id;
                if (!acc[key]) acc[key] = { catId: e.category_id, routeBrandId: e.route_brand_id, execs: [] };
                acc[key].execs.push(e);
                return acc;
              }, {});

              const globalMissingBeforePhotos = isCheckinOnlyMode ? [] : Object.entries(allExecutionsGroupedGlobal).filter(([key, data]: [string, any]) => {
                const { catId, routeBrandId, execs } = data;
                const catStatus = categoryStatusMap[key] || categoryStatusMap[catId];
                const rbConfig = isMultiBrand ? routeBrands.find((b: any) => b.id === routeBrandId) : null;
                const reqPhotos = (rbConfig || route as any)?.require_category_photos !== false;
                const pMode = (rbConfig || route as any)?.category_photo_mode || 'both';
                const needsBefore = reqPhotos && (pMode === 'both' || pMode === 'before');
                if (!needsBefore) return false;
                // Pontos extras seguem o mesmo checklist da marca (antes/depois obrigatórios conforme configuração)
                const hasBeforePhotoInRoute = (route?.photos || []).some((p: any) => (p.category_id || null) === (catId || null) && (!routeBrandId || (p.route_brand_id || null) === routeBrandId) && p.photo_type === 'category_before');
                const hasBefore = !!catStatus?.category_before_photo || !!catStatus?.products_unlocked || hasBeforePhotoInRoute || !!optimisticBeforeUnlock[`${catId}_${routeBrandId || 'null'}`];
                return !hasBefore;
              });

              const globalMissingAfterPhotos = isCheckinOnlyMode ? [] : Object.entries(allExecutionsGroupedGlobal).filter(([key, data]: [string, any]) => {
                const { catId, routeBrandId, execs } = data;
                const catStatus = categoryStatusMap[key] || categoryStatusMap[catId];
                 const allDone = execs.every((e: any) => e.status === 'completed');
                
                // Busca as configurações da marca para esta categoria
                const rbConfig = isMultiBrand ? routeBrands.find((b: any) => b.id === routeBrandId) : null;
                const reqPhotos = (rbConfig || route as any)?.require_category_photos !== false;
                const pMode = (rbConfig || route as any)?.category_photo_mode || 'both';
                
                 const needsAfter = reqPhotos && (pMode === 'both' || pMode === 'after');
                 const minAfterPhotos = Math.max(1, parseInt((rbConfig || route as any)?.min_category_photos_after, 10) || 1);
                 const afterPhotoCount = new Set(
                   [...(route?.photos || []), ...optimisticPhotos]
                     .filter((p: any) =>
                       (p.category_id || null) === (catId || null) &&
                       (!isMultiBrand || (p.route_brand_id || null) === (routeBrandId || null)) &&
                       p.photo_type === 'category_after'
                     )
                     .map((p: any) => p.photo_url)
                     .filter(Boolean)
                 ).size;
                 // Mesma definição de "foto do depois concluída" usada no card da categoria (hasAfterPhoto):
                 // category_after_photo OU completed (backend já aceitou a foto) OU foto na rota OU estado offline.
                 // Sem o fallback `completed`, uma categoria marcada como concluída no backend mas sem
                 // category_after_photo no status retornado ficava verde mas bloqueava a conclusão da rota.
                  const hasAfter = !!catStatus?.completed ||
                    !!catStatus?.category_after_photo ||
                    !!optimisticAfterPhoto[`${catId}_${routeBrandId || 'null'}`] ||
                    afterPhotoCount >= minAfterPhotos;
                 
                  const photoOnlyAfter = pMode === 'after' &&
                    !(rbConfig || route as any)?.require_stock_count &&
                    !(rbConfig || route as any)?.require_validity_check;
                  // No modo somente foto depois, produtos não bloqueiam a categoria.
                  return (allDone || photoOnlyAfter) && needsAfter && !hasAfter;
              });

              const allBeforePhotosDone = globalMissingBeforePhotos.length === 0;
              const allAfterPhotosDone = globalMissingAfterPhotos.length === 0;
              
              // Também checamos se todas as marcas estão concluídas (para garantir que o checklist foi processado)
              const allBrandsCompleted = isMultiBrand 
                ? routeBrands.every((rb: any) => rb.status === 'completed' || rb.progress_pct >= 100)
                : true;
              
              const minDuration = parseInt(route?.min_duration_minutes || "0", 10);
              const checkinAt = route?.checkin_at ? new Date(route.checkin_at) : null;
              const elapsedMinutes = checkinAt ? Math.floor((currentTime.getTime() - checkinAt.getTime()) / 60000) : 0;
              const hasMinDurationMet = minDuration === 0 || elapsedMinutes >= minDuration;
              
              // A rota só pode ser concluída se TODOS os produtos, TODAS as fotos (antes+depois) e tempo mínimo forem respeitados
              const stockCountPending = stockCountBlocking.length;
              const canCompleteRoute = allProductsDoneGlobal && allBrandsCompleted && allBeforePhotosDone && allAfterPhotosDone && hasMinDurationMet && stockCountPending === 0;
              
              return (
                <>
                  <Button className="w-full h-12" onClick={() => {
                    // Helpers para nomear categoria/marca no toast
                    const nameFor = (catId: string, routeBrandId?: string) => {
                      const ex = allExecutions.find((e: any) => (e.category_id || null) === (catId || null) && (!routeBrandId || (e.route_brand_id || null) === routeBrandId));
                      const cat = ex?.category_name || 'Categoria';
                      const rb = routeBrandId ? routeBrands.find((b: any) => b.id === routeBrandId) : null;
                      return rb?.brand_name ? `${rb.brand_name} › ${cat}` : cat;
                    };
                    if (!allProductsDoneGlobal) {
                       const pendingList = requiredProductExecutions.filter((e: any) => e.status !== 'completed');
                      const pendingExtra = pendingList.filter((e: any) => e.exposure_point === 'extra').length;
                      const sample = pendingList.slice(0, 3).map((e: any) => {
                        const rb = e.route_brand_id ? routeBrands.find((b: any) => b.id === e.route_brand_id) : null;
                        return `${rb?.brand_name ? rb.brand_name + ' › ' : ''}${e.category_name || 'Categoria'} › ${e.product_name || 'Produto'}`;
                      }).join('\n');
                      toast.error(
                        (pendingExtra > 0 ? `${pendingExtra} produto(s) de PONTO EXTRA pendentes. ` : '') +
                        `Faltam ${totalExecsGlobal - completedExecsGlobal} produto(s):\n${sample}${pendingList.length > 3 ? `\n… e mais ${pendingList.length - 3}` : ''}`,
                        { duration: 8000 }
                      );
                      return;
                    }
                    if (!allBeforePhotosDone) {
                      const names = globalMissingBeforePhotos.slice(0, 4).map(([, d]: [string, any]) => nameFor(d.catId, d.routeBrandId)).join('\n');
                      toast.error(`Fotos ANTES pendentes:\n${names}${globalMissingBeforePhotos.length > 4 ? `\n… e mais ${globalMissingBeforePhotos.length - 4}` : ''}`, { duration: 8000 });
                      return;
                    }
                    if (!allAfterPhotosDone) {
                      const names = globalMissingAfterPhotos.slice(0, 4).map(([, d]: [string, any]) => nameFor(d.catId, d.routeBrandId)).join('\n');
                      toast.error(`Fotos DEPOIS pendentes:\n${names}${globalMissingAfterPhotos.length > 4 ? `\n… e mais ${globalMissingAfterPhotos.length - 4}` : ''}`, { duration: 8000 });
                      return;
                    }
                    if (!allBrandsCompleted) {
                      const pendingBrands = routeBrands.filter((rb: any) => !(rb.status === 'completed' || (rb.progress_pct || 0) >= 100)).map((rb: any) => `${rb.brand_name} (${Math.round(rb.progress_pct || 0)}%)`).join('\n');
                      toast.error(`Marcas ainda não concluídas:\n${pendingBrands}`, { duration: 8000 });
                      return;
                    }
                    if (stockCountPending > 0) {
                      toast.error(`Contagem de estoque obrigatória pendente em ${stockCountPending} marca(s).`);
                      return;
                    }
                    if (!hasMinDurationMet) {
                      toast.error(`Tempo mínimo de permanência não atingido. Faltam ${minDuration - elapsedMinutes} minuto(s).`);
                      return;
                    }
                    if (!isOnline) {
                      // Se offline, fazemos o checkout lógico na fila para liberar o promotor
                      handleCompleteRoute();
                    } else {
                    // Se estiver offline ou para melhor UX, chama handleCompleteRoute direto
                    // O diálogo só é estritamente necessário se quisermos forçar nota (opcional aqui)
                    handleCompleteRoute();
                    }
                  }} disabled={checkout.isPending} variant={canCompleteRoute ? 'default' : 'secondary'}>
                    <Check className="h-5 w-5 mr-2" /> {isCheckinOnlyMode ? 'Concluir Presença' : `Concluir Rota (${completedExecsGlobal}/${totalExecsGlobal})`}
                  </Button>
                  {!canCompleteRoute && (
                    <div className="space-y-1">
                      <p className="text-[10px] text-center text-destructive">
                        ⚠️ {isCheckinOnlyMode
                          ? (stockCountPending > 0
                              ? `Contagem de estoque obrigatória pendente em ${stockCountPending} marca(s).`
                              : !hasMinDurationMet
                                ? `Tempo mínimo: faltam ${minDuration - elapsedMinutes} min.`
                                : !allBrandsCompleted
                                  ? 'Conclua o checklist de todas as marcas antes de finalizar a rota.'
                                  : 'Aguarde o check-in ser processado.')
                          : !allProductsDoneGlobal 
                            ? 'Todos os produtos de TODAS as marcas devem estar executados (100%) para concluir a rota.'
                            : !allBeforePhotosDone
                              ? 'Tire as fotos obrigatórias (ANTES) de todas as categorias.'
                              : !allAfterPhotosDone
                                ? 'Tire as fotos obrigatórias (DEPOIS) de todas as categorias concluídas.'
                                : !allBrandsCompleted 
                                  ? 'Conclua o checklist de todas as marcas antes de finalizar a rota.'
                                  : stockCountPending > 0
                                    ? `Contagem de estoque obrigatória pendente em ${stockCountPending} marca(s).`
                                    : `Tempo mínimo: faltam ${minDuration - elapsedMinutes} min.`}
                      </p>
                      {(isCheckinOnlyMode ? hasMinDurationMet : allProductsDoneGlobal && allBrandsCompleted && allAfterPhotosDone) && !hasMinDurationMet && (
                        <p className="text-[10px] text-center text-muted-foreground flex items-center justify-center gap-1">
                          <Clock className="h-3 w-3" /> Tempo mínimo de permanência: {minDuration} min
                        </p>
                      )}
                    </div>
                  )}
                </>
              );
            })()}



            {/* Extra Point button */}
            {!isCheckinOnlyMode && (
            <>
              <Button variant="outline" className="w-full h-10 border-dashed border-orange-400/50 text-orange-600 hover:bg-orange-50"
              onClick={() => {
                const cats = Object.entries(groupedExecs).filter(([, v]) => !v.isExtraGroup);
                if (cats.length === 1) {
                  setShowExtraPointDialog({ catId: cats[0][1].catId, categoryName: cats[0][0] });
                  setSelectedExtraProducts([]);
                } else {
                  setShowExtraPointCategoryPicker(true);
                }
              }}>
              <Target className="h-4 w-4 mr-2" /> Registrar Ponto Extra
            </Button>

            <p className="text-[10px] text-center text-muted-foreground">
              <Info className="h-3 w-3 inline mr-1" />
              {isMultiBrand
                ? 'Concluir a rota finaliza todas as marcas. O checkout da loja só será feito na última rota do PDV.'
                : 'Concluir a rota finaliza o checklist desta marca. O checkout da loja só será feito na última rota do PDV.'}
            </p>
            </>
            )}
          </div>
  ) : null;

  return (
    <PromotorLayout>
      <div className="max-w-lg mx-auto p-4 space-y-4">
        <div className="flex justify-end">
          <SyncStatusIndicator />
        </div>
        {/* Route header card */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <h2 className="font-bold text-lg">{route.pdv_name}</h2>
                {isMultiBrand ? (
                  <div className="flex items-center gap-2 mt-1">
                    <Badge className="bg-primary/20 text-primary text-[10px]">🏷️ Multi-marca</Badge>
                    <span className="text-xs text-muted-foreground">{routeBrands.length} marcas</span>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{route.brand_name}</p>
                )}
                {!isMultiBrand && route.checklist_name && <p className="text-xs text-muted-foreground mt-1">Checklist: {route.checklist_name}</p>}
              </div>
              <Badge className={route.status === 'in_progress' ? 'bg-orange-500/20 text-orange-700' : route.status === 'completed' ? 'bg-green-500/20 text-green-700' : 'bg-blue-500/20 text-blue-700'}>
                {route.status === 'in_progress' ? 'Em Andamento' : route.status === 'completed' ? 'Concluída' : 'Agendada'}
              </Badge>
              {isCheckinOnlyMode && (
                <Badge className="bg-emerald-500/15 text-emerald-700 border-0">
                  📍 Apenas Presença
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{route.pdv_address || route.pdv_city}</span>
              <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{route.scheduled_time?.slice(0, 5)}</span>
            </div>
            {isActive && (
              <div className="mt-3">
                <div className="flex justify-between text-xs mb-1">
                  <span>Progresso Geral</span>
                  <span className="font-mono font-bold">{Math.round(route.progress_pct || 0)}%</span>
                </div>
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${route.progress_pct || 0}%` }} />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Multi-brand: list of brands (drill-down) */}
        {isMultiBrand && isActive && !activeBrandId && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground px-1">
              Toque numa marca para abrir suas categorias.
            </p>
            {routeBrands.map((rb: any) => {
              const isDone = rb.status === 'completed';
              const isInProgress = rb.status === 'in_progress' || ((rb.progress_pct || 0) > 0 && !isDone);
              const cardCls = isDone
                ? 'border-green-500/60 bg-green-500/10 hover:bg-green-500/15'
                : isInProgress
                  ? 'border-yellow-500/60 bg-yellow-500/10 hover:bg-yellow-500/15'
                  : 'hover:border-primary/40';
              const barCls = isDone ? 'bg-green-500' : isInProgress ? 'bg-yellow-500' : 'bg-primary';
              return (
                <Card key={rb.brand_id}
                  className={`cursor-pointer transition-all ${cardCls}`}
                  onClick={() => setActiveBrandId(rb.brand_id)}>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {isDone ? (
                          <CheckCircle2 className="h-5 w-5 text-green-600" />
                        ) : isInProgress ? (
                          <Clock className="h-5 w-5 text-yellow-600" />
                        ) : (
                          <Circle className="h-5 w-5 text-muted-foreground" />
                        )}
                        <div>
                          <div className="text-sm font-semibold">{rb.brand_name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {isDone ? 'Concluída' : isInProgress ? 'Em andamento' : 'Pendente'}
                            {rb.checklist_name ? ` • ${rb.checklist_name}` : ''}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-mono font-bold ${isDone ? 'text-green-700' : isInProgress ? 'text-yellow-700' : ''}`}>
                          {Math.round(rb.progress_pct || 0)}%
                        </span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mt-2">
                      <div className={`h-full rounded-full transition-all ${barCls}`}
                        style={{ width: `${rb.progress_pct || 0}%` }} />
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            {(() => {
              const allBrandsCompleted = routeBrands.length > 0 && routeBrands.every((rb: any) => rb.status === 'completed' || (rb.progress_pct || 0) >= 100);
              if (!allBrandsCompleted) return null;
              const minDuration = parseInt(route?.min_duration_minutes || "0", 10);
              const checkinAt = route?.checkin_at ? new Date(route.checkin_at) : null;
              const elapsedMinutes = checkinAt ? Math.floor((currentTime.getTime() - checkinAt.getTime()) / 60000) : 0;
              const hasMinDurationMet = minDuration === 0 || elapsedMinutes >= minDuration;
              return (
                <div className="pt-2 space-y-1">
                  <Button
                    className="w-full h-12"
                    onClick={() => {
                      if (!hasMinDurationMet) {
                        toast.error(`Tempo mínimo de permanência não atingido. Faltam ${minDuration - elapsedMinutes} minuto(s).`);
                        return;
                      }
                      setShowCompleteRoute(true);
                    }}
                    disabled={checkout.isPending}
                    variant={hasMinDurationMet ? 'default' : 'secondary'}
                  >
                    <Check className="h-5 w-5 mr-2" /> Concluir Rota
                  </Button>
                  {!hasMinDurationMet && (
                    <p className="text-[10px] text-center text-muted-foreground flex items-center justify-center gap-1">
                      <Clock className="h-3 w-3" /> Tempo mínimo: faltam {minDuration - elapsedMinutes} min
                    </p>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* Multi-brand: selected brand detail (only this brand's categories) */}
        {isMultiBrand && isActive && activeBrandId && (
          <div className="space-y-3">
            <Button variant="ghost" size="sm" className="h-8 -ml-2" onClick={() => setActiveBrandId(null)}>
              <ChevronRight className="h-4 w-4 rotate-180 mr-1" />
              Voltar para marcas
            </Button>
            <Card className="border-primary/40 bg-primary/5">
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Package className="h-5 w-5 text-primary" />
                    <div>
                      <div className="text-sm font-semibold">{currentBrand?.brand_name || 'Marca'}</div>
                      {currentBrand?.checklist_name && (
                        <div className="text-[10px] text-muted-foreground">{currentBrand.checklist_name}</div>
                      )}
                    </div>
                  </div>
                  <span className="text-sm font-mono font-bold">{Math.round(currentBrand?.progress_pct || 0)}%</span>
                </div>
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mt-2">
                  <div className={`h-full rounded-full transition-all ${currentBrand?.status === 'completed' ? 'bg-green-500' : 'bg-primary'}`}
                    style={{ width: `${currentBrand?.progress_pct || 0}%` }} />
                </div>
              </CardContent>
            </Card>
            {categoriesBlock}
          </div>
        )}

        {/* Alerta explícito quando check-in falha por GPS */}
        {needsCheckin && checkinGeoError && (
          <Card className="border-destructive/60 bg-destructive/5 shadow-md">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <div className="flex-1 space-y-1">
                  <h3 className="text-sm font-bold text-destructive flex items-center gap-2">
                    {checkinGeoError.title}
                  </h3>
                  <p className="text-sm font-medium leading-relaxed">
                    {checkinGeoError.message}
                  </p>
                  <p className="text-[13px] text-destructive/90 leading-relaxed">
                    {checkinGeoError.details?.hint ||
                      `Você precisa estar dentro da área permitida (polígono ou raio) da ${checkinGeoError.details?.placeType || 'Sede/PDV'} para fazer o check-in.`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 -mt-1 -mr-1 h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                  onClick={() => setCheckinGeoError(null)}
                  aria-label="Fechar aviso"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {!!checkinGeoError.details?.distance_meters && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="rounded-lg border border-destructive/20 bg-background/60 p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Distância do local</p>
                    <p className="text-sm font-bold mt-0.5">
                      {checkinGeoError.details.distance_meters >= 1000
                        ? `${(checkinGeoError.details.distance_meters / 1000).toFixed(1).replace('.',',')} km`
                        : `${checkinGeoError.details.distance_meters} m`}
                    </p>
                  </div>
                  <div className="rounded-lg border border-destructive/20 bg-background/60 p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Tipo de verificação</p>
                    <p className="text-sm font-bold mt-0.5">
                      {checkinGeoError.details?.mode === 'polygon' ? 'Polígono (perímetro)' : `Raio (${checkinGeoError.details?.radius_meters != null ? `${Number(checkinGeoError.details.radius_meters)} m` : 'configurado'})`}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1 h-9"
                  onClick={() => {
                    setCheckinGeoError(null);
                    if (navigator.geolocation) {
                      navigator.geolocation.getCurrentPosition(() => {}, () => {}, { enableHighAccuracy: true, timeout: 5000 });
                    }
                    if (route.require_checkin_photo) {
                      setCheckinPhotoUrl('');
                    }
                  }}
                >
                  <MapPin className="h-4 w-4 mr-1.5" /> Tentar novamente
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Check-in photo requirement */}
        {needsCheckin && requireCheckinPhoto && !checkinPhotoUrl && (
          <Card className="border-primary/30">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Camera className="h-4 w-4 text-primary" />
                Foto obrigatória para check-in
              </div>
              <CameraCapture
                onCapture={(url) => {
                  setCheckinPhotoUrl(url);
                  // Auto-submit check-in assim que a foto for validada
                  setTimeout(() => { void handleCheckin(url); }, 0);
                }}
                watermark={{ pdvName: route.pdv_name, brandName: route.brand_name || route.route_brands?.[0]?.brand_name, photoType: 'Check-in' }}
                customTokenGetter={() => localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}
                buttonLabel="Tirar foto de check-in"
                qualityConfig={photoQualityConfig}
                allowManualUpload={false}
              />
            </CardContent>
          </Card>
        )}

        {needsCheckin && requireCheckinPhoto && checkinPhotoUrl && (
          <Card className="border-primary/30">
            <CardContent className="p-4 space-y-2">
              <LocalImage src={checkinPhotoUrl} alt="Check-in" className="w-full rounded-lg border max-h-64 object-cover" />
              <p className="text-xs text-muted-foreground text-center">
                {checkin.isPending || checkinSubmitted ? 'Realizando check-in...' : 'Foto registrada. Concluindo check-in...'}
              </p>
            </CardContent>
          </Card>
        )}

        {needsCheckin && isFacialActiveCheckin && (
          <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 rounded-lg text-xs text-primary">
            <ScanFace className="h-4 w-4" />
            <span className="font-medium">Verificação facial obrigatória para check-in</span>
          </div>
        )}

        {/* Botão de check-in padrão (sem foto obrigatória) */}
        {needsCheckin && !requireCheckinPhoto && (
          <Button className="w-full h-14 text-lg" onClick={() => handleCheckin()} disabled={checkin.isPending}>
            {isFacialActiveCheckin ? <ScanFace className="h-5 w-5 mr-2" /> : <MapPin className="h-5 w-5 mr-2" />}
            {checkin.isPending ? 'Realizando check-in...' : 'Fazer Check-in'}
          </Button>
        )}


        {isActive && filteredExecs.length === 0 && activeBrandId && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Nenhum produto foi carregado para esta {isMultiBrand ? 'marca' : 'rota'}.
            </CardContent>
          </Card>
        )}

        {/* Active route: categories with step-by-step flow */}
        {!isMultiBrand && categoriesBlock}

        {isCompleted && (
          <div className="text-center py-6">
            <CheckCircle2 className="h-12 w-12 mx-auto text-green-500 mb-2" />
            <p className="text-sm font-medium text-green-700">Rota concluída</p>
            <p className="text-xs text-muted-foreground">
              {route.checkin_at && `Check-in: ${new Date(route.checkin_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
              {route.checkout_at && ` • Checkout: ${new Date(route.checkout_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
            </p>
            {(!route.checkout_at) && (
              <Button className="w-full mt-4 bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-bold" onClick={() => setShowPdvCheckout(true)}>
                <Store className="h-4 w-4 mr-2" /> Fazer Checkout da Loja (Pendente)
              </Button>
            )}
            <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate('/promotor/home')}>
              Voltar para Início
            </Button>
          </div>
        )}

        {/* Product Detail Modal */}
        <Dialog open={!!selectedExec && !activeAction} onOpenChange={() => setSelectedExec(null)}>
          <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                <div className="text-sm flex items-center gap-2">
                  {EXEC_STATUS_ICON[selectedExec?.status] || EXEC_STATUS_ICON.pending}
                  {selectedExec?.product_name}
                </div>
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge variant={selectedExec?.status === 'completed' ? 'default' : 'secondary'} className="text-[10px]">
                  {selectedExec?.status === 'completed' ? 'Executado' : selectedExec?.status === 'in_progress' ? 'Em andamento' : 'Pendente'}
                </Badge>
                {selectedExec?.exposure_point && selectedExec.exposure_point !== 'natural' && (
                  <Badge variant="outline" className="text-[10px]">{selectedExec.exposure_point}</Badge>
                )}
              </div>

              {/* Counting */}
              {requireStockCount && (

                <div className="space-y-2">
                  <Label className="text-xs font-semibold flex items-center gap-1">
                    <Store className="h-3.5 w-3.5" /> Contagem
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    {(() => {
                      const storeVal = Number(actionForm.qty_store ?? selectedExec?.qty_store ?? 0) || 0;
                      const stockVal = Number(actionForm.qty_stock ?? selectedExec?.qty_stock ?? 0) || 0;
                      return <>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">Qtd Loja</Label>
                          <Input type="number" min="0" inputMode="numeric" placeholder="0"
                            value={storeVal === 0 ? '' : storeVal}
                            onChange={e => {
                              const v = e.target.value.replace(/^0+(?=\d)/, '');
                              setActionForm({ ...actionForm, qty_store: v === '' ? 0 : parseInt(v) || 0 });
                            }} />
                        </div>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">Qtd Estoque</Label>
                          <Input type="number" min="0" inputMode="numeric" placeholder="0"
                            value={stockVal === 0 ? '' : stockVal}
                            onChange={e => {
                              const v = e.target.value.replace(/^0+(?=\d)/, '');
                              setActionForm({ ...actionForm, qty_stock: v === '' ? 0 : parseInt(v) || 0 });
                            }} />
                        </div>
                      </>;
                    })()}
                  </div>
                  <div className="text-[10px] text-muted-foreground text-right">
                    Total: {(Number(actionForm.qty_store ?? selectedExec?.qty_store ?? 0) || 0) + (Number(actionForm.qty_stock ?? selectedExec?.qty_stock ?? 0) || 0)}
                  </div>
                </div>
              )}

              {/* Inline Validity (when checklist requires it) */}
              {requireValidityCheck && (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold flex items-center gap-1">
                    <CalendarIcon className="h-3.5 w-3.5 text-blue-600" /> Validade mais próxima
                  </Label>
                  <Input
                    type="date"
                    value={actionForm.expiry_date ?? ''}
                    onChange={e => setActionForm({ ...actionForm, expiry_date: e.target.value })}
                  />
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {(() => {
                      const storeVal = Number(actionForm.val_qty_store ?? 0) || 0;
                      const stockVal = Number(actionForm.val_qty_stock ?? 0) || 0;
                      return <>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">Qtd na Loja (desta validade)</Label>
                          <Input type="number" min="0" inputMode="numeric" placeholder="0"
                            value={storeVal === 0 ? '' : storeVal}
                            onChange={e => {
                              const v = e.target.value.replace(/^0+(?=\d)/, '');
                              setActionForm({ ...actionForm, val_qty_store: v === '' ? 0 : parseInt(v) || 0 });
                            }} />
                        </div>
                        <div>
                          <Label className="text-[10px] text-muted-foreground">Qtd no Estoque (desta validade)</Label>
                          <Input type="number" min="0" inputMode="numeric" placeholder="0"
                            value={stockVal === 0 ? '' : stockVal}
                            onChange={e => {
                              const v = e.target.value.replace(/^0+(?=\d)/, '');
                              setActionForm({ ...actionForm, val_qty_stock: v === '' ? 0 : parseInt(v) || 0 });
                            }} />
                        </div>
                      </>;
                    })()}
                  </div>
                  <div className="text-[10px] text-muted-foreground text-right">
                    Total desta validade: {(Number(actionForm.val_qty_store ?? 0) || 0) + (Number(actionForm.val_qty_stock ?? 0) || 0)}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Informe a data de vencimento mais próxima encontrada na loja/estoque.
                  </p>
                </div>
              )}


              {/* Observation */}
              <div>
                <Label className="text-[10px] text-muted-foreground">Observação</Label>
                <Textarea rows={2} placeholder="Observação do produto..."
                  value={actionForm.product_observation ?? selectedExec?.observation ?? ''}
                  onChange={e => setActionForm({ ...actionForm, product_observation: e.target.value })} />
              </div>

              {/* Action buttons */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold">Registrar ocorrência</Label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { key: 'validity', label: 'Validade', icon: CalendarIcon, color: 'text-blue-600', show: !requireValidityCheck },
                    { key: 'rupture', label: 'Ruptura', icon: AlertTriangle, color: 'text-red-600', show: true },
                    { key: 'damage', label: 'Avaria', icon: Archive, color: 'text-orange-600', show: true },
                    { key: 'discard', label: 'Descarte', icon: Trash2, color: 'text-purple-600', show: true },
                  ].filter(a => a.show).map(a => (
                    <Button key={a.key} variant="outline" className="h-12 flex-col gap-0.5 text-[10px]"
                      onClick={() => setActiveAction(a.key as ActionType)}>
                      <a.icon className={`h-4 w-4 ${a.color}`} />
                      <span>{a.label}</span>
                    </Button>
                  ))}
                </div>
              </div>

            </div>
            <DialogFooter className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelectedExec(null)}>Fechar</Button>
              <Button size="sm" onClick={() => {
                if (!selectedExec) return;
                const qtyStore = actionForm.qty_store ?? selectedExec.qty_store ?? 0;
                const qtyStock = actionForm.qty_stock ?? selectedExec.qty_stock ?? 0;
                const observation = actionForm.product_observation ?? selectedExec.observation;
                const expiryDate = actionForm.expiry_date || null;

                // REMOVIDO: A obrigatoriedade de validade/fotos agora é apenas no checkout da ROTA,
                // permitindo que o promotor salve o progresso parcial do produto sem travar.


                const body = {
                  id: selectedExec.id,
                  qty_store: qtyStore,
                  qty_stock: qtyStock,
                  observation,
                  status: 'completed', checked: true,
                };

                // Save validity inline when checklist requires it
                const saveValidityIfNeeded = async () => {
                  if (!requireValidityCheck || !expiryDate) return;
                  const valStore = Number(actionForm.val_qty_store ?? 0) || 0;
                  const valStock = Number(actionForm.val_qty_stock ?? 0) || 0;
                  const validityBody = {
                    expiry_date: expiryDate,
                    qty_store: valStore,
                    qty_stock: valStock,
                    replace: true,
                  };
                  if (!isOnline) {
                    queueApiCall({
                      url: `/api/merch/promotor/executions/${selectedExec.id}/validity`,
                      method: 'POST',
                      body: validityBody,
                      headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` }
                    });
                  } else {
                    await addValidity.mutateAsync({ executionId: selectedExec.id, ...validityBody }).catch((e: any) => {
                      toast.error('Erro ao salvar validade: ' + (e?.message || ''));
                      throw e;
                    });
                  }
                };

                if (!isOnline) {
                  queueApiCall({
                    url: `/api/merch/promotor/executions/${selectedExec.id}`,
                    method: 'PUT',
                    body: { qty_store: qtyStore, qty_stock: qtyStock, observation, status: 'completed', checked: true },
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` }
                  });
                  saveValidityIfNeeded();
                  setSelectedExec(null);
                  return;
                }

                (async () => {
                  try {
                    await saveValidityIfNeeded();
                    await updateExec.mutateAsync(body);
                    setSelectedExec(null);
                  } catch (err: any) {
                    if (err?.message) toast.error(err.message);
                  }
                })();
              }} disabled={updateExec.isPending || addValidity.isPending}>
                <Check className="h-4 w-4 mr-1" />
                {(updateExec.isPending || addValidity.isPending) ? 'Salvando...' : 'Salvar e Concluir'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Action detail dialog */}
        <Dialog open={!!activeAction} onOpenChange={() => setActiveAction(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>
                <span className="text-sm">
                  {activeAction === 'validity' ? 'Registrar Validade' : activeAction === 'rupture' ? 'Registrar Ruptura' : activeAction === 'damage' ? 'Registrar Avaria' : 'Registrar Descarte'}
                  {selectedExec && <span className="block text-xs font-normal text-muted-foreground mt-1">{selectedExec.product_name}</span>}
                </span>
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {activeAction === 'validity' && (
                <>
                  <div><Label className="text-xs">Data de Validade</Label><Input type="date" value={actionForm.expiry_date || ''} onChange={e => setActionForm({ ...actionForm, expiry_date: e.target.value })} /></div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Label className="text-xs">Qtd Loja</Label><Input type="number" placeholder="0" value={actionForm.val_qty_store ?? ''} onChange={e => setActionForm({ ...actionForm, val_qty_store: parseInt(e.target.value) || 0 })} /></div>
                    <div><Label className="text-xs">Qtd Estoque</Label><Input type="number" placeholder="0" value={actionForm.val_qty_stock ?? ''} onChange={e => setActionForm({ ...actionForm, val_qty_stock: parseInt(e.target.value) || 0 })} /></div>
                  </div>
                </>
              )}
              {(activeAction === 'rupture' || activeAction === 'damage' || activeAction === 'discard') && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Label className="text-xs">Qtd Loja</Label><Input type="number" placeholder="0" value={actionForm.occ_qty_store ?? ''} onChange={e => setActionForm({ ...actionForm, occ_qty_store: parseInt(e.target.value) || 0 })} /></div>
                    <div><Label className="text-xs">Qtd Estoque</Label><Input type="number" placeholder="0" value={actionForm.occ_qty_stock ?? ''} onChange={e => setActionForm({ ...actionForm, occ_qty_stock: parseInt(e.target.value) || 0 })} /></div>
                  </div>
                  <div><Label className="text-xs">Motivo</Label><Input placeholder="Motivo" value={actionForm.reason ?? ''} onChange={e => setActionForm({ ...actionForm, reason: e.target.value })} /></div>
                  <div><Label className="text-xs">Observação</Label><Textarea rows={2} placeholder="Observação" value={actionForm.observation ?? ''} onChange={e => setActionForm({ ...actionForm, observation: e.target.value, description: e.target.value })} /></div>
                  {activeAction === 'damage' && (
                    <div>
                      <Label className="text-xs">Local</Label>
                      <Select value={actionForm.location} onValueChange={v => setActionForm({ ...actionForm, location: v })}>
                        <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="store">Loja</SelectItem>
                          <SelectItem value="stock">Estoque</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setActiveAction(null)}>Cancelar</Button>
              <Button onClick={() => {
                if (!selectedExec || !activeAction) return;
                const execId = selectedExec.id;
                const onDone = () => { setActiveAction(null); };
                const onErr = (err: any) => toast.error(err.message);
                
                const body: any = { executionId: execId };
                let url = '';
                
                if (activeAction === 'validity') {
                  url = `/api/merch/promotor/executions/${execId}/validity`;
                  body.expiry_date = actionForm.expiry_date;
                  body.qty_store = actionForm.val_qty_store || 0;
                  body.qty_stock = actionForm.val_qty_stock || 0;
                } else if (activeAction === 'rupture') {
                  url = `/api/merch/promotor/executions/${execId}/rupture`;
                  body.qty_store = actionForm.occ_qty_store || 0;
                  body.qty_stock = actionForm.occ_qty_stock || 0;
                  body.reason = actionForm.reason;
                  body.observation = actionForm.observation;
                } else if (activeAction === 'damage') {
                  url = `/api/merch/promotor/executions/${execId}/damage`;
                  body.qty_store = actionForm.occ_qty_store || 0;
                  body.qty_stock = actionForm.occ_qty_stock || 0;
                  body.reason = actionForm.reason;
                  body.observation = actionForm.observation;
                  body.description = actionForm.observation;
                  body.location = actionForm.location;
                } else if (activeAction === 'discard') {
                  url = `/api/merch/promotor/executions/${execId}/discard`;
                  body.qty_store = actionForm.occ_qty_store || 0;
                  body.qty_stock = actionForm.occ_qty_stock || 0;
                  body.reason = actionForm.reason;
                  body.observation = actionForm.observation;
                }

                queueApiCall({
                  url,
                  method: 'POST',
                  body,
                  headers: { 'Authorization': `Bearer ${localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}` }
                });
                onDone();

              }}>Salvar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Complete Route Dialog */}
        <Dialog open={showCompleteRoute} onOpenChange={setShowCompleteRoute}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Concluir Rota</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground">
              Ao concluir esta rota, o checklist de <b>{currentBrand?.brand_name || route.brand_name}</b> será finalizado.
              Se houver mais rotas neste PDV, o checkout da loja será feito depois.
            </p>
            <div>
              <Label className="text-xs">Observação de encerramento</Label>
              <Textarea rows={3} placeholder="Observações finais..." onChange={e => setActionForm({ ...actionForm, notes: e.target.value })} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCompleteRoute(false)}>Cancelar</Button>
              <Button onClick={handleCompleteRoute} disabled={checkout.isPending}>
                {checkout.isPending ? 'Concluindo...' : 'Confirmar Conclusão'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* PDV Checkout Dialog */}
        <Dialog open={showPdvCheckout} onOpenChange={setShowPdvCheckout}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Store className="h-5 w-5 text-primary" /> Checkout da Loja
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Card className="border-green-500/30 bg-green-500/5">
                <CardContent className="p-3">
                  <p className="text-sm font-medium text-green-700">✅ Última rota concluída!</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Esta era a última rota neste PDV. Faça o checkout da loja para encerrar a visita.
                  </p>
                </CardContent>
              </Card>

              {route.require_checkout_photo && (
                <div className="space-y-2">
                  <Label className="text-xs">Foto final da loja (obrigatória)</Label>
                  {pdvCheckoutPhoto ? (
                    <div className="space-y-2">
                      <LocalImage src={pdvCheckoutPhoto} alt="Checkout" className="w-full rounded-lg border max-h-48 object-cover" />
                      <Button variant="outline" size="sm" onClick={() => setPdvCheckoutPhoto('')}>Tirar outra foto</Button>
                    </div>
                  ) : (
                    <CameraCapture
                      onCapture={setPdvCheckoutPhoto}
                      watermark={{ pdvName: route.pdv_name, brandName: route.brand_name || route.route_brands?.[0]?.brand_name, photoType: 'Checkout PDV' }}
                      customTokenGetter={() => localStorage.getItem('promotor_token') || localStorage.getItem('auth_token')}
                      buttonLabel="Tirar foto de saída da loja"
                      qualityConfig={photoQualityConfig}
                      allowManualUpload={false}
                    />
                  )}
                </div>
              )}


              <div>
                <Label className="text-xs">Observação</Label>
                <Textarea rows={2} placeholder="Observações sobre a visita..." onChange={e => setActionForm({ ...actionForm, pdv_notes: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowPdvCheckout(false); navigate('/promotor/home'); }}>
                Pular
              </Button>
              <Button onClick={handlePdvCheckout} disabled={route.require_checkout_photo && !pdvCheckoutPhoto}>
                Fazer Checkout
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Extra Point Category Picker Dialog */}
        <Dialog open={showExtraPointCategoryPicker} onOpenChange={setShowExtraPointCategoryPicker}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="text-sm">Selecione a Categoria</DialogTitle></DialogHeader>
            <div className="space-y-2">
              {Object.entries(groupedExecs).filter(([, v]) => !v.isExtraGroup).map(([category, { catId }]) => (
                <Button key={catId} variant="outline" className="w-full justify-start" onClick={() => {
                  setShowExtraPointCategoryPicker(false);
                  setShowExtraPointDialog({ catId, categoryName: category });
                  setSelectedExtraProducts([]);
                }}>
                  <Target className="h-4 w-4 mr-2 text-orange-600" /> {category}
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>

        {/* Extra Point Product Selection Dialog */}
        <Dialog open={!!showExtraPointDialog} onOpenChange={() => setShowExtraPointDialog(null)}>
          <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-sm flex items-center gap-2">
                <Target className="h-4 w-4 text-orange-600" /> Ponto Extra
              </DialogTitle>
              <p className="text-xs text-muted-foreground">
                Selecione os produtos de <b>{showExtraPointDialog?.categoryName}</b> que estão neste ponto extra.
              </p>
            </DialogHeader>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {showExtraPointDialog && (groupedExecs[showExtraPointDialog.categoryName]?.execs || [])
                .filter((e: any) => e.exposure_point !== 'extra' && !productsWithExtraPoint.has(`${e.category_id}_${e.product_id}`))
                .map((exec: any) => (
                  <label key={exec.id} className="flex items-center gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50">
                    <Checkbox
                      checked={selectedExtraProducts.includes(exec.product_id)}
                      onCheckedChange={(checked) => {
                        setSelectedExtraProducts(prev =>
                          checked ? [...prev, exec.product_id] : prev.filter(id => id !== exec.product_id)
                        );
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{exec.product_name}</span>
                      {exec.sku && <span className="text-[10px] text-muted-foreground ml-2">SKU: {exec.sku}</span>}
                    </div>
                  </label>
                ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowExtraPointDialog(null)}>Cancelar</Button>
              <Button disabled={selectedExtraProducts.length === 0 || registerExtraPoint.isPending}
                onClick={() => {
                  if (!showExtraPointDialog) return;
                  registerExtraPoint.mutate({
                    routeId: id!,
                    catId: showExtraPointDialog.catId,
                    product_ids: selectedExtraProducts,
                  }, {
                    onSuccess: (data: any) => {
                      // Removed toast per user request
                      setShowExtraPointDialog(null);
                      setSelectedExtraProducts([]);
                    },
                    onError: (err: any) => toast.error(err.message),
                  });
                }}>
                <Plus className="h-4 w-4 mr-1" />
                {registerExtraPoint.isPending ? 'Registrando...' : `Registrar ${selectedExtraProducts.length} produto(s)`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {/* Facial Verification Dialog */}
        <FaceVerifyDialog
          open={showFaceVerify}
          onOpenChange={(open) => { if (!open) { setShowFaceVerify(false); setFaceVerifyAction(null); } }}
          storedDescriptor={facialConfig?.descriptor || []}
          storedPhotoUrl={facialConfig?.photo_url}
          personName={route?.promoter_name}
          threshold={facialConfig?.min_confidence || 70}
          onResult={(result) => {
            setShowFaceVerify(false);
            if (result.match) {
              toast.success(`Identidade confirmada (${result.score.toFixed(1)}%)`);
              const action = faceVerifyAction;
              setTimeout(() => {
                if (action === 'checkin') handleCheckin();
                else if (action === 'checkout') handleCompleteRoute();
                else if (action === 'pdv_checkout') handlePdvCheckout();
              }, 300);
            } else {
              toast.error(`Identidade não confirmada (${result.score.toFixed(1)}%). Ação bloqueada.`);
              setFaceVerifyAction(null);
            }
          }}
        />
      </div>
    </PromotorLayout>
  );
}
