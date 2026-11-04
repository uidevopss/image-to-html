// Image helpers: load, prepare for upload to Gemini, crop assets, and assemble final HTML.

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the image file.'));
    r.readAsDataURL(file);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the image.'));
    img.src = src;
  });
}

// Downscale very large uploads for the API call (boxes are normalised, so crops still use the original).
export function prepareForGemini(img, maxSide = 2048) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  return { base64: dataUrl.split(',')[1], mime: 'image/jpeg', width: w, height: h };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// box_2d = [ymin, xmin, ymax, xmax] on a 0-1000 scale
export function cropAsset(img, asset, { maxWidth = 1200, jpegQuality = 0.85 } = {}) {
  const box = (asset.box_2d || []).map(Number);
  if (box.length !== 4 || box.some(Number.isNaN)) throw new Error(`Invalid box for "${asset.id}"`);
  let [ymin, xmin, ymax, xmax] = box.map((v) => clamp(v, 0, 1000));
  if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
  if (xmax < xmin) [xmin, xmax] = [xmax, xmin];

  const sx = Math.round((xmin / 1000) * img.naturalWidth);
  const sy = Math.round((ymin / 1000) * img.naturalHeight);
  const sw = Math.max(1, Math.round(((xmax - xmin) / 1000) * img.naturalWidth));
  const sh = Math.max(1, Math.round(((ymax - ymin) / 1000) * img.naturalHeight));

  // Output at up to 2x the display width (retina) but never upscale beyond the source pixels.
  const target = asset.display_width ? Math.min(maxWidth, asset.display_width * 2) : maxWidth;
  const scale = Math.min(1, target / sw);
  const ow = Math.max(1, Math.round(sw * scale));
  const oh = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = ow;
  canvas.height = oh;
  const ctx = canvas.getContext('2d');
  const isPng = asset.format === 'png';
  if (!isPng) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ow, oh);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, ow, oh);
  const mime = isPng ? 'image/png' : 'image/jpeg';
  return {
    id: asset.id,
    description: asset.description || '',
    dataUrl: canvas.toDataURL(mime, jpegQuality),
    width: ow,
    height: oh,
    mime,
    displayWidth: asset.display_width || Math.min(600, sw),
  };
}

export function cropAll(img, assets) {
  const done = [];
  const errors = [];
  for (const a of assets) {
    try {
      done.push(cropAsset(img, a));
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { crops: done, errors };
}

// Replace {{img:ID}} placeholders with data URIs.
export function assembleHtml(template, crops) {
  const map = Object.fromEntries(crops.map((c) => [c.id, c.dataUrl]));
  const missing = [];
  const html = template.replace(/\{\{\s*img:([\w-]+)\s*\}\}/g, (_, id) => {
    if (map[id]) return map[id];
    missing.push(id);
    return `https://placehold.co/600x300?text=${encodeURIComponent(id)}`;
  });
  return { html, missing };
}

// Quick rule checker shown in the UI.
export function runChecks(html) {
  const lower = html.toLowerCase();
  const noPlaceholders = !/\{\{\s*img:/.test(html);
  const bytes = new Blob([html]).size;
  return [
    { label: 'Table-based layout', ok: lower.includes('<table') && !/<div[\s>]/.test(lower) },
    { label: 'Container max-width 600px', ok: /max-width:\s*600px/.test(lower) },
    {
      label: 'No modern CSS (flex / grid / var / calc)',
      ok: !/display:\s*(flex|grid|inline-flex)|var\(--|calc\(|clamp\(|position:\s*(absolute|fixed)|float:/.test(lower),
    },
    { label: 'No <script> / <svg> / <form>', ok: !/<(script|svg|form)[\s>]/.test(lower) },
    { label: 'Images have alt text', ok: !/<img(?![^>]*\balt=)/i.test(html) },
    { label: 'All image placeholders resolved', ok: noPlaceholders },
    {
      label: `Size ${(bytes / 1024).toFixed(0)} KB (Gmail clips above ~102 KB)`,
      ok: bytes < 102 * 1024,
      warn: true,
    },
  ];
}
