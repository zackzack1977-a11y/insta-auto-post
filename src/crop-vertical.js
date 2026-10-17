// Gensparkに渡す前に、横長の写真を縦9:16に切り出す(2026-10-17追加)。
// 横長の写真をそのまま9:16で頼むと、写っていない上下をAIが想像で描き足して崩れるため、
// 先にこちらで縦に切り出し、描き足す余地を無くす。
//
// 使い方: node src/crop-vertical.js <写真のパス> [中心の位置(0〜1、既定0.5=真ん中)]
// 結果: generated/crop/<写真名>.jpg に保存し、そのパスを1行目に出力する。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'generated', 'crop');

function findFfmpeg() {
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(winget)) {
    for (const pkg of fs.readdirSync(winget).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      const pkgDir = path.join(winget, pkg);
      for (const build of fs.readdirSync(pkgDir)) {
        const exe = path.join(pkgDir, build, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return 'ffmpeg';
}

const src = process.argv[2];
const center = process.argv[3] === undefined ? 0.5 : Number(process.argv[3]);
if (!src || !fs.existsSync(src) || !(center >= 0 && center <= 1)) {
  console.error('使い方: node src/crop-vertical.js <写真のパス> [中心の位置0〜1]');
  process.exit(2);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, path.basename(src, path.extname(src)) + '.jpg');
// 幅 = 高さ×9/16。横の位置は center で決める(はみ出さないよう範囲内に収める)。
const vf = `crop=trunc(ih*9/16/2)*2:ih:max(0\\,min(iw-ow\\,iw*${center}-ow/2)):0`;
const r = spawnSync(findFfmpeg(), ['-y', '-loglevel', 'error', '-i', src, '-vf', vf, '-q:v', '2', out], {
  shell: false,
  encoding: 'utf8',
});
if (r.status !== 0) {
  console.error(r.stderr || '切り出しに失敗しました');
  process.exit(1);
}
console.log(out);
