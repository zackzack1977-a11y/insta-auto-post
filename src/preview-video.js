// 投稿する動画の仕上がり(文字入れ・BGM・表紙のコマ)を、投稿せずに手元で作って確かめる。
// 使い方: node src/preview-video.js "videos/料理名.mp4"
// 出力: generated/preview/ の中(料理名_final.mp4、表紙の候補、選ばれた表紙)
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./shared');
const { renderFinalVideo, pickCoverFrame } = require('./video-edit');
const { dishNameFromFilename, pickRandomMusic } = require('./post-helpers');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  loadDotEnv();
  const input = process.argv[2];
  if (!input || !fs.existsSync(input)) {
    console.error('使い方: node src/preview-video.js "videos/料理名.mp4"');
    process.exit(1);
  }
  const dishName = dishNameFromFilename(path.basename(input));
  const outDir = path.join(ROOT, 'generated', 'preview');
  const out = path.join(outDir, `${path.parse(input).name}_final.mp4`);
  renderFinalVideo(input, pickRandomMusic(), out, { dishName, workDir: outDir });
  console.log('仕上がりの動画: ' + out);
  const cover = await pickCoverFrame(out, path.join(outDir, 'cover'), { apiKey: process.env.ANTHROPIC_API_KEY, dishName });
  console.log('表紙(thumb_offset): ' + cover.offsetMs + 'ミリ秒 / ' + cover.framePath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
