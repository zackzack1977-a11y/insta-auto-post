// Genspark動画生成の対象を決めるための補助スクリプト。
// post.js内のpickNextPhoto()と同じロジック(posted.jsonに無い最古の写真)を使うことで、
// Genspark側(ローカルで事前生成)とGitHub Actions側(投稿時)が
// 必ず同じ写真を選ぶようにする。
//
// 使い方: node src/pick-next-photo.js
// 出力: 次に投稿すべき写真のファイル名(標準出力に1行)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const POSTED_LOG = path.join(ROOT, 'data', 'posted.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

function loadPostedList() {
  if (!fs.existsSync(POSTED_LOG)) return [];
  return JSON.parse(fs.readFileSync(POSTED_LOG, 'utf8'));
}

function pickNextPhoto() {
  const posted = new Set(loadPostedList());
  const candidates = fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .filter((f) => !posted.has(f))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(PHOTOS_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  return candidates[0]?.name ?? null;
}

const next = pickNextPhoto();
if (!next) {
  console.error('投稿できる新しい写真がありません。');
  process.exit(1);
}
console.log(next);
