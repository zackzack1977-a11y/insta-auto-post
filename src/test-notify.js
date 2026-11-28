// 知らせの送り先(Discord / LINE)の試し(2026-11-28)。本番の確認通知と同じ形で1通送る。
// 確認リンクは、存在しない投稿ID(test-…)で作るので、開いて「投稿する」を押しても何も投稿されない。
// Discordが確認リンクを勝手に開かないこと(<> で囲む)と、開いても確認の画面が出るだけなことを、たけしさんが見て確かめる。
const crypto = require('crypto');
const { notify, channel } = require('./notify');

(async () => {
  const { PUBLISH_SIGNING_SECRET, PUBLISH_WORKER_URL } = process.env;
  if (!PUBLISH_SIGNING_SECRET || !PUBLISH_WORKER_URL) throw new Error('PUBLISH_SIGNING_SECRET / PUBLISH_WORKER_URL がありません');
  const id = `test-${Date.now()}`;
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', PUBLISH_SIGNING_SECRET).update(`${id}.${ts}`).digest('hex');
  const publishUrl = `${PUBLISH_WORKER_URL}?id=${encodeURIComponent(id)}&ts=${ts}&sig=${sig}`;
  const videoUrl = 'https://cdn.jsdelivr.net/gh/zackzack1977-a11y/insta-auto-post@master/generated/video-gen-sample/4%E7%A8%AE%E3%81%AE%E3%81%8A%E6%96%99%E7%90%86%E3%81%AEZack%E3%83%97%E3%83%AC%E3%83%BC%E3%83%88.mp4';
  const text =
    `【試しの知らせ】Instagram投稿の確認(これは試しです。投稿はされません)\n\n` +
    `🎬 動画(試し): \n${videoUrl}\n\n` +
    `下のリンクを開くと、確認の画面が出るだけです。「投稿する」を押しても、試しの番号なので何も投稿されません:\n${publishUrl}`;
  console.log(`送り先: ${channel()}`);
  const r = await notify([{ type: 'video', originalContentUrl: videoUrl, previewImageUrl: videoUrl }, { type: 'text', text }]);
  console.log(`結果: ${r.ok ? '届いた' : '届かなかった'}${r.error ? '(' + r.error + ')' : ''}`);
  if (!r.ok) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
