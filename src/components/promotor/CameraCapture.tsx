import { useState, useRef, useCallback, useEffect } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Camera, RotateCcw, Check, X, Loader2, AlertTriangle, Upload, WifiOff } from "lucide-react";
import { useUpload } from "@/hooks/use-upload";
import { useOfflineSync } from "@/hooks/use-offline-sync";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import {
  compressWebP,
  getCachedGeolocation,
  warmGeolocation,
  prewarmUploadConnection,
} from "@/lib/photo-perf";

interface WatermarkData {
  pdvName?: string;
  promotorName?: string;
  brandName?: string;
  categoryName?: string;
  photoType?: string;
  latitude?: number;
  longitude?: number;
}

interface CameraCaptureProps {
  onCapture: (url: string) => void;
  watermark?: WatermarkData;
  customTokenGetter?: () => string | null;
  buttonLabel?: string;
  buttonClassName?: string;
  disabled?: boolean;
  qualityConfig?: PhotoQualityConfig;
  allowManualUpload?: boolean;
  autoOpen?: boolean;
  /** Se true, mostra a foto com watermark aplicada e exige "Aprovar" antes do upload. */
  requireConfirmation?: boolean;
}

export interface PhotoQualityConfig {
  blur_tolerance: number;       // 0-100, lower = stricter (default 30)
  min_brightness: number;       // 0-255 (default 40)
  max_brightness: number;       // 0-255 (default 220)
  min_resolution_w: number;     // min width px (default 640)
  min_resolution_h: number;     // min height px (default 480)
  compression_quality: number;  // 0-1 (default 0.7)
  max_file_size_kb: number;     // max compressed size (default 1024)
}

const DEFAULT_QUALITY_CONFIG: PhotoQualityConfig = {
  blur_tolerance: 30,
  min_brightness: 40,
  max_brightness: 220,
  min_resolution_w: 640,
  min_resolution_h: 480,
  compression_quality: 0.6,    // Reduced from 0.7 for better initial compression
  max_file_size_kb: 500,        // Reduced from 1024 to save server storage
};

interface ValidationResult {
  valid: boolean;
  message?: string;
}

function analyzeImageQuality(
  canvas: HTMLCanvasElement,
  config: PhotoQualityConfig
): ValidationResult {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { valid: false, message: "Não foi possível validar a foto. Tente novamente." };

  const w = canvas.width;
  const h = canvas.height;

  // Resolution check
  if (w < config.min_resolution_w || h < config.min_resolution_h) {
    return { valid: false, message: `Resolução muito baixa (${w}x${h}). Mínimo: ${config.min_resolution_w}x${config.min_resolution_h}.` };
  }

  // Optimize: use an even smaller sample area for faster analysis
  const sampleW = Math.min(200, Math.floor(w * 0.2));
  const sampleH = Math.min(150, Math.floor(h * 0.2));
  const sampleX = Math.floor((w - sampleW) / 2);
  const sampleY = Math.floor((h - sampleH) / 2);
  
  const imageData = ctx.getImageData(sampleX, sampleY, sampleW, sampleH);
  const data = imageData.data;
  const pixelCount = sampleW * sampleH;

  // Brightness analysis
  let totalBrightness = 0;
  // Step through pixels to speed up (every 4th pixel)
  for (let i = 0; i < data.length; i += 16) {
    totalBrightness += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }
  const avgBrightness = totalBrightness / (pixelCount / 4);

  if (avgBrightness < config.min_brightness) {
    return { valid: false, message: "A foto está muito escura. Melhore a iluminação." };
  }
  if (avgBrightness > config.max_brightness) {
    return { valid: false, message: "A foto está muito clara. Ajuste a posição da câmera." };
  }

  // Blur detection using Laplacian variance
  const grayData = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    grayData[i] = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
  }

  let laplacianVar = 0;
  // Step through pixels to speed up
  const step = 2;
  let count = 0;
  for (let y = 1; y < sampleH - 1; y += step) {
    for (let x = 1; x < sampleW - 1; x += step) {
      const idx = y * sampleW + x;
      const laplacian =
        -grayData[idx - sampleW] -
        grayData[idx - 1] +
        4 * grayData[idx] -
        grayData[idx + 1] -
        grayData[idx + sampleW];
      laplacianVar += laplacian * laplacian;
      count++;
    }
  }
  laplacianVar /= count;

  if (laplacianVar < config.blur_tolerance) {
    return { valid: false, message: "A foto está borrada. Tire novamente." };
  }

  return { valid: true };
}

