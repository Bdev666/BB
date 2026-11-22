// macOS without an Apple Developer ID: sign the app "ad-hoc" after packing.
// Apple Silicon Macs refuse to run code with no signature at all ("app is damaged"); an ad-hoc
// signature lets it start after the usual first-open approval (right click > Open).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  // a universal build packs x64 and arm64 first (…-temp folders) and merges them: those two must stay
  // untouched (identical files), only the merged app gets the signature
  if (/-temp$/.test(ctx.appOutDir)) return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
