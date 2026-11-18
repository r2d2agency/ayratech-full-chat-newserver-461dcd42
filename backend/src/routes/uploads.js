import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Limite rígido para fotos enviadas por celular ou PC. O compress do navegador
// é best-effort (Safari nem sempre honra target de tamanho), então o servidor
// precisa garantir o tamanho final.
const IMAGE_TARGET_MAX_BYTES = 300 * 1024;
const IMAGE_MAX_DIMENSION = 1920;

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with original extension.
    // If original filename has no extension (common on mobile), infer from mimetype
    // so providers like W-API can fetch a URL that ends with a visible extension.
    const originalExt = path.extname(file.originalname || '');
    // Alguns dispositivos salvam JPEG como .jfif; normalizamos para .jpg porque vários provedores
    // validam a extensão da URL/arquivo e rejeitam .jfif.
    const normalizedOriginalExt = originalExt.toLowerCase() === '.jfif' ? '.jpg' : originalExt;
    const mime = String(file.mimetype || '').toLowerCase();

    const mimeToExt = {
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'text/plain': '.txt',
      'text/csv': '.csv',
      'application/csv': '.csv',
      'application/zip': '.zip',
      'application/x-zip-compressed': '.zip',
      'application/x-rar-compressed': '.rar',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/tiff': '.tiff',
      'image/svg+xml': '.svg',
      'image/avif': '.avif',
      // JFIF é um contêiner de JPEG; salvamos como .jpg para compatibilidade.
      'image/jfif': '.jpg',
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',
      'audio/ogg': '.ogg',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/webm': '.webm',
      'audio/aac': '.aac',
      'audio/m4a': '.m4a',
      'audio/x-m4a': '.m4a',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/ogg': '.ogv',
      'video/quicktime': '.mov',
    };

    const ext = normalizedOriginalExt || mimeToExt[mime] || '.bin';
    const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    cb(null, uniqueName);
  }
});

function isRasterImage(file) {
  const mime = String(file?.mimetype || '').toLowerCase();
  const ext = path.extname(file?.originalname || '').toLowerCase();
  return [
    'image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff', 'image/avif', 'image/jfif',
  ].includes(mime) || ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.avif', '.jfif'].includes(ext);
}

