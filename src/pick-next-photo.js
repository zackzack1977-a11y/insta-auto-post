// Genspark動画生成の対象を決めるための補助スクリプト。
// post.js内のpickNextPhoto()と必ず同じロジックになるよう、ロジック本体は
// shared.jsに1本化してある(以前はここに古いmtime順のロジックが別途あり、
// post.js側だけ更新されてズレていた事故があったため)。
//
// 使い方: node src/pick-next-photo.js
// 出力: 次に投稿すべき写真のファイル名(標準出力に1行)

const { pickNextPhoto } = require('./shared');

const next = pickNextPhoto();
if (!next) {
  console.error('投稿できる新しい写真がありません。');
  process.exit(1);
}
console.log(next);
