// Deterministic XSelf Home brand asset generator.
// Run: node scripts/gen-brand.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repoRoot = path.resolve(__dirname, '..');
const masterPath = path.join(
  repoRoot,
  'assets/brand/xself-home-logo-master.jpg',
);

const pngTargets = [
  ['assets/icon.png', 1024],
  ['assets/logo.png', 1024],
  ['assets/favicon.png', 256],
  ['ios/XselfHome/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png', 1024],
  ['android/app/src/main/res/drawable-mdpi/splashscreen_logo.png', 288],
  ['android/app/src/main/res/drawable-hdpi/splashscreen_logo.png', 432],
  ['android/app/src/main/res/drawable-xhdpi/splashscreen_logo.png', 576],
  ['android/app/src/main/res/drawable-xxhdpi/splashscreen_logo.png', 864],
  ['android/app/src/main/res/drawable-xxxhdpi/splashscreen_logo.png', 1152],
];

const launcherTargets = [
  ['android/app/src/main/res/mipmap-mdpi/ic_launcher.webp', 48],
  ['android/app/src/main/res/mipmap-hdpi/ic_launcher.webp', 72],
  ['android/app/src/main/res/mipmap-xhdpi/ic_launcher.webp', 96],
  ['android/app/src/main/res/mipmap-xxhdpi/ic_launcher.webp', 144],
  ['android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp', 192],
  ['android/app/src/main/res/mipmap-mdpi/ic_launcher_round.webp', 48],
  ['android/app/src/main/res/mipmap-hdpi/ic_launcher_round.webp', 72],
  ['android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.webp', 96],
  ['android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.webp', 144],
  ['android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.webp', 192],
  ['android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.webp', 108],
  ['android/app/src/main/res/mipmap-hdpi/ic_launcher_foreground.webp', 162],
  ['android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.webp', 216],
  ['android/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.webp', 324],
  ['android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.webp', 432],
];

async function writePng(relativePath, size) {
  const outputPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await sharp(masterPath)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .removeAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
  console.log(`✓ ${relativePath} (${size}×${size} PNG)`);
}

async function writeWebp(relativePath, size) {
  const outputPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await sharp(masterPath)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .removeAlpha()
    .webp({ quality: 100, lossless: true })
    .toFile(outputPath);
  console.log(`✓ ${relativePath} (${size}×${size} WebP)`);
}

async function main() {
  if (!fs.existsSync(masterPath)) {
    throw new Error(`Missing approved brand master: ${masterPath}`);
  }

  const metadata = await sharp(masterPath).metadata();
  if (
    metadata.width !== metadata.height
    || !metadata.width
    || metadata.width < 1024
  ) {
    throw new Error(
      `Brand master must be square and at least 1024px; got ${metadata.width}×${metadata.height}`,
    );
  }

  for (const [relativePath, size] of pngTargets) {
    await writePng(relativePath, size);
  }

  for (const [relativePath, size] of launcherTargets) {
    await writeWebp(relativePath, size);
  }

  console.log('\nBrand assets generated from the approved XSelf Home master.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
