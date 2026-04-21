// Brand asset generator — icon.png + splash.png
// Run: node scripts/gen-brand.js
const { PNG } = require('../node_modules/pngjs');
const fs = require('fs');
const path = require('path');

// ── helpers ──────────────────────────────────────────────────────────────────

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.sqrt((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2);
}

function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Render an X mark (two crossing diagonals with rounded caps + anti-aliasing).
 * cx/cy = mark center, span = half-width of each arm (arm goes span px from center),
 * stroke = half-stroke-width.
 */
function drawX(data, W, cx, cy, span, stroke, [fr, fg, fb]) {
  // Endpoints of both diagonals
  const segs = [
    [cx - span, cy - span, cx + span, cy + span],
    [cx + span, cy - span, cx - span, cy + span],
  ];
  const half = stroke / 2;

  for (let y = Math.floor(cy - span - half - 2); y <= Math.ceil(cy + span + half + 2); y++) {
    for (let x = Math.floor(cx - span - half - 2); x <= Math.ceil(cx + span + half + 2); x++) {
      if (x < 0 || x >= W || y < 0 || y >= W) continue;
      const d = Math.min(...segs.map(([x1, y1, x2, y2]) => distToSegment(x, y, x1, y1, x2, y2)));
      if (d > half + 1) continue;
      const alpha = d > half - 1 ? Math.max(0, half - d + 1) : 1; // 0–1 anti-alias
      const idx = (y * W + x) * 4;
      const bg = [data[idx], data[idx + 1], data[idx + 2]];
      data[idx]     = Math.round(fr * alpha + bg[0] * (1 - alpha));
      data[idx + 1] = Math.round(fg * alpha + bg[1] * (1 - alpha));
      data[idx + 2] = Math.round(fb * alpha + bg[2] * (1 - alpha));
      data[idx + 3] = 255;
    }
  }
}

function fillSolid(png, [r, g, b]) {
  const { data, width, height } = png;
  for (let i = 0; i < width * height * 4; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
}

function savePNG(png, outPath) {
  const buf = PNG.sync.write(png);
  fs.writeFileSync(outPath, buf);
  console.log('✓ wrote', path.relative(process.cwd(), outPath), `(${(buf.length / 1024).toFixed(0)} KB)`);
}

// ── icon.png  1024×1024 ──────────────────────────────────────────────────────
// Deep green bg, gold X mark, no text, centered with 18% padding

const ICON_SIZE = 1024;
const icon = new PNG({ width: ICON_SIZE, height: ICON_SIZE, filterType: -1 });
fillSolid(icon, hex('#0F5C5E'));
drawX(
  icon.data, ICON_SIZE,
  ICON_SIZE / 2,         // cx
  ICON_SIZE / 2,         // cy
  300,                   // span: arm extends 300px from center (60% of canvas radius)
  108,                   // stroke diameter 108px → clean bold X
  hex('#D4A017'),
);
savePNG(icon, path.join(__dirname, '../assets/icon.png'));

// ── splash.png  1284×1284 ────────────────────────────────────────────────────
// Transparent background — backgroundColor in app.json fills the screen.
// Only the gold X mark is rendered; everything else stays fully transparent.

const SPLASH_SIZE = 1284;
const splash = new PNG({ width: SPLASH_SIZE, height: SPLASH_SIZE, filterType: -1 });
// Fill with fully transparent pixels
for (let i = 0; i < SPLASH_SIZE * SPLASH_SIZE * 4; i += 4) {
  splash.data[i] = 0; splash.data[i+1] = 0; splash.data[i+2] = 0; splash.data[i+3] = 0;
}
// Draw X over transparent bg using direct pixel writes
{
  const [fr, fg, fb] = hex('#D4A017');
  const segs = [
    [SPLASH_SIZE/2 - 130, SPLASH_SIZE/2 - 130 - 60, SPLASH_SIZE/2 + 130, SPLASH_SIZE/2 + 130 - 60],
    [SPLASH_SIZE/2 + 130, SPLASH_SIZE/2 - 130 - 60, SPLASH_SIZE/2 - 130, SPLASH_SIZE/2 + 130 - 60],
  ];
  const half = 32;
  for (let y = 0; y < SPLASH_SIZE; y++) {
    for (let x = 0; x < SPLASH_SIZE; x++) {
      const d = Math.min(...segs.map(([x1,y1,x2,y2]) => distToSegment(x,y,x1,y1,x2,y2)));
      if (d > half + 1) continue;
      const alpha = d > half - 1 ? Math.max(0, half - d + 1) : 1;
      const idx = (y * SPLASH_SIZE + x) * 4;
      splash.data[idx]   = fr;
      splash.data[idx+1] = fg;
      splash.data[idx+2] = fb;
      splash.data[idx+3] = Math.round(alpha * 255);
    }
  }
}
savePNG(splash, path.join(__dirname, '../assets/splash.png'));

// ── logo.png  (same as icon, used for expo adaptive icon fallback) ───────────
const logo = new PNG({ width: ICON_SIZE, height: ICON_SIZE, filterType: -1 });
fillSolid(logo, hex('#0F5C5E'));
drawX(
  logo.data, ICON_SIZE,
  ICON_SIZE / 2,
  ICON_SIZE / 2,
  300,
  108,
  hex('#D4A017'),
);
savePNG(logo, path.join(__dirname, '../assets/logo.png'));

console.log('\nDone. Update Expo cache if needed: npx expo start --clear');
