// Genspark動画の「作り置き」バッチ生成用の補助スクリプト。
// まだ動画が用意されておらず(videos/に対応する.mp4が無い)、かつ未投稿の写真を、
// ファイル名順に最大N件(デフォルト4件)だけ一覧する。
// Gensparkの無料枠クレジットを使いすぎないよう、1回の実行で処理する本数を
// 呼び出し側(run-genspark-video.bat)で制限するために使う。
// 対象が無ければ何も出力せず、終了コード0で終わる(呼び出し側はこれを
// 「在庫が足りているので今日は生成不要」の合図として扱う)。
//
// 使い方: node src/list-video-candidates.js [件数(デフォルト4)]
// 出力: 対象ファイル名を1行ずつ標準出力に出す

const fs = require('fs');
const path = require('path');
const { PHOTOS_DIR, IMAGE_EXTENSIONS, loadPostedList, findPremadeVideoPath } = require('./shared');

const limit = Math.max(1, parseInt(process.argv[2], 10) || 4);

const posted = new Set(loadPostedList().map((entry) => entry.photo));

const candidates = fs
  .readdirSync(PHOTOS_DIR)
  .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
  .filter((f) => !posted.has(f))
  .filter((f) => !findPremadeVideoPath(f))
  .sort((a, b) => a.localeCompare(b, 'ja'))
  .slice(0, limit);

for (const c of candidates) console.log(c);