// Comprime qualquer imagem raster para WebP, reduzindo qualidade e resolução
// até caber no limite. Nunca altera documentos/áudios/vídeos/SVG (que podem
// ter semântica própria e não devem virar WebP).
async function normalizeUploadedImage(req, res, next) {
  if (!req.file || !isRasterImage(req.file)) return next();

  try {
    const inputPath = req.file.path;
    const outputPath = path.join(uploadsDir, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.webp`);

    let created = false;
    let bestPath = null;
    let bestSize = Infinity;

    for (const quality of [72, 62, 52, 42, 32, 22, 12]) {
      for (const maxDim of [IMAGE_MAX_DIMENSION, 1440, 1200, 960, 800, 640]) {
        const candidate = `${outputPath}.${quality}-${maxDim}.tmp.webp`;
        await sharp(inputPath)
          .rotate()
          .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
          .webp({ quality, effort: 4 })
          .toFile(candidate);
        const size = fs.statSync(candidate).size;
        if (size < bestSize) {
          if (bestPath && fs.existsSync(bestPath)) fs.unlinkSync(bestPath);
          bestPath = candidate;
          bestSize = size;
        } else {
          fs.unlinkSync(candidate);
        }
        if (size <= IMAGE_TARGET_MAX_BYTES) {
          created = true;
          break;
        }
      }
      if (created) break;
    }

    if (!bestPath) throw new Error('Falha ao comprimir imagem');
    fs.unlinkSync(inputPath);
    fs.renameSync(bestPath, outputPath);

    req.file.path = outputPath;
    req.file.filename = path.basename(outputPath);
    req.file.mimetype = 'image/webp';
    req.file.size = bestSize;
    return next();
  } catch (err) {
    // Se a imagem estiver corrompida, rejeita em vez de salvar um arquivo grande.
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Não foi possível processar a imagem enviada' });
  }
}

// File filter for allowed types
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    // Images
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'image/svg+xml',
    'image/avif',
    'image/jfif',
    // Audio
    'audio/mpeg',
    'audio/mp3',
    'audio/ogg',
    'audio/wav',
    'audio/x-wav',
    'audio/webm',
    'audio/aac',
    'audio/m4a',
    'audio/x-m4a',
    // Video
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    'application/csv',
    'application/zip',
    'application/x-rar-compressed',
    'application/x-zip-compressed',
  ];

  // Fallback extension allowlist (some browsers/mobile send generic mimetypes)
  const allowedExts = [
    // images
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.jfif', '.bmp', '.tiff', '.svg', '.avif',
    // audio
    '.mp3', '.ogg', '.wav', '.webm', '.aac', '.m4a',
    // video
    '.mp4', '.webm', '.ogg', '.mov', '.qt',
    // documents
    '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.csv',
    // archives
    '.zip', '.rar', '.7z',
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext && allowedExts.includes(ext)) {
      cb(null, true);
      return;
    }
    cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  }
});

// Upload single file
router.post('/', authenticate, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err?.message || 'Erro ao fazer upload' });
    }

    normalizeUploadedImage(req, res, () => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        // Build the public URL - use backend domain, not frontend
        const baseUrl = String(process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
        const fileUrl = baseUrl
          ? `${baseUrl}/uploads/${req.file.filename}`
          : `/uploads/${req.file.filename}`;

        res.json({
          success: true,
          file: {
            filename: req.file.filename,
            originalName: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            url: fileUrl,
          }
        });
      } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Erro ao fazer upload' });
      }
    });
  });
});

// Public download with forced filename (keeps extension visible in the URL)
// Useful for providers that require a file extension to be present.
// Example: GET /api/uploads/public/<stored>/<downloadName.pdf>
router.get('/public/:stored/:downloadName', (req, res) => {
  try {
    const stored = String(req.params.stored || '');
    const downloadName = String(req.params.downloadName || '');

    // Prevent path traversal
    const safe = /^[a-zA-Z0-9._-]+$/;
    if (!safe.test(stored) || !safe.test(downloadName)) {
      return res.status(400).json({ error: 'Nome de arquivo inválido' });
    }

    const filePath = path.join(uploadsDir, stored);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }

    // Ensure downstream services see the extension in the URL
    const ext = path.extname(downloadName) || path.extname(stored);
    if (ext) {
      res.type(ext);
    }

    // Inline is usually fine; providers just need to fetch the bytes.
    // Keep a friendly filename for any human downloads.
    res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);

    return res.sendFile(filePath);
  } catch (error) {
    console.error('Public download error:', error);
    return res.status(500).json({ error: 'Erro ao baixar arquivo' });
  }
});

// Delete file
router.delete('/:filename', authenticate, (req, res) => {
  try {
    const filePath = path.join(uploadsDir, req.params.filename);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Arquivo não encontrado' });
    }
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Erro ao deletar arquivo' });
  }
});

// Check if file exists (public diagnostic endpoint)
router.get('/check/:filename', (req, res) => {
  try {
    const filePath = path.join(uploadsDir, req.params.filename);
    const exists = fs.existsSync(filePath);
    
    if (exists) {
      const stats = fs.statSync(filePath);
      const baseUrl = String(process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
      res.json({ 
        exists: true, 
        size: stats.size,
        created: stats.birthtime,
        url: baseUrl ? `${baseUrl}/uploads/${req.params.filename}` : `/uploads/${req.params.filename}`
      });
    } else {
      res.json({ exists: false, message: 'Arquivo não encontrado no servidor' });
    }
  } catch (error) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Erro ao verificar arquivo' });
  }
});

// List recent uploads (for diagnostics)
router.get('/list', authenticate, (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .map(name => {
        const filePath = path.join(uploadsDir, name);
        const stats = fs.statSync(filePath);
        return { name, size: stats.size, created: stats.birthtime };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, 50);
    
    res.json({ files, count: files.length });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Erro ao listar arquivos' });
  }
});

export default router;
