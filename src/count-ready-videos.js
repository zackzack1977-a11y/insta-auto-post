// Genspark動画の「作り置き」バッチ用の在庫カウンター。
// 「動画があり、かつ未投稿の写真」の本数(=これから投稿に使える動画の本数)だけを標準出力に出す。
// videos/の.mp4の総数ではなく、投稿済みの写真の動画を除いて数える
// (総数で数えると、使い切った動画が在庫に見えて生成が止まる。2026-10-15に発生)。
//
// 使い方: node src/count-ready-videos.js

const fs = require('fs');
const path = require('path');
const { PHOTOS_DIR, IMAGE_EXTENSIONS, loadPostedList, findPremadeVideoPath } = require('./shared');

const posted = new Set(loadPostedList().map((entry) => entry.photo));

const ready = fs
  .readdirSync(PHOTOS_DIR)
  .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
  .filter((f) => !posted.has(f))
  .filter((f) => findPremadeVideoPath(f));

console.log(ready.length);