function applyWatermark(
  canvas: HTMLCanvasElement,
  watermark: WatermarkData
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const now = new Date();
  const dateStr = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

  const lines: string[] = [];
  if (watermark.pdvName) lines.push(`PDV: ${watermark.pdvName}`);
  if (watermark.brandName) lines.push(`Marca: ${watermark.brandName}`);
  if (watermark.promotorName) lines.push(`Promotor: ${watermark.promotorName}`);
  if (watermark.categoryName) lines.push(`Categoria: ${watermark.categoryName}`);
  lines.push(`${dateStr} ${timeStr}`);
  if (watermark.photoType) lines.push(`Tipo: ${watermark.photoType}`);
  if (watermark.latitude && watermark.longitude) {
    lines.push(`GPS: ${watermark.latitude.toFixed(5)}, ${watermark.longitude.toFixed(5)}`);
  }

  const fontSize = Math.max(12, Math.floor(w * 0.025));
  const lineHeight = fontSize * 1.4;
  const padding = fontSize * 0.8;
  const boxHeight = lines.length * lineHeight + padding * 2;

  // Semi-transparent background at bottom
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(0, h - boxHeight, w, boxHeight);

  // Text
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = "top";

  lines.forEach((line, i) => {
    ctx.fillText(line, padding, h - boxHeight + padding + i * lineHeight);
  });

  // Timestamp watermark top-right
  ctx.font = `${Math.floor(fontSize * 0.8)}px sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  const ts = `${dateStr} ${timeStr}`;
  const tsWidth = ctx.measureText(ts).width;
  ctx.fillText(ts, w - tsWidth - padding, padding);
}

// Compressão WebP delegada a Web Worker (com fallback main-thread).
// Implementação em src/lib/photo-perf.ts

export function CameraCapture({
  onCapture,
  watermark = {},
  customTokenGetter,
  buttonLabel = "Tirar Foto",
  buttonClassName,
  disabled,
  qualityConfig,
  allowManualUpload = true,
  autoOpen = false,
  requireConfirmation = false,
}: CameraCaptureProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<{ lat?: number; lng?: number } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureLockRef = useRef(false);
  const { uploadFile, isUploading } = useUpload(customTokenGetter);
  const { isOnline, queueUpload } = useOfflineSync();
  const config = { ...DEFAULT_QUALITY_CONFIG, ...qualityConfig };

  const startCamera = useCallback(async (facing: "environment" | "user", existingStream?: MediaStream | null): Promise<MediaStream | null> => {
    try {
      // Stop existing stream
      const prev = existingStream ?? stream;
      if (prev) prev.getTracks().forEach((t) => t.stop());

      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facing,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      setStream(s);
      // Attach immediately if the video element is already mounted (iOS needs
      // srcObject + play() within the same user gesture to avoid black screen).
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current.muted = true;
        try { await videoRef.current.play(); } catch { /* will retry via effect */ }
      }
      return s;
    } catch (err: any) {
      logger.warn('[CameraCapture] getUserMedia failed', { error: err?.message, name: err?.name });
      toast.error("Não foi possível acessar a câmera. Verifique as permissões.");
      setIsOpen(false);
      return null;
    }
  }, [stream]);

  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
  }, [stream]);

  // Open dialog and request the camera within the same user gesture.
  // flushSync forces React to mount the <video> element BEFORE we call
  // getUserMedia, so srcObject + play() happen in the gesture context.
  // This is required on iOS Safari to avoid the "black screen / permission re-prompt"
  // bug when the video element is mounted asynchronously.
  const handleOpen = () => {
    // #4 — Pré-aquece TLS/conexão com o endpoint de upload e
    //       já dispara a geolocalização em background (popula cache).
    prewarmUploadConnection();
    warmGeolocation();

    flushSync(() => {
      setCapturedImage(null);
      setValidationError(null);
      setIsOpen(true);
    });
    // Fire getUserMedia synchronously after the DOM is committed
    void startCamera(facingMode);
  };

  // Auto-abrir a câmera ao montar quando solicitado (ex.: usuário clicou em
  // "Adicionar mais fotos" e queremos evitar um clique adicional no botão).
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpen && !autoOpenedRef.current && !disabled) {
      autoOpenedRef.current = true;
      handleOpen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, disabled]);

  // Re-attach the existing stream to the video element when the dialog mounts
  // (in case the <video> wasn't in the DOM when startCamera ran).
  useEffect(() => {
    if (isOpen && !capturedImage && stream && videoRef.current && !videoRef.current.srcObject) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => {});
    }
  }, [isOpen, capturedImage, stream]);

  const handleClose = () => {
    stopCamera();
    setCapturedImage(null);
    setPreviewMeta(null);
    setValidationError(null);
    setIsOpen(false);
  };

  // Aplica watermark + GPS ao canvas e devolve dataURL para preview
  const stampCanvas = async (canvas: HTMLCanvasElement) => {
    const { lat, lng } = await getCachedGeolocation({ timeoutMs: 1500 });
    const wmData: WatermarkData = { ...watermark, latitude: lat, longitude: lng };
    applyWatermark(canvas, wmData);
    return { lat, lng };
  };

  // Comprime e envia o canvas já com watermark aplicada
  const uploadCanvas = async (canvas: HTMLCanvasElement) => {
    const blob = await compressWebP(
      canvas,
      config.compression_quality,
      config.max_file_size_kb,
    );
    if (!blob) {
      toast.error("Erro ao comprimir imagem");
      return;
    }
    const file = new File([blob], `photo_${Date.now()}.webp`, { type: "image/webp" });
    const token = (customTokenGetter ? customTokenGetter() : null)
      || localStorage.getItem('promotor_token')
      || localStorage.getItem('auth_token');
    const localRef = await queueUpload(file, token);
    onCapture(localRef);
  };

  const processAndUpload = async (canvas: HTMLCanvasElement) => {
    setIsProcessing(true);
    // Fecha o diálogo imediatamente — upload segue em background (fila offline).
    stopCamera();
    setIsOpen(false);

    try {
      await stampCanvas(canvas);
      await uploadCanvas(canvas);
    } catch (err: any) {
      toast.error(err.message || "Erro ao processar foto");
    } finally {
      setIsProcessing(false);
      setCapturedImage(null);
      setPreviewMeta(null);
    }
  };

  // Fluxo com confirmação: aplica watermark, mostra preview e aguarda "Aprovar"
  const stampAndPreview = async (canvas: HTMLCanvasElement) => {
    setIsProcessing(true);
    try {
      stopCamera();
      const meta = await stampCanvas(canvas);
      setPreviewMeta(meta);
      setCapturedImage(canvas.toDataURL("image/jpeg", 0.92));
      setIsOpen(true);
    } catch (err: any) {
      toast.error(err.message || "Erro ao gerar prévia");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    // Guard against double-tap / double-invocation which would upload the same photo twice.
    if (captureLockRef.current || isProcessing) return;
    captureLockRef.current = true;

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0);

      // Validate quality
      const result = analyzeImageQuality(canvas, config);
      if (!result.valid) {
        setValidationError(result.message || "Foto inválida");
        setCapturedImage(null);
        return;
      }

      setValidationError(null);
      if (requireConfirmation) {
        // Aplica watermark + GPS e mostra prévia; upload só ao clicar "Aprovar".
        await stampAndPreview(canvas);
      } else {
        // Auto-aprovar: processa e envia imediatamente (sem etapa extra de "Salvar").
        await processAndUpload(canvas);
      }
    } finally {
      captureLockRef.current = false;
    }
  };

  const handleRetake = () => {
    setCapturedImage(null);
    setPreviewMeta(null);
    setValidationError(null);
    startCamera(facingMode);
  };

  const handleFlipCamera = () => {
    const newFacing = facingMode === "environment" ? "user" : "environment";
    setFacingMode(newFacing);
  };

  const handleAccept = async () => {
    if (!canvasRef.current) return;
    if (requireConfirmation && capturedImage) {
      // Canvas já tem watermark aplicada pelo stampAndPreview — só enviar.
      setIsProcessing(true);
      stopCamera();
      setIsOpen(false);
      try {
        await uploadCanvas(canvasRef.current);
      } catch (err: any) {
        toast.error(err.message || "Erro ao enviar foto");
      } finally {
        setIsProcessing(false);
        setCapturedImage(null);
        setPreviewMeta(null);
      }
      return;
    }
    await processAndUpload(canvasRef.current);
  };


  const handleManualFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error("Por favor, selecione um arquivo de imagem.");
      return;
    }

    setIsProcessing(true);
    setValidationError(null);

    try {
      if (!canvasRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Use createImageBitmap with EXIF orientation applied automatically when available
      let drewFromBitmap = false;
      try {
        // @ts-ignore — imageOrientation is supported in modern browsers
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        ctx.drawImage(bmp, 0, 0);
        bmp.close?.();
        drewFromBitmap = true;
      } catch {
        // Fallback: plain <img> (may not honor EXIF orientation on some browsers)
      }
      if (!drewFromBitmap) {
        const img = new Image();
        img.src = URL.createObjectURL(file);
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
      }

      // Validate quality
      const result = analyzeImageQuality(canvas, config);
      if (!result.valid) {
        setValidationError(`A imagem do computador não passou na validação: ${result.message}`);
        toast.error(result.message || "A imagem não passou nos critérios de qualidade.");
        setIsProcessing(false);
        return;
      }

      setIsManualOpen(false);
      if (requireConfirmation) {
        // Aplica watermark + GPS e mostra prévia; upload só ao clicar "Aprovar".
        await stampAndPreview(canvas);
      } else {
        // Preview sem watermark; watermark é aplicada no processAndUpload.
        setCapturedImage(canvas.toDataURL("image/jpeg", 0.95));
        setIsOpen(true);
      }
    } catch (err) {
      toast.error("Erro ao processar imagem do computador.");
    } finally {
      setIsProcessing(false);
    }
  };

  const busy = isProcessing || isUploading;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className={cn(
            "flex-1 h-14 flex-col gap-1 border-2 border-dashed border-primary/40 hover:border-primary hover:bg-primary/5",
            buttonClassName
          )}
          onClick={handleOpen}
          disabled={disabled}
        >
          <Camera className="h-5 w-5 text-primary" />
          <span className="text-xs font-medium">{buttonLabel}</span>
        </Button>

        {allowManualUpload && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="w-14 h-14 border-2 border-dashed border-muted-foreground/40 hover:border-primary hover:bg-primary/5"
            onClick={() => setIsManualOpen(true)}
            disabled={disabled}
          >
            <Upload className="h-5 w-5 text-muted-foreground" />
          </Button>
        )}
      </div>

      {/* Hidden canvas for processing */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Manual Upload Dialog */}
      <Dialog open={isManualOpen} onOpenChange={setIsManualOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Subir Foto do Computador</DialogTitle>
            <DialogDescription>
              A foto passará pelos mesmos critérios de validação (brilho, nitidez e resolução) da câmera.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <Input 
              type="file" 
              accept="image/*" 
              onChange={handleManualFile}
              disabled={isProcessing}
            />
            {validationError && (
              <div className="p-3 bg-destructive/10 text-destructive text-xs flex items-center gap-2 rounded-md">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                <span>{validationError}</span>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground italic">
              * A marca d'água será aplicada automaticamente após a validação.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsManualOpen(false)}>Cancelar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent className="max-w-md p-0 overflow-hidden bg-black">
          {/* Live camera view */}
          {!capturedImage && (
            <div className="relative">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full aspect-[3/4] object-cover"
              />

              {/* Validation error overlay */}
              {validationError && (
                <div className="absolute inset-x-0 top-0 p-3 bg-destructive/90 text-white text-sm flex items-center gap-2 animate-in fade-in">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  <span>{validationError}</span>
                </div>
              )}

              {/* Camera controls */}
              <div className="absolute inset-x-0 bottom-0 p-4 flex items-center justify-center gap-6 bg-gradient-to-t from-black/70 to-transparent">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-10 w-10 text-white hover:bg-white/20"
                  onClick={handleClose}
                >
                  <X className="h-5 w-5" />
                </Button>

                <button
                  onClick={handleCapture}
                  disabled={isProcessing}
                  className="h-16 w-16 rounded-full border-4 border-white bg-white/20 hover:bg-white/40 transition-all active:scale-90 disabled:opacity-50 disabled:cursor-not-allowed"
                />

                <Button
                  size="icon"
                  variant="ghost"
                  className="h-10 w-10 text-white hover:bg-white/20"
                  onClick={handleFlipCamera}
                >
                  <RotateCcw className="h-5 w-5" />
                </Button>
              </div>
            </div>
          )}

          {/* Preview captured image */}
          {capturedImage && (
            <div className="relative">
              <img src={capturedImage} alt="Preview" className="w-full aspect-[3/4] object-cover" />

              {requireConfirmation && (
                <div className="absolute inset-x-0 top-0 p-3 bg-black/60 text-white text-[11px] space-y-0.5 backdrop-blur-sm">
                  <div className="font-semibold text-xs mb-1">Confira a rotulagem antes de aprovar:</div>
                  {watermark.pdvName && <div>PDV: <span className="font-medium">{watermark.pdvName}</span></div>}
                  {watermark.brandName && <div>Marca: <span className="font-medium">{watermark.brandName}</span></div>}
                  {watermark.promotorName && <div>Promotor: <span className="font-medium">{watermark.promotorName}</span></div>}
                  {watermark.categoryName && <div>Categoria: <span className="font-medium">{watermark.categoryName}</span></div>}
                  {watermark.photoType && <div>Tipo: <span className="font-medium">{watermark.photoType}</span></div>}
                  <div>
                    GPS: <span className="font-medium">
                      {previewMeta?.lat && previewMeta?.lng
                        ? `${previewMeta.lat.toFixed(5)}, ${previewMeta.lng.toFixed(5)}`
                        : 'não disponível'}
                    </span>
                  </div>
                  <div>Data/hora: <span className="font-medium">{new Date().toLocaleString('pt-BR')}</span></div>
                </div>
              )}

              <div className="absolute inset-x-0 bottom-0 p-4 flex items-center justify-center gap-4 bg-gradient-to-t from-black/70 to-transparent">
                <Button
                  variant="ghost"
                  className="h-12 px-6 text-white hover:bg-white/20 gap-2"
                  onClick={handleRetake}
                  disabled={busy}
                >
                  <RotateCcw className="h-4 w-4" />
                  Nova Foto
                </Button>

                <Button
                  className="h-12 px-6 bg-green-600 hover:bg-green-700 text-white gap-2"
                  onClick={handleAccept}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  {busy ? "Enviando..." : "Aprovar e enviar"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
