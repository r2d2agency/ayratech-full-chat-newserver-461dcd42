export interface WatermarkData {
  pdvName?: string;
  brandName?: string;
  promotorName?: string;
  categoryName?: string;
  productName?: string;
  photoType?: string;
  latitude?: number;
  longitude?: number;
}

// Legenda aplicada no próprio bitmap da foto, antes do upload/compressão.
// Usada pela câmera e pelo upload manual de vários arquivos.
export async function stampWatermarkOnFile(
  file: File,
  watermark: WatermarkData,
  capturedAt: Date = new Date()
): Promise<File> {
  let bitmap: ImageBitmap | null = null;
  let objectUrl: string | null = null;

  try {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    } catch {
      const img = new Image();
      objectUrl = URL.createObjectURL(file);
      img.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Não foi possível ler a imagem'));
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas indisponível');
      ctx.drawImage(img, 0, 0);
      return await canvasToFile(canvas, file, watermark, capturedAt);
    }

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas indisponível');
    ctx.drawImage(bitmap, 0, 0);
    return await canvasToFile(canvas, file, watermark, capturedAt);
  } finally {
    bitmap?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function canvasToFile(canvas: HTMLCanvasElement, original: File, watermark: WatermarkData, capturedAt: Date): Promise<File> {
  drawWatermark(canvas, watermark, capturedAt);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  if (!blob) throw new Error('Não foi possível gerar a imagem com legenda');
  const ext = /\.webp$/i.test(original.name) ? '.webp' : /\.png$/i.test(original.name) ? '.png' : '.jpg';
  const baseName = original.name.replace(/\.[^.]+$/, '');
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return new File([blob], `${baseName}-legenda${ext}`, { type });
}

export function drawWatermark(canvas: HTMLCanvasElement, watermark: WatermarkData, capturedAt: Date = new Date()): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  // Usa a data da foto (informada na contingência), não a data do upload.
  const dateStr = `${capturedAt.getDate().toString().padStart(2, '0')}/${(capturedAt.getMonth() + 1).toString().padStart(2, '0')}/${capturedAt.getFullYear()}`;
  const timeStr = `${capturedAt.getHours().toString().padStart(2, '0')}:${capturedAt.getMinutes().toString().padStart(2, '0')}:${capturedAt.getSeconds().toString().padStart(2, '0')}`;

  const lines: string[] = [];
  if (watermark.pdvName) lines.push(`PDV: ${watermark.pdvName}`);
  if (watermark.brandName) lines.push(`Marca: ${watermark.brandName}`);
  if (watermark.promotorName) lines.push(`Promotor: ${watermark.promotorName}`);
  if (watermark.categoryName) lines.push(`Categoria: ${watermark.categoryName}`);
  if (watermark.productName) lines.push(`Produto: ${watermark.productName}`);
  lines.push(`${dateStr} ${timeStr}`);
  if (watermark.photoType) lines.push(`Tipo: ${watermark.photoType}`);
  if (watermark.latitude && watermark.longitude) {
    lines.push(`GPS: ${watermark.latitude.toFixed(5)}, ${watermark.longitude.toFixed(5)}`);
  }

  const fontSize = Math.max(12, Math.floor(w * 0.025));
  const lineHeight = fontSize * 1.4;
  const padding = fontSize * 0.8;
  const boxHeight = lines.length * lineHeight + padding * 2;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(0, h - boxHeight, w, boxHeight);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillText(line, padding, h - boxHeight + padding + i * lineHeight);
  });

  ctx.font = `${Math.floor(fontSize * 0.8)}px sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  const ts = `${dateStr} ${timeStr}`;
  const tsWidth = ctx.measureText(ts).width;
  ctx.fillText(ts, w - tsWidth - padding, padding);
}
