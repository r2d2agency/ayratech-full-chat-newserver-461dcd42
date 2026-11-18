import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Compressão em massa da pasta uploads. Mantém o MESMO nome do arquivo para
// não quebrar URLs já gravadas no banco. Processa WebP, JPEG, JPG e PNG.
//
// Uso:
//   node scripts/compress-uploads.mjs [pasta] [targetKb] [--dry-run] [--limit N]
//
// Exemplos:
//   node scripts/compress-uploads.mjs ../uploads 300 --dry-run
//   node scripts/compress-uploads.mjs ../uploads 300 --limit 1000

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const uploadsDir = path.resolve(positional[0] || '../uploads');
const targetKb = Number(positional[1] || 300);
const targetBytes = targetKb * 1024;
const dryRun = args.includes('--dry-run');
const limitArgIndex = args.indexOf('--limit');
const limit = limitArgIndex >= 0 ? Number(args[limitArgIndex + 1] || 0) : 0;

const IMAGE_EXTENSIONS = new Set(['.webp', '.jpg', '.jpeg', '.png']);
const DIMENSIONS = [1920, 1440, 1200, 960, 800, 640, 480];
const QUALITIES_BY_EXT = {
  '.webp': [72, 62, 52, 42, 32, 22, 12],
  '.jpg': [72, 62, 52, 42, 32, 22, 12],
  '.jpeg': [72, 62, 52, 42, 32, 22, 12],
  '.png': [85, 75, 65, 55, 45, 35],
};

function encoderFor(ext, quality) {
  if (ext === '.webp') return sharp().webp({ quality, effort: 4 });
  if (ext === '.jpg' || ext === '.jpeg') return sharp().jpeg({ quality, mozjpeg: true });
  return sharp().png({ quality, compressionLevel: 9, palette: true });
}

async function walk(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

async function compressOne(file) {
  const ext = path.extname(file).toLowerCase();
  const before = fs.statSync(file).size;
  if (before <= targetBytes) return { status: 'skipped-small', before, after: before };

  const input = await fs.promises.readFile(file);
  let best = null;
  let bestSize = Infinity;

  for (const quality of QUALITIES_BY_EXT[ext]) {
    for (const maxDim of DIMENSIONS) {
      const output = await sharp(input)
        .rotate()
        .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        .pipe(encoderFor(ext, quality))
        .toBuffer();
      if (output.length < bestSize) {
        best = output;
        bestSize = output.length;
      }
      if (output.length <= targetBytes) break;
    }
    if (bestSize <= targetBytes) break;
  }

  if (!best || bestSize >= before) return { status: 'no-gain', before, after: bestSize || before };

  if (!dryRun) {
    const tmp = `${file}.compress-${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, best);
    await fs.promises.rename(tmp, file);
  }
  return { status: dryRun ? 'would-compress' : 'compressed', before, after: bestSize };
}

async function main() {
  if (!fs.existsSync(uploadsDir)) {
    console.error(`Pasta não encontrada: ${uploadsDir}`);
    process.exit(1);
  }

  let files = await walk(uploadsDir);
  if (limit > 0) files = files.slice(0, limit);

  let totalBefore = 0;
  let totalAfter = 0;
  let processed = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const result = await compressOne(file);
      totalBefore += result.before;
      totalAfter += result.after;
      if (result.status === 'compressed' || result.status === 'would-compress') processed++;
      if (processed <= 30 || result.status === 'compressed' || result.status === 'would-compress') {
        console.log(
          `${result.status.padEnd(15)} ${((result.before - result.after) / 1024).toFixed(0).padStart(8)} KB  ${path.relative(uploadsDir, file)}`,
        );
      }
    } catch (err) {
      errors++;
      console.error(`error           ${path.relative(uploadsDir, file)}: ${err?.message || err}`);
    }
  }

  console.log('\nResumo');
  console.log(`Arquivos encontrados: ${files.length}`);
  console.log(`Comprimidos: ${processed}${dryRun ? ' (dry-run, nada foi alterado)' : ''}`);
  console.log(`Erros: ${errors}`);
  console.log(`Antes: ${(totalBefore / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Depois: ${(totalAfter / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Economia: ${((totalBefore - totalAfter) / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
