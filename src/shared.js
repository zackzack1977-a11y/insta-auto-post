// post.js と pick-next-photo.js の両方から使う共通ロジック。
// 「次に投稿する写真の選び方」と「投稿履歴(posted.json)の読み書き」を
// 1箇所にまとめることで、2つのファイルでロジックがズレる事故を防ぐ。
//
// posted.json のスキーマ(2026-09-14〜):
//   [{ photo: "ファイル名.jpg", creationId: "IGのコンテナID", presentedAt: "ISO日時", confirmed: true|false }, ...]
// confirmed: false は「LINEに提示はしたが、実際にInstagramへ公開されたかまだ未確認」を意味する。
// 過去形式(ファイル名の文字列だけの配列)との後方互換のため、文字列のエントリは
// 「確定済みの投稿」(confirmed: true)として扱う(過去に実際に運用されていた投稿記録のため)。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const PREMADE_VIDEOS_DIR = path.join(ROOT, 'videos');
const POSTED_LOG = path.join(ROOT, 'data', 'posted.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

function loadPostedList() {
  if (!fs.existsSync(POSTED_LOG)) return [];
  const raw = JSON.parse(fs.readFileSync(POSTED_LOG, 'utf8'));
  return raw.map((entry) =>
    typeof entry === 'string'
      ? { photo: entry, creationId: null, presentedAt: null, confirmed: true }
      : entry
  );
}

function savePostedList(list) {
  fs.mkdirSync(path.dirname(POSTED_LOG), { recursive: true });
  fs.writeFileSync(POSTED_LOG, JSON.stringify(list, null, 2) + '\n');
}

// 写真ファイル名に対応する事前生成動画(videos/配下)を探す。
// 大文字小文字を区別しない(.MP4なども見つける)。見つからなければnull。
function findPremadeVideoPath(photoFilename) {
  if (!fs.existsSync(PREMADE_VIDEOS_DIR)) return null;
  const baseName = path.parse(photoFilename).name.toLowerCase();
  const match = fs
    .readdirSync(PREMADE_VIDEOS_DIR)
    .find((f) => path.extname(f).toLowerCase() === '.mp4' && path.parse(f).name.toLowerCase() === baseName);
  return match ? path.join(PREMADE_VIDEOS_DIR, match) : null;
}

function hasPremadeVideo(photoFilename) {
  return findPremadeVideoPath(photoFilename) !== null;
}

// GitHub Actions上のチェックアウトではファイルの更新日時がgit管理外(チェックアウト時刻)に
// なってしまい、mtime順は意味を持たない。そのため「Genspark動画が事前に用意されている
// 写真」を優先して選ぶ(たけしさんの方針: 作り置きした動画がある写真から順に投稿する)。
// 動画が無い写真同士の順序はファイル名順(決定的な順序を保つため)。
function pickNextPhoto() {
  const posted = new Set(loadPostedList().map((entry) => entry.photo));
  const candidates = fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .filter((f) => !posted.has(f))
    .sort((a, b) => {
      const aHasVideo = hasPremadeVideo(a);
      const bHasVideo = hasPremadeVideo(b);
      if (aHasVideo !== bHasVideo) return aHasVideo ? -1 : 1;
      return a.localeCompare(b, 'ja');
    });
  return candidates[0] ?? null;
}

module.exports = {
  ROOT,
  PHOTOS_DIR,
  PREMADE_VIDEOS_DIR,
  POSTED_LOG,
  IMAGE_EXTENSIONS,
  loadPostedList,
  savePostedList,
  findPremadeVideoPath,
  hasPremadeVideo,
  pickNextPhoto,
};
